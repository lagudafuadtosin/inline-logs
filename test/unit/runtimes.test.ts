// Real runs of the fixture projects with the hook, the way a terminal in VS
// Code starts them: console.table/dir/trace in Node, ts-node, Jest, Vitest,
// Bun, Deno, and the server side of Next.js (Turbopack and webpack). Each
// checks the entries landed on the marked lines and, where the output is
// steady, that the app printed the same with and without the hook.
// Bun and Deno runs are skipped when that runtime is not installed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { startServer, type LogServer } from "../../src/server";
import { startSpool } from "../../src/spool";
import { ENV_OPTS, ENV_PORT, ENV_SPOOL, ENV_TOKEN } from "../../src/names";
import type { Entry } from "../../src/shared/types";
import { cleanEnv, expectedLines } from "../expect";

const root = path.resolve(import.meta.dirname, "..", "..");
const fixtures = path.join(root, "test-fixtures");
const hook = path.join(root, "dist", "hook.cjs").replace(/\\/g, "/");
const win = process.platform === "win32";
mkdirSync(path.join(root, ".test-build"), { recursive: true });
const spoolDir = mkdtempSync(path.join(root, ".test-build", "runtimes-spool-"));

const received: Entry[] = [];
let server: LogServer;
const ready = startServer((e) => received.push(...e)).then((s) => (server = s));
const spool = startSpool(spoolDir, (e) => received.push(...e), 100);
after(async () => {
  spool.close();
  await server?.close();
  rmSync(spoolDir, { recursive: true, force: true });
});

function env(hooked: boolean, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const e = { ...cleanEnv(), ...extra };
  delete e.BUN_OPTIONS;
  if (hooked) {
    e.NODE_OPTIONS = `--require "${hook}"`;
    e.BUN_OPTIONS = `"--preload=${hook}"`;
    e[ENV_PORT] = String(server.port);
    e[ENV_TOKEN] = server.token;
    e[ENV_OPTS] = JSON.stringify({ sourceMaps: true, includeNodeModules: false, browser: true });
    e[ENV_SPOOL] = spoolDir;
  }
  return e;
}

function run(cmd: string, args: string[], dir: string, e: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; status: number | null; pid?: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: dir, env: e, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    child.on("close", (status) => resolve({ stdout, stderr, status, pid: child.pid }));
  });
}

/** Waits until every marked line of `file` has an entry (or 10 s). */
async function linesOf(file: string, names: string[]): Promise<Map<string, Entry>> {
  const marks = expectedLines(file);
  const find = () => new Map(names.map((n) => [n, received.find((e) => path.resolve(e.file).toLowerCase() === file.toLowerCase() && e.line === marks.get(n))!] as const));
  const end = Date.now() + 10_000;
  while (Date.now() < end && [...find().values()].some((e) => !e)) await new Promise((r) => setTimeout(r, 100));
  const got = find();
  for (const [n, e] of got) assert.ok(e, `an entry on line ${marks.get(n)} (${n}) of ${path.basename(file)}; got ${received.filter((x) => path.basename(x.file) === path.basename(file)).map((x) => x.line)}`);
  return got as Map<string, Entry>;
}

const which = (name: string, also: string[]) => {
  const r = spawnSync(win ? "where" : "which", [name], { encoding: "utf8" });
  const found = r.status === 0 ? r.stdout.split(/\r?\n/).find((l) => l && (!win || /\.(exe|cmd)$/i.test(l))) : undefined;
  return found ?? also.find((p) => existsSync(p));
};

test("console.table, console.dir and console.trace in Node: output unchanged, entries say which", async () => {
  await ready;
  const dir = path.join(fixtures, "node-cjs");
  const plain = await run(process.execPath, ["methods.js"], dir, env(false));
  const hooked = await run(process.execPath, ["methods.js"], dir, env(true));
  assert.equal(hooked.stdout, plain.stdout);
  assert.equal(hooked.stderr, plain.stderr, "console.trace prints the same stack");
  const got = await linesOf(path.join(dir, "methods.js"), ["table", "dir", "trace"]);
  assert.equal(got.get("table")!.method, "table");
  assert.equal(got.get("table")!.preview, "table, 2 rows: name, born");
  assert.ok(got.get("table")!.full.includes("│ 1       │ 'Grace' │ 1906 │"));
  assert.equal(got.get("dir")!.method, "dir");
  assert.equal(got.get("dir")!.preview, "{ deep: { deeper: { deepest: { bottom: true } } } }");
  assert.equal(got.get("trace")!.method, "trace");
  assert.equal(got.get("trace")!.preview, "Trace: traced 2");
  assert.ok(/at where .*methods\.js:9:11/.test(got.get("trace")!.full), got.get("trace")!.full);
  // By id, as the extension counts them: under load an entry can also come through the spool file.
  assert.equal(new Set(received.filter((e) => e.file.endsWith("methods.js")).map((e) => e.id)).size, 3, "table's own console.log is not a second entry");
});

