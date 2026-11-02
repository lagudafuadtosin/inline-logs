import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, fileKey, type LineChange } from "../../src/store";
import type { Entry } from "../../src/shared/types";

let n = 0;
const entry = (line: number, preview: string, extra: Partial<Entry> = {}): Entry => ({
  id: `1:${n++}`,
  kind: "log",
  level: "log",
  file: "C:\\proj\\a.js",
  line,
  col: 1,
  preview,
  full: preview,
  time: 0,
  source: "node",
  pid: 1,
  ...extra,
});
const at = (s: Store) => s.lines("C:/proj/a.js").map((i) => [i.line, i.latest.preview, i.count]).sort((a, b) => (a[0] as number) - (b[0] as number));
const change = (startLine: number, startChar: number, endLine: number, endChar: number, newLines: number): LineChange => ({ startLine, startChar, endLine, endChar, newLines });

test("latest value per line, with a hit count; duplicates by id are ignored", () => {
  const s = new Store(true);
  const first = entry(3, "a");
  s.add([first, entry(3, "b"), entry(5, "c")]);
  s.add([first]);
  assert.deepEqual(at(s), [
    [3, "b", 2],
    [5, "c", 1],
  ]);
  assert.equal(s.size, 3);
});

test("an error is not hidden by a later log on the same line", () => {
  const s = new Store(true);
  s.add([entry(2, "boom", { kind: "error", level: "error" }), entry(2, "after")]);
  assert.deepEqual(at(s), [[2, "boom", 2]]);
});

test("file keys ignore case and slashes on Windows-like systems", () => {
  assert.equal(fileKey("c:\\Proj\\A.js", true), fileKey("C:/proj/a.js", true));
  assert.notEqual(fileKey("/app/A.js", false), fileKey("/app/a.js", false));
  const s = new Store(true);
  s.add([entry(1, "x")]);
  assert.equal(s.lines("c:/PROJ/a.js").length, 1);
});

test("a line inserted above moves values down", () => {
  const s = new Store(true);
  s.add([entry(3, "a"), entry(5, "b")]);
  // Enter at the end of line 1 (0-based 0).
  assert.equal(s.shift("C:/proj/a.js", [change(0, 10, 0, 10, 1)]), true);
  assert.deepEqual(at(s), [
    [4, "a", 1],
    [6, "b", 1],
  ]);
});

test("Enter at the very start of a logged line pushes the value down with it", () => {
  const s = new Store(true);
  s.add([entry(3, "a")]);
  s.shift("C:/proj/a.js", [change(2, 0, 2, 0, 1)]);
  assert.deepEqual(at(s), [[4, "a", 1]]);
});

test("deleting a line above moves values up; deleting the logged line drops it", () => {
  const s = new Store(true);
  s.add([entry(3, "a"), entry(5, "b")]);
  // Delete 0-based line 1 (1-based 2) whole.
  s.shift("C:/proj/a.js", [change(1, 0, 2, 0, 0)]);
  assert.deepEqual(at(s), [
    [2, "a", 1],
    [4, "b", 1],
  ]);
  s.shift("C:/proj/a.js", [change(1, 0, 2, 0, 0)]);
  assert.deepEqual(at(s), [[3, "b", 1]]);
});

test("typing on a logged line clears its value, other lines stay", () => {
  const s = new Store(true);
  s.add([entry(3, "a"), entry(5, "b")]);
  s.shift("C:/proj/a.js", [change(2, 4, 2, 4, 0)]);
  assert.deepEqual(at(s), [[5, "b", 1]]);
});

test("edits below a value leave it alone", () => {
  const s = new Store(true);
  s.add([entry(3, "a")]);
  assert.equal(s.shift("C:/proj/a.js", [change(9, 0, 9, 0, 3)]), false);
  assert.deepEqual(at(s), [[3, "a", 1]]);
});

test("a new run after an edit lands on the moved line and counts with it", () => {
  const s = new Store(true);
  s.add([entry(3, "a")]);
  s.shift("C:/proj/a.js", [change(0, 0, 0, 0, 1)]);
  s.add([entry(4, "a2")]);
  assert.deepEqual(at(s), [[4, "a2", 2]]);
});

test("clear empties everything", () => {
  const s = new Store(true);
  s.add([entry(1, "a")]);
  s.clear();
  assert.equal(s.size, 0);
  assert.deepEqual(s.files(), []);
});
