// The JSON form of logged values (for the diff editor and the graph), the
// search query, the text the diff editor shows, and finding the value logged
// before another on the same line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeJson } from "../../src/shared/serialize";
import { matches, parseQuery, previousOf, search, valueText } from "../../src/search";
import { fileKey } from "../../src/store";
import type { Entry } from "../../src/shared/types";

test("JSON form: plain objects as they are, kinds in $type, what JSON cannot hold as bracketed text", () => {
  class Point {
    constructor(
      public x: number,
      public y: number,
    ) {}
  }
  const circular: Record<string, unknown> = { name: "loop" };
  circular.self = circular;
  const v = JSON.parse(serializeJson([{ p: new Point(1, 2), m: new Map([["a", 1]]), s: new Set([1, 2]), u: undefined, b: 10n, f: function named() {}, c: circular, d: new Date(0), e: new TypeError("bad"), n: NaN }])!) as Record<string, unknown>;
  assert.deepEqual(v.p, { $type: "Point", x: 1, y: 2 });
  assert.deepEqual(v.m, { $type: "Map(1)", a: 1 });
  assert.deepEqual(v.s, { $type: "Set(2)", values: [1, 2] });
  assert.equal(v.u, "[undefined]");
  assert.equal(v.b, "10n");
  assert.equal(v.f, "[Function: named]");
  assert.deepEqual(v.c, { name: "loop", self: "[Circular]" });
  assert.equal(v.d, "1970-01-01T00:00:00.000Z");
  assert.equal((v.e as { $type: string; message: string }).$type, "TypeError");
  assert.equal(v.n, "NaN");
});

test("JSON form: several arguments are an array, primitives alone have none, getters are never called, limits hold", () => {
  assert.deepEqual(JSON.parse(serializeJson(["user", { a: 1 }])!), ["user", { a: 1 }]);
  assert.equal(serializeJson(["just", "text", 1]), undefined);
  let called = false;
  const o = {
    get secret() {
      called = true;
      return 1;
    },
  };
  assert.deepEqual(JSON.parse(serializeJson([o])!), { secret: "[Getter]" });
  assert.equal(called, false);
  const deep = JSON.parse(serializeJson([{ a: { b: { c: { d: 1 } } } }], { depth: 2, maxItems: 3, maxString: 5, maxTotal: 1000 })!);
  assert.deepEqual(deep, { a: { b: "[Object]" } });
  assert.deepEqual(JSON.parse(serializeJson([[1, 2, 3, 4, "abcdefgh"]], { depth: 5, maxItems: 3, maxString: 5, maxTotal: 1000 })!), [1, 2, 3, "… 2 more items"]);
  assert.equal(serializeJson([{ big: "x".repeat(500) }], { depth: 5, maxItems: 5, maxString: 10_000, maxTotal: 100 }), undefined, "too big: no JSON");
});

let n = 0;
const e = (extra: Partial<Entry>): Entry => ({ id: `1:${n++}`, kind: "log", level: "log", file: "C:\\p\\src\\a.js", line: 1, col: 1, preview: "", full: "", time: n, source: "node", pid: 1, ...extra });

test("search: every word must match, any case; prefixes narrow by kind, level, file and status", () => {
  const all = [
    e({ preview: "user Ada", full: "user { name: 'Ada' }" }),
    e({ level: "warn", preview: "slow query 900ms", file: "C:\\p\\src\\db.js" }),
    e({ kind: "error", level: "error", preview: "TypeError: boom" }),
    e({ kind: "request", preview: "GET 404 · 3 ms · http://h/users", request: { api: "fetch", method: "GET", url: "http://h/users", status: 404, ms: 3, responseBody: '{"error":"no such user"}' } }),
    e({ kind: "request", preview: "GET failed", request: { api: "fetch", method: "GET", url: "http://h/down", ms: 3, error: "refused" } }),
  ];
  assert.deepEqual(parseQuery("Kind:Request  foo LEVEL:warn"), { words: ["foo"], kind: "request", level: "warn" });
  assert.deepEqual(search(all, "ADA").map((x) => x.preview), ["user Ada"]);
  assert.deepEqual(search(all, "slow 900").length, 1);
  assert.deepEqual(search(all, "slow 901").length, 0);
  assert.deepEqual(search(all, "file:src/db").map((x) => x.level), ["warn"]);
  assert.deepEqual(search(all, "kind:error").length, 1);
  assert.deepEqual(search(all, "status:4").length, 1);
  assert.deepEqual(search(all, "status:failed").length, 1);
  assert.deepEqual(search(all, "no such user").length, 1, "response bodies are searched");
  assert.deepEqual(search(all, "").map((x) => x.id), [...all].reverse().map((x) => x.id), "newest first");
  assert.ok(matches(all[0], parseQuery("")));
});

test("diff text: pretty JSON when there is JSON, the printed text otherwise", () => {
  assert.deepEqual(valueText(e({ json: '{"a":[1,2]}', full: "{ a: [ 1, 2 ] }" })), { text: '{\n  "a": [\n    1,\n    2\n  ]\n}\n', json: true });
  assert.deepEqual(valueText(e({ full: "plain 1" })), { text: "plain 1\n", json: false });
});

test("the previous value is the one before it from the same line and kind", () => {
  const key = (f: string) => fileKey(f, true);
  const a1 = e({ line: 5, preview: "1" });
  const other = e({ line: 6 });
  const req = e({ line: 5, kind: "request" });
  const a2 = e({ line: 5, preview: "2", file: "c:/p/src/a.js" });
  const all = [a1, other, req, a2];
  assert.equal(previousOf(all, a2, key), a1);
  assert.equal(previousOf(all, a1, key), undefined);
});
