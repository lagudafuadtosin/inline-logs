// The MCP server: the JSON-RPC handler on its own, the HTTP endpoint on the
// real local server (tokens, origins, off means not there), the stdio bridge
// built into dist/mcp.cjs, and the official MCP SDK client (in
// test-fixtures/mcp-client) talking to both.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as http from "node:http";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { startServer, type LogServer } from "../../src/server";
import { handleRpc, PROTOCOL_VERSIONS, TOOLS } from "../../src/mcp";
import { pickWindow } from "../../src/mcpbridge";
import { MCP_PATH, TOKEN_HEADER } from "../../src/names";
import type { Entry } from "../../src/shared/types";
import { cleanEnv } from "../expect";

const root = path.resolve(import.meta.dirname, "..", "..");
mkdirSync(path.join(root, ".test-build"), { recursive: true });
const tmp = mkdtempSync(path.join(root, ".test-build", "mcp-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const entry = (extra: Partial<Entry>): Entry => ({ id: `7:${n++}`, kind: "log", level: "log", file: "/proj/src/a.js", line: 3, col: 1, preview: "x", full: "x", time: 1_700_000_000_000 + n, source: "node", pid: 7, ...extra });
const entries: Entry[] = [
  entry({ preview: "user { name: 'Ada' }", full: "user { name: 'Ada' }", json: '["user",{"name":"Ada"}]' }),
  entry({ file: "/proj/src/b.js", line: 9, level: "warn", preview: "slow 900" }),
  entry({ kind: "error", level: "error", file: "/proj/src/b.js", line: 12, preview: "TypeError: x is undefined", full: "TypeError: x is undefined\n    at b.js:12:3" }),
  entry({ kind: "request", file: "/proj/src/api.js", line: 4, preview: "GET 404 · 3 ms · http://h/x", request: { api: "fetch", method: "GET", url: "http://h/x", status: 404, ms: 3 } }),
];
const src = { entries: () => entries, version: "9.9.9", relative: (f: string) => f.replace("/proj/", "") };
const rpc = (method: string, params?: object, id: number | null = 1) => handleRpc({ jsonrpc: "2.0", id, method, params }, src) as { result?: Record<string, unknown>; error?: { code: number } } | undefined;
const call = (name: string, args: object = {}) => (rpc("tools/call", { name, arguments: args })!.result as { structuredContent: Record<string, unknown>; isError: boolean });

test("initialize answers with the asked protocol version when known, tools, and server info", () => {
  const r = rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })!.result!;
  assert.equal(r.protocolVersion, "2025-06-18");
  assert.deepEqual(r.capabilities, { tools: { listChanged: false } });
  assert.equal((r.serverInfo as { version: string }).version, "9.9.9");
  assert.equal(rpc("initialize", { protocolVersion: "1999-01-01" })!.result!.protocolVersion, PROTOCOL_VERSIONS[0]);
  assert.equal(rpc("notifications/initialized", undefined, null), undefined, "notifications get no answer");
  assert.deepEqual(rpc("ping")!.result, {});
  assert.equal(rpc("resources/list")!.error!.code, -32601);
});

test("the tools are read-only and listed with schemas", () => {
  const tools = rpc("tools/list")!.result!.tools as typeof TOOLS;
  assert.deepEqual(tools.map((t) => t.name), ["recent_logs", "recent_errors", "recent_requests", "search_entries", "get_entry", "list_files"]);
  assert.ok(tools.every((t) => t.annotations.readOnlyHint && t.inputSchema.type === "object"));
});

