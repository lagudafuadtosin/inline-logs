// A small MCP server (Model Context Protocol, JSON-RPC 2.0) over the
// extension's local HTTP server, so AI tools can read what the app logged.
// Read-only: the tools list and look up entries, nothing else. It speaks the
// Streamable HTTP transport in its simplest form: each POST carries one
// message and gets one JSON answer, with no event stream. No VS Code imports,
// so it is unit tested on its own.
import { MCP_NAME } from "./names";
import { search } from "./search";
import type { Entry } from "./shared/types";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export interface McpSource {
  entries(): readonly Entry[];
  version: string;
  /** Workspace-relative path for display, when the file is in the workspace. */
  relative?(file: string): string;
  coverage?(): { file: string; covered: number; total: number }[];
}

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type Args = Record<string, unknown>;

const limitProp = { type: "integer", minimum: 1, maximum: 500, description: "Most entries to return, newest first. Default 50." };
const fileProp = { type: "string", description: "Only entries from files whose path contains this text, such as 'src/api' or 'index.ts'." };
const containsProp = { type: "string", description: "Only entries whose value, file or URL contains every word of this text (any case)." };

export const TOOLS = [
  {
    name: "recent_logs",
    title: "Recent console logs",
    description: "Console output (log, info, warn, error, debug, table, dir, trace) from apps, dev servers, browsers and tests started in the VS Code terminal, newest first, with the file and line that logged each value.",
    inputSchema: { type: "object", properties: { limit: limitProp, file: fileProp, contains: containsProp, level: { type: "string", enum: ["log", "info", "warn", "error", "debug"] } } },
  },
  {
    name: "recent_errors",
    title: "Recent uncaught errors",
    description: "Uncaught errors and unhandled promise rejections, newest first, with the line that threw and the stack.",
    inputSchema: { type: "object", properties: { limit: limitProp, file: fileProp, contains: containsProp } },
  },
  {
    name: "recent_requests",
    title: "Recent network requests",
    description: "fetch, XMLHttpRequest and Node http(s) calls the app made, newest first: method, URL, status, time, and the line that made the call. Secret headers and fields are redacted.",
    inputSchema: { type: "object", properties: { limit: limitProp, file: fileProp, contains: containsProp, status: { type: "string", description: "Status code or its start, such as '404' or '5'. 'failed' for requests with no answer." } } },
  },
  {
    name: "search_entries",
    title: "Search everything captured",
    description: "Search logs, errors and requests. Words must all match. Narrow with kind:log|error|request, level:warn, file:<text>, status:<code>.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: limitProp }, required: ["query"] },
  },
  {
    name: "get_entry",
    title: "One entry in full",
    description: "One entry by its id (from the other tools): the full value, the value as JSON when it is an object, and for a request its headers and bodies.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "list_files",
    title: "Files with entries",
    description: "Every file that logged, threw or made a request, with how many entries of each kind and the lines they are on.",
    inputSchema: { type: "object", properties: {} },
  },
].map((t) => ({ ...t, annotations: { readOnlyHint: true, openWorldHint: false } }));

/** Handles one JSON-RPC message. Undefined for a notification (no answer). */
export function handleRpc(msg: unknown, src: McpSource): object | undefined {
  const m = (msg && typeof msg === "object" ? msg : {}) as Rpc;
  const id = m.id;
  if (id === undefined || id === null) return undefined;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return fail(-32600, "Invalid request");
  switch (m.method) {
    case "initialize": {
      const asked = typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : "";
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_NAME, title: "Inline Logs", version: src.version },
        instructions: "Read-only access to what the user's app logged while it ran from the VS Code terminal: console output, uncaught errors and network requests, each with its file and line. Use recent_errors first when debugging a crash.",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const name = String(m.params?.name ?? "");
      const args = (m.params?.arguments && typeof m.params.arguments === "object" ? m.params.arguments : {}) as Args;
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
      try {
        const data = callTool(name, args, src);
        return ok({ content: [{ type: "text", text: JSON.stringify(data, null, 1) }], structuredContent: data, isError: false });
      } catch (err) {
        return ok({ content: [{ type: "text", text: String((err as Error).message ?? err) }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${m.method}`);
  }
}

function limitOf(a: Args): number {
  const n = Number(a.limit ?? 50);
  return Number.isFinite(n) ? Math.min(500, Math.max(1, Math.floor(n))) : 50;
}

function brief(e: Entry, src: McpSource) {
  return {
    id: e.id,
    kind: e.kind,
    level: e.level,
    file: e.file,
    path: src.relative?.(e.file) ?? e.file,
    line: e.line,
    time: new Date(e.time).toISOString(),
    source: e.source,
    value: e.preview,
    ...(e.request ? { method: e.request.method, url: e.request.url, status: e.request.status ?? null, ms: Math.round(e.request.ms) } : {}),
  };
}

/** Builds a query string from the tool's arguments for search(). */
function query(kind: string, a: Args): string {
  const parts = [`kind:${kind}`];
  if (typeof a.file === "string" && a.file.trim()) parts.push(`file:${a.file.trim().replace(/\s+/g, "")}`);
  if (typeof a.level === "string" && a.level) parts.push(`level:${a.level}`);
  if (typeof a.status === "string" && a.status) parts.push(`status:${a.status}`);
  if (typeof a.contains === "string") parts.push(a.contains);
  return parts.join(" ");
}

function callTool(name: string, a: Args, src: McpSource): { [k: string]: unknown } {
  const all = src.entries();
  switch (name) {
    case "recent_logs":
    case "recent_errors":
    case "recent_requests": {
      const kind = name === "recent_logs" ? "log" : name === "recent_errors" ? "error" : "request";
      const found = search(all, query(kind, a), limitOf(a));
      return { count: found.length, total: all.length, entries: found.map((e) => brief(e, src)) };
    }
    case "search_entries": {
      const found = search(all, String(a.query ?? ""), limitOf(a));
      return { count: found.length, entries: found.map((e) => brief(e, src)) };
    }
    case "get_entry": {
      const e = all.find((x) => x.id === a.id);
      if (!e) throw new Error(`No entry with id ${String(a.id)}. It may have been cleared.`);
      let json: unknown;
      try {
        json = e.json ? (JSON.parse(e.json) as unknown) : undefined;
      } catch {
        json = undefined;
      }
      return { ...brief(e, src), full: e.full, method: e.method ?? e.request?.method, json, request: e.request };
    }
    case "list_files": {
      const files = new Map<string, { file: string; path: string; logs: number; errors: number; requests: number; lines: Set<number> }>();
      for (const e of all) {
        let f = files.get(e.file);
        if (!f) files.set(e.file, (f = { file: e.file, path: src.relative?.(e.file) ?? e.file, logs: 0, errors: 0, requests: 0, lines: new Set() }));
        if (e.kind === "error") f.errors++;
        else if (e.kind === "request") f.requests++;
        else f.logs++;
        f.lines.add(e.line);
      }
      return { files: [...files.values()].map((f) => ({ ...f, lines: [...f.lines].sort((x, y) => x - y) })) };
    }
  }
  throw new Error(`Unknown tool: ${name}`);
}
