// Code coverage: V8's ranges turned into line hits (painted by hand here),
// and real runs of test-fixtures/coverage-app with the hook and
// NODE_V8_COVERAGE, the way a terminal with coverage on starts them: plain
// JavaScript, TypeScript through tsx (source maps), two runs adding up, and
// a process killed while it runs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { CoverageStore, linesFromSource, linesThroughMap, paint, readReports, reportLines } from "../../src/coverage";
import { fileKey } from "../../src/store";
import { ENV_OPTS, ENV_PORT, ENV_TOKEN } from "../../src/names";
import { startServer, type LogServer } from "../../src/server";
import { cleanEnv, expectedLines } from "../expect";

const root = path.resolve(import.meta.dirname, "..", "..");
const dir = path.join(root, "test-fixtures", "coverage-app");
const hook = path.join(root, "dist", "hook.cjs").replace(/\\/g, "/");
mkdirSync(path.join(root, ".test-build"), { recursive: true });
const tmp = mkdtempSync(path.join(root, ".test-build", "coverage-"));
let server: LogServer;
const ready = startServer(() => undefined).then((s) => (server = s));
after(async () => {
  await server?.close();
  rmSync(tmp, { recursive: true, force: true });
});
const key = (f: string) => fileKey(f, process.platform === "win32" || process.platform === "darwin");

test("inner ranges win over the ranges around them", () => {
  // 0..20 ran once, 5..10 never, 12..15 three times.
  const c = paint(20, [{ ranges: [{ startOffset: 0, endOffset: 20, count: 1 }, { startOffset: 5, endOffset: 10, count: 0 }] }, { ranges: [{ startOffset: 12, endOffset: 15, count: 3 }] }]);
  assert.deepEqual([c[0], c[5], c[9], c[10], c[12], c[14], c[15]], [1, 0, 0, 1, 3, 3, 1]);
});

test("lines from the source: a line ran when any of its code ran; blank and comment lines are left out", () => {
  const src = "a();\n// note\n\nif (x) {\n  b();\n}\n";
  // Everything ran once except the block body "  b();" (offsets 23..29).
  const lines = linesFromSource(src, [{ ranges: [{ startOffset: 0, endOffset: src.length, count: 1 }, { startOffset: 22, endOffset: 30, count: 0 }] }]);
  assert.deepEqual([...lines], [
    [1, 1],
    [4, 1],
    [5, 0],
    [6, 1],
  ]);
});

test("lines through a source map land on the original file's lines", () => {
  // Generated: line 1 "abc", line 2 "def". Segments: gen 1:0 -> src line 10, gen 2:0 -> src line 20.
  const map = { version: 3, sources: ["orig.ts"], mappings: "AASA;AAUA" };
  const out = linesThroughMap([3, 3], map, [{ ranges: [{ startOffset: 0, endOffset: 7, count: 2 }, { startOffset: 4, endOffset: 7, count: 0 }] }], (s) => `/x/${s}`);
  assert.deepEqual([...out.get("/x/orig.ts")!], [
    [10, 2],
    [20, 0],
  ]);
});

test("a file that differs from what V8 ran is skipped; node_modules and node: scripts are never shown", () => {
  const report = {
    result: [
      { url: "node:internal/x", functions: [{ ranges: [{ startOffset: 0, endOffset: 5, count: 1 }] }] },
      { url: "/p/node_modules/lib/a.js", functions: [{ ranges: [{ startOffset: 0, endOffset: 5, count: 1 }] }] },
      { url: "/p/short.js", functions: [{ ranges: [{ startOffset: 0, endOffset: 500, count: 1 }] }] },
      { url: "file:///p/ok.js", functions: [{ ranges: [{ startOffset: 0, endOffset: 4, count: 1 }] }] },
    ],
  };
  const hits = reportLines(report, () => false, (f) => (f.endsWith("ok.js") ? "a();" : "b();"));
  assert.deepEqual([...hits.keys()].map((f) => f.replace(/\\/g, "/")), ["/p/ok.js"]);
});

