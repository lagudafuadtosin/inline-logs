import { test } from "node:test";
import assert from "node:assert/strict";
import { formatArgs, serialize, FULL, PREVIEW, type SerializeOptions } from "../../src/shared/serialize";

const p = (...args: unknown[]) => formatArgs(args, PREVIEW);

test("top-level strings print raw, nested strings quoted", () => {
  assert.equal(p("hello", "world"), "hello world");
  assert.equal(p({ s: "it's" }), `{ s: "it's" }`);
  assert.equal(p(["a\nb"]), "[ 'a\\nb' ]");
});

test("primitives", () => {
  assert.equal(p(1, -0, NaN, true, null, undefined), "1 -0 NaN true null undefined");
  assert.equal(p(10n), "10n");
  assert.equal(p(Symbol("s")), "Symbol(s)");
});

test("plain objects, arrays and keys that need quotes", () => {
  assert.equal(p({ a: 1, b: [1, 2], "x-y": true }), "{ a: 1, b: [ 1, 2 ], 'x-y': true }");
  assert.equal(p({}), "{}");
  assert.equal(p([]), "[]");
  // eslint-disable-next-line no-sparse-arrays
  assert.equal(p([1, , 3]), "[ 1, <empty>, 3 ]");
});

test("circular references", () => {
  const a: Record<string, unknown> = { name: "a" };
  a.self = a;
  a.list = [a];
  assert.equal(p(a), "{ name: 'a', self: [Circular], list: [ [Circular] ] }");
  // The same object twice side by side is not circular.
  const shared = { x: 1 };
  assert.equal(p([shared, shared]), "[ { x: 1 }, { x: 1 } ]");
});

test("Map, Set, typed arrays and buffers", () => {
  assert.equal(p(new Map<unknown, unknown>([["a", 1], [{ k: 1 }, [2]]])), "Map(2) { 'a' => 1, { k: 1 } => [ 2 ] }");
  assert.equal(p(new Set([1, "two"])), "Set(2) { 1, 'two' }");
  assert.equal(p(new Map()), "Map(0) {}");
  assert.equal(p(new Uint8Array([1, 2, 3])), "Uint8Array(3) [ 1, 2, 3 ]");
  assert.equal(p(new ArrayBuffer(4)), "ArrayBuffer { byteLength: 4 }");
  assert.equal(p(new WeakMap()), "WeakMap { <items unknown> }");
});

test("errors: one line in the preview, stack in the full text", () => {
  const e = new TypeError("bad input");
  assert.equal(p(e), "TypeError: bad input");
  const full = formatArgs([e], FULL);
  assert.ok(full.startsWith("TypeError: bad input\n"));
  assert.match(full, /at /);
  class MyError extends Error {
    name = "MyError";
  }
  assert.equal(p(new MyError("x")), "MyError: x");
});

test("class names, null prototypes, functions and classes", () => {
  class Point {
    constructor(
      public x: number,
      public y: number,
    ) {}
  }
  assert.equal(p(new Point(1, 2)), "Point { x: 1, y: 2 }");
  class Empty {}
  assert.equal(p(new Empty()), "Empty {}");
  const bare = Object.create(null) as Record<string, number>;
  bare.a = 1;
  assert.equal(p(bare), "[Object: null prototype] { a: 1 }");
  function named() {}
  assert.equal(p(named, () => 1, Point), "[Function: named] [Function (anonymous)] [class Point]");
});

test("dates, regexps, boxed values", () => {
  assert.equal(p(new Date(0)), "1970-01-01T00:00:00.000Z");
  assert.equal(p(new Date(NaN)), "Invalid Date");
  assert.equal(p(/a+b/gi), "/a+b/gi");
  assert.equal(p(Object(5)), "[Number: 5]");
});

test("getters are never called", () => {
  let called = 0;
  const o = {
    get secret() {
      called++;
      return 42;
    },
    plain: 1,
  };
  assert.equal(p(o), "{ secret: [Getter], plain: 1 }");
  assert.equal(called, 0);
});

test("proxies that throw do not throw out of the serializer", () => {
  const evil = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("no");
      },
      getPrototypeOf() {
        throw new Error("no");
      },
    },
  );
  assert.doesNotThrow(() => p(evil));
});

test("depth limit", () => {
  const deep = { a: { b: { c: { d: { e: 1 } } } } };
  assert.equal(p(deep), "{ a: { b: { c: { d: [Object] } } } }");
  assert.equal(p({ a: { b: { c: { d: [1] } } } }), "{ a: { b: { c: { d: [Array] } } } }");
  class Deep {
    x = 1;
  }
  assert.equal(p({ a: { b: { c: { d: new Deep() } } } }), "{ a: { b: { c: { d: [Deep] } } } }");
});

test("item, string and total limits", () => {
  const big = Array.from({ length: 50 }, (_, i) => i);
  assert.match(p(big), /\.\.\. 30 more items \]$/);
  const long = "x".repeat(500);
  assert.equal(p(long).length, PREVIEW.maxString + 1);
  const huge = Array.from({ length: 10_000 }, (_, i) => ({ i, text: "y".repeat(50) }));
  const o: SerializeOptions = { ...FULL, maxItems: 10_000 };
  const t0 = Date.now();
  const out = formatArgs([huge], o);
  assert.ok(out.length <= o.maxTotal + 1, `length ${out.length}`);
  assert.ok(Date.now() - t0 < 500, "a huge value stops early");
  const manyKeys = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
  assert.match(p(manyKeys), /\.\.\. 10 more items \}$/);
});

test("printf-style placeholders", () => {
  assert.equal(p("%s has %d tags", "Ada", 2), "Ada has 2 tags");
  assert.equal(p("%i|%f", 3.9, "1.5"), "3|1.5");
  assert.equal(p("%o", { a: 1 }), "{ a: 1 }");
  assert.equal(p("%j", { a: [1] }), '{"a":[1]}');
  assert.equal(p("%c styled", "color: red"), " styled");
  assert.equal(p("100%% sure", 1), "100% sure 1");
  assert.equal(p("%s and %s", "one"), "one and %s");
  assert.equal(p("extra", 1, { b: 2 }), "extra 1 { b: 2 }");
});

test("pretty output breaks long objects over lines", () => {
  const o = { name: "a long enough name", tags: ["one", "two", "three"], nested: { deep: true, deeper: { yes: 1 } } };
  const out = serialize(o, FULL);
  assert.ok(out.includes("\n  name: 'a long enough name',"), out);
  assert.equal(serialize({ a: 1 }, FULL), "{ a: 1 }");
});

test("DOM-like nodes print as tags", () => {
  const el = { nodeType: 1, nodeName: "DIV", tagName: "DIV", id: "app", className: "x y" };
  assert.equal(p(el), '<div id="app" class="x y">');
});
