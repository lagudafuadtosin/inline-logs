// Turns console arguments into text without running any of the app's code:
// getters are not called, toString/inspect are not called, and every limit
// (depth, items, string length, total length) is enforced as we go, so a huge
// or circular value costs the same as a small one. Works in Node and browsers.

export interface SerializeOptions {
  /** Objects deeper than this show as [Object] / [Array] / [ClassName]. */
  depth: number;
  /** Array items, Map/Set entries and object keys shown per container. */
  maxItems: number;
  /** Longest string shown before it is cut with an ellipsis. */
  maxString: number;
  /** Stop once the output reaches roughly this many characters. */
  maxTotal: number;
  /** Multi-line output with two-space indents (hover/viewer) or one line. */
  pretty: boolean;
}

export const PREVIEW: SerializeOptions = { depth: 3, maxItems: 20, maxString: 300, maxTotal: 1000, pretty: false };
export const FULL: SerializeOptions = { depth: 6, maxItems: 200, maxString: 10_000, maxTotal: 20_000, pretty: true };

const ELLIPSIS = "…";
const LINE_WIDTH = 72;

interface Ctx {
  o: SerializeOptions;
  seen: unknown[];
  used: number;
}

/** Formats console arguments the way a console prints them: top-level strings raw, the rest serialized, joined with spaces, printf-style %s %d %i %f %o %O %j %c on a first string. */
export function formatArgs(args: readonly unknown[], o: SerializeOptions): string {
  try {
    return formatArgsUnsafe(args, o);
  } catch {
    return "[Unserializable]";
  }
}

function formatArgsUnsafe(args: readonly unknown[], o: SerializeOptions): string {
  const ctx: Ctx = { o, seen: [], used: 0 };
  const parts: string[] = [];
  let rest = args;
  if (typeof args[0] === "string" && args[0].includes("%") && args.length > 1) {
    const [text, used] = printf(args[0], args.slice(1), ctx);
    parts.push(text);
    rest = args.slice(1 + used);
  } else if (args.length > 0) {
    parts.push(top(args[0], ctx));
    rest = args.slice(1);
  }
  for (const a of rest) {
    if (ctx.used >= o.maxTotal) {
      parts.push(ELLIPSIS);
      break;
    }
    parts.push(top(a, ctx));
  }
  return clip(parts.join(" "), o.maxTotal);
}

/** Serializes one value (strings quoted). */
export function serialize(value: unknown, o: SerializeOptions): string {
  return clip(guarded(value, { o, seen: [], used: 0 }), o.maxTotal);
}

/**
 * console.table, console.dir and console.trace. One line for the end of the
 * code line (pretty off), the full form for the hover (pretty on): the table
 * drawn the way Node draws it, the whole object, the call stack.
 */
export function formatCall(method: "table" | "dir" | "trace", args: readonly unknown[], o: SerializeOptions, stack?: string): string {
  try {
    if (method === "dir") return serialize(args[0], o);
    if (method === "trace") {
      const head = args.length ? `Trace: ${formatArgs(args, o)}` : "Trace";
      if (!o.pretty) return head;
      const frames = (stack ?? "")
        .split("\n")
        .filter((l) => /^\s*at\s|@/.test(l))
        .slice(0, 10);
      return clip([head, ...frames.map((l) => "    " + l.trim())].join("\n"), o.maxTotal);
    }
    return table(args[0], Array.isArray(args[1]) ? (args[1] as unknown[]).map(String) : undefined, o) ?? formatArgs(args.slice(0, 1), o);
  } catch {
    return "[Unserializable]";
  }
}

/** One line for console output that arrives as text: a drawn table becomes its size and columns, a trace its first line, like the previews elsewhere. */
export function textPreview(text: string, method?: "table" | "dir" | "trace"): string {
  if (method === "trace") return textPreview(text.split("\n")[0]);
  if (method === "table") {
    const rows = text.split("\n").filter((l) => l.trimStart().startsWith("│"));
    const cols = (rows[0] ?? "")
      .split("│")
      .map((c) => c.trim())
      .filter((c) => c && !/^\((iteration )?index\)$/.test(c));
    const n = Math.max(0, rows.length - 1);
    return `table, ${n} ${n === 1 ? "row" : "rows"}${cols.length ? `: ${cols.join(", ")}` : ""}`;
  }
  const one = text.trim();
  return one.length > PREVIEW.maxTotal ? one.slice(0, PREVIEW.maxTotal) + "…" : one;
}

