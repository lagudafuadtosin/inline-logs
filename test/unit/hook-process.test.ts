// Runs the fixture apps as real Node processes three ways: without the hook,
// with the hook and a listening server, and with the hook but nothing
// listening. Output and exit codes must match; the entries must land on the
// marked lines.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { startServer, type LogServer } from "../../src/server";
import { ENV_OPTS, ENV_PORT, ENV_TOKEN } from "../../src/names";
import type { Entry } from "../../src/shared/types";
import { cleanEnv, expectedLines } from "../expect";

const root = path.resolve(import.meta.dirname, "..", "..");
const fixtures = path.join(root, "test-fixtures");
const hook = path.join(root, "dist", "hook.cjs").replace(/\\/g, "/");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

const received: Entry[] = [];
let server: LogServer;
const ready = startServer((e) => received.push(...e)).then((s) => (server = s));
after(() => server?.close());

function run(dir: string, args: string[], mode: "plain" | "hooked" | "dead" | "badtoken") {
  const env = cleanEnv();
  if (mode !== "plain") {
    env.NODE_OPTIONS = `--require "${hook}"`;
    env[ENV_PORT] = mode === "dead" ? "1" : String(server.port);
    env[ENV_TOKEN] = mode === "badtoken" ? "x".repeat(48) : server.token;
    env[ENV_OPTS] = JSON.stringify({ sourceMaps: true, includeNodeModules: false, browser: true });
  }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: path.join(fixtures, dir), env, encoding: "utf8", timeout: 30_000 });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status, ms: Date.now() - t0 };
}

const cases: { name: string; dir: string; args: string[]; file: string; expect: string[] }[] = [
  { name: "CommonJS", dir: "node-cjs", args: ["index.js"], file: "node-cjs/index.js", expect: ["user", "map", "warn", "error-log", "loop", "class", "printf", "later"] },
  { name: "crash", dir: "node-cjs", args: ["crash.js"], file: "node-cjs/crash.js", expect: ["before", "throw"] },
  { name: "process.exit", dir: "node-cjs", args: ["exit.js"], file: "node-cjs/exit.js", expect: ["exit"] },
  { name: "unhandled rejection", dir: "node-cjs", args: ["rejection.js"], file: "node-cjs/rejection.js", expect: ["reject"] },
  { name: "ESM", dir: "node-esm", args: ["index.mjs"], file: "node-esm/index.mjs", expect: ["config", "waited", "area"] },
  { name: "TypeScript (tsx)", dir: "ts-tsx", args: [tsxCli, "index.ts"], file: "ts-tsx/index.ts", expect: ["total", "all"] },
];

for (const c of cases) {
  test(`${c.name}: output unchanged, entries on the marked lines`, async () => {
    await ready;
    assert.ok(existsSync(hook), "run the build first (dist/hook.cjs)");
    const file = path.join(fixtures, c.file);
    const plain = run(c.dir, c.args, "plain");
    received.length = 0;
    const hooked = run(c.dir, c.args, "hooked");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(hooked.stdout, plain.stdout, "stdout is the same with the hook");
    assert.equal(hooked.stderr, plain.stderr, "stderr is the same with the hook");
    assert.equal(hooked.status, plain.status, "exit code is the same with the hook");

    const lines = expectedLines(file);
    const mine = received.filter((e) => path.resolve(e.file).toLowerCase() === file.toLowerCase());
    for (const name of c.expect) {
      const line = lines.get(name)!;
      assert.ok(mine.some((e) => e.line === line), `an entry on line ${line} (${name}); got lines ${mine.map((e) => e.line).join(",")}`);
    }
    assert.equal(received.filter((e) => e.lib).length, 0, "nothing from node_modules");
    assert.equal(mine.length, received.length, `every entry is from the app file; got ${received.map((e) => `${e.file}:${e.line}`).join(", ")}`);
  });

  test(`${c.name}: nothing listening leaves the app untouched`, async () => {
    await ready;
    const plain = run(c.dir, c.args, "plain");
    const dead = run(c.dir, c.args, "dead");
    assert.equal(dead.stdout, plain.stdout);
    assert.equal(dead.stderr, plain.stderr);
    assert.equal(dead.status, plain.status);
    assert.ok(dead.ms < plain.ms + 1500, `no long wait: ${dead.ms} ms vs ${plain.ms} ms`);
  });
}

test("a wrong token is refused and the app is untouched", async () => {
  await ready;
  received.length = 0;
  const plain = run("node-cjs", ["index.js"], "plain");
  const bad = run("node-cjs", ["index.js"], "badtoken");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(bad.stdout, plain.stdout);
  assert.equal(bad.status, plain.status);
  assert.equal(received.length, 0);
});

test("no variables, no hook: the hook file alone does nothing", async () => {
  const env = cleanEnv();
  env.NODE_OPTIONS = `--require "${hook}"`;
  const r = spawnSync(process.execPath, ["-e", "console.log(typeof globalThis.__inlineLogsInstalled, console.log.name)"], { env, encoding: "utf8" });
  assert.equal(r.stdout.trim(), "undefined log");
});

test("console methods keep their names and return values", async () => {
  await ready;
  const env = cleanEnv();
  env.NODE_OPTIONS = `--require "${hook}"`;
  env[ENV_PORT] = String(server.port);
  env[ENV_TOKEN] = server.token;
  const r = spawnSync(process.execPath, ["-e", "const r = console.log('x'); console.info(console.log.name, console.warn.name, r)"], { env, encoding: "utf8" });
  assert.equal(r.stdout, "x\nlog warn undefined\n");
});
