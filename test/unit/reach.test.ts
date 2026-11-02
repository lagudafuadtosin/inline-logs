// The 0.5.0 work: each test runs real fixture programs with the hook (or the
// part in question on its own) and checks a limit of 0.4.0 is gone: bun
// test, node:http and WebSockets in Bun and Deno, the ws package, compressed
// http bodies, a Request object's body, total time, Jest's values and
// --silent, tslog's JSON, React Router on Vite 7, a
// custom webpack server loaded with import, two identical Astro lines, the
// spool folder watched, calls side by side on a line, the graph drawn in
// parts, Deno coverage, and the new request kinds' text.
// Bun, Deno and Chrome runs are skipped when that program is not installed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as zlib from "node:zlib";
import { createRequire } from "node:module";
import { startSpool } from "../../src/spool";
import { ENV_SPOOL } from "../../src/names";
import { Store } from "../../src/store";
import type { Entry } from "../../src/shared/types";
import { requestFields } from "../../src/shared/request";
import { unpack } from "../../src/hook/requests";
import { tslogJson } from "../../src/hook/loggers";
import { astroScriptLine, isDevServerProcess, noteDevCompiler } from "../../src/hook/browser";
import { isViteDevProcess } from "../../src/hook/nodemap";
import { buildGraph, expandRow, layout, moreRows, MAX_ROWS } from "../../src/graph/layout";
import { readReports, reportLines } from "../../src/coverage";
import { expectedLines } from "../expect";
import { fixtures, inFile, receiver, root, run, runSync, until, wait, type Receiver } from "../hooked";

const win = process.platform === "win32";
mkdirSync(path.join(root, ".test-build"), { recursive: true });
const tmp = mkdtempSync(path.join(root, ".test-build", "reach-"));
let rx: Receiver;
const ready = receiver().then((r) => (rx = r));
const spool = startSpool(path.join(tmp, "spool"), (e) => rx?.received.push(...e), 100);
after(async () => {
  spool.close();
  await rx?.server.close();
  rmSync(tmp, { recursive: true, force: true });
});

const which = (name: string, also: string[]) => {
  const r = spawnSync(win ? "where" : "which", [name], { encoding: "utf8" });
  const found = r.status === 0 ? r.stdout.split(/\r?\n/).find((l) => l && (!win || /\.(exe|cmd)$/i.test(l))) : undefined;
  return found ?? also.find((p) => existsSync(p));
};
const bunFound = which("bun", []);
const bun = bunFound && /\.cmd$/i.test(bunFound) ? spawnSync(`"${bunFound}" -e "console.log(process.execPath)"`, { shell: true, encoding: "utf8" }).stdout.trim() || undefined : bunFound;
const deno = which("deno", [path.join(root, ".vscode-test", "deno", win ? "deno.exe" : "deno")]);
const denoEnv = { DENO_NO_UPDATE_CHECK: "1", DENO_DIR: path.join(root, ".vscode-test", "deno", "cache") };
const chrome = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));

/** The hooked env, with BUN_OPTIONS and the spool folder too. */
const env = (extra: NodeJS.ProcessEnv = {}) => {
  const e = { ...rx.env(), ...extra };
  e.BUN_OPTIONS = `"--preload=${path.join(root, "dist", "hook.cjs").replace(/\\/g, "/")}"`;
  e[ENV_SPOOL] = path.join(tmp, "spool");
  return e;
};
const plainEnv = (extra: NodeJS.ProcessEnv = {}) => {
  const e = { ...rx.env(), ...extra };
  for (const k of Object.keys(e)) if (/^INLINE_LOGS_|^NODE_OPTIONS$|^BUN_OPTIONS$/i.test(k)) delete e[k];
  return e;
};
/** Entries on a marked line, each once (one can come over HTTP and through the spool file). */
const at = (file: string, name: string) => {
  const seen = new Set<string>();
  return inFile(rx.received, file).filter((e) => e.line === expectedLines(file).get(name) && !seen.has(e.id) && !!seen.add(e.id));
};

