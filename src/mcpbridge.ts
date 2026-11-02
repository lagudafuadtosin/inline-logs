// The MCP server for command-line AI tools, which start their MCP servers as
// a process and talk over stdin and stdout: `node <this file>`. It passes
// each message on to the MCP endpoint of a VS Code window and prints the
// answer. Each window writes its address and token to a small file in the
// "mcp" folder next to this file while MCP is on. The window whose folder
// holds the tool's working directory is used, else the newest one.
// No dependencies, runs on Node 16+.
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { ENV_MCP_INFO, MCP_INFO_DIR, MCP_PATH } from "./names";

export interface McpInfo {
  port: number;
  token: string;
  pid: number;
  folders: string[];
  time: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === "EPERM";
  }
}

function norm(p: string): string {
  const s = path.resolve(p).replace(/\\/g, "/");
  return process.platform === "win32" || process.platform === "darwin" ? s.toLowerCase() : s;
}

/** The window to talk to, or undefined when none has MCP on. */
export function pickWindow(dir: string, cwd: string, only?: string): McpInfo | undefined {
  const files = only ? [only] : (() => {
    try {
      return fs.readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => path.join(dir, n));
    } catch {
      return [];
    }
  })();
  const live: McpInfo[] = [];
  for (const f of files) {
    try {
      const info = JSON.parse(fs.readFileSync(f, "utf8")) as McpInfo;
      if (Number.isInteger(info.port) && typeof info.token === "string" && alive(info.pid)) live.push(info);
    } catch {
      // half written or gone
    }
  }
  const here = norm(cwd);
  const score = (i: McpInfo) => Math.max(-1, ...(i.folders ?? []).map((f) => norm(f)).filter((f) => here === f || here.startsWith(f.endsWith("/") ? f : f + "/")).map((f) => f.length));
  live.sort((a, b) => score(b) - score(a) || b.time - a.time);
  return live[0];
}

function post(info: McpInfo, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: info.port, path: MCP_PATH, method: "POST", agent: false, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${info.token}`, "content-length": Buffer.byteLength(body) } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error("timeout")));
    req.end(body);
  });
}

function main(): void {
  const dir = path.join(__dirname, MCP_INFO_DIR);
  const only = process.env[ENV_MCP_INFO] || undefined;
  const write = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
  let chain = Promise.resolve();
  let buf = "";
  const handle = async (line: string) => {
    let msg: { id?: unknown } | undefined;
    try {
      msg = JSON.parse(line) as { id?: unknown };
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const id = msg && typeof msg === "object" && "id" in msg ? msg.id : undefined;
    const info = pickWindow(dir, process.cwd(), only);
    const fail = (message: string) => id !== undefined && id !== null && write({ jsonrpc: "2.0", id, error: { code: -32000, message } });
    if (!info) {
      fail("No VS Code window has Inline Logs MCP turned on. Turn on the inlineLogs.mcp setting in VS Code.");
      return;
    }
    try {
      const r = await post(info, line);
      if (r.status === 200 && r.text) process.stdout.write(r.text.trim() + "\n");
      else if (r.status !== 202) fail(`VS Code answered ${r.status}.`);
    } catch (err) {
      fail(`Could not reach VS Code: ${String((err as Error).message ?? err)}`);
    }
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c: string) => {
    buf += c;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      // In order, one at a time, as they came.
      if (line) chain = chain.then(() => handle(line));
    }
  });
  process.stdin.on("end", () => void chain.then(() => process.exit(0)));
}

if (typeof module !== "undefined" && typeof require !== "undefined" && require.main === module) main();
