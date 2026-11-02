// Code coverage from V8's own reports, the files Node writes to
// NODE_V8_COVERAGE and Deno to DENO_COVERAGE_DIR. Each report lists, per
// script, the ranges of code that ran and how often (Deno writes one file
// per script). Here they become hit counts per source line: through
// the script's source map when Node kept one (tsx, ts-node, compiled code
// with source maps), else against the file on disk. Counts add up across
// reports and runs until cleared. No VS Code imports, so it is unit tested
// on its own.
import * as fs from "node:fs";
import * as path from "node:path";
import { decodeMappings, type RawMap } from "./hook/sourcemap";
import { fileUrlToPath, isLibrary } from "./shared/stack";

export interface V8Range {
  startOffset: number;
  endOffset: number;
  count: number;
}
export interface V8Function {
  functionName?: string;
  ranges: V8Range[];
  isBlockCoverage?: boolean;
}
export interface V8Script {
  url: string;
  functions: V8Function[];
}
export interface V8Report {
  result?: V8Script[];
  /** Deno's form: one script per file, at the top level. */
  url?: string;
  functions?: V8Function[];
  "source-map-cache"?: Record<string, { lineLengths?: number[]; data?: RawMap | null; url?: string | null }>;
}

/** file -> line (1-based) -> times it ran; 0 means it is code that never ran. */
export type LineHits = Map<string, Map<number, number>>;

/** Hit counts per offset of the code V8 ran: inner ranges (blocks) win over the ranges around them. */
export function paint(length: number, functions: readonly V8Function[]): Float64Array {
  const counts = new Float64Array(length).fill(-1);
  const ranges = functions.flatMap((f) => f.ranges ?? []).sort((a, b) => b.endOffset - b.startOffset - (a.endOffset - a.startOffset));
  for (const r of ranges) counts.fill(r.count, Math.max(0, r.startOffset), Math.min(length, r.endOffset));
  return counts;
}

/** Lines of a file V8 ran as it is on disk. Blank and comment-only lines are left out. */
export function linesFromSource(source: string, functions: readonly V8Function[]): Map<number, number> {
  const counts = paint(source.length, functions);
  const out = new Map<number, number>();
  let start = 0;
  const lines = source.split("\n");
  lines.forEach((text, i) => {
    const t = text.trim();
    if (t && !/^(\/\/|\/\*|\*)/.test(t)) {
      let best = -1;
      for (let o = start; o < start + text.length; o++) if (text.charCodeAt(o - start) > 32 && counts[o] > best) best = counts[o];
      if (best >= 0) out.set(i + 1, best);
    }
    start += text.length + 1;
  });
  return out;
}

/**
 * Lines of the original sources, through a source map of the code V8 ran.
 * `lineLengths` are the generated code's line lengths (Node keeps them with
 * the map). A source line ran when any code mapped to it ran.
 */
export function linesThroughMap(lineLengths: readonly number[], map: RawMap, functions: readonly V8Function[], resolve: (source: string) => string | undefined): LineHits {
  const starts: number[] = [];
  let total = 0;
  for (const len of lineLengths) {
    starts.push(total);
    total += len + 1;
  }
  const counts = paint(total, functions);
  const out: LineHits = new Map();
  const files = map.sources.map((s) => resolve(s));
  decodeMappings(map.mappings).forEach((segs, g) => {
    if (g >= starts.length) return;
    for (const [genCol, src, srcLine] of segs) {
      const file = files[src];
      if (!file) continue;
      const c = counts[starts[g] + genCol];
      if (c === undefined || c < 0) continue;
      let lines = out.get(file);
      if (!lines) out.set(file, (lines = new Map()));
      lines.set(srcLine + 1, Math.max(lines.get(srcLine + 1) ?? 0, c));
    }
  });
  return out;
}

/** Scripts worth showing: the app's own files, not Node's, not node_modules, not ours. */
export function isAppScript(url: string, skip: (file: string) => boolean): string | undefined {
  if (!url || url.startsWith("node:") || url.startsWith("internal/") || !/^(file:\/\/|\/|[A-Za-z]:[\\/])/.test(url)) return undefined;
  const file = fileUrlToPath(url);
  if (isLibrary(file) || skip(file)) return undefined;
  return file;
}

