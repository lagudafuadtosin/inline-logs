// Every name the outside world sees lives here, so a rename is one file plus
// package.json. See "Renaming" in README.md for the full list.

/** Prefix for settings, commands, views and colours (must match package.json). */
export const ID = "inlineLogs";
/** Shown in the status bar, the viewer and messages. */
export const DISPLAY_NAME = "Inline Logs";
/** Environment variables the extension sets in integrated terminals. */
export const ENV_PORT = "INLINE_LOGS_PORT";
export const ENV_TOKEN = "INLINE_LOGS_TOKEN";
export const ENV_OPTS = "INLINE_LOGS_OPTS";
/** Folder the hooks write their spool files to (see hook/transport.ts). */
export const ENV_SPOOL = "INLINE_LOGS_SPOOL";
/** Header the hook sends the token in. */
export const TOKEN_HEADER = "x-inline-logs-token";
/** Path prefix the browser posts to on the dev server (same origin). */
export const BROWSER_PATH = "/__inline-logs/";
/** Global flag so the hook and the browser client only install once. */
export const GLOBAL_FLAG = "__inlineLogsInstalled";
/** Name of the browser client config object injected into the page. */
export const CLIENT_CONFIG = "__INLINE_LOGS__";
/** Function names in our own wrappers, skipped when reading the stack. */
export const WRAPPER_MARK = "__inlineLogs";
/** Scheme of the read-only documents the diff editor shows logged values in. */
export const VALUE_SCHEME = "inline-logs-value";
/** Webview panel type of the value graph. */
export const GRAPH_VIEW = `${ID}.graph`;
/** Id of the MCP server definition provider (must match package.json). */
export const MCP_PROVIDER = `${ID}.mcp`;
/** Name AI tools see for the MCP server. */
export const MCP_NAME = "inline-logs";
/** Path of the MCP endpoint on the extension's local server. */
export const MCP_PATH = "/mcp";
/** The stdio MCP bridge for CLI tools, and the folder (next to it) its connection files live in. */
export const MCP_BRIDGE_FILE = "mcp.cjs";
export const MCP_INFO_DIR = "mcp";
/** Launchers next to the bridge that run it on VS Code's own program as Node (Windows, and the rest). */
export const MCP_LAUNCHER_CMD = "mcp.cmd";
export const MCP_LAUNCHER_SH = "mcp.sh";
/** Set for a CLI tool to pick one VS Code window's connection file by path. */
export const ENV_MCP_INFO = "INLINE_LOGS_MCP_INFO";
/** Start of the file name Export suggests (inline-logs-<date>.json). */
export const EXPORT_FILE = "inline-logs";