test("ts-node: values land on the .ts lines", async () => {
  await ready;
  const dir = path.join(fixtures, "ts-node-app");
  const bin = path.join(dir, "node_modules", "ts-node", "dist", "bin.js");
  const plain = await run(process.execPath, [bin, "index.ts"], dir, env(false));
  const hooked = await run(process.execPath, [bin, "index.ts"], dir, env(true));
  assert.equal(hooked.stdout, plain.stdout);
  assert.equal(hooked.stderr, plain.stderr);
  assert.equal(hooked.status, plain.status);
  const got = await linesOf(path.join(dir, "index.ts"), ["ts-node-log", "ts-node-info"]);
  assert.equal(got.get("ts-node-log")!.preview, "distance 5");
  assert.equal(got.get("ts-node-info")!.level, "info");
});

test("Jest: logs inside tests land on their lines, and Jest prints exactly what it prints without the hook", async () => {
  await ready;
  const dir = path.join(fixtures, "jest-app");
  const bin = path.join(dir, "node_modules", "jest", "bin", "jest.js");
  // Times, and the estimate Jest adds once it has timings from an earlier run.
  const steady = (s: string) => s.replace(/\d+(\.\d+)? ?m?s\b/g, "<t>").replace(/, estimated <t>/g, "");
  const plain = await run(process.execPath, [bin], dir, env(false));
  const hooked = await run(process.execPath, [bin], dir, env(true));
  assert.equal(steady(hooked.stdout), steady(plain.stdout));
  assert.equal(steady(hooked.stderr), steady(plain.stderr), "the 'at' lines Jest prints under each log are unchanged");
  assert.equal(hooked.status, 0);
  const got = await linesOf(path.join(dir, "math.test.js"), ["jest-log", "jest-table", "jest-warn"]);
  assert.equal(got.get("jest-log")!.preview, "jest result { result: 5 }");
  assert.equal(got.get("jest-table")!.method, "table");
  assert.equal(got.get("jest-table")!.preview, "table, 2 rows: a, b");
  assert.equal(got.get("jest-warn")!.level, "warn");
});

