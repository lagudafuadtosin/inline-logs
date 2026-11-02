// WebSockets in the request log: Node's global WebSocket against a real
// server, messages redacted like bodies, the app's own behaviour unchanged.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { redactUrl, requestFields, socketData } from "../../src/shared/request";
import { wrapSocketClass } from "../../src/shared/socket";
import type { RequestInfo } from "../../src/shared/types";
import { expectedLines } from "../expect";
import { fixtures, inFile, receiver, run, runSync, until, type Receiver } from "../hooked";

let rx: Receiver;
const ready = receiver().then((r) => (rx = r));
after(() => rx?.server.close());

test("socket data: text redacted like a body, binary as a note, secret query values out of the URL", () => {
  assert.deepEqual(socketData('{"type":"hi","token":"abc"}'), { data: '{"type":"hi","token":"[redacted]"}', size: 27 });
  assert.deepEqual(socketData(new Uint8Array(5)), { data: "[binary, 5 bytes]", size: 5 });
  assert.deepEqual(socketData(new ArrayBuffer(3)), { data: "[binary, 3 bytes]", size: 3 });
  assert.equal(redactUrl("wss://u:p@host/live?token=abc&room=7&api_key=k#x"), "wss://host/live?token=%5Bredacted%5D&room=7&api_key=%5Bredacted%5D#x");
  const f = requestFields({ api: "websocket", method: "WS", url: "ws://h/x", ms: 3, ws: { event: "close", code: 1006 } });
  assert.deepEqual([f.level, f.preview], ["warn", "WS close 1006 · ws://h/x"]);
  assert.equal(requestFields({ api: "websocket", method: "WS", url: "ws://h/x", ms: 3, ws: { event: "message", size: 2, data: "hi" } }).preview, "WS ↓ 2 B · hi");
});

test("wrapping keeps the class: instanceof, constructor, statics and send's return value", () => {
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    url: string;
    sent: unknown[] = [];
    constructor(url: string) {
      super();
      this.url = url;
    }
    send(d: unknown) {
      this.sent.push(d);
      return "returned";
    }
  }
  const holder: Record<string, unknown> = { WebSocket: FakeSocket };
  const seen: RequestInfo[] = [];
  assert.ok(wrapSocketClass(holder, "WebSocket", (_s, i) => seen.push(i), { bodies: true }, () => false, () => "stack"));
  const W = holder.WebSocket as typeof FakeSocket;
  const ws = new W("ws://h/a?secret=1");
  assert.ok(ws instanceof W && ws instanceof FakeSocket && ws.constructor === W && W.OPEN === 1 && W.name === "FakeSocket");
  assert.equal(ws.send("hello"), "returned");
  assert.deepEqual(ws.sent, ["hello"]);
  ws.dispatchEvent(Object.assign(new Event("message"), { data: "back" }));
  ws.dispatchEvent(Object.assign(new Event("close"), { code: 1000, reason: "done" }));
  assert.deepEqual(
    seen.map((i) => [i.ws?.event, i.ws?.data, i.url]),
    [
      ["send", "hello", "ws://h/a?secret=%5Bredacted%5D"],
      ["message", "back", "ws://h/a?secret=%5Bredacted%5D"],
      ["close", undefined, "ws://h/a?secret=%5Bredacted%5D"],
    ],
  );
  const quiet: RequestInfo[] = [];
  const h2: Record<string, unknown> = { WebSocket: class extends FakeSocket {} };
  wrapSocketClass(h2, "WebSocket", (_s, i) => quiet.push(i), { bodies: false }, () => false, () => "stack");
  new (h2.WebSocket as typeof FakeSocket)("ws://h/b").send("secret text");
  assert.deepEqual([quiet[0].ws?.data, quiet[0].ws?.size], [undefined, 11], "without bodies only the size is kept");
});

test("Node's global WebSocket: open, messages both ways, close and a failed socket, on their lines", async () => {
  await ready;
  const dir = path.join(fixtures, "sockets-app");
  const file = path.join(dir, "index.js");
  const plain = runSync(dir, ["index.js"]);
  rx.received.length = 0;
  const hooked = await run(process.execPath, ["index.js"], dir, rx.env());
  assert.equal(hooked.stdout, plain.stdout);
  assert.equal(hooked.stderr, plain.stderr);
  assert.equal(hooked.status, plain.status);
  const L = expectedLines(file);
  const ws = () => inFile(rx.received, file).filter((e) => e.request?.api === "websocket");
  await until(() => ws().filter((e) => e.request?.ws?.event === "close").length === 2);
  const on = (n: string) => ws().filter((e) => e.line === L.get(n));
  assert.deepEqual(
    on("ws-open").map((e) => e.request?.ws?.event),
    ["open", "message", "message", "close"],
  );
  assert.match(on("ws-open")[0].preview, /^WS open · \d+ ms · ws:\/\/127\.0\.0\.1:\d+\/live\?token=%5Bredacted%5D&room=7$/);
  const sent = on("ws-send")[0];
  assert.equal(sent.preview, 'WS ↑ 37 B · {"type":"hello","password":"[redacted]"}');
  assert.ok(!JSON.stringify(rx.received).includes("hunter2") && !JSON.stringify(rx.received).includes("abc123"), "secrets never leave the app");
  assert.equal(on("ws-open")[3].preview.startsWith("WS close 1000 done"), true);
  assert.deepEqual(
    on("ws-dead").map((e) => [e.request?.ws?.event, e.level]),
    [
      ["error", "error"],
      ["close", "warn"],
    ],
  );
});
