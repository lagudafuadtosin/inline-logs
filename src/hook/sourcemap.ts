// A minimal source map v3 reader: enough to turn a generated line:column
// into the original source and line. Used for browser stack frames, which
// browsers report against the code the dev server sent, not the source file,
// and for Node frames in bundled server code (Next.js, webpack).

export interface RawMap {
  version?: number;
  sources: string[];
  sourceRoot?: string;
  sourcesContent?: (string | null)[];
  mappings: string;
}

/** An index map (Turbopack writes these): each section is a map for the lines from its offset on. */
export interface IndexMap {
  version?: number;
  sections: { offset: { line: number; column: number }; map: RawMap | IndexMap }[];
}

export interface Original {
  source: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  col: number;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

/** Segments per generated line: [genCol, srcIndex, srcLine, srcCol] (all 0-based). */
export type Decoded = number[][][];

export function decodeMappings(mappings: string): Decoded {
  const lines: Decoded = [];
  let srcIndex = 0;
  let srcLine = 0;
  let srcCol = 0;
  for (const lineStr of mappings.split(";")) {
    const segs: number[][] = [];
    let genCol = 0;
    if (lineStr) {
      for (const segStr of lineStr.split(",")) {
        if (!segStr) continue;
        const vals = vlq(segStr);
        genCol += vals[0];
        if (vals.length >= 4) {
          srcIndex += vals[1];
          srcLine += vals[2];
          srcCol += vals[3];
          segs.push([genCol, srcIndex, srcLine, srcCol]);
        }
      }
    }
    segs.sort((a, b) => a[0] - b[0]);
    lines.push(segs);
  }
  return lines;
}

function vlq(s: string): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (const ch of s) {
    const digit = B64_INDEX.get(ch);
    if (digit === undefined) throw new Error("bad mapping");
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
    } else {
      const neg = value & 1;
      value >>>= 1;
      out.push(neg ? -value : value);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

/** Maps a 1-based generated position. Falls back to the nearest earlier segment on the line, then the first one. */
export function originalFor(map: RawMap, decoded: Decoded, line: number, col: number): Original | undefined {
  const segs = decoded[line - 1];
  if (!segs || segs.length === 0) return undefined;
  let best = segs[0];
  for (const s of segs) {
    if (s[0] <= col - 1) best = s;
    else break;
  }
  const src = map.sources[best[1]];
  if (src === undefined) return undefined;
  const source = map.sourceRoot ? joinRoot(map.sourceRoot, src) : src;
  return { source, line: best[2] + 1, col: best[3] + 1 };
}

function joinRoot(root: string, src: string): string {
  if (/^([a-z]+:|\/)/i.test(src)) return src;
  return root.endsWith("/") ? root + src : `${root}/${src}`;
}

/** Reads an inline data: source map from the end of generated code. */
export function inlineMap(code: string): RawMap | undefined {
  const map = inlineAnyMap(code);
  return map && "mappings" in map ? map : undefined;
}

/** Like inlineMap, and also returns an index map. */
export function inlineAnyMap(code: string): RawMap | IndexMap | undefined {
  const m = /\/\/[#@] sourceMappingURL=data:application\/json(?:;charset=[\w-]+)?;base64,([A-Za-z0-9+/=]+)\s*$/.exec(code.slice(-2_000_000));
  return m ? parseMap(Buffer.from(m[1], "base64").toString("utf8")) : undefined;
}

/** A source map from JSON text: a plain map or an index map with sections. */
export function parseMap(text: string): RawMap | IndexMap | undefined {
  try {
    const json = JSON.parse(text) as Partial<RawMap & IndexMap>;
    if (Array.isArray(json.sections)) return json as IndexMap;
    if (!Array.isArray(json.sources) || typeof json.mappings !== "string") return undefined;
    return json as RawMap;
  } catch {
    return undefined;
  }
}

/** The map file named at the end of generated code (`//# sourceMappingURL=x.js.map`), not an inline one. */
export function externalMapUrl(code: string): string | undefined {
  const m = /\/\/[#@] sourceMappingURL=([^\s'"]+)\s*$/.exec(code.slice(-4_000));
  return m && !m[1].startsWith("data:") ? m[1] : undefined;
}

export interface Mapper {
  original(line: number, col: number): Original | undefined;
}

/** Wraps a plain or index map. Mappings are decoded once, on first use, per section. */
export function makeMapper(map: RawMap | IndexMap): Mapper {
  if ("sections" in map) {
    const sections = map.sections
      .filter((s) => s && s.offset && s.map)
      .map((s) => ({ line: Number(s.offset.line) || 0, col: Number(s.offset.column) || 0, mapper: makeMapper(s.map) }))
      .sort((a, b) => a.line - b.line || a.col - b.col);
    return {
      original(line, col) {
        // The last section that starts at or before this position (offsets are 0-based).
        let hit: (typeof sections)[number] | undefined;
        for (const s of sections) {
          if (s.line < line - 1 || (s.line === line - 1 && s.col <= col - 1)) hit = s;
          else break;
        }
        if (!hit) return undefined;
        const l = line - hit.line;
        return hit.mapper.original(l, l === 1 ? col - hit.col : col);
      },
    };
  }
  let decoded: Decoded | undefined;
  return {
    original(line, col) {
      try {
        decoded ??= decodeMappings(map.mappings);
      } catch {
        decoded = [];
      }
      return originalFor(map, decoded, line, col);
    },
  };
}

/**
 * webpack's eval-source-map (Next.js uses it in dev): each module is an
 * eval() string that ends with its own map and a sourceURL, written with JS
 * string escapes (a line break is a backslash and an n). Returns
 * sourceURL -> base64 map.
 */
export function evalMaps(code: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /sourceMappingURL=data:application\/json;charset=utf-8;base64,([A-Za-z0-9+/=]+)\\n\/\/# sourceURL=([^\\"'\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) out.set(m[2], m[1]);
  return out;
}

/**
 * webpack's plain "eval" devtool (its development default) has no map. Each
 * module is the source with a few lines webpack adds on top, so lines are
 * found by lining the source up with it (see lineInSource). Returns
 * sourceURL -> the eval'd code.
 */
export function evalSources(code: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /eval\(("(?:[^"\\]|\\.)*")\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m[1].includes("sourceMappingURL=data:")) continue;
    // webpack 5 ends the string with the sourceURL, then line breaks and the module's closing brace.
    const url = /\\n\/\/# sourceURL=([^\\"'\s]+)(?:\\n)*\}?"$/.exec(m[1]);
    if (!url) continue;
    try {
      out.set(url[1], JSON.parse(m[1]) as string);
    } catch {
      // not a plain JSON string
    }
  }
  return out;
}

/** The source line for a line of eval'd module code, or undefined when the two cannot be lined up. */
export function lineInSource(evalCode: string, source: string, line: number): number | undefined {
  const gen = evalCode.split(/\r?\n/);
  const src = source.split(/\r?\n/);
  // webpack adds lines on top and keeps the rest line for line: it empties
  // import lines, drops "export " and renames imported names where they are
  // used. So the first source lines vote for the distance, and the distance
  // most of them agree on (two at least, when there are two) wins.
  const firsts = src
    .map((t, i) => [t.trim().replace(/^export\s+(default\s+)?/, ""), i] as const)
    .filter(([t]) => t.length > 0 && !/^import[\s{*"']/.test(t))
    .slice(0, 10);
  if (firsts.length === 0) return undefined;
  const votes = new Map<number, number>();
  for (const [t, i] of firsts) {
    const at = gen.findIndex((g) => g.trim().endsWith(t));
    if (at >= 0) votes.set(at - i, (votes.get(at - i) ?? 0) + 1);
  }
  const [offset, count] = [...votes].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
  if (count < Math.min(2, firsts.length)) return undefined;
  const l = line - offset;
  return l >= 1 && l <= src.length ? l : undefined;
}