/** Starts the WebSocket echo server of sockets-app on a port. */
function echo(port: number): ChildProcess {
  return spawn(process.execPath, ["echo.js", String(port)], { cwd: path.join(fixtures, "sockets-app"), stdio: "ignore", windowsHide: true });
}

function get(url: string, headers: Record<string, string> = { accept: "text/html" }): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = http.get(url, { headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", () => resolve({ status: 0, body: "" }));
    req.setTimeout(60_000, () => req.destroy());
  });
}

/** Stops a dev server started with spawn, and everything it started. */
function stop(child: ChildProcess): void {
  if (win) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else process.kill(-child.pid!, "SIGKILL");
}

// ---- runtimes ----

test("bun test: a log inside a test lands on its line (bun test fires no exit events, the spool file brings it)", { skip: !bun && "bun is not installed" }, async () => {
  await ready;
  const dir = path.join(fixtures, "bun-app");
  const file = path.join(dir, "math.test.js");
  const r = await run(bun!, ["test", "./math.test.js"], dir, env());
  assert.equal(r.status, 0, r.stderr);
  assert.ok(await until(() => at(file, "bun-test-log").length > 0, 8_000), JSON.stringify(inFile(rx.received, file)));
  assert.equal(at(file, "bun-test-log")[0].preview, "bun test result { result: 5 }");
});

