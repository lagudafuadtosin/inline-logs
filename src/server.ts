// The local server the hooks post to: 127.0.0.1 only, a random port, and a
// random token per VS Code window, checked on every request. It also answers
// the MCP endpoint when that is on, with a second token of its own that apps
// in the terminal never get.
import * as http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { MCP_PATH, TOKEN_HEADER } from "./names";
import { LEVELS, type Entry } from "./shared/types";

const MAX_BODY = 8_000_000;

export interface LogServer {
  port: number;
  token: string;
  close(): Promise<void>;
}

/** The MCP endpoint: answers when token() gives a token (MCP is on), else it is not there. */
export interface McpRoute {
  token(): string | undefined;
  handle(message: unknown): object | undefined;
}

const MAX_MCP_BODY = 1_000_000;

function same(given: string, expected: string): boolean {
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function serveMcp(req: http.IncomingMessage, res: http.ServerResponse, route: McpRoute): void {
  const token = route.token();
  const auth = String(req.headers.authorization ?? "");
  // A web page could reach 127.0.0.1 too: only requests with no Origin (tools) or a local one.
  const origin = req.headers.origin;
  const localOrigin = !origin || origin === "null" || /^(https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?|vscode-webview:\/\/.*)$/i.test(origin);
  if (!token || !localOrigin || !auth.startsWith("Bearer ") || !same(auth.slice(7), token)) {
    res.statusCode = token ? 403 : 404;
    res.end();
    req.resume();
    return;
  }
  if (req.method !== "POST") {
    // No server-sent event stream: everything is answered on the POST.
    res.statusCode = 405;
    res.setHeader("allow", "POST");
    res.end();
    req.resume();
    return;
  }
  let size = 0;
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size <= MAX_MCP_BODY) chunks.push(c);
  });
  req.on("error", () => undefined);
  req.on("end", () => {
    let msg: unknown;
    try {
      if (size > MAX_MCP_BODY) throw new Error("too big");
      msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      return;
    }
    const answers = (Array.isArray(msg) ? msg : [msg]).map((m) => route.handle(m)).filter((a) => a !== undefined);
    if (!answers.length) {
      res.statusCode = 202;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(msg) ? answers : answers[0]));
  });
}

export async function startServer(onEntries: (entries: Entry[]) => void, mcp?: McpRoute): Promise<LogServer> {
  const token = randomBytes(24).toString("hex");
  const expected = Buffer.from(token);
  const server = http.createServer((req, res) => {
    if (mcp && (req.url === MCP_PATH || req.url?.startsWith(`${MCP_PATH}?`))) {
      serveMcp(req, res, mcp);
      return;
    }
    const given = req.headers[TOKEN_HEADER];
    const ok = typeof given === "string" && given.length === token.length && timingSafeEqual(Buffer.from(given), expected);
    if (!ok || req.method !== "POST" || req.url !== "/entries") {
      res.statusCode = ok ? 404 : 403;
      res.end();
      req.resume();
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on("end", () => {
      if (size > MAX_BODY) {
        res.statusCode = 413;
        res.end();
        return;
      }
      res.statusCode = 204;
      res.end();
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { entries?: unknown };
        if (Array.isArray(body.entries)) {
          const good = body.entries.filter(isEntry);
          if (good.length) onEntries(good);
        }
      } catch {
        // bad body: ignore
      }
    });
    req.on("error", () => undefined);
  });
  server.keepAliveTimeout = 1_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    token,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export function isEntry(v: unknown): v is Entry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    (e.kind === "log" || e.kind === "error" || e.kind === "request") &&
    LEVELS.includes(e.level as Entry["level"]) &&
    typeof e.file === "string" &&
    e.file.length > 0 &&
    Number.isInteger(e.line) &&
    (e.line as number) > 0 &&
    typeof e.preview === "string" &&
    typeof e.full === "string"
  );
}
