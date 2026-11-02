// pino, winston, consola and tslog: their calls land on the app line that
// made them, with their level, and their output stays byte for byte the same.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { consolaLine, pinoLevel, stripAnsi, tslogLine, winstonLevel } from "../../src/hook/loggers";
import { expectedLines } from "../expect";
import { fixtures, inFile, receiver, run, runSync, until, type Receiver } from "../hooked";

let rx: Receiver;
const ready = receiver().then((r) => (rx = r));
after(() => rx?.server.close());

test("levels: pino numbers, winston names, consola badges and icons, tslog names", () => {
  assert.deepEqual([10, 20, 30, 40, 50, 60].map(pinoLevel), ["debug", "debug", "info", "warn", "error", "error"]);
  assert.deepEqual(["error", "warn", "info", "http", "verbose", "debug", "silly", "crit", "warning", "notice"].map(winstonLevel), ["error", "warn", "info", "info", "info", "debug", "debug", "error", "warn", "info"]);
  assert.deepEqual(consolaLine("[warn] careful"), { level: "warn", message: "careful" });
  assert.deepEqual(consolaLine("\n ERROR  it broke\n"), { level: "error", message: "it broke" });
  assert.deepEqual(consolaLine("ℹ ready to go                                      12:01:02"), { level: "info", message: "ready to go" });
  assert.deepEqual(consolaLine("✔ built"), { level: "info", message: "built" });
  assert.deepEqual(consolaLine("plain text"), { level: "log", message: "plain text" });
  assert.deepEqual(tslogLine("2026-11-02 17:05:07.440\tINFO\tindex.js:28\tapp\ttslog hello { id: 1 }"), { level: "info", message: "tslog hello { id: 1 }" });
  assert.deepEqual(tslogLine("2026-11-02 17:05:07.440\tERROR\tbad"), { level: "error", message: "bad" });
  assert.equal(stripAnsi("\u001b[33mwarn\u001b[39m \u001b]8;;http://x\u0007link\u001b]8;;\u0007"), "warn link");
});

test("pino, winston, consola and tslog in Node: output the same, each call on its line with its level", async () => {
  await ready;
  const dir = path.join(fixtures, "loggers-app");
  const file = path.join(dir, "index.js");
  const plain = runSync(dir, ["index.js"]);
  rx.received.length = 0;
  const hooked = await run(process.execPath, ["index.js"], dir, rx.env());
  // tslog prints the time of each line: the only thing set aside.
  const steady = (s: string) => s.replace(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}/g, "<time>");
  // pino writes from a buffer of its own, after the others, at a moment that
  // depends on timing: each library's own lines are compared, in their order.
  const own = (s: string, re: RegExp) =>
    steady(s)
      .split(/(?<=\n)(?=\S)/)
      .filter((l) => re.test(l));
  for (const re of [/^\{"level"/, /^(info|warn|error): winston/, /^\[\w+\] consola/, /^<time>/]) assert.deepEqual(own(hooked.stdout, re), own(plain.stdout, re));
  assert.equal(steady(hooked.stdout).length, steady(plain.stdout).length);
  assert.equal(hooked.stderr, plain.stderr);
  assert.equal(hooked.status, plain.status);
  assert.ok(plain.stdout.includes('"msg":"pino order placed"') && plain.stdout.includes("info: winston started") && plain.stderr.includes("[warn] consola careful"), plain.stdout);
  const L = expectedLines(file);
  const names = ["pino-info", "pino-warn", "pino-error", "winston-info", "winston-warn", "winston-error", "consola-info", "consola-warn", "consola-error", "tslog-info", "tslog-warn"];
  await until(() => names.every((n) => inFile(rx.received, file).some((e) => e.line === L.get(n))));
  const at = (n: string) => inFile(rx.received, file).find((e) => e.line === L.get(n));
  const got = Object.fromEntries(names.map((n) => [n, [at(n)?.logger, at(n)?.level, at(n)?.preview]]));
  assert.deepEqual(got, {
    "pino-info": ["pino", "info", "pino order placed { order: 7 }"],
    "pino-warn": ["pino", "warn", "pino low stock 3"],
    "pino-error": ["pino", "error", "Error: pino failed"],
    "winston-info": ["winston", "info", "winston started { port: 8080 }"],
    "winston-warn": ["winston", "warn", "winston slow"],
    "winston-error": ["winston", "error", "winston broke"],
    "consola-info": ["consola", "info", "consola ready { mode: 'dev' }"],
    "consola-warn": ["consola", "warn", "consola careful"],
    "consola-error": ["consola", "error", "consola bad"],
    "tslog-info": ["tslog", "info", "tslog hello { id: 1 }"],
    "tslog-warn": ["tslog", "warn", "tslog warned"],
  });
  assert.equal(inFile(rx.received, file).length, names.length, "levels the library leaves out are not recorded, and nothing comes twice");
  assert.equal(rx.received.filter((e) => e.lib).length, 0);
  assert.equal(JSON.parse(at("pino-info")?.json ?? "{}").order, 7, "the fields are kept as JSON for the graph and the diff");
});
