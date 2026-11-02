// Holds what the hook sent: every entry for the viewer, and per file and line
// the latest value and a hit count for the editor. No VS Code imports, so it
// is unit tested on its own.
import type { Entry } from "./shared/types";

export interface LineInfo {
  latest: Entry;
  count: number;
  /** Line as it is now (1-based); starts at entry.line and moves with edits. */
  line: number;
  /** The newest runs of the line, oldest first, at most RECENT_RUNS (for the hover). */
  recent: Entry[];
  /**
   * The newest entry of each call on the line, left to right (by column), at
   * most LINE_SITES: a request and the log in its callback, say. An error
   * stays in its place until a newer error, as on the line itself.
   */
  sites: Entry[];
}

/** Runs of one line kept for its hover. The count keeps going past it. */
export const RECENT_RUNS = 10;
/** Calls on one line shown side by side. */
export const LINE_SITES = 3;

/** One change from a text document event, in 0-based positions before the change. */
export interface LineChange {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  /** Line breaks in the inserted text. */
  newLines: number;
}

export const MAX_ENTRIES = 10_000;

export function fileKey(file: string, caseInsensitive: boolean): string {
  let k = file.replace(/\\/g, "/");
  if (/^[a-z]:\//i.test(k)) k = k[0].toUpperCase() + k.slice(1);
  return caseInsensitive ? k.toLowerCase() : k;
}

export class Store {
  readonly all: Entry[] = [];
  private seen = new Set<string>();
  private byFile = new Map<string, Map<number, LineInfo>>();

  constructor(private readonly caseInsensitive: boolean) {}

  key(file: string): string {
    return fileKey(file, this.caseInsensitive);
  }

  get size(): number {
    return this.all.length;
  }

  has(id: string): boolean {
    return this.seen.has(id);
  }

  /** Adds entries; returns the file keys that changed. Duplicates (same id) are ignored. */
  add(entries: readonly Entry[]): Set<string> {
    const changed = new Set<string>();
    for (const e of entries) {
      if (this.seen.has(e.id)) continue;
      this.seen.add(e.id);
      this.all.push(e);
      const k = this.key(e.file);
      let lines = this.byFile.get(k);
      if (!lines) this.byFile.set(k, (lines = new Map()));
      const info = lines.get(e.line);
      // A logged value replaces the last one on its line; an error stays
      // until a newer error on the same line, so a log after it does not hide it.
      if (info) {
        info.count++;
        if (!(info.latest.kind === "error" && e.kind !== "error")) info.latest = e;
        info.recent.push(e);
        if (info.recent.length > RECENT_RUNS) info.recent.shift();
        const at = info.sites.findIndex((s) => s.col === e.col);
        if (at >= 0) {
          if (!(info.sites[at].kind === "error" && e.kind !== "error")) info.sites[at] = e;
        } else if (info.sites.length < LINE_SITES) {
          info.sites.push(e);
          info.sites.sort((a, b) => a.col - b.col);
        }
      } else {
        lines.set(e.line, { latest: e, count: 1, line: e.line, recent: [e], sites: [e] });
      }
      changed.add(k);
    }
    if (this.all.length > MAX_ENTRIES) {
      const drop = this.all.splice(0, this.all.length - MAX_ENTRIES);
      for (const d of drop) this.seen.delete(d.id);
    }
    return changed;
  }

  lines(fileKeyOrPath: string): LineInfo[] {
    const m = this.byFile.get(this.key(fileKeyOrPath));
    return m ? [...m.values()] : [];
  }

  /** Every entry that was logged on the line now shown at `line`. */
  hitsAt(file: string, line: number): Entry[] {
    const info = this.lines(file).find((i) => i.line === line);
    if (!info) return [];
    const k = this.key(file);
    return this.all.filter((e) => this.key(e.file) === k && e.line === info.latest.line);
  }

  files(): string[] {
    return [...this.byFile.keys()];
  }

  clear(): void {
    this.all.length = 0;
    this.seen.clear();
    this.byFile.clear();
  }

  /**
   * Moves values with the text when the file is edited. Lines below a change
   * move up or down; a line the edit touched loses its value (it is stale);
   * a line pushed down by a line break inserted at its start keeps it.
   * Returns true when something moved or went.
   */
  shift(file: string, changes: readonly LineChange[]): boolean {
    const m = this.byFile.get(this.key(file));
    if (!m || m.size === 0) return false;
    let touched = false;
    for (const c of changes) {
      const delta = c.newLines - (c.endLine - c.startLine);
      const next = new Map<number, LineInfo>();
      for (const info of m.values()) {
        const L = info.line - 1;
        if (L < c.startLine) {
          next.set(info.line, info);
          continue;
        }
        if (L > c.endLine || (L === c.endLine && c.endChar === 0 && (c.startLine < L || c.newLines > 0))) {
          if (delta !== 0) {
            info.line += delta;
            touched = true;
          }
          next.set(info.line, info);
          continue;
        }
        touched = true; // edited line: drop
      }
      m.clear();
      for (const [k, v] of next) m.set(k, v);
    }
    return touched;
  }
}
