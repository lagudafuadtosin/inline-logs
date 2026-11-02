// The one-line setup for a terminal outside VS Code: pasted into a real
// PowerShell, Command Prompt and bash, then an app started there reports to
// the window. Also a plain process with nothing but those variables.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { setupLine, setupVars, type SetupVars } from "../../src/setup";
import { expectedLines, cleanEnv } from "../expect";
import { fixtures, hook, inFile, receiver, root, run, until, type Receiver } from "../hooked";

let rx: Receiver;
const ready = receiver().then((r) => (rx = r));
after(() => rx?.server.close());

const dir = path.join(fixtures, "outside-app");
const file = path.join(dir, "index.js");
const node = process.execPath;
const win = process.platform === "win32";

function vars(): SetupVars {
  const spool = path.join(root, ".test-build", "outside-spool");
  mkdirSync(spool, { recursive: true });
  return { hook, port: rx.server.port, token: rx.server.token, opts: JSON.stringify({ sourceMaps: true, requests: true }), spool };
}

async function arrived(): Promise<boolean> {
  const L = expectedLines(file);
  return until(() => ["outside", "outside-warn"].every((n) => inFile(rx.received, file).some((e) => e.line === L.get(n))), 8_000);
}

test("the line for each shell sets the port, the key, the options and the hook", () => {
  const v: SetupVars = { hook: "C:/x y/hook.cjs", port: 4321, token: "abc", opts: '{"a":true}', spool: "C:\\s p\\spool" };
  assert.equal(
    setupLine("powershell", v),
    `$env:NODE_OPTIONS = ("$env:NODE_OPTIONS " + '--require "C:/x y/hook.cjs"').Trim(); $env:BUN_OPTIONS = ("$env:BUN_OPTIONS " + '"--preload=C:/x y/hook.cjs"').Trim(); $env:INLINE_LOGS_PORT = '4321'; $env:INLINE_LOGS_TOKEN = 'abc'; $env:INLINE_LOGS_OPTS = '{"a":true}'; $env:INLINE_LOGS_SPOOL = 'C:\\s p\\spool'`,
  );
  assert.equal(setupLine("cmd", v), `set "NODE_OPTIONS=--require "C:/x y/hook.cjs"" & set "BUN_OPTIONS="--preload=C:/x y/hook.cjs"" & set "INLINE_LOGS_PORT=4321" & set "INLINE_LOGS_TOKEN=abc" & set "INLINE_LOGS_OPTS={"a":true}" & set "INLINE_LOGS_SPOOL=C:\\s p\\spool"`);
  assert.equal(setupLine("posix", { ...v, spool: "/tmp/it's" }), `export NODE_OPTIONS="\${NODE_OPTIONS:+$NODE_OPTIONS }"'--require "C:/x y/hook.cjs"' BUN_OPTIONS="\${BUN_OPTIONS:+$BUN_OPTIONS }"'"--preload=C:/x y/hook.cjs"' INLINE_LOGS_PORT='4321' INLINE_LOGS_TOKEN='abc' INLINE_LOGS_OPTS='{"a":true}' INLINE_LOGS_SPOOL='/tmp/it'\\''s'`);
  assert.ok(setupLine("fish", v).startsWith(`set -gx NODE_OPTIONS (string trim -- "$NODE_OPTIONS "'--require "C:/x y/hook.cjs"')`));
  assert.deepEqual(
    setupVars({ ...v, coverage: "C:/cov" }).map(([k]) => k),
    ["INLINE_LOGS_PORT", "INLINE_LOGS_TOKEN", "INLINE_LOGS_OPTS", "INLINE_LOGS_SPOOL", "NODE_V8_COVERAGE", "DENO_COVERAGE_DIR"],
  );
});

test("a plain process with only those variables reports to the window", async () => {
  await ready;
  rx.received.length = 0;
  const env: NodeJS.ProcessEnv = { NODE_OPTIONS: `--require "${hook}"` };
  for (const [k, x] of setupVars(vars())) env[k] = x;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const r = await run(node, ["index.js"], dir, env);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(await arrived(), JSON.stringify(rx.received.map((e) => `${e.file}:${e.line}`)));
});

test("PowerShell: paste the line, start the app, the values arrive", { skip: !win }, async () => {
  await ready;
  rx.received.length = 0;
  const script = `${setupLine("powershell", vars())}; & "${node}" index.js`;
  const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], dir, cleanEnv());
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("outside terminal"), r.stdout);
  assert.ok(await arrived(), JSON.stringify(rx.received.map((e) => `${e.file}:${e.line}`)));
});

test("Command Prompt: paste the line, start the app, the values arrive", { skip: !win }, async () => {
  await ready;
  rx.received.length = 0;
  const line = `${setupLine("cmd", vars())} & "${node}" index.js`;
  const r = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
    const c = spawn("cmd.exe", ["/d", "/s", "/c", `"${line}"`], { cwd: dir, env: cleanEnv(), windowsVerbatimArguments: true, windowsHide: true });
    let stderr = "";
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => resolve({ status, stderr }));
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(await arrived(), JSON.stringify(rx.received.map((e) => `${e.file}:${e.line}`)));
});

const bash = ["C:\\Program Files\\Git\\bin\\bash.exe", "/bin/bash"].find((p) => existsSync(p));
test("bash: paste the line, start the app, the values arrive", { skip: !bash }, async () => {
  await ready;
  rx.received.length = 0;
  const r = await run(bash!, ["-c", `${setupLine("posix", vars())}; "${node.replace(/\\/g, "/")}" index.js`], dir, cleanEnv());
  assert.equal(r.status, 0, r.stderr);
  assert.ok(await arrived(), JSON.stringify(rx.received.map((e) => `${e.file}:${e.line}`)));
});

test("a wrong key from outside is refused", async () => {
  await ready;
  rx.received.length = 0;
  const v = { ...vars(), token: "f".repeat(48) };
  const env: NodeJS.ProcessEnv = { ...cleanEnv(), NODE_OPTIONS: `--require "${hook}"` };
  for (const [k, x] of setupVars(v)) env[k] = x;
  delete env.INLINE_LOGS_SPOOL;
  const r = await run(node, ["index.js"], dir, env);
  assert.equal(r.status, 0);
  await new Promise((z) => setTimeout(z, 300));
  assert.equal(rx.received.length, 0);
});