test("recent logs, errors and requests, newest first, filtered by file and text", () => {
  const logs = call("recent_logs").structuredContent as { entries: { id: string; path: string }[] };
  assert.deepEqual(logs.entries.map((e) => e.path), ["src/b.js", "src/a.js"]);
  assert.deepEqual((call("recent_logs", { file: "a.js" }).structuredContent as { entries: unknown[] }).entries.length, 1);
  assert.deepEqual((call("recent_logs", { contains: "slow" }).structuredContent as { entries: { line: number }[] }).entries.map((e) => e.line), [9]);
  assert.deepEqual((call("recent_logs", { level: "warn" }).structuredContent as { count: number }).count, 1);
  const errors = call("recent_errors").structuredContent as { entries: { line: number; value: string }[] };
  assert.deepEqual(errors.entries.map((e) => e.line), [12]);
  const reqs = call("recent_requests", { status: "4" }).structuredContent as { entries: { status: number; url: string }[] };
  assert.deepEqual(reqs.entries.map((e) => [e.status, e.url]), [[404, "http://h/x"]]);
  assert.equal((call("recent_requests", { status: "5" }).structuredContent as { count: number }).count, 0);
  assert.equal((call("search_entries", { query: "kind:error typeerror" }).structuredContent as { count: number }).count, 1);
});

test("get_entry gives the full value and its JSON; an unknown id is a tool error, not a crash", () => {
  const e = call("get_entry", { id: entries[0].id }).structuredContent as { json: unknown; full: string };
  assert.deepEqual(e.json, ["user", { name: "Ada" }]);
  assert.equal(e.full, "user { name: 'Ada' }");
  assert.equal(call("get_entry", { id: "nope" }).isError, true);
  const files = call("list_files").structuredContent as { files: { path: string; errors: number; lines: number[] }[] };
  assert.deepEqual(files.files.find((f) => f.path === "src/b.js"), { file: "/proj/src/b.js", path: "src/b.js", logs: 1, errors: 1, requests: 0, lines: [9, 12] });
});

function post(port: number, body: unknown, headers: Record<string, string>, method = "POST"): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, path: MCP_PATH, method, headers: { "content-type": "application/json", ...headers } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: b ? (JSON.parse(b) as unknown) : undefined }));
    });
    req.on("error", reject);
    req.end(method === "POST" ? text : undefined);
  });
}

let mcpToken: string | undefined = "t".repeat(48);
let server: LogServer;
const ready = startServer(() => undefined, { token: () => mcpToken, handle: (m) => handleRpc(m, src) }).then((s) => (server = s));
after(() => server?.close());

test("the HTTP endpoint needs its own token, refuses other origins, and is gone while off", async () => {
  await ready;
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };
  const auth = { authorization: `Bearer ${mcpToken}` };
  assert.equal((await post(server.port, init, {})).status, 403, "no token");
  assert.equal((await post(server.port, init, { [TOKEN_HEADER]: server.token, authorization: `Bearer ${server.token}` })).status, 403, "the hooks' token is not the MCP token");
  assert.equal((await post(server.port, init, { ...auth, origin: "https://evil.example" })).status, 403, "a web page's origin");
  const ok = await post(server.port, init, { ...auth, origin: "http://localhost:3000" });
  assert.equal(ok.status, 200);
  assert.equal(((ok.json as { result: { serverInfo: { name: string } } }).result.serverInfo.name), "inline-logs");
  assert.equal((await post(server.port, { jsonrpc: "2.0", method: "notifications/initialized" }, auth)).status, 202);
  assert.equal((await post(server.port, "{bad", auth)).status, 400);
  assert.equal((await post(server.port, undefined, auth, "GET")).status, 405);
  mcpToken = undefined;
  assert.equal((await post(server.port, init, auth)).status, 404, "off: not there at all");
  mcpToken = "t".repeat(48);
});

function runNode(args: string[], env: NodeJS.ProcessEnv, cwd: string, input?: string): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    child.on("close", (status) => resolve({ stdout, stderr, status }));
    child.stdin.end(input ?? "");
  });
}

/** The bridge as the extension installs it: global storage, with an "mcp" folder of window files next to it. */
function installBridge(): { bridge: string; infoDir: string } {
  const dir = mkdtempSync(path.join(tmp, "storage-"));
  const bridge = path.join(dir, "mcp.cjs");
  cpSync(path.join(root, "dist", "mcp.cjs"), bridge);
  const infoDir = path.join(dir, "mcp");
  mkdirSync(infoDir);
  return { bridge, infoDir };
}

