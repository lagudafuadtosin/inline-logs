// console.count, countReset, time, timeLog, timeEnd, group, groupCollapsed,
// groupEnd and assert: what each shows inline, and that Node prints exactly
// what it prints without the hook.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { ConsoleCounters, formatMs } from "../../src/shared/console";
import { expectedLines } from "../expect";
import { fixtures, inFile, receiver, run, runSync, until, type Receiver } from "../hooked";

let rx: Receiver;
const ready = receiver().then((r) => (rx = r));
after(() => rx?.server.close());

test("counters: count, reset, timers, groups and asserts, as the console counts them", () => {
  let now = 1000;
  const c = new ConsoleCounters(() => now);
  assert.equal(c.call("count", [], undefined, "warn")?.preview, "default: 1");
  assert.equal(c.call("count", ["x"], undefined, "warn")?.preview, "x: 1");
  assert.equal(c.call("count", ["x"], undefined, "warn")?.preview, "x: 2");
  assert.equal(c.call("countReset", ["x"], undefined, "warn")?.preview, "x: 0 (reset)");
  assert.equal(c.call("count", ["x"], undefined, "warn")?.preview, "x: 1");
  assert.equal(c.call("time", ["t"], undefined, "warn")?.preview, "t: timer started");
  now = 1012.5;
  assert.equal(c.call("timeLog", ["t", "mid", { a: 1 }], undefined, "warn")?.preview, "t: 12.500ms mid { a: 1 }");
  now = 3500;
  assert.equal(c.call("timeEnd", ["t"], undefined, "warn")?.preview, "t: 2.500s");
  assert.equal(c.call("timeEnd", ["t"], undefined, "warn"), undefined, "a timer that is gone shows nothing");
  const g = c.call("group", ["Outer"], undefined, "warn");
  assert.equal(g?.preview, "▾ Outer");
  assert.equal(g?.group, undefined, "a group's own entry is not inside itself");
  assert.equal(c.call("groupCollapsed", ["Inner", 2], undefined, "warn")?.group, "Outer");
  assert.equal(c.groupPath(), "Outer › Inner 2");
  assert.equal(c.call("groupEnd", [], undefined, "warn"), undefined);
  assert.equal(c.groupPath(), "Outer");
  c.call("groupEnd", [], undefined, "warn");
  assert.equal(c.groupPath(), undefined);
  assert.equal(c.call("assert", [true, "fine"], undefined, "warn"), undefined, "a passing assert shows nothing");
  const failed = c.call("assert", [0, "broken %s", "here"], undefined, "error");
  assert.deepEqual([failed?.preview, failed?.level], ["Assertion failed: broken here", "error"]);
  assert.equal(c.call("assert", [false], undefined, "warn")?.preview, "Assertion failed");
  // What the console printed itself is the text when there is some (Node's count calls console.log).
  assert.equal(c.call("count", ["y"], ["y: 1"], "warn")?.preview, "y: 1");
  assert.equal(formatMs(0.0291), "0.029ms");
});

test("counters in Node: output byte for byte the same, one entry per call on its line", async () => {
  await ready;
  const dir = path.join(fixtures, "node-cjs");
  const file = path.join(dir, "counters.js");
  const plain = runSync(dir, ["counters.js"]);
  rx.received.length = 0;
  const hooked = await run(process.execPath, ["counters.js"], dir, rx.env());
  // Timers differ from run to run: their numbers are the only thing set aside.
  const steady = (s: string) => s.replace(/\d+\.\d+m?s/g, "<t>");
  assert.equal(steady(hooked.stdout), steady(plain.stdout));
  assert.equal(hooked.stderr, plain.stderr);
  assert.equal(hooked.status, plain.status);
  assert.ok(plain.stdout.includes("loop: 3") && plain.stderr.includes("Assertion failed: math is broken: 3"), plain.stdout + plain.stderr);
  const L = expectedLines(file);
  await until(() => inFile(rx.received, file).some((e) => e.line === L.get("assert-fail")));
  const at = (n: string) => inFile(rx.received, file).filter((e) => e.line === L.get(n));
  assert.deepEqual(
    at("count").map((e) => [e.preview, e.method]),
    [
      ["loop: 1", "count"],
      ["loop: 2", "count"],
      ["loop: 3", "count"],
    ],
  );
  assert.equal(at("count-reset")[0]?.preview, "loop: 0 (reset)");
  assert.equal(at("time")[0]?.preview, "load: timer started");
  assert.match(at("time-log")[0]?.preview ?? "", /^load: \d+\.\d+ms halfway \{ step: 1 \}$/);
  assert.match(at("time-end")[0]?.preview ?? "", /^load: \d+\.\d+ms$/);
  assert.equal(at("group")[0]?.preview, "▾ Outer");
  assert.deepEqual([at("in-group")[0]?.preview, at("in-group")[0]?.group], ["inside the group", "Outer"]);
  assert.deepEqual([at("group-collapsed")[0]?.preview, at("group-collapsed")[0]?.group], ["▸ Inner", "Outer"]);
  assert.equal(at("group-end").length, 0, "groupEnd shows nothing");
  assert.equal(at("assert-ok").length, 0, "a passing assert shows nothing");
  assert.deepEqual([at("assert-fail")[0]?.preview, at("assert-fail")[0]?.level, at("assert-fail")[0]?.method], ["Assertion failed: math is broken: 3", "warn", "assert"]);
  // Each call is one entry: Node's own console.log inside count is not a second one.
  assert.equal(inFile(rx.received, file).length, 11);
});
