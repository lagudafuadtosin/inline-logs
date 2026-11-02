// Sends entries to the extension's local server. Batched and asynchronous
// while the app runs; at exit whatever is still unsent goes through one short
// synchronous child process, so logs printed just before process.exit() or a
// crash are not lost. Every entry is also written at once to a spool file
// the extension reads, for processes that end with no exit event at all
// (Ctrl+C, a test runner stopping its worker, a closed terminal). Any
// failure turns the transport off for good: the app never sees an error from us.
import * as http from "node:http";
import * as path from "node:path";
import { closeSync, ftruncateSync, mkdirSync, openSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { Entry } from "../shared/types";
import { TOKEN_HEADER } from "../names";

const BATCH_MS = 25;
const MAX_QUEUE = 5_000;
const MAX_BATCH = 500;
const TIMEOUT_MS = 1_500;

// Taken now, before the app can wrap http.request (nock, msw and friends).
const request = http.request;

const SENDER = `
const http = require("http");
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (body += c));
process.stdin.on("end", () => {
  const req = http.request({ host: "127.0.0.1", port: Number(process.argv[1]), path: "/entries", method: "POST", agent: false,
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ${JSON.stringify(TOKEN_HEADER)}: process.argv[2] } }, (res) => { res.resume(); res.on("end", () => process.exit(0)); });
  req.on("error", () => process.exit(0));
  req.setTimeout(${TIMEOUT_MS}, () => req.destroy());
  req.end(body);
});`;

export class Transport {
  private queue: Entry[] = [];
  private inflight = new Map<number, Entry[]>();
  private nextBatch = 0;
  private timer: NodeJS.Timeout | undefined;
  private dead = false;
  /** undefined: not opened yet; -1: no spool. */
  private spoolFd: number | undefined;
  private spoolPath: string | undefined;

  constructor(
    private readonly port: number,
    private readonly token: string,
    /** False where starting a process is not allowed (Deno without --allow-run): no last-chance send then. */
    private readonly canSpawn = true,
    /** Folder for the spool file; none means no spool. */
    private readonly spoolDir?: string,
  ) {}

  get off(): boolean {
    return this.dead;
  }

  push(e: Entry): void {
    if (this.dead) return;
    this.spool(e);
    this.queue.push(e);
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), BATCH_MS);
      // Never keeps the app alive on its own. beforeExit flushes instead.
      this.timer.unref();
    }
  }

  /** Starts sending everything queued. The request keeps the event loop alive until it is done, so natural exits wait for it. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    while (this.queue.length && !this.dead) this.send(this.queue.splice(0, MAX_BATCH));
  }

  get pending(): boolean {
    return this.queue.length > 0;
  }

  private send(batch: Entry[]): void {
    const id = this.nextBatch++;
    this.inflight.set(id, batch);
    const body = JSON.stringify({ entries: batch });
    const done = (ok: boolean) => {
      this.inflight.delete(id);
      if (!ok) this.kill();
      else if (!this.queue.length && !this.inflight.size) this.spoolEmpty();
    };
    try {
      const req = request(
        {
          host: "127.0.0.1",
          port: this.port,
          path: "/entries",
          method: "POST",
          agent: false,
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), [TOKEN_HEADER]: this.token },
        },
        (res) => {
          res.resume();
          res.on("end", () => done(res.statusCode === 204 || res.statusCode === 200));
          res.on("error", () => done(false));
        },
      );
      req.on("error", () => done(false));
      req.setTimeout(TIMEOUT_MS, () => req.destroy());
      req.end(body);
    } catch {
      done(false);
    }
  }

  private kill(): void {
    this.dead = true;
    this.queue = [];
    this.inflight.clear();
    if (this.timer) clearTimeout(this.timer);
    this.spoolClose(true);
  }

  /** One line per entry, written before this call returns, so even a process killed on the next line leaves it behind. */
  private spool(e: Entry): void {
    if (!this.spoolDir || this.spoolFd === -1) return;
    try {
      if (this.spoolFd === undefined) {
        mkdirSync(this.spoolDir, { recursive: true });
        this.spoolPath = path.join(this.spoolDir, `${process.pid}-${randomBytes(4).toString("hex")}.jsonl`);
        this.spoolFd = openSync(this.spoolPath, "a");
      }
      writeSync(this.spoolFd, JSON.stringify(e) + "\n");
    } catch {
      this.spoolClose(false);
      this.spoolFd = -1;
    }
  }

  /** Everything written has arrived over HTTP: the file starts again from nothing. */
  private spoolEmpty(): void {
    if (this.spoolFd === undefined || this.spoolFd < 0) return;
    try {
      ftruncateSync(this.spoolFd, 0);
    } catch {
      // the extension reads it again and drops what it has
    }
  }

  private spoolClose(remove: boolean): void {
    if (this.spoolFd === undefined || this.spoolFd < 0) return;
    try {
      closeSync(this.spoolFd);
      if (remove && this.spoolPath) unlinkSync(this.spoolPath);
    } catch {
      // the extension removes it once this process is gone
    }
    this.spoolFd = -1;
  }

  /** Called from process 'exit': sends what is queued or still in flight, synchronously. The server drops duplicates by id. */
  flushSync(): void {
    if (this.dead) return;
    const all = [...[...this.inflight.values()].flat(), ...this.queue];
    this.queue = [];
    // Nothing left unsent: the spool file is not needed any more.
    this.spoolClose(all.length === 0);
    if (all.length === 0 || !this.canSpawn) return;
    try {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.NODE_OPTIONS;
      delete env.BUN_OPTIONS;
      spawnSync(process.execPath, ["-e", SENDER, String(this.port), this.token], {
        input: JSON.stringify({ entries: all.slice(-MAX_BATCH * 4) }),
        env,
        stdio: ["pipe", "ignore", "ignore"],
        timeout: TIMEOUT_MS + 500,
        windowsHide: true,
      });
    } catch {
      // nothing to do: the app is exiting anyway
    }
  }
}
