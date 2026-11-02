// Insert Log, and Comment Out, Uncomment and Remove console calls: real
// calls only (found by TypeScript's parser), never text in strings,
// templates or comments, and calls over several lines as one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { commentOut, findConsoleCalls, insertLog, regions, removeAll, uncomment, type TextEdit } from "../../src/logedit";

function apply(text: string, edits: readonly TextEdit[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  return out;
}

/** Inserts a log with the cursor at the first "|" (or the selection between two). */
function ins(src: string, lang = "typescript", file = "app.ts", unit = "  ") {
  const a = src.indexOf("|");
  const rest = src.slice(0, a) + src.slice(a + 1);
  const b = rest.indexOf("|");
  const text = b >= 0 ? rest.slice(0, b) + rest.slice(b + 1) : rest;
  const r = insertLog(text, lang, file, { start: a, end: b >= 0 ? b : a, fileLabel: file, eol: "\n", indentUnit: unit });
  if ("error" in r) return r.error;
  return apply(text, [r.edit]);
}

test("insert: the name under the cursor, on the line after its statement, with the file and line", () => {
  assert.equal(ins('const user = { name: "a" };\nconst u|ser2 = user;\nrun(user2);\n'), 'const user = { name: "a" };\nconst user2 = user;\nconsole.log("app.ts:3 user2", user2);\nrun(user2);\n');
  // a.b.c with the cursor on b logs a.b.
  assert.equal(ins("function f(a) {\n    return g(a.b|x.c);\n}\n", "javascript", "f.js"), "function f(a) {\n    console.log(\"f.js:2 a.bx\", a.bx);\n    return g(a.bx.c);\n}\n");
});

test("insert: the file's quotes, semicolons and indentation", () => {
  assert.equal(ins("const a = 'x'\nconst b = 'y'\nif (a) {\n\tconst c = a + b|\n}\n", "javascript", "q.js"), "const a = 'x'\nconst b = 'y'\nif (a) {\n\tconst c = a + b\n\tconsole.log('q.js:5 b', b)\n}\n");
});

test("insert: a selection, a statement over several lines, and a label with quotes in it", () => {
  assert.equal(ins('const total = |items.reduce((s, i) => s + i["price"], 0)|;\n'), 'const total = items.reduce((s, i) => s + i["price"], 0);\nconsole.log("app.ts:2 items.reduce((s, i) => s + i[\\"price\\"], 0)", items.reduce((s, i) => s + i["price"], 0));\n');
  assert.equal(ins("const r|ows = load({\n  a: 1,\n});\nuse(rows);\n"), 'const rows = load({\n  a: 1,\n});\nconsole.log("app.ts:4 rows", rows);\nuse(rows);\n');
});

test("insert: parameters, loop variables and conditions go first in their block; before a return", () => {
  assert.equal(ins("function area(w|idth, height) {\n  return width * height;\n}\n"), 'function area(width, height) {\n  console.log("app.ts:2 width", width);\n  return width * height;\n}\n');
  assert.equal(ins("for (const it|em of list) {\n  use(item);\n}\n"), 'for (const item of list) {\n  console.log("app.ts:2 item", item);\n  use(item);\n}\n');
  assert.equal(ins("if (user.o|k) {\n}\n", "typescript", "app.ts", "    "), 'if (user.ok) {\n    console.log("app.ts:2 user.ok", user.ok);\n}\n');
  assert.equal(ins("function f() {\n  const v = 1;\n  return v|;\n}\n"), 'function f() {\n  const v = 1;\n  console.log("app.ts:3 v", v);\n  return v;\n}\n');
  assert.match(ins("const f = (x|) => x * 2;\n"), /no braces/);
  assert.match(ins("class A {\n  fi|eld = 1;\n}\n"), /class field/);
  assert.match(ins("const x = 1; // a com|ment\n"), /name or select/);
});

test("insert: the <script> of a Svelte file and the frontmatter of an Astro file", () => {
  assert.equal(ins("<script>\n  let co|unt = $state(0);\n</script>\n\n<p>{count}</p>\n", "svelte", "C.svelte"), '<script>\n  let count = $state(0);\n  console.log("C.svelte:3 count", count);\n</script>\n\n<p>{count}</p>\n');
  assert.equal(ins("---\nconst pl|anet = { name: 'Mars' };\n---\n<h1>{planet.name}</h1>\n", "astro", "p.astro"), "---\nconst planet = { name: 'Mars' };\nconsole.log('p.astro:3 planet', planet);\n---\n<h1>{planet.name}</h1>\n");
  assert.match(ins("<p>{co|unt}</p>\n", "svelte", "C.svelte"), /JavaScript or TypeScript/);
  assert.deepEqual(regions('<script type="application/json">{"a":1}</script><script lang="ts">let a = 1</script>', "svelte", "x.svelte").length, 1);
});

const SAMPLE = `const s = "console.log(not a call)";
const t = \`
  console.log(in a template)
\`;
// console.log("already a comment")
console.log("one", s);
if (s) console.warn("body of an if");
console.info(
  "two",
  { a: 1 },
);
const f = () => console.debug("arrow body");
const v = check() || console.error("part of an expression");
foo(); console.log("shares a line"); bar();
window.console.log("not the global console name");
`;

test("find: only real console calls, a call over lines as one, never text in strings or comments", () => {
  const calls = findConsoleCalls(SAMPLE, "javascript", "x.js");
  assert.deepEqual(
    calls.map((c) => [c.method, !!c.statement, c.statement?.inList ?? null, !!c.arrowBody]),
    [
      ["log", true, true, false],
      ["warn", true, false, false],
      ["info", true, true, false],
      ["debug", false, null, true],
      ["error", false, null, false],
      ["log", true, true, false],
    ],
  );
});

test("comment out, then uncomment: back to the same text", () => {
  const c = commentOut(SAMPLE, "javascript", "x.js");
  const commented = apply(SAMPLE, c.edits);
  assert.equal(c.done, 3);
  assert.equal(c.skipped, 3, "the if body, the arrow body and the expression are left as they are");
  assert.ok(commented.includes('// console.log("one", s);'));
  assert.ok(commented.includes('// console.info(\n//   "two",\n//   { a: 1 },\n// );'), commented);
  assert.ok(commented.includes('foo(); /* console.log("shares a line"); */ bar();'));
  assert.ok(commented.includes('const s = "console.log(not a call)";') && commented.includes("  console.log(in a template)\n"), "strings and templates are untouched");
  assert.equal(findConsoleCalls(commented, "javascript", "x.js").length, 3);
  const u = uncomment(commented, "javascript", "x.js");
  // The comment that was there before is a console call too: it comes back as code.
  assert.equal(u.done, 4);
  assert.equal(apply(commented, u.edits), SAMPLE.replace('// console.log("already a comment")', 'console.log("already a comment")'));
});

test("uncomment: only comments that are a whole console call", () => {
  const src = "// console.log(\n//   half\n// note: console.log is handy\n/* console.warn('w') */\n/* console.warn( */\nconst x = `\n// console.log(1)\n`;\n";
  const u = uncomment(src, "javascript", "x.js");
  assert.equal(apply(src, u.edits), "// console.log(\n//   half\n// note: console.log is handy\nconsole.warn('w')\n/* console.warn( */\nconst x = `\n// console.log(1)\n`;\n");
});

test("remove: whole lines go, other code stays, and the code keeps its shape", () => {
  const r = removeAll(SAMPLE, "javascript", "x.js");
  const out = apply(SAMPLE, r.edits);
  assert.equal(r.done, 5);
  assert.equal(r.skipped, 1);
  assert.equal(
    out,
    `const s = "console.log(not a call)";
const t = \`
  console.log(in a template)
\`;
// console.log("already a comment")
if (s) {}
const f = () => {};
const v = check() || console.error("part of an expression");
foo(); bar();
window.console.log("not the global console name");
`,
  );
});

test("remove: TypeScript, TSX, Windows line ends, and a call on the last line", () => {
  const ts = "type A = { n: number };\r\nconst a: A = { n: 1 };\r\nconsole.log(a as A);\r\nexport default a;\r\nconsole.log(<A>a);";
  assert.equal(apply(ts, removeAll(ts, "typescript", "a.ts").edits), "type A = { n: number };\r\nconst a: A = { n: 1 };\r\nexport default a;");
  const tsx = "export const C = () => {\n  console.log('render');\n  return <div>{'console.log(no)'}</div>;\n};\n";
  assert.equal(apply(tsx, removeAll(tsx, "typescriptreact", "c.tsx").edits), "export const C = () => {\n  return <div>{'console.log(no)'}</div>;\n};\n");
});