test("the stdio bridge picks the window whose folder holds the working directory, and skips dead ones", () => {
  const { infoDir } = installBridge();
  writeFileSync(path.join(infoDir, "1.json"), JSON.stringify({ port: 1, token: "a", pid: process.pid, folders: ["/other"], time: 3 }));
  writeFileSync(path.join(infoDir, "2.json"), JSON.stringify({ port: 2, token: "b", pid: process.pid, folders: [path.join(tmp, "proj")], time: 1 }));
  writeFileSync(path.join(infoDir, "3.json"), JSON.stringify({ port: 3, token: "c", pid: 999_999_99, folders: [path.join(tmp, "proj", "sub")], time: 9 }));
  assert.equal(pickWindow(infoDir, path.join(tmp, "proj", "sub"))?.port, 2);
  assert.equal(pickWindow(infoDir, path.join(tmp, "elsewhere"))?.port, 1, "else the newest live one");
  assert.equal(pickWindow(path.join(tmp, "none"), tmp), undefined);
});

test("the stdio bridge passes messages to the window and prints the answers, one per line", async () => {
  await ready;
  const { bridge, infoDir } = installBridge();
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "recent_errors", arguments: {} } },
  ].map((m) => JSON.stringify(m) + "\n").join("");
  const none = await runNode([bridge], cleanEnv(), tmp, lines);
  assert.match(none.stdout.split("\n")[0], /No VS Code window has Inline Logs MCP turned on/);
  writeFileSync(path.join(infoDir, "w.json"), JSON.stringify({ port: server.port, token: mcpToken, pid: process.pid, folders: [tmp], time: Date.now() }));
  const r = await runNode([bridge], cleanEnv(), tmp, lines);
  const out = r.stdout.trim().split("\n").map((l) => JSON.parse(l) as { id: number; result: { structuredContent?: { entries: { line: number }[] } } });
  assert.deepEqual(out.map((o) => o.id), [1, 2], "the notification has no answer line");
  assert.deepEqual(out[1].result.structuredContent!.entries.map((e) => e.line), [12]);
});

test("the official MCP SDK client works over Streamable HTTP and over the stdio bridge", async () => {
  await ready;
  const client = path.join(root, "test-fixtures", "mcp-client", "client.mjs");
  const viaHttp = await runNode([client, "http", `http://127.0.0.1:${server.port}${MCP_PATH}`, mcpToken!, "b.js"], cleanEnv(), path.dirname(client));
  assert.equal(viaHttp.status, 0, viaHttp.stderr);
  const h = JSON.parse(viaHttp.stdout) as { server: { name: string }; tools: string[]; logs: { entries: { line: number }[] }; errors: { count: number }; requests: { count: number }; first: { full: string } };
  assert.equal(h.server.name, "inline-logs");
  assert.equal(h.tools.length, 6);
  assert.deepEqual(h.logs.entries.map((e) => e.line), [9]);
  assert.equal(h.errors.count, 1);
  assert.equal(h.requests.count, 1);
  assert.equal(h.first.full, "x");

  const { bridge, infoDir } = installBridge();
  writeFileSync(path.join(infoDir, "w.json"), JSON.stringify({ port: server.port, token: mcpToken, pid: process.pid, folders: [], time: Date.now() }));
  const viaStdio = await runNode([client, "stdio", bridge], cleanEnv(), path.dirname(client));
  assert.equal(viaStdio.status, 0, viaStdio.stderr);
  const s = JSON.parse(viaStdio.stdout) as { tools: string[]; logs: { count: number }; first: { json: unknown } };
  assert.equal(s.tools.length, 6);
  assert.equal(s.logs.count, 2);
  assert.ok(s.first !== null);
});