test("Jest with worker processes (no timings cached yet): logs from both test files land on their lines", async () => {
  await ready;
  const dir = path.join(fixtures, "jest-app");
  const bin = path.join(dir, "node_modules", "jest", "bin", "jest.js");
  // A fresh cache folder has no timings, so Jest starts workers for two files.
  const cache = mkdtempSync(path.join(root, ".test-build", "jest-cache-"));
  try {
    const hooked = await run(process.execPath, [bin, "--cacheDirectory", cache], dir, env(true));
    assert.equal(hooked.status, 0, hooked.stderr);
    const got = await linesOf(path.join(dir, "second.test.js"), ["jest-second"]);
    assert.equal(got.get("jest-second")!.preview, "jest second [ 'a', 'b' ]");
    assert.notEqual(got.get("jest-second")!.pid, hooked.pid, "logged from a worker, not the jest process");
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test("Vitest: logs inside tests land on their lines (the worker is killed when done: they come through the spool)", async () => {
  await ready;
  const dir = path.join(fixtures, "vitest-app");
  const bin = path.join(dir, "node_modules", "vitest", "vitest.mjs");
  const hooked = await run(process.execPath, [bin, "run"], dir, env(true));
  assert.equal(hooked.status, 0, hooked.stdout + hooked.stderr);
  assert.match(hooked.stdout, /Tests\s+3 passed/);
  const got = await linesOf(path.join(dir, "math.test.js"), ["vitest-log", "vitest-dir", "vitest-info", "vitest-trace"]);
  assert.equal(got.get("vitest-log")!.preview, "vitest result { result: 12 }");
  assert.equal(got.get("vitest-dir")!.method, "dir");
  assert.equal(got.get("vitest-info")!.level, "info");
  assert.equal(got.get("vitest-trace")!.method, "trace");
});

// On Windows a global npm install gives bun.cmd: ask it for the real executable.
const bunFound = which("bun", []);
const bun = bunFound && /\.cmd$/i.test(bunFound) ? spawnSync(`"${bunFound}" -e "console.log(process.execPath)"`, { shell: true, encoding: "utf8" }).stdout.trim() || undefined : bunFound;
test("Bun: BUN_OPTIONS --preload loads the hook", { skip: !bun && "bun is not installed" }, async () => {
  await ready;
  const dir = path.join(fixtures, "bun-app");
  const plain = await run(bun!, ["index.js"], dir, env(false));
  const hooked = await run(bun!, ["index.js"], dir, env(true));
  assert.equal(hooked.stdout, plain.stdout);
  assert.equal(hooked.status, plain.status);
  const got = await linesOf(path.join(dir, "index.js"), ["bun-log", "bun-later"]);
  assert.equal(got.get("bun-log")!.preview, "runtime bun { ok: true }");
  // BUN_OPTIONS must not break other bun commands.
  const v = await run(bun!, ["install", "--help"], dir, env(true));
  assert.equal(v.status, 0, v.stderr);
});

const deno = which("deno", [path.join(root, ".vscode-test", "deno", win ? "deno.exe" : "deno")]);
test("Deno: NODE_OPTIONS --require works with -A, and without permissions the hook stays off and asks nothing", { skip: !deno && "deno is not installed" }, async () => {
  await ready;
  const dir = path.join(fixtures, "deno-app");
  const denoEnv = { DENO_NO_UPDATE_CHECK: "1", DENO_DIR: path.join(root, ".vscode-test", "deno", "cache") };
  const plain = await run(deno!, ["run", "-A", "main.js"], dir, env(false, denoEnv));
  const hooked = await run(deno!, ["run", "-A", "main.js"], dir, env(true, denoEnv));
  assert.equal(hooked.stdout, plain.stdout);
  assert.equal(hooked.stderr, plain.stderr);
  const got = await linesOf(path.join(dir, "main.js"), ["deno-log", "deno-later"]);
  assert.equal(got.get("deno-later")!.level, "warn");
  const before = received.length;
  const locked = await run(deno!, ["run", "--no-prompt", "main.js"], dir, env(true, denoEnv));
  assert.equal(locked.stdout, plain.stdout);
  assert.equal(locked.status, 0, locked.stderr);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(received.length, before, "no permissions, no entries");
});

/** Starts `next dev`, runs `f`, and stops the whole process tree. */
async function withNext(args: string[], port: number, f: () => Promise<void>) {
  const dir = path.join(fixtures, "next-app");
  const child = spawn(process.execPath, [path.join(dir, "node_modules", "next", "dist", "bin", "next"), "dev", ...args, "--port", String(port)], {
    cwd: dir,
    env: env(true, { NEXT_TELEMETRY_DISABLED: "1" }),
    stdio: "ignore",
    detached: !win,
    windowsHide: true,
  });
  try {
    await f();
  } finally {
    if (win) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-child.pid!, "SIGKILL");
  }
}

function get(url: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.get(url, { headers: { accept: "text/html" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", () => resolve(0));
    req.setTimeout(60_000, () => req.destroy());
  });
}

for (const [mode, args, port] of [
  ["Turbopack", [], 5211],
  ["webpack", ["--webpack"], 5212],
] as const) {
  test(`Next.js (${mode}) server: app router page, route handler, Edge route handler and pages router land on their source lines`, { timeout: 240_000 }, async () => {
    await ready;
    await withNext([...args], port, async () => {
      const base = `http://localhost:${port}`;
      const end = Date.now() + 120_000;
      while ((await get(`${base}/api/hello`)) !== 200 && Date.now() < end) await new Promise((r) => setTimeout(r, 500));
      assert.equal(await get(`${base}/`), 200);
      assert.equal(await get(`${base}/legacy`), 200);
      assert.equal(await get(`${base}/api/edge`), 200);
      const app = path.join(fixtures, "next-app");
      await linesOf(path.join(app, "app", "page.js"), ["app-server"]);
      await linesOf(path.join(app, "app", "api", "hello", "route.js"), ["route"]);
      await linesOf(path.join(app, "pages", "legacy.js"), ["pages-server"]);
      // The Edge runtime runs in Next.js's own sandbox (with webpack, from build chunks that never pass through require).
      const edge = await linesOf(path.join(app, "app", "api", "edge", "route.js"), ["edge"]);
      assert.equal(edge.get("edge")!.preview, "edge handler { ok: true, at: 'edge' }");
      const bundled = received.filter((e) => /[\\/]\.next/.test(e.file) || e.file.startsWith("webpack"));
      assert.deepEqual(bundled.map((e) => `${e.file}:${e.line}`), [], "no entry left on a bundle file");
    });
  });
}