/** Undefined when the value is not tabular (console.table then logs it as is). */
function table(data: unknown, only: string[] | undefined, o: SerializeOptions): string | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const t = tag(data);
  const rows: [string, unknown, unknown?][] = [];
  let indexHead = "(index)";
  let keyCol = false;
  let total = 0;
  if (t === "Map" || t === "Set") {
    indexHead = "(iteration index)";
    keyCol = t === "Map";
    const iter = safe(() => (t === "Map" ? Map.prototype.entries.call(data) : Set.prototype.values.call(data)) as Iterator<unknown>, undefined);
    for (let r = iter && safe(() => iter.next(), undefined); r && !r.done; r = safe(() => iter!.next(), undefined)) {
      if (rows.length < o.maxItems) rows.push(t === "Map" ? [String(total), (r.value as [unknown, unknown])[1], (r.value as [unknown, unknown])[0]] : [String(total), r.value]);
      total++;
    }
  } else {
    for (const k of safe(() => Object.keys(data), [] as string[])) {
      const d = safe(() => Object.getOwnPropertyDescriptor(data, k), undefined);
      if (!d || d.get || d.set) continue;
      if (rows.length < o.maxItems) rows.push([k, d.value]);
      total++;
    }
  }
  const cellOpts: SerializeOptions = { depth: 0, maxItems: 5, maxString: 40, maxTotal: 60, pretty: false };
  const cell = (v: unknown) => serialize(v, cellOpts);
  const columns: string[] = [];
  let values = false;
  for (const [, v] of rows) {
    if (v !== null && typeof v === "object") {
      for (const k of safe(() => Object.keys(v), [] as string[])) if (!columns.includes(k) && columns.length < 20) columns.push(k);
    } else {
      values = true;
    }
  }
  const cols = only ? only : columns;
  if (!o.pretty) {
    const names = [...(keyCol ? ["Key"] : []), ...cols, ...(values && !only ? ["Values"] : [])];
    return `table, ${total} ${total === 1 ? "row" : "rows"}${names.length ? `: ${names.join(", ")}` : ""}`;
  }
  const head = [indexHead, ...(keyCol ? ["Key"] : []), ...cols, ...(values && !only ? ["Values"] : [])];
  const body = rows.map(([k, v, key]) => {
    const own = (c: string) => (v !== null && typeof v === "object" && safe(() => Object.prototype.hasOwnProperty.call(v, c), false) ? cell(safe(() => Object.getOwnPropertyDescriptor(v, c)?.value, undefined)) : "");
    return [k, ...(keyCol ? [cell(key)] : []), ...cols.map(own), ...(values && !only ? [v !== null && typeof v === "object" ? "" : cell(v)] : [])];
  });
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (l: string, m: string, r: string) => l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  const row = (cells: string[]) => "│" + cells.map((c, i) => ` ${c.padEnd(widths[i])} `).join("│") + "│";
  const out = [line("┌", "┬", "┐"), row(head), line("├", "┼", "┤"), ...body.map(row), line("└", "┴", "┘")];
  if (total > rows.length) out.push(`... ${total - rows.length} more rows`);
  return clip(out.join("\n"), o.maxTotal);
}

function top(v: unknown, ctx: Ctx): string {
  if (typeof v === "string") return note(ctx, cut(v, ctx.o.maxString));
  return guarded(v, ctx);
}

function guarded(v: unknown, ctx: Ctx): string {
  try {
    return fmt(v, 0, ctx, "");
  } catch {
    ctx.seen.length = 0;
    return note(ctx, "[Unserializable]");
  }
}

