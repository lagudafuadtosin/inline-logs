// The value graph's model and layout: one box per object or array, rows
// pointing at child boxes, boxes that never overlap, collapse hiding what
// is under a box, and size limits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bounds, buildGraph, layout, MAX_ROWS, type Box } from "../../src/graph/layout";

const value = { $type: "Order", id: 7, customer: { name: "Ada", address: { city: "Stirling" } }, items: [{ sku: "a", qty: 1 }, { sku: "b", qty: 2 }], paid: true };

test("one box per object or array, plain values as rows, $type in the title", () => {
  const g = buildGraph(value, "order");
  assert.equal(g.nodes.size, 6);
  const root = g.nodes.get(g.root)!;
  assert.equal(root.title, "order: Order");
  assert.deepEqual(root.rows.map((r) => [r.key, r.value ?? `-> ${g.nodes.get(r.child!)!.title}`]), [
    ["id", "7"],
    ["customer", "-> customer"],
    ["items", "-> items: Array(2)"],
    ["paid", "true"],
  ]);
  assert.equal(root.children.length, 2);
  assert.equal(buildGraph("just text").nodes.size, 1);
});

const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test("the layout: columns by depth, no two boxes overlap, children to the right of their parent", () => {
  const g = buildGraph(value);
  const boxes = layout(g);
  assert.equal(boxes.size, 6);
  const list = [...boxes.values()];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) assert.ok(!overlap(list[i], list[j]), `boxes ${i} and ${j} overlap`);
  for (const [id, n] of g.nodes) for (const c of n.children) assert.ok(boxes.get(c)!.x > boxes.get(id)!.x + boxes.get(id)!.w, "children are to the right");
  const b = bounds(boxes);
  assert.ok(b.w > 0 && b.h > 0 && b.x === 0 && b.y === 0);
});

test("collapse hides everything under a box", () => {
  const g = buildGraph(value);
  const items = g.nodes.get(g.root)!.children[1];
  assert.equal(layout(g, new Set([items])).size, 4, "root, customer, address");
  assert.equal(layout(g, new Set([g.root])).size, 1);
});

test("big values are cut: rows per box and boxes in all", () => {
  const wide = Object.fromEntries(Array.from({ length: MAX_ROWS + 15 }, (_, i) => [`k${i}`, i]));
  const g = buildGraph(wide);
  assert.equal(g.nodes.get(g.root)!.rows.length, MAX_ROWS);
  assert.equal(g.nodes.get(g.root)!.hidden, 15);
  const many = buildGraph(Array.from({ length: 50 }, (_, i) => ({ i })), "v", 10);
  assert.equal(many.nodes.size, 10);
  assert.ok(many.cut);
});