/**
 * All of one report's line hits. Files that are gone, or that changed since
 * they ran, are left out. In Deno's one-script form only JavaScript files
 * count: TypeScript and JSX ran as code Deno made from them, with no map in
 * the report, so their offsets do not fit the file.
 */
export function reportLines(report: V8Report, skip: (file: string) => boolean = () => false, read: (file: string) => string | undefined = readText): LineHits {
  if (!report.result && typeof report.url === "string" && Array.isArray(report.functions)) {
    if (!/\.(c|m)?js$/i.test(report.url.replace(/[?#].*$/, ""))) return new Map();
    return reportLines({ result: [{ url: report.url, functions: report.functions }] }, skip, read);
  }
  const out: LineHits = new Map();
  const merge = (file: string, lines: Map<number, number>) => {
    if (!lines.size) return;
    let m = out.get(file);
    if (!m) out.set(file, (m = new Map()));
    for (const [l, c] of lines) m.set(l, (m.get(l) ?? 0) + c);
  };
  const maps = report["source-map-cache"] ?? {};
  for (const script of report.result ?? []) {
    const file = isAppScript(script.url, skip);
    if (!file) continue;
    const cached = maps[script.url];
    if (cached?.data && cached.lineLengths && Array.isArray(cached.data.sources)) {
      const base = path.dirname(file);
      const resolve = (s: string) => {
        const p = s.startsWith("file://") ? fileUrlToPath(s) : path.isAbsolute(s) ? s : path.resolve(base, cached.data!.sourceRoot ?? "", s);
        return isLibrary(p) || skip(p) ? undefined : path.normalize(p);
      };
      for (const [f, lines] of linesThroughMap(cached.lineLengths, cached.data, script.functions, resolve)) merge(f, lines);
      continue;
    }
    const source = read(file);
    if (source === undefined) continue;
    // A file that differs from what V8 ran (edited since, or transformed with no map) would land on the wrong lines.
    const end = Math.max(0, ...script.functions.flatMap((f) => f.ranges.map((r) => r.endOffset)));
    if (end > source.length + 1) continue;
    merge(path.normalize(file), linesFromSource(source, script.functions));
  }
  return out;
}

function readText(file: string): string | undefined {
  try {
    const st = fs.statSync(file);
    if (st.size > 5_000_000) return undefined;
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Coverage kept across runs until cleared. Keys go through `key` (case rules of the platform). */
export class CoverageStore {
  private files = new Map<string, { file: string; lines: Map<number, number> }>();

  constructor(private readonly key: (file: string) => string) {}

  add(hits: LineHits): Set<string> {
    const changed = new Set<string>();
    for (const [file, lines] of hits) {
      const k = this.key(file);
      let f = this.files.get(k);
      if (!f) this.files.set(k, (f = { file, lines: new Map() }));
      for (const [l, c] of lines) f.lines.set(l, (f.lines.get(l) ?? 0) + c);
      changed.add(k);
    }
    return changed;
  }

  lines(file: string): Map<number, number> {
    return this.files.get(this.key(file))?.lines ?? new Map();
  }

  get size(): number {
    return this.files.size;
  }

  summary(): { file: string; covered: number; total: number }[] {
    return [...this.files.values()].map((f) => ({ file: f.file, covered: [...f.lines.values()].filter((c) => c > 0).length, total: f.lines.size }));
  }

  clear(): void {
    this.files.clear();
  }
}

/**
 * Reads the reports Node wrote to `dir` and removes them. A file that does
 * not parse yet (still being written) is read again next time, unless it is old.
 */
export function readReports(dir: string, onHits: (hits: LineHits) => void, skip?: (file: string) => boolean): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try {
      const text = fs.readFileSync(file, "utf8");
      let report: V8Report;
      try {
        report = JSON.parse(text) as V8Report;
      } catch {
        if (Date.now() - fs.statSync(file).mtimeMs > 10_000) fs.rmSync(file, { force: true });
        continue;
      }
      fs.rmSync(file, { force: true });
      const hits = reportLines(report, skip);
      if (hits.size) onHits(hits);
    } catch {
      // busy or gone: next time
    }
  }
}
