// Search across every captured log, error and request, used by the Search
// command, the Log Map filter and the MCP tools. No VS Code imports, so it
// is unit tested on its own.
//
// A query is words that must all match (any case) somewhere in the entry:
// its value, its file path, or a request's URL and bodies. Words can be
// narrowed with a prefix: kind:request, level:warn, file:api, status:404
// (status:4 matches every 4xx).
import type { Entry } from "./shared/types";

export interface Query {
  words: string[];
  kind?: string;
  level?: string;
  file?: string;
  status?: string;
}

export function parseQuery(q: string): Query {
  const out: Query = { words: [] };
  for (const raw of q.trim().split(/\s+/)) {
    if (!raw) continue;
    const m = /^(kind|level|file|status):(.+)$/i.exec(raw);
    if (m) out[m[1].toLowerCase() as "kind" | "level" | "file" | "status"] = m[2].toLowerCase();
    else out.words.push(raw.toLowerCase());
  }
  return out;
}

/** The text a word is looked for in. */
function haystack(e: Entry): string {
  const r = e.request;
  return [e.preview, e.full, e.file, r?.url, r?.requestBody, r?.responseBody].filter(Boolean).join("\n").toLowerCase();
}

export function matches(e: Entry, q: Query): boolean {
  if (q.kind && e.kind !== q.kind) return false;
  if (q.level && e.level !== q.level) return false;
  if (q.file && !e.file.replace(/\\/g, "/").toLowerCase().includes(q.file.replace(/\\/g, "/"))) return false;
  // A WebSocket message has no status: status: words leave it out.
  if (q.status && (e.request?.ws || !String(e.request?.status ?? (e.request ? "failed" : "")).startsWith(q.status))) return false;
  if (!q.words.length) return true;
  const text = haystack(e);
  return q.words.every((w) => text.includes(w));
}

/** Newest first, at most `limit`. */
export function search(entries: readonly Entry[], query: string, limit = 500): Entry[] {
  const q = parseQuery(query);
  const out: Entry[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) if (matches(entries[i], q)) out.push(entries[i]);
  return out;
}

/**
 * The value of an entry as a document for the diff editor: pretty JSON when
 * it has a JSON form, else the full text.
 */
export function valueText(e: Entry): { text: string; json: boolean } {
  if (e.json) {
    try {
      return { text: JSON.stringify(JSON.parse(e.json), null, 2) + "\n", json: true };
    } catch {
      // fall back to the text
    }
  }
  return { text: e.full + "\n", json: false };
}

/** The entry logged on the same line just before `e`, if any. */
export function previousOf(entries: readonly Entry[], e: Entry, key: (file: string) => string): Entry | undefined {
  const k = key(e.file);
  let i = entries.indexOf(e);
  if (i < 0) i = entries.length;
  for (let j = i - 1; j >= 0; j--) {
    const x = entries[j];
    if (x.line === e.line && x.kind === e.kind && key(x.file) === k) return x;
  }
  return undefined;
}
