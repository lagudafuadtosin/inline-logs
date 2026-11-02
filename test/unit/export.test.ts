// Export (JSON and plain text), Copy Value, and each run of a line kept for its hover.
import { test } from "node:test";
import assert from "node:assert/strict";
import { exportJson, exportText, valueJson } from "../../src/export";
import { RECENT_RUNS, Store } from "../../src/store";
import type { Entry } from "../../src/shared/types";

const base = { kind: "log", level: "log", file: "/app/src/a.js", col: 1, source: "node", pid: 7 } as const;
const e = (id: string, line: number, preview: string, extra: Partial<Entry> = {}): Entry => ({ ...base, id, line, preview, full: preview, time: Date.UTC(2026, 10, 2, 12, 0, Number(id)), ...extra });

test("copy value: the JSON form when there is one, else the printed text as a JSON string", () => {
  assert.equal(valueJson(e("1", 1, "user { a: 1 }", { json: '{"a":1}' })), '{\n  "a": 1\n}');
  assert.equal(valueJson(e("2", 1, "count 5")), '"count 5"');
});

test("export: JSON with paths relative to the workspace, and plain text", () => {
  const all = [e("1", 3, "first", { json: '{"x":[1]}' }), e("2", 9, "Error: bad", { kind: "error", level: "error" }), e("3", 4, "pino hello", { logger: "pino", level: "info" })];
  const rel = (f: string) => f.replace("/app/", "");
  const json = JSON.parse(exportJson(all, rel)) as Record<string, unknown>[];
  assert.equal(json.length, 3);
  assert.deepEqual(json[0], { time: "2026-11-02T12:00:01.000Z", kind: "log", level: "log", file: "src/a.js", line: 3, column: 1, source: "node", pid: 7, text: "first", value: { x: [1] } });
  assert.equal(json[2].logger, "pino");
  const text = exportText(all, rel);
  assert.equal(text.split("\n")[0], "2026-11-02T12:00:01.000Z  console.log  src/a.js:3  (pid 7)");
  assert.ok(text.includes("uncaught error  src/a.js:9") && text.includes("pino info  src/a.js:4") && text.includes("\n    Error: bad\n"));
});

test("runs: a line keeps its last runs for the hover, the count keeps going", () => {
  const s = new Store(false);
  s.add(Array.from({ length: 25 }, (_, i) => e(String(i + 1), 5, `i = ${i}`)));
  const [info] = s.lines("/app/src/a.js");
  assert.equal(info.count, 25);
  assert.equal(info.recent.length, RECENT_RUNS);
  assert.deepEqual([info.recent[0].preview, info.recent.at(-1)?.preview], ["i = 15", "i = 24"]);
});
