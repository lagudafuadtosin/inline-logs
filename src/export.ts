// Captured entries as a file (Export), and one value as JSON (Copy Value).
// No VS Code imports, so it is unit tested on its own. Everything here was
// already redacted inside the app before it was sent.
import type { Entry } from "./shared/types";

/** The value of one entry as JSON text: its JSON form when it has one (objects, requests), else the printed text as a JSON string. */
export function valueJson(e: Entry): string {
  if (e.json) {
    try {
      return JSON.stringify(JSON.parse(e.json), null, 2);
    } catch {
      // the text below
    }
  }
  return JSON.stringify(e.full);
}

/** Every entry as one JSON document: a list, oldest first, with the file path relative to the workspace. */
export function exportJson(entries: readonly Entry[], relative: (file: string) => string): string {
  const rows = entries.map((e) => {
    let value: unknown;
    if (e.json) {
      try {
        value = JSON.parse(e.json);
      } catch {
        value = undefined;
      }
    }
    return {
      time: new Date(e.time).toISOString(),
      kind: e.kind,
      level: e.level,
      file: relative(e.file),
      line: e.line,
      column: e.col,
      source: e.source,
      pid: e.pid,
      method: e.method,
      logger: e.logger,
      group: e.group,
      text: e.full,
      value,
      request: e.request,
    };
  });
  return JSON.stringify(rows, null, 2) + "\n";
}

/** Every entry as plain text: a heading line per entry, then the full value indented. */
export function exportText(entries: readonly Entry[], relative: (file: string) => string): string {
  const out: string[] = [];
  for (const e of entries) {
    const what = e.kind === "error" ? "uncaught error" : e.kind === "request" ? (e.request?.api === "websocket" || e.request?.api === "eventsource" ? e.request.api : "request") : e.logger ? `${e.logger} ${e.level}` : `console.${e.method ?? e.level}`;
    out.push(`${new Date(e.time).toISOString()}  ${what}  ${relative(e.file)}:${e.line}  (${e.source === "browser" ? "browser" : `pid ${e.pid}`})`);
    for (const l of e.full.split(/\r?\n/)) out.push(`    ${l}`);
  }
  return out.join("\n") + "\n";
}
