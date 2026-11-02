// A workspace of packages (npm workspaces, run the way Turborepo runs a task):
// two packages run at once, each value on the right package's file, even
// though the two files have the same name.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { expectedLines } from "../expect";
import { fixtures, inFile, receiver, run, until, type Receiver } from "../hooked";

let rx: Receiver;
const ready = receiver().then((r) => (rx = r));
after(() => rx?.server.close());

test("monorepo: two packages at once, each value on its own package's file", async () => {
  await ready;
  const dir = path.join(fixtures, "monorepo");
  const api = path.join(dir, "packages", "api", "src", "index.js");
  const web = path.join(dir, "packages", "web", "src", "index.js");
  rx.received.length = 0;
  const r = await run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev"], dir, rx.env(), { shell: process.platform === "win32" });
  assert.equal(r.status, 0, r.stderr);
  await until(() => inFile(rx.received, api).length === 6 && inFile(rx.received, web).length === 6, 8_000);
  const a = inFile(rx.received, api);
  const w = inFile(rx.received, web);
  assert.equal(a.length, 6);
  assert.equal(w.length, 6);
  assert.ok(a.every((e) => e.line === expectedLines(api).get("api-tick") && e.preview.startsWith("api tick")));
  assert.ok(w.every((e) => e.line === expectedLines(web).get("web-tick") && e.preview.startsWith("web tick")));
  assert.notEqual(a[0].pid, w[0].pid);
  // They ran at the same time: each logged while the other was still logging.
  assert.ok(a[0].time < w[5].time && w[0].time < a[5].time, "the two packages ran side by side");
  assert.equal(rx.received.length, 12, "nothing from npm or the start script");
});
