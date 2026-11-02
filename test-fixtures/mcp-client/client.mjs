// A real MCP client, the official TypeScript SDK, run by the tests.
//   node client.mjs http <url> <token> [file]
//   node client.mjs stdio <bridge.cjs> [file]
//   IL_BRIDGE=<json> node client.mjs stdio - [file]
// Connects, lists the tools, reads recent logs (from files matching [file]),
// errors and requests, gets the first log in full, and prints it all as JSON.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [mode, a, b, c] = process.argv.slice(2);
// IL_BRIDGE: the command, args and env a tool was told to start the bridge with (the JSON setup), in place of node.
const bridge = process.env.IL_BRIDGE ? JSON.parse(process.env.IL_BRIDGE) : undefined;
const file = mode === "http" ? c : b;
const transport =
  mode === "http"
    ? new StreamableHTTPClientTransport(new URL(a), { requestInit: { headers: { Authorization: `Bearer ${b}` } } })
    : new StdioClientTransport(bridge ? { command: bridge.command, args: bridge.args, env: { ...process.env, ...bridge.env }, stderr: "inherit" } : { command: process.execPath, args: [a], env: { ...process.env }, stderr: "inherit" });
const client = new Client({ name: "inline-logs-test", version: "1.0.0" });
await client.connect(transport);
const tools = (await client.listTools()).tools.map((t) => t.name);
const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
const logs = await call("recent_logs", file ? { file, limit: 20 } : { limit: 20 });
const errors = await call("recent_errors", {});
const requests = await call("recent_requests", {});
const first = logs.entries[0] ? await call("get_entry", { id: logs.entries[0].id }) : null;
const files = await call("list_files", {});
console.log(JSON.stringify({ server: client.getServerVersion(), tools, logs, errors, requests, first, files }));
await client.close();
