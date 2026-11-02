// console.table, console.dir and console.trace: one line at the end of the
// code line, the full form (the table, the whole object, the stack) in the hover.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCall, textPreview, FULL, PREVIEW } from "../../src/shared/serialize";

const people = [
  { name: "Ada", born: 1815 },
  { name: "Grace", born: 1906, tags: ["navy"] },
];

test("table: size and columns inline, the drawn table in full", () => {
  assert.equal(formatCall("table", [people], PREVIEW), "table, 2 rows: name, born, tags");
  assert.equal(
    formatCall("table", [people], FULL),
    [
      "┌─────────┬─────────┬──────┬────────────┐",
      "│ (index) │ name    │ born │ tags       │",
      "├─────────┼─────────┼──────┼────────────┤",
      "│ 0       │ 'Ada'   │ 1815 │            │",
      "│ 1       │ 'Grace' │ 1906 │ [ 'navy' ] │",
      "└─────────┴─────────┴──────┴────────────┘",
    ].join("\n"),
  );
});

test("table: the columns argument, primitive rows, Map and Set", () => {
  assert.equal(formatCall("table", [people, ["name"]], PREVIEW), "table, 2 rows: name");
  assert.ok(formatCall("table", [people, ["name"]], FULL).includes("│ (index) │ name    │\n"));
  assert.equal(formatCall("table", [{ x: { v: 1 }, y: 5 }], PREVIEW), "table, 2 rows: v, Values");
  assert.equal(formatCall("table", [new Map([["k", 1]])], PREVIEW), "table, 1 row: Key, Values");
  assert.ok(formatCall("table", [new Map([["k", 1]])], FULL).includes("│ (iteration index) │ Key │ Values │"));
  assert.equal(formatCall("table", [new Set(["a", "b"])], PREVIEW), "table, 2 rows: Values");
  // Not tabular: shown as console.log would.
  assert.equal(formatCall("table", [5], PREVIEW), "5");
  assert.equal(formatCall("table", ["text"], PREVIEW), "text");
});

test("table: many rows are cut, the count stays true", () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ i }));
  assert.equal(formatCall("table", [rows], PREVIEW), "table, 500 rows: i");
  assert.ok(formatCall("table", [rows], FULL).includes("... 300 more rows"));
});

test("dir: the object, strings quoted (as util.inspect does), deep in the hover", () => {
  const deep = { a: { b: { c: { d: { e: 1 } } } } };
  assert.equal(formatCall("dir", ["text"], PREVIEW), "'text'");
  assert.equal(formatCall("dir", [deep], PREVIEW), "{ a: { b: { c: { d: [Object] } } } }");
  assert.ok(formatCall("dir", [deep], FULL).includes("e: 1"));
});

test("trace: the message inline, the stack in the hover", () => {
  const stack = "Error\n    at where (/app/a.js:9:11)\n    at Object.<anonymous> (/app/a.js:11:1)";
  assert.equal(formatCall("trace", ["traced", 2], PREVIEW, stack), "Trace: traced 2");
  assert.equal(formatCall("trace", [], PREVIEW, stack), "Trace");
  assert.equal(formatCall("trace", ["x"], FULL, stack), "Trace: x\n    at where (/app/a.js:9:11)\n    at Object.<anonymous> (/app/a.js:11:1)");
});

test("output that arrives as text (Jest): a drawn table and a trace get one-line previews", () => {
  const drawn = formatCall("table", [people], FULL);
  assert.equal(textPreview(drawn, "table"), "table, 2 rows: name, born, tags");
  assert.equal(textPreview("Trace: x\n    at a (/f.js:1:1)", "trace"), "Trace: x");
  assert.equal(textPreview("  plain text  "), "plain text");
});
