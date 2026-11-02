// Logging libraries: pino, winston, consola and tslog. Their calls are
// recorded on the app line that called them, with the library's level. Their
// output, levels and transports are never changed: each one is met at a
// point every call passes through synchronously, and the call goes on as it was.
//  - pino: its internal write method, which gets the level, the merged object
//    and the message (only levels that are on reach it).
//  - winston: Logger's write, which every level method and log() end in.
//    Levels no transport takes are left out.
//  - consola: what it writes to process.stdout and process.stderr while
//    consola is on the stack (it is an ES module, so there is no earlier point).
//  - tslog: its pretty output goes through console.log, which the hook already
//    sees; the console wrapper hands it here to name the library and the level.
//    Its JSON output is written to process.stdout later, in batches, off the
//    caller's stack: a JSON line is placed by the position tslog puts in it
//    (when its stack capture is on), and left out when it has none.
import { formatArgs, FULL, PREVIEW, serializeJson } from "../shared/serialize";
import type { Level, Logger } from "../shared/types";

/** One library call: the stack where the app made it, and what to show. */
export interface LoggerCall {
  logger: Logger;
  level: Level;
  stack: string | undefined;
  preview: string;
  full: string;
  json?: string;
}

// Colour codes (ESC [ ... letter) and terminal links (ESC ] ... BEL).
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]|${ESC}\\][^${BEL}]*${BEL}`, "g");

/** Colour codes out, for the text shown in the editor. What the app prints keeps them. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** pino's numeric levels: 10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal. */
export function pinoLevel(n: unknown): Level {
  const v = Number(n);
  if (!Number.isFinite(v)) return "log";
  return v >= 50 ? "error" : v >= 40 ? "warn" : v >= 30 ? "info" : "debug";
}

/** winston's npm and syslog levels. */
export function winstonLevel(name: unknown): Level {
  const l = String(name ?? "").toLowerCase();
  if (/^(error|emerg|alert|crit|fatal)$/.test(l)) return "error";
  if (/^warn(ing)?$/.test(l)) return "warn";
  if (/^(info|http|notice|verbose)$/.test(l)) return "info";
  if (/^(debug|silly|trace)$/.test(l)) return "debug";
  return "log";
}

/**
 * One line consola wrote, colour codes already out: its level from the
 * badge, the icon or the [type] in front, and the message without them.
 */
export function consolaLine(text: string): { level: Level; message: string } {
  let t = text.replace(/^\s+|\s+$/g, "");
  // Badges: " ERROR " or " WARN " (fancy reporter), [error] (basic reporter).
  const badge = /^(?:\[(\w+)\]|(ERROR|WARN|FATAL|FAIL|INFO|SUCCESS|READY|START|DEBUG|TRACE|LOG|BOX)\b)\s*/.exec(t);
  let type = "";
  if (badge) {
    type = (badge[1] ?? badge[2]).toLowerCase();
    t = t.slice(badge[0].length);
  } else {
    const icons: Record<string, string> = { "✖": "error", "×": "error", "⚠": "warn", "‼": "warn", "ℹ": "info", "✔": "success", "√": "success", "⚙": "debug", "→": "trace", "◐": "start" };
    const first = [...t][0] ?? "";
    if (icons[first]) {
      type = icons[first];
      t = t.slice(first.length).trimStart();
    }
  }
  // The fancy reporter puts the time at the far right of wide terminals.
  t = t.replace(/\s{3,}(\[?[\w:.\s]*\d{1,2}:\d{2}:\d{2}[\w\s.]*\]?)$/, "");
  const level: Level = /^(error|fatal|fail)$/.test(type) ? "error" : type === "warn" ? "warn" : /^(debug|trace)$/.test(type) ? "debug" : type && type !== "log" ? "info" : "log";
  return { level, message: t };
}

/** tslog's pretty line: the level name after the date, the rest is the message. */
export function tslogLine(text: string): { level: Level; message: string } {
  const t = text.trim();
  const m = /^(?:[\d.:\- ]+\s+)?(SILLY|TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\t+(.*)$/s.exec(t) ?? /^(?:[\d.:\- ]+\s+)?(SILLY|TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s+(.*)$/s.exec(t);
  if (!m) return { level: "log", message: t };
  const name = m[1];
  const level: Level = name === "ERROR" || name === "FATAL" ? "error" : name === "WARN" ? "warn" : name === "INFO" ? "info" : "debug";
  // The default template puts "file:line" and the logger's name before the message, each ending in a tab.
  let message = m[2];
  const parts = message.split("\t");
  if (parts.length > 1 && /^\S+:\d+$/.test(parts[0])) parts.shift();
  if (parts.length > 1 && /^[^\s:]+$/.test(parts[0])) parts.shift();
  message = parts.join("\t");
  return { level, message };
}

function stackHere(fn: unknown): string | undefined {
  const holder: { stack?: string } = {};
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 30;
  Error.captureStackTrace(holder, fn as () => void);
  Error.stackTraceLimit = limit;
  return holder.stack;
}

/** A message and the fields that came with it, the way the library's call read. */
function describe(message: unknown, fields: Record<string, unknown> | undefined): { preview: string; full: string; json?: string } {
  const args: unknown[] = [];
  if (message !== undefined && message !== null && message !== "") args.push(message);
  if (fields && Object.keys(fields).length) args.push(fields);
  if (!args.length) args.push("");
  return { preview: formatArgs(args, PREVIEW), full: formatArgs(args, FULL), json: fields && Object.keys(fields).length ? serializeJson([fields]) : undefined };
}

/** Own enumerable string keys of `o` except `skip`, without calling getters. */
function fieldsOf(o: unknown, skip: readonly string[]): Record<string, unknown> | undefined {
  if (!o || typeof o !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) {
    if (skip.includes(k)) continue;
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (d && "value" in d) out[k] = d.value;
  }
  return out;
}

/** pino's prototype (lib/proto.js exports a function that makes an object with it): wraps its write, once. */
export function patchPino(exp: unknown, on: (c: LoggerCall) => void, off: () => boolean, quiet: <T>(f: () => T) => T): boolean {
  // The function only does Object.create(prototype): calling it is how the prototype is reached.
  const made = typeof exp === "function" && exp.length === 0 ? (exp as () => unknown)() : exp;
  const proto = (typeof exp === "function" ? Object.getPrototypeOf(made) : made) as Record<string | symbol, unknown> | null;
  if (!proto || typeof proto !== "object") return false;
  const sym = Object.getOwnPropertySymbols(proto).find((s) => s.description === "pino.write");
  const write = sym && proto[sym];
  if (!sym || typeof write !== "function" || (write as { __patched?: boolean }).__patched) return false;
  const messageKey = Object.getOwnPropertySymbols(proto).find((s) => s.description === "pino.messageKey");
  const name = "__inlineLogs_pinoWrite";
  const wrapped = {
    [name](this: Record<string | symbol, unknown>, obj: unknown, msg: unknown, num: unknown) {
      if (!off()) {
        try {
          const key = messageKey && typeof this[messageKey] === "string" ? (this[messageKey] as string) : "msg";
          const isError = obj instanceof Error;
          const fields = isError ? undefined : fieldsOf(obj, [key]);
          const message = msg !== undefined ? msg : obj && typeof obj === "object" && !isError ? (obj as Record<string, unknown>)[key] : undefined;
          const shown = isError ? { preview: formatArgs(msg !== undefined ? [msg, obj] : [obj], PREVIEW), full: formatArgs(msg !== undefined ? [msg, obj] : [obj], FULL) } : describe(message, fields);
          on({ logger: "pino", level: pinoLevel(num), stack: stackHere(wrapped), ...shown });
        } catch {
          // pino goes on as it is
        }
      }
      return quiet(() => (write as (...a: unknown[]) => unknown).call(this, obj, msg, num));
    },
  }[name];
  Object.defineProperty(wrapped, "__patched", { value: true });
  proto[sym] = wrapped;
  return true;
}

const LEVEL = Symbol.for("level");
const SPLAT = Symbol.for("splat");

/** winston's Logger class (lib/winston/logger.js): its write, which every log call ends in. */
export function patchWinston(Logger: { prototype: Record<string, unknown> }, on: (c: LoggerCall) => void, off: () => boolean, quiet: <T>(f: () => T) => T): boolean {
  const proto = Logger?.prototype;
  if (!proto || Object.prototype.hasOwnProperty.call(proto, "write") || typeof proto.write !== "function") return false;
  const write = proto.write as (...a: unknown[]) => unknown;
  const name = "__inlineLogs_winstonWrite";
  const wrapped = {
    [name](this: { isLevelEnabled?: (l: string) => boolean }, ...args: unknown[]) {
      const info = args[0] as Record<string | symbol, unknown> | undefined;
      if (!off() && info && typeof info === "object") {
        try {
          const lvl = String(info[LEVEL] ?? info.level ?? "");
          if (lvl && (typeof this.isLevelEnabled !== "function" || this.isLevelEnabled(lvl))) {
            const splat = Array.isArray(info[SPLAT]) ? (info[SPLAT] as unknown[]) : [];
            const message = info.message;
            const tokens = typeof message === "string" && /%[sdifjoO%]/.test(message) && splat.length;
            const fields = fieldsOf(info, ["level", "message"]);
            const shown = tokens ? { preview: formatArgs([message, ...splat], PREVIEW), full: formatArgs([message, ...splat], FULL) } : describe(message, fields);
            on({ logger: "winston", level: winstonLevel(lvl), stack: stackHere(wrapped), ...shown });
          }
        } catch {
          // winston goes on as it is
        }
      }
      return quiet(() => write.apply(this, args));
    },
  }[name];
  try {
    Object.defineProperty(wrapped, "name", { value: "write" });
  } catch {
    // cosmetic only
  }
  Object.defineProperty(proto, "write", { value: wrapped, writable: true, configurable: true, enumerable: false });
  return true;
}

const LIB_PATH = (name: string) => new RegExp(`[\\\\/]node_modules[\\\\/]${name}[\\\\/]`);
const CONSOLA = LIB_PATH("consola");

/** True when a file on the stack above here is inside the given package. Cheap: no stack text is built. */
function onStack(re: RegExp, fn: unknown): boolean {
  const prepare = Error.prepareStackTrace;
  const limit = Error.stackTraceLimit;
  try {
    Error.prepareStackTrace = (_e, sites) => sites;
    Error.stackTraceLimit = 25;
    const holder: { stack?: unknown } = {};
    Error.captureStackTrace(holder, fn as () => void);
    const sites = holder.stack as { getFileName?: () => string | null | undefined }[] | undefined;
    return Array.isArray(sites) && sites.some((s) => re.test(s.getFileName?.() ?? ""));
  } catch {
    return false;
  } finally {
    Error.prepareStackTrace = prepare;
    Error.stackTraceLimit = limit;
  }
}

/** consola: process.stdout and process.stderr writes made while consola is on the stack. tslog's JSON lines too. */
export function watchConsola(on: (c: LoggerCall) => void, off: () => boolean, skip: () => boolean): void {
  for (const stream of [process.stdout, process.stderr] as unknown as Record<string, unknown>[]) {
    const write = stream?.write;
    if (typeof write !== "function") continue;
    const name = "__inlineLogs_streamWrite";
    const wrapped = {
      [name](this: unknown, ...args: unknown[]) {
        if (!off() && !skip()) {
          try {
            const chunk = args[0];
            if ((typeof chunk === "string" || chunk instanceof Uint8Array) && onStack(CONSOLA, wrapped)) {
              const text = stripAnsi(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
              if (text.trim()) {
                const { level, message } = consolaLine(text);
                on({ logger: "consola", level, stack: stackHere(wrapped), preview: message.replace(/\s*\n\s*/g, " ").slice(0, PREVIEW.maxTotal), full: message.slice(0, FULL.maxTotal) });
              }
            } else if ((typeof chunk === "string" || chunk instanceof Uint8Array) && onStack(TSLOG, wrapped)) {
              for (const c of tslogJson(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))) on(c);
            }
          } catch {
            // the write goes on as it is
          }
        }
        return (write as (...a: unknown[]) => unknown).apply(this, args);
      },
    }[name];
    try {
      Object.defineProperty(wrapped, "name", { value: (write as { name?: string }).name || "write" });
    } catch {
      // cosmetic only
    }
    stream.write = wrapped;
  }
}

/** tslog prints its pretty lines with console.log: a console call with tslog on its stack is one of its. */
export const TSLOG = LIB_PATH("tslog");

/**
 * tslog's JSON lines (one per log, written in batches), each placed by the
 * position tslog recorded in it: `_logMeta.path` (tslog 5) or `_meta.path`
 * (tslog 4), there when its stack capture is on. Lines with no position are
 * left out: nothing else says which line made them.
 */
export function tslogJson(text: string): LoggerCall[] {
  const out: LoggerCall[] = [];
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    if (!t.startsWith("{") || !/"_(logMeta|meta)"/.test(t)) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    const meta = (o._logMeta ?? o._meta) as { logLevelName?: unknown; path?: { fullFilePath?: unknown; fileLine?: unknown; fileColumn?: unknown } } | undefined;
    const where = meta?.path;
    if (!where || typeof where.fullFilePath !== "string") continue;
    // "file:///app/a.ts:3:5" (or a plain path), with the line and column at the end.
    const file = where.fullFilePath.replace(/:\d+(:\d+)?$/, "");
    const line = Number(where.fileLine);
    if (!file || !Number.isInteger(line) || line < 1) continue;
    const col = Number(where.fileColumn) || 1;
    const name = String(meta.logLevelName ?? o.level ?? "").toUpperCase();
    const level: Level = name === "ERROR" || name === "FATAL" ? "error" : name === "WARN" ? "warn" : name === "INFO" ? "info" : name ? "debug" : "log";
    // tslog 5 has "message", tslog 4 numbered keys for each argument.
    const message = typeof o.message === "string" ? o.message : typeof o["0"] === "string" ? o["0"] : undefined;
    const fields = fieldsOf(o, ["message", "0", "level", "levelId", "time", "_logMeta", "_meta"]);
    out.push({ logger: "tslog", level, stack: `    at tslog (${file}:${line}:${col})`, ...describe(message, fields) });
  }
  return out;
}

export interface ModuleHooks {
  pino?: (exp: unknown) => void;
  winston?: (Logger: { prototype: Record<string, unknown> }) => void;
  /** The ws package's WebSocket class: gets the module, to put a watched class in its exports. */
  ws?: (exp: unknown, mod: Record<string, unknown>) => void;
  /** webpack's Compiler and MultiCompiler classes. */
  webpack?: (Compiler: { prototype: Record<string, unknown> }) => void;
}

const WATCHED: [RegExp, keyof ModuleHooks][] = [
  [/[\\/]node_modules[\\/]pino[\\/]lib[\\/]proto\.js$/, "pino"],
  [/[\\/]node_modules[\\/]winston[\\/]lib[\\/]winston[\\/]logger\.js$/, "winston"],
  [/[\\/]node_modules[\\/]ws[\\/]lib[\\/]websocket\.js$/, "ws"],
  [/[\\/]node_modules[\\/]webpack[\\/]lib[\\/](Multi)?Compiler\.js$/, "webpack"],
];

/**
 * Meets the library files above as CommonJS loads them (also when the app
 * imports them as an ES module). Nothing runs on the stack while
 * a module's code runs, so stack traces the app prints stay the same: Node's
 * module cache is watched for the new module, and that one module's exports
 * are met when its code sets them, then left as a plain property again.
 */
export function watchModules(hooks: ModuleHooks): void {
  // The module object itself (not an import's copy of it), to reach its cache.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Module = require("node:module") as { _cache?: Record<string, unknown> };
  const real = Module._cache;
  if (!real || typeof real !== "object") return;
  Module._cache = new Proxy(real, {
    set(target, key, value) {
      const ok = Reflect.set(target, key, value);
      try {
        if (typeof key === "string" && value && typeof value === "object") {
          for (const [re, name] of WATCHED) if (hooks[name] && re.test(key)) onExports(value as { exports?: unknown }, hooks[name] as (exp: unknown, mod: Record<string, unknown>) => void);
        }
      } catch {
        // the module is the app's as it is
      }
      return ok;
    },
  });
}

function onExports(mod: { exports?: unknown }, then: (exp: unknown, mod: Record<string, unknown>) => void): void {
  let current = mod.exports;
  Object.defineProperty(mod, "exports", {
    configurable: true,
    enumerable: true,
    get: () => current,
    set(v: unknown) {
      current = v;
      Object.defineProperty(mod, "exports", { value: v, writable: true, configurable: true, enumerable: true });
      try {
        then(v, mod as Record<string, unknown>);
      } catch {
        // the library works as it is
      }
    },
  });
}
