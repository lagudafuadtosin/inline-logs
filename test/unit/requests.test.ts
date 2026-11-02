// The request log: the helpers that redact and describe a request, and real
// runs of test-fixtures/requests-app with the hook, checking each fetch and
// http call landed on its line with the right status and bodies, secrets
// redacted, and that the app printed the same with and without the hook.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { startServer, type LogServer } from "../../src/server";
import { ENV_OPTS, ENV_PORT, ENV_TOKEN } from "../../src/names";
import { MAX_BODY, REDACTED, bodyText, cleanUrl, isTextType, redactBody, redactHeaders, requestFields, requestLevel } from "../../src/shared/request";
import type { Entry } from "../../src/shared/types";
import { cleanEnv, expectedLines } from "../expect";

const root = path.resolve(import.meta.dirname, "..", "..");
const dir = path.join(root, "test-fixtures", "requests-app");
const file = path.join(dir, "index.js");
const hook = path.join(root, "dist", "hook.cjs").replace(/\\/g, "/");
mkdirSync(path.join(root, ".test-build"), { recursive: true });
const tmp = mkdtempSync(path.join(root, ".test-build", "requests-"));

const received: Entry[] = [];
let server: LogServer;
const ready = startServer((e) => received.push(...e)).then((s) => (server = s));
after(async () => {
  await server?.close();
  rmSync(tmp, { recursive: true, force: true });
});

function run(hooked: boolean, opts: Record<string, unknown> = {}): Promise<{ stdout: string; stderr: string; status: number | null }> {
  const env = cleanEnv();
  if (hooked) {
    env.NODE_OPTIONS = `--require "${hook}"`;
    env[ENV_PORT] = String(server.port);
    env[ENV_TOKEN] = server.token;
    env[ENV_OPTS] = JSON.stringify({ sourceMaps: true, includeNodeModules: false, browser: true, ...opts });
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["index.js"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    child.on("close", (status) => resolve({ stdout, stderr, status }));
  });
}

const requestsIn = () => received.filter((e) => e.kind === "request" && path.resolve(e.file).toLowerCase() === file.toLowerCase());

test("secret headers are redacted, the rest kept with lower-case names", () => {
  const h = redactHeaders({ Authorization: "Bearer x", Cookie: "a=b", "Set-Cookie": ["s=1", "t=2"], "X-Api-Key": "k", Accept: "application/json" });
  assert.deepEqual(h, { authorization: REDACTED, cookie: REDACTED, "set-cookie": REDACTED, "x-api-key": REDACTED, accept: "application/json" });
  assert.deepEqual(redactHeaders(new Map([["Proxy-Authorization", "p"], ["x-trace", "1"]])), { "proxy-authorization": REDACTED, "x-trace": "1" });
});

test("secret fields in JSON and form bodies are redacted, other text kept, long bodies cut", () => {
  assert.equal(redactBody(JSON.stringify({ user: "ada", password: "p", nested: { apiKey: "k", list: [{ token: "t" }] } }), "application/json"), JSON.stringify({ user: "ada", password: REDACTED, nested: { apiKey: REDACTED, list: [{ token: REDACTED }] } }));
  assert.equal(redactBody("user=ada&password=p&x=1", "application/x-www-form-urlencoded"), "user=ada&password=%5Bredacted%5D&x=1");
  assert.equal(redactBody("plain text with password=1", "text/plain"), "plain text with password=1");
  assert.equal(redactBody("{not json", "application/json"), "{not json");
  const long = redactBody("y".repeat(MAX_BODY + 50), "text/plain");
  assert.equal(long.length, MAX_BODY + 1);
  assert.ok(long.endsWith("…"));
});

test("only text-like bodies are kept, binary bodies are a note, user:password@ leaves the URL", () => {
  assert.ok(isTextType("application/json; charset=utf-8") && isTextType("text/html") && isTextType("application/x-www-form-urlencoded") && isTextType("application/graphql"));
  assert.ok(!isTextType("text/event-stream") && !isTextType("image/png") && !isTextType("application/octet-stream") && !isTextType(undefined));
  assert.equal(bodyText("a=1"), "a=1");
  assert.equal(bodyText(new URLSearchParams({ a: "1", b: "2" })), "a=1&b=2");
  assert.equal(bodyText(new Uint8Array(5)), "[binary, 5 bytes]");
  assert.equal(bodyText(new ArrayBuffer(3)), "[binary, 3 bytes]");
  assert.equal(bodyText({ some: "object" }), undefined);
  assert.equal(cleanUrl("https://user:pw@example.com/a?b=1"), "https://example.com/a?b=1");
});