function printf(fmtStr: string, args: readonly unknown[], ctx: Ctx): [string, number] {
  let i = 0;
  const out = fmtStr.replace(/%[sdifoOjc%]/g, (m) => {
    if (m === "%%") return "%";
    if (i >= args.length) return m;
    const a = args[i++];
    switch (m) {
      case "%s":
        return typeof a === "string" ? cut(a, ctx.o.maxString) : typeof a === "bigint" ? `${a}n` : typeof a === "object" && a !== null ? fmt(a, Math.max(ctx.o.depth - 1, 0), ctx, "") : fmt(a, 0, ctx, "");
      case "%d":
      case "%i": {
        if (typeof a === "bigint") return `${a}n`;
        if (typeof a === "symbol") return "NaN";
        const n = Number(a);
        return m === "%i" ? String(Math.trunc(n)) : String(n);
      }
      case "%f":
        return typeof a === "symbol" ? "NaN" : String(parseFloat(String(a)));
      case "%j":
        try {
          return JSON.stringify(a) ?? "undefined";
        } catch {
          return "[Circular]";
        }
      case "%c":
        return "";
      default:
        return fmt(a, 0, ctx, "");
    }
  });
  return [note(ctx, out), i];
}

function note(ctx: Ctx, s: string): string {
  ctx.used += s.length;
  return s;
}

