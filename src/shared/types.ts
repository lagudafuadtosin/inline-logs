export type Level = "log" | "info" | "warn" | "error" | "debug";
export const LEVELS: readonly Level[] = ["log", "info", "warn", "error", "debug"];

/** Console methods besides the five levels. Each shows as a "log". */
export type Method = "table" | "dir" | "trace" | CounterMethod;
export const METHODS: readonly ("table" | "dir" | "trace")[] = ["table", "dir", "trace"];

/** console.count, time, group and assert, and their partners. Shown as a "log", a failing assert as a warning (Node) or an error (browser). */
export type CounterMethod = "count" | "countReset" | "time" | "timeLog" | "timeEnd" | "group" | "groupCollapsed" | "groupEnd" | "assert";
export const COUNTER_METHODS: readonly CounterMethod[] = ["count", "countReset", "time", "timeLog", "timeEnd", "group", "groupCollapsed", "groupEnd", "assert"];
/** Every method an entry can carry. */
export const ALL_METHODS: readonly Method[] = [...METHODS, ...COUNTER_METHODS];

/** Logging libraries whose calls are recorded on the line that called them. */
export type Logger = "pino" | "winston" | "consola" | "tslog";
export const LOGGERS: readonly Logger[] = ["pino", "winston", "consola", "tslog"];

/** One WebSocket or EventSource event: the socket opened, a message went out or came in, it closed, or it failed. */
export interface SocketEvent {
  event: "open" | "send" | "message" | "close" | "error";
  /** Text or JSON messages, redacted like request bodies and cut at MAX_BODY characters. Binary ones are a short note. */
  data?: string;
  /** Message size in bytes (characters for text). */
  size?: number;
  code?: number;
  reason?: string;
}

/** A fetch, XMLHttpRequest, Node http(s) call, socket, EventSource or beacon the app made. Secret headers are already redacted. */
export interface RequestInfo {
  api: "fetch" | "xhr" | "http" | "websocket" | "eventsource" | "beacon";
  method: string;
  url: string;
  /** Missing when the request failed before a response (see error), and for a beacon, which gets no answer the page can see. */
  status?: number;
  statusText?: string;
  /** Milliseconds from the call to the response headers (or to the failure). */
  ms: number;
  /** Milliseconds from the call to the end of the response body, when its end was seen. */
  totalMs?: number;
  /** A failure, or for a beacon the browser's refusal to queue it. */
  error?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  /** Text or JSON bodies only, cut at MAX_BODY characters. */
  requestBody?: string;
  responseBody?: string;
  /** Set for api "websocket" and "eventsource". */
  ws?: SocketEvent;
}

/** One console call, runtime error or request, as sent from the hook to the extension. */
export interface Entry {
  /** `<pid>:<seq>` for Node, `<pid>:b<seq>` for the browser. Used to drop duplicates. */
  id: string;
  /** "log" for console calls, "error" for uncaught errors and rejections, "request" for fetch, XMLHttpRequest and http(s) calls. */
  kind: "log" | "error" | "request";
  level: Level;
  /** Absolute file path of the line that logged or threw. */
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  col: number;
  /** One line, for the end of the code line. */
  preview: string;
  /** Pretty, multi-line, for the hover and the viewer. */
  full: string;
  /** Epoch ms. */
  time: number;
  source: "node" | "browser";
  pid: number;
  /** True when the only frame found was inside node_modules. */
  lib?: boolean;
  /** Set for console.table, console.dir, console.trace, and console.count, time, group and assert. */
  method?: Method;
  /** The console groups (console.group) the call was made in, outermost first, joined with " › ". */
  group?: string;
  /** Set when the entry came from a logging library (pino, winston, consola, tslog) instead of console. */
  logger?: Logger;
  /** Which program the process runs (a short hash of its folder and script), so a new run of it replaces the old run's problems. For the browser, the dev server's and the page's path. */
  run?: string;
  /** Browser entries: one load of the page (a reload is a new one), so a reload replaces that page's problems. */
  load?: string;
  /** Sent once when a page loads, before any of its entries: says a new load of the page started. Never shown. */
  pageLoad?: boolean;
  /** The logged value as JSON (see serializeJson), for diffs and the value graph. Only for values that are objects. */
  json?: string;
  /** Set for kind "request". */
  request?: RequestInfo;
}