test("level and the line shown: ok is log, 4xx warn, 5xx and failures error", () => {
  const base = { api: "fetch" as const, method: "GET", url: "http://h/x", ms: 12.4 };
  assert.equal(requestLevel({ ...base, status: 200 }), "log");
  assert.equal(requestLevel({ ...base, status: 404 }), "warn");
  assert.equal(requestLevel({ ...base, status: 503 }), "error");
  assert.equal(requestLevel({ ...base, error: "refused" }), "error");
  const f = requestFields({ ...base, status: 200, responseBody: '{"a":1}', responseHeaders: { "content-type": "application/json" } });
  assert.equal(f.preview, "GET 200 · 12 ms · http://h/x");
  assert.ok(f.full.includes("Response body\n{\n  \"a\": 1\n}"), f.full);
  assert.deepEqual(JSON.parse(f.json).response.body, { a: 1 });
});

test("fetch and node:http calls land on their lines, the app prints the same, secrets are redacted", async () => {
  await ready;
  const plain = await run(false);
  const hooked = await run(true);
  assert.equal(hooked.stdout, plain.stdout);
  assert.equal(hooked.stderr, plain.stderr);
  assert.equal(hooked.status, plain.status);
  assert.ok(hooked.stdout.includes("auth: 'Bearer secret-1'") && hooked.stdout.includes("password: 'hunter2'"), "the app itself still sends and sees its real values");
  const marks = expectedLines(file);
  const names = ["fetch-get", "fetch-post", "fetch-big", "fetch-404", "fetch-fail", "http-get", "http-post", "http-unread"];
  const end = Date.now() + 15_000;
  const at = (n: string) => requestsIn().find((e) => e.line === marks.get(n));
  while (Date.now() < end && names.some((n) => !at(n))) await new Promise((r) => setTimeout(r, 100));
  for (const n of names) assert.ok(at(n), `a request entry on the ${n} line; got lines ${requestsIn().map((e) => e.line)}`);

  const get = at("fetch-get")!;
  assert.equal(get.request!.api, "fetch");
  assert.equal(get.request!.status, 200);
  assert.equal(get.level, "log");
  assert.match(get.preview, /^GET 200 · \d+ ms · http:\/\/127\.0\.0\.1:\d+\/user$/);
  assert.equal(get.request!.responseHeaders!["set-cookie"], REDACTED);
  assert.deepEqual(JSON.parse(get.request!.responseBody!), { name: "Ada", token: REDACTED });
  assert.deepEqual(JSON.parse(get.json!).response.body, { name: "Ada", token: REDACTED });

  const post = at("fetch-post")!;
  assert.equal(post.request!.method, "POST");
  assert.equal(post.request!.requestHeaders!.authorization, REDACTED);
  assert.deepEqual(JSON.parse(post.request!.requestBody!), { q: 1, password: REDACTED });
  assert.ok(!JSON.stringify(requestsIn()).includes("secret-1") && !JSON.stringify(requestsIn()).includes("hunter2"), "no secret reaches the extension in a request entry");

  assert.equal(at("fetch-big")!.request!.responseBody!.length, MAX_BODY + 1, "a big body is cut, the app still read all of it");
  assert.ok(hooked.stdout.includes("big length 40000"));
  assert.equal(at("fetch-404")!.level, "warn");
  assert.equal(at("fetch-fail")!.level, "error");
  assert.equal(at("fetch-fail")!.request!.status, undefined);
  assert.match(at("fetch-fail")!.preview, /^GET failed/);

  const hget = at("http-get")!;
  assert.equal(hget.request!.api, "http");
  assert.equal(hget.request!.status, 200);
  assert.match(hget.request!.url, /^http:\/\/127\.0\.0\.1:\d+\/user$/);
  assert.deepEqual(JSON.parse(hget.request!.responseBody!), { name: "Ada", token: REDACTED });
  const hpost = at("http-post")!;
  assert.equal(hpost.request!.requestBody, '{"n":2}');
  assert.equal(hpost.request!.requestHeaders!.cookie, REDACTED);
  assert.equal(at("http-unread")!.request!.responseBody, undefined, "a binary body is not kept");
  assert.equal(requestsIn().length, names.length, "one entry per request, none for the hook's own sends");
});

test("with requests off, no request entries and the same output", async () => {
  await ready;
  received.length = 0;
  const plain = await run(false);
  const hooked = await run(true, { requests: false });
  assert.equal(hooked.stdout, plain.stdout);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(requestsIn().length, 0);
  assert.ok(received.some((e) => e.kind === "log" && e.file.endsWith("index.js")), "console logs still arrive");
});

test("with bodies off, requests arrive without bodies", async () => {
  await ready;
  received.length = 0;
  await run(true, { requestBodies: false });
  const end = Date.now() + 10_000;
  while (Date.now() < end && requestsIn().length < 8) await new Promise((r) => setTimeout(r, 100));
  assert.equal(requestsIn().length, 8);
  assert.ok(requestsIn().every((e) => e.request!.requestBody === undefined && e.request!.responseBody === undefined));
});