function cut(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + ELLIPSIS : s;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + ELLIPSIS : s;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

function quote(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  const body = s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
  return q + (q === "'" ? body.replace(/'/g, "\\'") : body) + q;
}

function keyText(k: string | symbol): string {
  if (typeof k === "symbol") return `[${String(k)}]`;
  return IDENT.test(k) ? k : quote(k);
}

function safe<T>(f: () => T, fallback: T): T {
  try {
    return f();
  } catch {
    return fallback;
  }
}

function className(v: object): string | null | undefined {
  const proto = safe(() => Object.getPrototypeOf(v) as object | null, undefined);
  if (proto === null) return null;
  if (proto === undefined) return undefined;
  const desc = safe(() => Object.getOwnPropertyDescriptor(proto, "constructor"), undefined);
  const ctor = desc && "value" in desc ? (desc.value as unknown) : undefined;
  if (typeof ctor === "function") {
    const name = safe(() => (ctor as { name?: unknown }).name, undefined);
    if (typeof name === "string" && name) return name;
  }
  return undefined;
}

function tag(v: object): string {
  return safe(() => Object.prototype.toString.call(v).slice(8, -1), "Object");
}

function fnText(f: unknown): string {
  const src = safe(() => Function.prototype.toString.call(f), "");
  const name = safe(() => (f as { name?: unknown }).name, "");
  const n = typeof name === "string" ? name : "";
  if (/^class[\s{]/.test(src)) return n ? `[class ${n}]` : "[class (anonymous)]";
  return n ? `[Function: ${n}]` : "[Function (anonymous)]";
}

function fmt(v: unknown, depth: number, ctx: Ctx, indent: string): string {
  if (ctx.used >= ctx.o.maxTotal) return ELLIPSIS;
  switch (typeof v) {
    case "string":
      return note(ctx, quote(cut(v, ctx.o.maxString)));
    case "number":
      return note(ctx, Object.is(v, -0) ? "-0" : String(v));
    case "bigint":
      return note(ctx, `${v}n`);
    case "boolean":
    case "undefined":
      return note(ctx, String(v));
    case "symbol":
      return note(ctx, safe(() => v.toString(), "Symbol()"));
    case "function":
      return note(ctx, fnText(v));
  }
  if (v === null) return note(ctx, "null");
  const obj = v as object;
  if (ctx.seen.includes(obj)) return note(ctx, "[Circular]");
  const t = tag(obj);
  const cls = className(obj);

  if (t === "Error" || safe(() => obj instanceof Error, false)) return note(ctx, errorText(obj, ctx.o.pretty, indent));
  if (t === "Date") return note(ctx, safe(() => { const d = obj as Date; return isNaN(d.getTime()) ? "Invalid Date" : d.toISOString(); }, "Date"));
  if (t === "RegExp") return note(ctx, safe(() => RegExp.prototype.toString.call(obj), "/?/"));
  if (t === "Promise") return note(ctx, "Promise {}");
  if (t === "WeakMap" || t === "WeakSet" || t === "WeakRef") return note(ctx, `${t} { <items unknown> }`);
  if (t === "ArrayBuffer" || t === "SharedArrayBuffer") return note(ctx, `${t} { byteLength: ${safe(() => (obj as ArrayBuffer).byteLength, 0)} }`);
  if (t === "Number" || t === "String" || t === "Boolean" || t === "BigInt" || t === "Symbol") {
    const inner = safe(() => (obj as { valueOf(): unknown }).valueOf(), undefined);
    return `[${t}: ${fmt(inner, depth, ctx, indent)}]`;
  }
  const dom = domText(obj);
  if (dom) return note(ctx, dom);

  const isArray = safe(() => Array.isArray(obj), false);
  const typed = !isArray && safe(() => ArrayBuffer.isView(obj), false) && t !== "DataView";
  const isMap = t === "Map";
  const isSet = t === "Set";

  const prefixName = (fallback: string) => (cls === null ? `[${fallback}: null prototype]` : cls && cls !== fallback ? cls : fallback);
  if (depth > ctx.o.depth) {
    if (isArray) return note(ctx, "[Array]");
    return note(ctx, `[${cls || t}]`);
  }

  ctx.seen.push(obj);
  try {
    const items: string[] = [];
    let open: string;
    let close: string;
    let extra = 0;
    const inner = indent + "  ";
    if (isArray || typed) {
      const arr = obj as ArrayLike<unknown>;
      const len = safe(() => arr.length, 0);
      const shown = Math.min(len, ctx.o.maxItems);
      for (let i = 0; i < shown; i++) {
        if (ctx.used >= ctx.o.maxTotal) break;
        if (isArray && !safe(() => Object.prototype.hasOwnProperty.call(arr, i), false)) {
          items.push(note(ctx, "<empty>"));
          continue;
        }
        items.push(propValue(arr, String(i), depth, ctx, inner));
      }
      extra = len - shown;
      const name = isArray ? prefixName("Array") : cls || t;
      open = isArray ? (name === "Array" ? "[" : `${name}(${len}) [`) : `${name}(${len}) [`;
      close = "]";
    } else if (isMap || isSet) {
      const size = safe(() => (obj as Map<unknown, unknown>).size, 0);
      let n = 0;
      const iter = safe(() => (isMap ? Map.prototype.entries.call(obj) : Set.prototype.values.call(obj)) as Iterator<unknown>, undefined);
      if (iter) {
        for (let r = safe(() => iter.next(), { done: true, value: undefined } as IteratorResult<unknown>); !r.done; r = safe(() => iter.next(), { done: true, value: undefined } as IteratorResult<unknown>)) {
          if (n >= ctx.o.maxItems || ctx.used >= ctx.o.maxTotal) break;
          if (isMap) {
            const [k, val] = r.value as [unknown, unknown];
            items.push(`${fmt(k, depth + 1, ctx, inner)} => ${fmt(val, depth + 1, ctx, inner)}`);
          } else {
            items.push(fmt(r.value, depth + 1, ctx, inner));
          }
          n++;
        }
      }
      extra = size - n;
      open = `${prefixName(t)}(${size}) {`;
      close = "}";
    } else {
      const keys = safe(() => Reflect.ownKeys(obj), [] as (string | symbol)[]);
      let n = 0;
      for (const k of keys) {
        const d = safe(() => Object.getOwnPropertyDescriptor(obj, k), undefined);
        if (!d || !d.enumerable) continue;
        if (n >= ctx.o.maxItems || ctx.used >= ctx.o.maxTotal) {
          extra++;
          continue;
        }
        let val: string;
        if (d.get || d.set) val = note(ctx, d.get && d.set ? "[Getter/Setter]" : d.get ? "[Getter]" : "[Setter]");
        else val = fmt(d.value, depth + 1, ctx, inner);
        items.push(`${note(ctx, keyText(k))}: ${val}`);
        n++;
      }
      const name = cls === null ? "[Object: null prototype]" : cls && cls !== "Object" ? cls : t !== "Object" && !cls ? t : "";
      if (items.length === 0 && extra === 0) return note(ctx, name ? `${name} {}` : "{}");
      open = name ? `${name} {` : "{";
      close = "}";
    }
    if (extra > 0) items.push(note(ctx, `... ${extra} more item${extra === 1 ? "" : "s"}`));
    if (items.length === 0) return note(ctx, close === "]" ? (open === "[" ? "[]" : `${open}]`) : `${open}}`);
    const flat = `${open} ${items.join(", ")} ${close}`;
    if (!ctx.o.pretty || (flat.length + indent.length <= LINE_WIDTH && !flat.includes("\n"))) return flat;
    return `${open}\n${items.map((s) => inner + s).join(",\n")}\n${indent}${close}`;
  } finally {
    ctx.seen.pop();
  }
}

function propValue(o: ArrayLike<unknown>, k: string, depth: number, ctx: Ctx, indent: string): string {
  const d = safe(() => Object.getOwnPropertyDescriptor(o, k), undefined);
  if (d && (d.get || d.set)) return note(ctx, "[Getter]");
  return fmt(d ? d.value : undefined, depth + 1, ctx, indent);
}

function errorText(e: object, pretty: boolean, indent: string): string {
  const name = safe(() => String((e as Error).name ?? "Error"), "Error");
  const msg = safe(() => String((e as Error).message ?? ""), "");
  const head = msg ? `${name}: ${msg}` : name;
  if (!pretty) return head;
  const stack = safe(() => (e as Error).stack, undefined);
  if (typeof stack !== "string") return head;
  const lines = stack.split("\n");
  const frames = lines.filter((l) => /^\s*at\s|@/.test(l)).slice(0, 10);
  return [head, ...frames.map((l) => indent + "    " + l.trim())].join("\n");
}

function domText(v: object): string | undefined {
  const n = v as { nodeType?: unknown; tagName?: unknown; id?: unknown; className?: unknown; nodeName?: unknown; textContent?: unknown };
  const nodeType = safe(() => n.nodeType, undefined);
  if (typeof nodeType !== "number" || typeof safe(() => n.nodeName, undefined) !== "string") return undefined;
  if (nodeType === 1) {
    const tagName = String(safe(() => n.tagName, "")).toLowerCase();
    const id = safe(() => n.id, "");
    const cls = safe(() => n.className, "");
    return `<${tagName}${typeof id === "string" && id ? ` id="${id}"` : ""}${typeof cls === "string" && cls ? ` class="${cls}"` : ""}>`;
  }
  if (nodeType === 3) return `#text ${quote(cut(String(safe(() => n.textContent, "")), 60))}`;
  if (nodeType === 9) return "#document";
  return `#${String(safe(() => n.nodeName, "node"))}`;
}

export interface JsonOptions {
  depth: number;
  maxItems: number;
  maxString: number;
  /** Longest JSON text kept; a longer one is dropped (the entry then has no JSON). */
  maxTotal: number;
}

export const JSON_LIMITS: JsonOptions = { depth: 8, maxItems: 200, maxString: 10_000, maxTotal: 100_000 };

/**
 * The console arguments as JSON, for the diff editor and the value graph,
 * with the same rules as the text forms: no getters or methods of the app's
 * are called. Only made when an argument is an object; one argument is the
 * value itself, more are an array. What JSON cannot hold is written as a
 * string in brackets ("[undefined]", "[Function: f]", "[Circular]", "10n"),
 * and objects that are not plain carry their kind in "$type" (class name,
 * Map, Set, error name). Undefined when there is nothing to draw or it is too big.
 */
export function serializeJson(args: readonly unknown[], o: JsonOptions = JSON_LIMITS): string | undefined {
  try {
    if (!args.some((a) => a !== null && typeof a === "object")) return undefined;
    const value = args.length === 1 ? plain(args[0], 0, o, []) : args.map((a) => plain(a, 0, o, []));
    const text = JSON.stringify(value);
    return text.length > o.maxTotal ? undefined : text;
  } catch {
    return undefined;
  }
}

function plain(v: unknown, depth: number, o: JsonOptions, seen: object[]): unknown {
  switch (typeof v) {
    case "string":
      return cut(v, o.maxString);
    case "number":
      return Number.isFinite(v) ? v : String(v);
    case "boolean":
      return v;
    case "bigint":
      return `${v}n`;
    case "undefined":
      return "[undefined]";
    case "symbol":
      return `[${safe(() => v.toString(), "Symbol()")}]`;
    case "function":
      return fnText(v);
  }
  if (v === null) return null;
  const obj = v as object;
  if (seen.includes(obj)) return "[Circular]";
  const t = tag(obj);
  const cls = className(obj);
  if (t === "Error" || safe(() => obj instanceof Error, false)) {
    return {
      $type: safe(() => String((obj as Error).name ?? "Error"), "Error"),
      message: safe(() => String((obj as Error).message ?? ""), ""),
      stack: cut(String(safe(() => (obj as Error).stack, "") ?? ""), 2_000),
    };
  }
  if (t === "Date") return safe(() => { const d = obj as Date; return isNaN(d.getTime()) ? "Invalid Date" : d.toISOString(); }, "Date");
  if (t === "RegExp") return safe(() => RegExp.prototype.toString.call(obj), "/?/");
  if (t === "Promise" || t === "WeakMap" || t === "WeakSet" || t === "WeakRef") return `[${t}]`;
  if (t === "Number" || t === "String" || t === "Boolean") return plain(safe(() => (obj as { valueOf(): unknown }).valueOf(), undefined), depth, o, seen);
  const dom = domText(obj);
  if (dom) return dom;
  const isArray = safe(() => Array.isArray(obj), false);
  const typed = !isArray && safe(() => ArrayBuffer.isView(obj), false) && t !== "DataView";
  if (depth >= o.depth) return isArray ? "[Array]" : `[${cls || t}]`;
  seen.push(obj);
  try {
    if (isArray || typed) {
      const arr = obj as ArrayLike<unknown>;
      const len = safe(() => arr.length, 0);
      const out: unknown[] = [];
      for (let i = 0; i < Math.min(len, o.maxItems); i++) {
        const d = safe(() => Object.getOwnPropertyDescriptor(arr, i), undefined);
        out.push(!d ? "[empty]" : d.get || d.set ? "[Getter]" : plain(d.value, depth + 1, o, seen));
      }
      if (len > o.maxItems) out.push(`… ${len - o.maxItems} more items`);
      return typed ? { $type: `${cls || t}(${len})`, values: out } : out;
    }
    if (t === "Map" || t === "Set") {
      const out: Record<string, unknown> = { $type: `${t}(${safe(() => (obj as Map<unknown, unknown>).size, 0)})` };
      const values: unknown[] = [];
      let n = 0;
      const iter = safe(() => (t === "Map" ? Map.prototype.entries.call(obj) : Set.prototype.values.call(obj)) as Iterator<unknown>, undefined);
      for (let r = iter && safe(() => iter.next(), undefined); r && !r.done; r = safe(() => iter!.next(), undefined)) {
        if (n++ >= o.maxItems) break;
        if (t === "Map") {
          const [k, val] = r.value as [unknown, unknown];
          out[typeof k === "string" ? k : serialize(k, PREVIEW)] = plain(val, depth + 1, o, seen);
        } else {
          values.push(plain(r.value, depth + 1, o, seen));
        }
      }
      if (t === "Set") out.values = values;
      return out;
    }
    const out: Record<string, unknown> = {};
    const name = cls === null ? undefined : cls && cls !== "Object" ? cls : t !== "Object" && !cls ? t : undefined;
    if (name) out.$type = name;
    let n = 0;
    let extra = 0;
    for (const k of safe(() => Reflect.ownKeys(obj), [] as (string | symbol)[])) {
      const d = safe(() => Object.getOwnPropertyDescriptor(obj, k), undefined);
      if (!d || !d.enumerable) continue;
      if (n >= o.maxItems) {
        extra++;
        continue;
      }
      out[typeof k === "symbol" ? `[${String(k)}]` : k] = d.get || d.set ? (d.get && d.set ? "[Getter/Setter]" : d.get ? "[Getter]" : "[Setter]") : plain(d.value, depth + 1, o, seen);
      n++;
    }
    if (extra) out["…"] = `${extra} more keys`;
    return out;
  } finally {
    seen.pop();
  }
}