test("the store adds counts up across runs and clears", () => {
  const s = new CoverageStore(key);
  s.add(new Map([["/p/a.js", new Map([[1, 1], [2, 0]])]]));
  s.add(new Map([["/p/a.js", new Map([[2, 3], [3, 0]])]]));
  assert.deepEqual([...s.lines("/p/a.js")], [[1, 1], [2, 3], [3, 0]]);
  assert.deepEqual(s.summary(), [{ file: "/p/a.js", covered: 2, total: 3 }]);
  s.clear();
  assert.equal(s.size, 0);
});

function run(args: string[], covDir: string, killAfter?: number): Promise<{ stdout: string; status: number | null }> {
  const env = cleanEnv();
  env.NODE_OPTIONS = `--require "${hook}"`;
  env[ENV_PORT] = String(server.port);
  env[ENV_TOKEN] = server.token;
  env[ENV_OPTS] = JSON.stringify({ sourceMaps: true, includeNodeModules: false, browser: true, coverage: true });
  env.NODE_V8_COVERAGE = covDir;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    if (killAfter) setTimeout(() => child.kill("SIGKILL"), killAfter);
    child.on("close", (status) => resolve({ stdout, status }));
  });
}

const collect = (covDir: string, store: CoverageStore) => readReports(covDir, (h) => store.add(h), (f) => key(f).endsWith("/dist/hook.cjs"));

test("real runs: a branch not taken is red, a second run taking it makes it green, a function never called stays red", async () => {
  await ready;
  const covDir = path.join(tmp, "plain");
  const store = new CoverageStore(key);
  const file = path.join(dir, "index.js");
  const L = expectedLines(file);
  assert.equal((await run(["index.js", "a"], covDir)).stdout.trim(), "went a");
  collect(covDir, store);
  let lines = store.lines(file);
  assert.ok(lines.get(L.get("a-branch")!)! > 0, "branch a ran");
  assert.equal(lines.get(L.get("b-branch")!), 0, "branch b did not run");
  assert.equal(lines.get(L.get("never")!), 0);
  assert.ok(lines.get(L.get("top")!)! > 0);
  assert.equal(readdirSync(covDir).length, 0, "reports are removed once read");
  await run(["index.js", "b"], covDir);
  collect(covDir, store);
  lines = store.lines(file);
  assert.ok(lines.get(L.get("a-branch")!)! > 0 && lines.get(L.get("b-branch")!)! > 0, "both branches after two runs");
  assert.equal(lines.get(L.get("never")!), 0, "never called stays red");
  assert.ok(![...store.summary()].some((s) => /node_modules|hook\.cjs/.test(s.file)), "no library or hook files");
});

test("real run: TypeScript through tsx lands on the .ts lines through its source map", async () => {
  await ready;
  const covDir = path.join(tmp, "tsx");
  const store = new CoverageStore(key);
  const file = path.join(dir, "calc.ts");
  const L = expectedLines(file);
  const r = await run([path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "calc.ts"], covDir);
  assert.equal(r.stdout.trim(), "area 6");
  collect(covDir, store);
  const lines = store.lines(file);
  assert.ok(lines.get(L.get("ts-hit")!)! > 0, `ts-hit ran; got ${JSON.stringify([...lines])}`);
  assert.equal(lines.get(L.get("ts-miss")!), 0, "the throw never ran");
  assert.ok(lines.get(L.get("ts-top")!)! > 0);
  assert.ok(!lines.has(3) && !lines.has(4), "type-only lines have no code and no mark");
});

test("real run: a process killed while it runs still sends what it ran (the hook writes coverage every few seconds)", async () => {
  await ready;
  const covDir = path.join(tmp, "forever");
  const store = new CoverageStore(key);
  const file = path.join(dir, "forever.js");
  await run(["forever.js"], covDir, 4_500);
  collect(covDir, store);
  assert.ok(store.lines(file).get(expectedLines(file).get("forever-tick")!)! > 0, JSON.stringify(store.summary()));
});
