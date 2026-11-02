// The spool file: entries written at once by the hook, read by the
// extension, for processes that end with no chance to send. The last test
// kills a real process outright (TerminateProcess on Windows, SIGKILL
// elsewhere) right after it logs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { startSpool } from "../../src/spool";
import { startServer } from "../../src/server";
import { ENV_OPTS, ENV_PORT, ENV_SPOOL, ENV_TOKEN } from "../../src/names";
import type { Entry } from "../../src/shared/types";
import { cleanEnv, expectedLines } from "../expect";

const root = path.resolve(import.meta.dirname, "..", "..");
mkdirSync(path.join(root, ".test-build"), { recursive: true });
const tmp = mkdtempSync(path.join(root, ".test-build", "spool-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const entry = (line: number): Entry => ({ id: `9:${n++}`, kind: "log", level: "log", file: "/app/a.js", line, col: 1, preview: "x", full: "x", time: 0, source: "node", pid: 9 });

test("reads whole lines, waits for a line still being written, starts over after the hook empties the file", () => {
  const dir = path.join(tmp, "read");
  const got: Entry[] = [];
  const spool = startSpool(dir, (e) => got.push(...e), 60_000);
  // A live pid (ours), so the file is not removed.
  const file = path.join(dir, `${process.pid}-aa.jsonl`);
  writeFileSync(file, JSON.stringify(entry(1)) + "\n" + JSON.stringify(entry(2)).slice(0, 10));
  spool.read();
  assert.deepEqual(got.map((e) => e.line), [1]);
  appendFileSync(file, JSON.stringify(entry(2)).slice(10) + "\n");
  spool.read();
  assert.deepEqual(got.map((e) => e.line), [1, 2]);
  truncateSync(file, 0);
  appendFileSync(file, JSON.stringify(entry(3)) + "\nnot json\n");
  spool.read();
  assert.deepEqual(got.map((e) => e.line), [1, 2, 3]);
  assert.ok(existsSync(file), "the process is alive: the file stays");
  spool.close();
});

test("a file whose process is gone is removed once it is read", () => {
  const dir = path.join(tmp, "dead");
  const got: Entry[] = [];
  const spool = startSpool(dir, (e) => got.push(...e), 60_000);
  // pid 2147483646 does not exist.
  const file = path.join(dir, "2147483646-bb.jsonl");
  writeFileSync(file, JSON.stringify(entry(7)) + "\n");
  spool.read();
  assert.deepEqual(got.map((e) => e.line), [7]);
  assert.equal(existsSync(file), false);
  spool.close();
});

test("a process killed outright right after it logs: its entries come through the spool", async () => {
  const dir = path.join(tmp, "killed");
  const got: Entry[] = [];
  const spool = startSpool(dir, (e) => got.push(...e), 100);
  // A server that never answers: nothing can arrive over HTTP.
  const server = await startServer(() => undefined);
  const silent = await import("node:http").then((http) => {
    const s = http.createServer(() => undefined);
    return new Promise<import("node:http").Server>((r) => s.listen(0, "127.0.0.1", () => r(s)));
  });
  const port = (silent.address() as import("node:net").AddressInfo).port;
  const file = path.join(root, "test-fixtures", "node-cjs", "killed.js");
  const env = cleanEnv();
  env.NODE_OPTIONS = `--require "${path.join(root, "dist", "hook.cjs").replace(/\\/g, "/")}"`;
  env[ENV_PORT] = String(port);
  env[ENV_TOKEN] = server.token;
  env[ENV_OPTS] = JSON.stringify({ sourceMaps: true, includeNodeModules: false, browser: false });
  env[ENV_SPOOL] = dir;
  const child = spawn(process.execPath, [file], { cwd: path.dirname(file), env, stdio: ["ignore", "pipe", "inherit"] });
  // The fixture prints "ready" after its logs; then it is killed with no warning.
  await new Promise<void>((resolve) => child.stdout!.on("data", (d: Buffer) => d.toString().includes("ready") && resolve()));
  child.kill("SIGKILL");
  await new Promise((r) => child.on("exit", r));
  const want = expectedLines(file).get("killed")!;
  const end = Date.now() + 5_000;
  while (!got.some((e) => e.line === want) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  assert.ok(got.some((e) => e.line === want && e.preview.includes("last words")), `entry on line ${want}; got ${got.map((e) => e.line)}`);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(readdirSync(dir), [], "the file is removed once read");
  spool.close();
  silent.close();
  await server.close();
});