for (const [name, cmd, args] of [
  ["Bun", bun, ["requests.cjs"]],
  ["Deno", deno, ["run", "-A", "requests.cjs"]],
  ["Node", process.execPath, ["requests.cjs"]],
] as const) {
  test(`${name}: node:http, a Request object's body and the global WebSocket, on their lines`, { skip: !cmd && `${name.toLowerCase()} is not installed` }, async () => {
    await ready;
    const dir = path.join(fixtures, "deno-app");
    const file = path.join(dir, "requests.cjs");
    const port = 5290 + ["Bun", "Deno", "Node"].indexOf(name);
    const server = echo(port);
    try {
      await wait(800);
      const plain = await run(cmd!, [...args, String(port)], dir, plainEnv(denoEnv));
      // The same file runs in each runtime: only this run's entries.
      rx.received.length = 0;
      const hooked = await run(cmd!, [...args, String(port)], dir, env(denoEnv));
      assert.equal(hooked.status, 0, hooked.stderr);
      assert.equal(hooked.stdout.replace(/:\d+\//g, ":P/"), plain.stdout.replace(/:\d+\//g, ":P/"));
      await until(() => at(file, "rt-ws").some((e) => e.request?.ws?.event === "close"), 8_000);
      const getE = at(file, "rt-http-get").find((e) => e.kind === "request");
      const post = at(file, "rt-http-post").find((e) => e.kind === "request");
      const req = at(file, "rt-fetch-request").find((e) => e.kind === "request");
      assert.match(getE?.preview ?? "", /^GET 200 · \d+ ms · http:\/\/127\.0\.0\.1:\d+\/get$/);
      assert.equal(post?.request?.api, "http");
      assert.equal(post?.request?.requestBody, '{"n":1,"password":"[redacted]"}');
      assert.equal(req?.request?.requestBody, '{"via":"Request","token":"[redacted]"}', "a Request object's own body, read from a clone");
      assert.equal(req?.request?.responseBody?.includes('"path":"/req"'), true);
      assert.deepEqual(at(file, "rt-ws").map((e) => e.request?.ws?.event), ["open", "message", "close"]);
      assert.equal(at(file, "rt-ws-send")[0]?.preview, "WS ↑ 7 B · rt ping");
    } finally {
      server.kill();
    }
  });
}

test("the ws package: a client socket's open, messages and close on its lines, its server's own sockets left out", async () => {
  await ready;
  const dir = path.join(fixtures, "sockets-app");
  const file = path.join(dir, "wspkg.js");
  const plain = runSync(dir, ["wspkg.js"]);
  const hooked = await run(process.execPath, ["wspkg.js"], dir, env());
  assert.equal(hooked.stdout, plain.stdout);
  assert.equal(hooked.status, plain.status);
  await until(() => at(file, "wspkg-open").some((e) => e.request?.ws?.event === "close"));
  assert.deepEqual(at(file, "wspkg-open").map((e) => e.request?.ws?.event), ["open", "message", "close"], "the handshake is not an http entry of its own");
  assert.match(at(file, "wspkg-open")[0].preview, /^WS open · \d+ ms · ws:\/\/127\.0\.0\.1:\d+\/feed\?token=%5Bredacted%5D$/);
  assert.equal(at(file, "wspkg-send")[0]?.preview, 'WS ↑ 30 B · {"hi":"pkg","secret":"[redacted]"}');
  assert.equal(at(file, "wspkg-open")[2].preview.startsWith("WS close 1000 bye"), true);
  assert.equal(new Set(inFile(rx.received, file).filter((e) => e.request?.api === "websocket").map((e) => e.id)).size, 4, "the echo server's socket is not recorded");
  assert.ok(!JSON.stringify(rx.received).includes("s3cret"));
});

test("the ws package and node:http: an error the app does not handle still ends it, and Node prints the same", async () => {
  await ready;
  const dir = path.join(fixtures, "sockets-app");
  const plain = runSync(dir, ["wspkg-crash.js"]);
  const hooked = await run(process.execPath, ["wspkg-crash.js"], dir, env());
  assert.notEqual(plain.status, 0);
  assert.equal(hooked.status, plain.status);
  assert.equal(hooked.stderr, plain.stderr, "the 'Emitted error event' trace names no frame of ours");
  const file = path.join(dir, "wspkg-crash.js");
  assert.ok(await until(() => inFile(rx.received, file).some((e) => e.kind === "request" && e.level === "error")));
});

// ---- request bodies and times ----

test("node:http: gzip, deflate and br bodies are unpacked from a copy, the app unpacks its own as before", async () => {
  await ready;
  const dir = path.join(fixtures, "requests-app");
  const file = path.join(dir, "compressed.js");
  const plain = runSync(dir, ["compressed.js"]);
  const hooked = await run(process.execPath, ["compressed.js"], dir, env());
  assert.equal(hooked.stdout, plain.stdout);
  assert.equal(hooked.stdout.split("\n").filter((l) => l.includes('"Stirling"')).length, 3);
  await until(() => at(file, "zip-get").filter((e) => e.kind === "request").length === 3);
  const reqs = at(file, "zip-get").filter((e) => e.kind === "request");
  assert.deepEqual(reqs.map((e) => e.request?.responseHeaders?.["content-encoding"]).sort(), ["br", "deflate", "gzip"]);
  for (const e of reqs) {
    assert.equal(e.request?.responseBody, '{"city":"Stirling","token":"[redacted]","n":42}');
    assert.ok(e.request!.totalMs! >= e.request!.ms, "the body's end is after its headers");
  }
  assert.ok(!JSON.stringify(reqs).includes("zip-secret"), "the secret in the body is redacted (the app logs it itself)");
});

test("unpack: bytes cut short unpack as far as they go, unknown encodings and bad bytes give nothing", () => {
  const text = JSON.stringify({ list: Array.from({ length: 2_000 }, (_, i) => i) });
  assert.equal(unpack(zlib.gzipSync(text), "gzip"), text);
  assert.equal(unpack(zlib.deflateRawSync(text), "deflate"), text, "raw deflate too");
  const cut = unpack(zlib.gzipSync(text).subarray(0, 200), "gzip");
  assert.ok(cut !== undefined && cut.length > 0 && text.startsWith(cut));
  assert.equal(unpack(Buffer.from("not packed"), "gzip"), undefined);
  assert.equal(unpack(zlib.gzipSync(text), "compress"), undefined);
});

test("fetch in Node: the total time reaches the end of the body", async () => {
  await ready;
  const dir = path.join(fixtures, "requests-app");
  const file = path.join(dir, "index.js");
  await run(process.execPath, ["index.js"], dir, env());
  await until(() => at(file, "fetch-big").some((e) => e.kind === "request"));
  const big = at(file, "fetch-big").find((e) => e.kind === "request")!;
  assert.ok(big.request!.totalMs !== undefined && big.request!.totalMs >= big.request!.ms, JSON.stringify(big.request));
  assert.match(big.full, /^200 OK in \d+ ms, body done after \d+ ms$/m);
  assert.equal(big.request!.responseBody!.length > 15_000, true, "the kept text is still cut at its limit");
});

// ---- test runners and logging libraries ----

test("Jest: a log's values are the values (JSON for the graph), and with --silent they are still recorded", async () => {
  await ready;
  const dir = path.join(fixtures, "jest-app");
  const file = path.join(dir, "math.test.js");
  const bin = path.join(dir, "node_modules", "jest", "bin", "jest.js");
  const steady = (s: string) => s.replace(/\d+(\.\d+)? ?m?s\b/g, "<t>").replace(/, estimated <t>/g, "");
  rx.received.length = 0;
  const hooked = await run(process.execPath, [bin, "math.test.js"], dir, env());
  assert.equal(hooked.status, 0, hooked.stderr);
  await until(() => at(file, "jest-log").length > 0);
  assert.equal(at(file, "jest-log")[0].preview, "jest result { result: 5 }");
  assert.equal(at(file, "jest-log")[0].json, JSON.stringify(["jest result", { result: 5 }]));
  rx.received.length = 0;
  const plainSilent = await run(process.execPath, [bin, "--silent", "math.test.js"], dir, plainEnv());
  const silent = await run(process.execPath, [bin, "--silent", "math.test.js"], dir, env());
  assert.equal(steady(silent.stdout), steady(plainSilent.stdout));
  assert.equal(steady(silent.stderr), steady(plainSilent.stderr), "--silent prints nothing more with the hook");
  assert.ok(!silent.stderr.includes("jest result"));
  await until(() => at(file, "jest-log").length > 0 && at(file, "jest-warn").length > 0);
  assert.equal(at(file, "jest-log")[0]?.preview, "jest result { result: 5 }");
  assert.equal(at(file, "jest-warn")[0]?.level, "warn");
});

test("tslog JSON: a line with tslog's position lands there, one with none is left out, output unchanged", async () => {
  await ready;
  const dir = path.join(fixtures, "loggers-app");
  const file = path.join(dir, "tsjson.mjs");
  const plain = runSync(dir, ["tsjson.mjs"]);
  const hooked = await run(process.execPath, ["tsjson.mjs"], dir, env());
  const steady = (s: string) => s.replace(/"(time|date)":"[^"]+"/g, '"$1":"T"');
  assert.equal(steady(hooked.stdout), steady(plain.stdout));
  await until(() => at(file, "tslog-json-warn").length > 0);
  assert.deepEqual([at(file, "tslog-json-info")[0]?.level, at(file, "tslog-json-info")[0]?.preview, at(file, "tslog-json-info")[0]?.logger], ["info", "tslog json placed { order: 9 }", "tslog"]);
  assert.equal(at(file, "tslog-json-warn")[0]?.level, "warn");
  await wait(300);
  assert.equal(at(file, "tslog-json-none").length, 0);
  assert.deepEqual(tslogJson('{"0":"v4 style","_meta":{"logLevelName":"ERROR","path":{"fullFilePath":"/app/a.ts:3:5","fileLine":"3","fileColumn":"5"}}}\nnot json\n'), [
    { logger: "tslog", level: "error", stack: "    at tslog (/app/a.ts:3:5)", preview: "v4 style", full: "v4 style", json: undefined },
  ]);
});

// ---- frameworks ----

/** Starts a dev server with the hook, waits for `ready`, runs `f`, and stops it. */
async function devServer(dir: string, args: string[], readyUrl: string, f: () => Promise<void>): Promise<void> {
  const child = spawn(process.execPath, args, { cwd: dir, env: env(), stdio: "ignore", detached: !win, windowsHide: true });
  try {
    const end = Date.now() + 120_000;
    while ((await get(readyUrl)).status !== 200 && Date.now() < end) await wait(500);
    await f();
  } finally {
    stop(child);
  }
}

// Next.js Edge route handlers are checked with the other Next.js routes in runtimes.test.ts (one dev server per project at a time).

test("React Router 7 on Vite 7: a loader's server log lands on its own line", { timeout: 180_000 }, async () => {
  await ready;
  const dir = path.join(fixtures, "react-router-app");
  const file = path.join(dir, "app", "routes", "home.jsx");
  await devServer(dir, [path.join(dir, "node_modules", "@react-router", "dev", "bin.js"), "dev", "--port", "5216", "--strictPort"], "http://localhost:5216/", async () => {
    assert.ok(await until(() => inFile(rx.received, file).some((e) => e.preview.startsWith("rr loader")), 10_000));
    const loader = inFile(rx.received, file).find((e) => e.preview.startsWith("rr loader"))!;
    assert.equal(loader.line, expectedLines(file).get("rr-server"), `the loader's line, not the line in the code Vite runs (${loader.line})`);
  });
});

test("a Vite dev server is known by its command, and only then are its inline maps read", () => {
  assert.equal(isViteDevProcess(["node", "/app/node_modules/vite/bin/vite.js"]), true);
  assert.equal(isViteDevProcess(["node", "/app/node_modules/vite/bin/vite.js", "build"]), false);
  assert.equal(isViteDevProcess(["node", "/app/node_modules/@react-router/dev/bin.js", "dev"]), true);
  assert.equal(isViteDevProcess(["node", "/app/server.js"]), false);
});

test("a custom webpack dev server loaded with import gets the browser script", { timeout: 120_000 }, async () => {
  await ready;
  const dir = path.join(fixtures, "webpack-app");
  const child = spawn(process.execPath, ["server.mjs", "5217"], { cwd: dir, env: env(), stdio: "ignore", detached: !win, windowsHide: true });
  try {
    let page = { status: 0, body: "" };
    const end = Date.now() + 90_000;
    while (page.status !== 200 && Date.now() < end) {
      await wait(500);
      page = await get("http://localhost:5217/");
    }
    assert.equal(page.status, 200);
    assert.ok(page.body.includes("__INLINE_LOGS__"), page.body.slice(0, 300));
  } finally {
    stop(child);
  }
});

test("webpack's compiler watched by webpack-dev-middleware makes the process a dev server, however it was loaded", () => {
  class Compiler {
    watch(_o: unknown, cb: () => void) {
      cb();
      return "watching";
    }
  }
  noteDevCompiler(Compiler as unknown as { prototype: Record<string, unknown> });
  assert.equal(new Compiler().watch({}, () => undefined), "watching", "watch works as before");
  assert.equal(isDevServerProcess(["node", "/app/build.js"], {}, {}), false, "a watch from the app's own script is not a dev server");
  // The same call, made from a file in webpack-dev-middleware.
  const from = path.join(tmp, "node_modules", "webpack-dev-middleware", "dist", "index.js");
  mkdirSync(path.dirname(from), { recursive: true });
  writeFileSync(from, "module.exports = (c) => c.watch({}, () => undefined);");
  (createRequire(import.meta.url)(from) as (c: Compiler) => void)(new Compiler());
  assert.equal(isDevServerProcess(["node", "/app/build.js"], {}, {}), true);
});

test("Astro: of two identical lines in one <script>, the second lands on the second", () => {
  const file = path.join(fixtures, "astro-app", "src", "pages", "index.astro");
  const L = expectedLines(file);
  const text = 'console.log("astro twin", twins.length);';
  assert.equal(astroScriptLine(file, 1, text, 1, 0)?.line, L.get("astro-twin-1"));
  assert.equal(astroScriptLine(file, 1, text, 1, 1)?.line, L.get("astro-twin-2"));
  assert.equal(astroScriptLine(file, 1, text, 1, 5)?.line, L.get("astro-twin-1"), "more than the file has: the first");
});

// ---- the extension's own parts ----

test("the spool folder is watched: a file written by a process is read at once, without waiting for the timer", async () => {
  const dir = path.join(tmp, "watched");
  const got: Entry[] = [];
  const s = startSpool(dir, (e) => got.push(...e), 60_000);
  try {
    const e: Entry = { id: "8:1", kind: "log", level: "log", file: "/app/a.js", line: 4, col: 1, preview: "x", full: "x", time: 0, source: "node", pid: 8 };
    writeFileSync(path.join(dir, `${process.pid}-cc.jsonl`), JSON.stringify(e) + "\n");
    assert.ok(await until(() => got.length === 1, 1_500), "read within a moment, with a 60 s timer");
  } finally {
    s.close();
  }
});

test("a line keeps each call's newest entry, left to right: a request and the log in its callback", () => {
  const store = new Store(false);
  const base = { kind: "log" as const, level: "log" as const, file: "/app/a.js", line: 3, full: "", time: 0, source: "node" as const, pid: 1 };
  store.add([
    { ...base, id: "1", col: 30, preview: "user { a: 1 }" },
    { ...base, id: "2", kind: "request", col: 5, preview: "GET 200 · 3 ms · http://h/u" },
    { ...base, id: "3", col: 30, preview: "user { a: 2 }" },
    { ...base, id: "4", kind: "error", col: 50, preview: "Error: boom" },
    { ...base, id: "5", col: 50, preview: "after the error" },
  ]);
  const info = store.lines("/app/a.js")[0];
  assert.deepEqual(info.sites.map((s) => s.preview), ["GET 200 · 3 ms · http://h/u", "user { a: 2 }", "Error: boom"]);
  assert.equal(info.count, 5);
});

test("the value graph draws a big value in parts: a cut row, and a box's next rows, when clicked", () => {
  const value = { list: Array.from({ length: MAX_ROWS + 10 }, (_, i) => ({ i })), deep: { a: { b: 1 } } };
  const g = buildGraph(value, "v", 5);
  assert.equal(g.cut, true);
  const list = g.nodes.get(g.root)!.children[0];
  const listNode = g.nodes.get(list)!;
  assert.equal(listNode.hidden, 10);
  const cutRow = listNode.rows.findIndex((r) => r.later !== undefined);
  assert.ok(cutRow > 0);
  const before = g.nodes.size;
  const id = expandRow(g, list, cutRow)!;
  assert.equal(g.nodes.get(id)!.title, String(cutRow));
  assert.equal(g.nodes.size, before + 1);
  assert.equal(listNode.rows[cutRow].child, id);
  assert.ok(listNode.children.includes(id));
  assert.ok(moreRows(g, list));
  assert.equal(listNode.hidden, 0);
  assert.equal(listNode.rows.length, MAX_ROWS + 10);
  const deep = g.nodes.get(g.root)!.rows.find((r) => r.key === "deep")!;
  assert.ok(deep.later !== undefined, "past the limit the root's own object waits too");
  expandRow(g, g.root, g.nodes.get(g.root)!.rows.indexOf(deep));
  assert.equal(layout(g).size, g.nodes.size, "every box drawn has a place");
});

test("Deno coverage: Deno's one-script reports count for JavaScript files, TypeScript is left out", { skip: !deno && "deno is not installed" }, async () => {
  const file = path.join(fixtures, "deno-app", "main.js");
  assert.equal(reportLines({ url: "file:///app/x.ts", functions: [{ ranges: [{ startOffset: 0, endOffset: 5, count: 1 }] }] }).size, 0);
  const dir = path.join(tmp, "deno-coverage");
  const r = await run(deno!, ["run", "main.js"], path.dirname(file), { ...plainEnv(denoEnv), DENO_COVERAGE_DIR: dir });
  assert.equal(r.status, 0, r.stderr);
  const hits: Map<string, Map<number, number>>[] = [];
  readReports(dir, (h) => hits.push(h));
  const lines = hits.map((h) => [...h].find(([f]) => path.resolve(f).toLowerCase() === file.toLowerCase())?.[1]).find(Boolean);
  assert.ok(lines && lines.size > 0, "Deno's report gives lines of main.js");
  const src = readFileSync(file, "utf8").split(/\r?\n/);
  const logLine = src.findIndex((l) => l.includes("@expect deno-log")) + 1;
  assert.ok((lines!.get(logLine) ?? 0) > 0, `line ${logLine} ran`);
});

test("EventSource, sendBeacon and total time in the request text", () => {
  const sse = requestFields({ api: "eventsource", method: "SSE", url: "http://h/feed", ms: 4, ws: { event: "message", size: 5, data: "tick1" } });
  assert.deepEqual([sse.level, sse.preview], ["log", "SSE ↓ 5 B · tick1"]);
  assert.ok(sse.full.startsWith("EventSource message received http://h/feed"));
  const beacon = requestFields({ api: "beacon", method: "POST", url: "http://h/hit", ms: 0, requestBody: '{"a":1}' });
  assert.deepEqual([beacon.level, beacon.preview], ["log", "POST beacon queued · http://h/hit"]);
  assert.equal(requestFields({ api: "beacon", method: "POST", url: "http://h/hit", ms: 0, error: "the browser did not queue it" }).level, "warn");
  assert.ok(requestFields({ api: "fetch", method: "GET", url: "http://h/", status: 200, ms: 3, totalMs: 9 }).full.includes("200 in 3 ms, body done after 9 ms"));
});

test("Chrome loads a page with every request kind: EventSource, sendBeacon, a Request body and a reload notice reach the dev server", { skip: !chrome && "Chrome is not installed", timeout: 120_000 }, async () => {
  await ready;
  const dir = path.join(fixtures, "vite-app");
  const file = path.join(dir, "src", "kinds.js");
  rx.received.length = 0;
  await devServer(dir, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "--port", "5218", "--strictPort"], "http://localhost:5218/kinds.html", async () => {
    const done = () => at(file, "kinds-sse").some((e) => e.request?.ws?.event === "message") && at(file, "kinds-beacon").length > 0 && at(file, "kinds-request").length > 0;
    // Headless Chrome loads the page and ends; it is started again until everything arrived.
    for (let i = 0; i < 3 && !done(); i++) {
      const c = spawn(chrome!, ["--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${path.join(tmp, `chrome-kinds-${i}`)}`, "--virtual-time-budget=8000", "--dump-dom", "http://localhost:5218/kinds.html"], { stdio: "ignore" });
      await until(done, 15_000);
      c.kill();
    }
    assert.ok(done(), JSON.stringify(inFile(rx.received, file).map((e) => `${e.line} ${e.preview}`)));
  });
  const sse = at(file, "kinds-sse").find((e) => e.request?.ws?.event === "message")!;
  assert.match(sse.preview, /^SSE ↓ \d+ B · tick /);
  assert.equal(at(file, "kinds-beacon")[0].preview.startsWith("POST beacon queued · http://localhost:5218/beacon"), true);
  assert.equal(at(file, "kinds-beacon")[0].request?.requestBody, '{"left":true,"token":"[redacted]"}');
  const req = at(file, "kinds-request")[0];
  assert.equal(req.request?.requestBody, '{"via":"Request","password":"[redacted]"}');
  assert.ok(req.request?.totalMs !== undefined && req.request.totalMs >= req.request.ms);
  const notice = rx.received.find((e) => e.pageLoad && e.load === req.load);
  assert.ok(notice && req.load && notice.run === req.run && req.run?.endsWith(":/kinds.html"), "the page says it loaded, with its own load id, and its entries carry it and its path");
});

for (const [name, cmd, args] of [
  ["Deno", deno, ["run", "-A", "sse.cjs"]],
  ["Node", process.execPath, ["--experimental-eventsource", "sse.cjs"]],
] as const) {
  test(`${name}: an EventSource opening and its messages land on the line that made it`, { skip: !cmd && `${name.toLowerCase()} is not installed` }, async () => {
    await ready;
    const dir = path.join(fixtures, "deno-app");
    const file = path.join(dir, "sse.cjs");
    rx.received.length = 0;
    const r = await run(cmd!, [...args], dir, env(denoEnv));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(await until(() => at(file, "sse").length === 4));
    assert.deepEqual(at(file, "sse").map((e) => e.preview.replace(/\d+ ms · http:\/\/127\.0\.0\.1:\d+/, "T")), ["SSE open · T/feed", "SSE ↓ 6 B · tick 1", "SSE ↓ 6 B · tick 2", "SSE ↓ 6 B · tick 3"]);
  });
}
