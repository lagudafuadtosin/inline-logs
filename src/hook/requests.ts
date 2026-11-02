// The request log in Node, Bun and Deno: wraps fetch, http.request/get and
// https.request/get, the global WebSocket and EventSource, and the ws
// package's WebSocket. It only watches. The app gets the same Response,
// ClientRequest and IncomingMessage objects it would get without us: fetch
// bodies are read from a clone (a separate branch of the stream), and http
// bodies are seen as the app's own reads pass by, so nothing is consumed,
// paused or resumed that the app did not ask for. A compressed http body is
// unpacked from our own copy of the bytes.
import type * as http from "node:http";
import * as zlib from "node:zlib";
import { errorMonitor } from "node:events";
import { WRAPPER_MARK } from "../names";
import { BODY_WAIT_MS, MAX_BODY, bodyText, cleanUrl, isTextType, readLimited, redactBody, redactHeaders } from "../shared/request";
import type { RequestInfo } from "../shared/types";
import { wrapSocketClass } from "../shared/socket";

export interface RequestLogOptions {
  /** Keep request and response bodies (text and JSON only, cut at MAX_BODY). */
  bodies: boolean;
  /** Patch node:http and node:https, and the global WebSocket and EventSource, too. */
  http: boolean;
}

/** Node's own http (not Bun's or Deno's), where requests and responses are watched without wrapping emit. */
const NODE_HTTP = !process.versions.bun && !(globalThis as { Deno?: unknown }).Deno;

/** Called once per finished request with the stack captured where the app made it. */
export type OnRequest = (stack: string | undefined, info: RequestInfo) => void;

function stackHere(fn: unknown): string | undefined {
  const holder: { stack?: string } = {};
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 30;
  Error.captureStackTrace(holder, fn as () => void);
  Error.stackTraceLimit = limit;
  return holder.stack;
}

export function installRequestLog(on: OnRequest, opts: RequestLogOptions, off: () => boolean): void {
  wrapFetch(on, opts, off);
  if (opts.http) {
    // The modules' own export objects (an import gives a copy of them).
    for (const protocol of ["http:", "https:"]) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(`node:${protocol.slice(0, -1)}`) as Record<string, unknown>;
      wrapHttp(mod, "request", protocol, on, opts, off);
      wrapHttp(mod, "get", protocol, on, opts, off);
    }
    try {
      // Node 22 and later: the global WebSocket, the same class as in browsers.
      wrapSocketClass(globalThis as unknown as Record<string, unknown>, "WebSocket", on, { bodies: opts.bodies }, off, stackHere);
      // Where there is one (Deno, Node behind a flag).
      wrapSocketClass(globalThis as unknown as Record<string, unknown>, "EventSource", on, { bodies: opts.bodies, api: "eventsource" }, off, stackHere);
    } catch {
      // WebSocket stays as it is
    }
  }
}

/** The ws package's WebSocket class, as its module sets it: `mod.exports` becomes the watched class. */
export function wrapWsPackage(mod: Record<string, unknown>, on: OnRequest, opts: { bodies: boolean }, off: () => boolean): boolean {
  return wrapSocketClass(mod, "exports", on, { bodies: opts.bodies, emitter: true }, off, stackHere);
}

// ---- fetch -------------------------------------------------------------

function wrapFetch(on: OnRequest, opts: RequestLogOptions, off: () => boolean): void {
  const g = globalThis as { fetch?: (...a: unknown[]) => Promise<Response> };
  const original = g.fetch;
  if (typeof original !== "function") return;
  const name = `${WRAPPER_MARK}_fetch`;
  const wrapped = {
    [name](this: unknown, ...args: unknown[]) {
      if (off()) return original.apply(this, args);
      let stack: string | undefined;
      let info: RequestInfo | undefined;
      let sent: Promise<RequestInfo> | undefined;
      const start = Date.now();
      try {
        stack = stackHere(wrapped);
        info = describeFetch(args[0], args[1] as RequestInit | undefined, opts);
        sent = requestBodyOf(args[0], args[1] as RequestInit | undefined, info, opts);
      } catch {
        info = undefined;
      }
      const p = original.apply(this, args);
      if (!info) return p;
      const req = info;
      const withBody = (i: RequestInfo) => (sent ? sent.then((s) => ({ ...i, requestBody: s.requestBody }), () => i) : Promise.resolve(i));
      // A new promise that settles the same way, so a rejection the app does
      // not handle stays unhandled, exactly as it would be without us.
      return p.then(
        (res) => {
          try {
            observeResponse(res, req, start, opts)
              .then(withBody)
              .then((done) => on(stack, done), () => undefined);
          } catch {
            // the app still gets its response
          }
          return res;
        },
        (err: unknown) => {
          try {
            void withBody({ ...req, ms: Date.now() - start, error: errorText(err) }).then((done) => on(stack, done), () => undefined);
          } catch {
            // ignore
          }
          throw err;
        },
      );
    },
  }[name];
  try {
    Object.defineProperty(wrapped, "name", { value: original.name || "fetch" });
    Object.defineProperty(wrapped, "length", { value: original.length });
  } catch {
    // cosmetic only
  }
  g.fetch = wrapped as typeof g.fetch;
}

function describeFetch(input: unknown, init: RequestInit | undefined, opts: RequestLogOptions): RequestInfo {
  const isRequest = typeof Request === "function" && input instanceof Request;
  const url = isRequest ? (input as Request).url : String(input instanceof URL ? input.href : input);
  const method = String(init?.method ?? (isRequest ? (input as Request).method : "GET")).toUpperCase();
  const headers = new Headers(isRequest ? (input as Request).headers : undefined);
  if (init?.headers) new Headers(init.headers).forEach((v, k) => headers.set(k, v));
  const info: RequestInfo = { api: "fetch", method, url: cleanUrl(url), ms: 0, requestHeaders: redactHeaders(headers) };
  // A body given in init is read here (a string, URLSearchParams, a note for binary). A Request's own body is read from a clone (requestBodyOf).
  if (opts.bodies && init && init.body !== undefined && init.body !== null) {
    const text = bodyText(init.body);
    if (text !== undefined) info.requestBody = redactBody(text, headers.get("content-type"));
  }
  return info;
}

/**
 * The text body of a Request object passed to fetch, read from a clone made
 * before fetch takes it: the request sends its own branch of the body, ours
 * is read alongside and then stopped. Undefined when there is none to read.
 */
function requestBodyOf(input: unknown, init: RequestInit | undefined, info: RequestInfo, opts: RequestLogOptions): Promise<RequestInfo> | undefined {
  if (!opts.bodies || (init && init.body !== undefined && init.body !== null) || typeof Request !== "function" || !(input instanceof Request)) return undefined;
  const type = input.headers.get("content-type");
  if (!input.body || input.bodyUsed || !isTextType(type)) return undefined;
  let copy: Request;
  try {
    copy = input.clone();
  } catch {
    return undefined;
  }
  return readLimited(copy.body).then((text) => (text === undefined ? info : { ...info, requestBody: redactBody(text, type) }));
}

async function observeResponse(res: Response, req: RequestInfo, start: number, opts: RequestLogOptions): Promise<RequestInfo> {
  const info: RequestInfo = { ...req, status: res.status, statusText: res.statusText || undefined, ms: Date.now() - start, responseHeaders: redactHeaders(res.headers) };
  const type = res.headers.get("content-type");
  if (opts.bodies && res.body && !res.bodyUsed && isTextType(type)) {
    let copy: Response | undefined;
    try {
      copy = res.clone();
    } catch {
      copy = undefined;
    }
    // The copy is read to the end of the body (up to MAX_TIMED_BODY), for the total time.
    const text = await readLimited(copy?.body, () => (info.totalMs = Date.now() - start));
    if (text !== undefined) info.responseBody = redactBody(text, type);
  }
  return info;
}

function errorText(err: unknown): string {
  try {
    const e = err as { name?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } };
    const cause = e?.cause && (e.cause.code || e.cause.message) ? ` (${String(e.cause.code ?? e.cause.message)})` : "";
    return `${String(e?.name ?? "Error")}: ${String(e?.message ?? err)}${cause}`.slice(0, 300);
  } catch {
    return "Error";
  }
}

// ---- node:http and node:https --------------------------------------------

type Emit = (event: string | symbol, ...args: unknown[]) => boolean;

function wrapHttp(mod: Record<string, unknown>, key: "request" | "get", protocol: string, on: OnRequest, opts: RequestLogOptions, off: () => boolean): void {
  const original = mod[key] as (...a: unknown[]) => http.ClientRequest;
  if (typeof original !== "function") return;
  const name = `${WRAPPER_MARK}_${protocol.slice(0, -1)}_${key}`;
  const wrapped = {
    [name](this: unknown, ...args: unknown[]) {
      if (off()) return original.apply(this, args);
      let stack: string | undefined;
      try {
        stack = stackHere(wrapped);
      } catch {
        stack = undefined;
      }
      const start = Date.now();
      const req = original.apply(this, args);
      try {
        watchClientRequest(req, protocol, portOf(args), start, stack, on, opts);
      } catch {
        // the request goes out as it is
      }
      return req;
    },
  }[name];
  try {
    Object.defineProperty(wrapped, "name", { value: original.name || key });
    Object.defineProperty(wrapped, "length", { value: original.length });
  } catch {
    // cosmetic only
  }
  mod[key] = wrapped;
}

/** Copies up to `max` bytes (MAX_BODY by default) of the chunks that pass by. */
function collector(max = MAX_BODY) {
  const parts: Buffer[] = [];
  let size = 0;
  return {
    add(chunk: unknown, encoding?: unknown) {
      if (size > max || chunk === undefined || chunk === null || typeof chunk === "function") return;
      let b: Buffer | undefined;
      if (typeof chunk === "string") b = Buffer.from(chunk, typeof encoding === "string" && Buffer.isEncoding(encoding) ? encoding : "utf8");
      else if (chunk instanceof Uint8Array) b = Buffer.from(chunk.subarray(0, max + 1 - size));
      if (!b) return;
      parts.push(b.subarray(0, max + 1 - size));
      size += b.length;
    },
    text: () => (size ? Buffer.concat(parts).toString("utf8") : undefined),
    bytes: () => (size ? Buffer.concat(parts) : undefined),
  };
}

/** Compressed bytes kept of a response body, to unpack at its end. */
const MAX_PACKED = 256_000;

/**
 * A compressed body as text, unpacked from our copy of its bytes (as far as
 * they go, when cut), with nothing read from the app's stream. Undefined for
 * an encoding Node cannot unpack, or bytes that do not unpack.
 */
export function unpack(bytes: Buffer | undefined, encoding: string): string | undefined {
  if (!bytes) return undefined;
  const z = zlib as typeof zlib & { zstdDecompressSync?: (b: Buffer, o?: object) => Buffer };
  const e = encoding.trim().toLowerCase();
  const max = { maxOutputLength: MAX_BODY * 8 };
  const flush = { ...max, finishFlush: zlib.constants.Z_SYNC_FLUSH };
  const once = (b: Buffer): Buffer => {
    if (e === "gzip" || e === "x-gzip") return zlib.gunzipSync(b, flush);
    if (e === "deflate") {
      try {
        return zlib.inflateSync(b, flush);
      } catch {
        return zlib.inflateRawSync(b, flush);
      }
    }
    if (e === "br") return zlib.brotliDecompressSync(b, { ...max, finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
    if (e === "zstd" && typeof z.zstdDecompressSync === "function") return z.zstdDecompressSync(b, max);
    throw new Error("unknown encoding");
  };
  // A body that unpacks past the limit is unpacked again from fewer bytes.
  for (let b = bytes; b.length > 0; b = b.subarray(0, Math.floor(b.length / 4))) {
    try {
      return once(b).toString("utf8");
    } catch (err) {
      if ((err as { code?: string }).code !== "ERR_BUFFER_TOO_LARGE" && !(err instanceof RangeError)) return undefined;
    }
  }
  return undefined;
}

/** The port the app asked for, from a URL or an options object (ClientRequest does not keep it). */
function portOf(args: unknown[]): string | undefined {
  let port: unknown;
  for (const a of args.slice(0, 2)) {
    if (typeof a === "string" || a instanceof URL) {
      try {
        port = new URL(String(a)).port || port;
      } catch {
        // not a URL
      }
    } else if (a && typeof a === "object") {
      const o = a as { port?: unknown; host?: unknown; hostname?: unknown };
      if (o.port !== undefined && o.port !== null && o.port !== "") port = o.port;
      else if (o.hostname === undefined && typeof o.host === "string" && /:\d+$/.test(o.host)) port = o.host.split(":").pop();
    }
  }
  return port === undefined ? undefined : String(port);
}

function watchClientRequest(req: http.ClientRequest, protocol: string, port: string | undefined, start: number, stack: string | undefined, on: OnRequest, opts: RequestLogOptions): void {
  const r = req as http.ClientRequest & { host?: string; protocol?: string; emit: Emit };
  const host = String(r.host ?? "localhost");
  const sent = collector();
  let reported = false;
  const report = (extra: Partial<RequestInfo>) => {
    if (reported) return;
    reported = true;
    try {
      const headers = r.getHeaders();
      const defaultPort = (r.protocol ?? protocol) === "https:" ? "443" : "80";
      const info: RequestInfo = {
        api: "http",
        method: String(r.method ?? "GET").toUpperCase(),
        url: cleanUrl(`${r.protocol ?? protocol}//${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}${port && port !== defaultPort ? `:${port}` : ""}${r.path ?? "/"}`),
        ms: Date.now() - start,
        requestHeaders: redactHeaders(headers as Record<string, unknown>),
        ...extra,
      };
      const body = sent.text();
      if (opts.bodies && body !== undefined && isTextType(String(headers["content-type"] ?? ""))) info.requestBody = redactBody(body, String(headers["content-type"]));
      on(stack, info);
    } catch {
      // nothing to report
    }
  };

  if (opts.bodies) {
    const m = req as unknown as { write: (...a: unknown[]) => unknown; end: (...a: unknown[]) => unknown };
    const write = m.write;
    const end = m.end;
    m.write = function (this: unknown, ...a: unknown[]) {
      sent.add(a[0], a[1]);
      return write.apply(this, a);
    };
    m.end = function (this: unknown, ...a: unknown[]) {
      if (typeof a[0] !== "function") sent.add(a[0], a[1]);
      return end.apply(this, a);
    };
  }

  // Seen without changing what the runtime does: a 'response' listener
  // would stop Node from discarding an unread response, a 'data' listener
  // would start the flow, an 'error' listener would stop an error the app
  // does not handle from ending it, and a wrapper around emit would be named
  // in the trace Node prints for such an error. So in Node the response is
  // met where Node sets req.res, errors through errorMonitor (which never
  // counts as handling one), and the body as Node pushes it in. Bun's and
  // Deno's http are their own code: there emit is watched.
  if (NODE_HTTP) {
    let res: unknown = (r as { res?: unknown }).res ?? null;
    Object.defineProperty(r, "res", {
      configurable: true,
      enumerable: true,
      get: () => res,
      set(v: unknown) {
        res = v;
        try {
          // A 101 to an upgrade is the WebSocket itself (the ws package), shown as its own entries.
          if (v && !((v as http.IncomingMessage).statusCode === 101 && r.getHeader("upgrade"))) watchResponse(v as http.IncomingMessage, start, report, opts);
        } catch {
          // keep going
        }
      },
    });
    r.on(errorMonitor, (err: unknown) => report({ error: errorText(err) }));
    return;
  }
  const emit = r.emit;
  r.emit = function (this: unknown, event: string | symbol, ...a: unknown[]) {
    try {
      if (event === "response") watchResponse(a[0] as http.IncomingMessage, start, report, opts);
      else if (event === "error") report({ error: errorText(a[0]) });
    } catch {
      // keep going
    }
    return emit.call(this, event, ...a);
  };
}

function watchResponse(res: http.IncomingMessage, start: number, report: (extra: Partial<RequestInfo>) => void, opts: RequestLogOptions): void {
  const ms = Date.now() - start;
  const type = String(res.headers["content-type"] ?? "");
  const encoding = String(res.headers["content-encoding"] ?? "");
  const encoded = encoding !== "" && !/^\s*identity\s*$/i.test(encoding);
  const keep = opts.bodies && isTextType(type);
  // Compressed bytes are kept as they came, and unpacked from that copy at the end.
  const got = collector(encoded ? MAX_PACKED : MAX_BODY);
  const base: Partial<RequestInfo> = { status: res.statusCode, statusText: res.statusMessage || undefined, ms, responseHeaders: redactHeaders(res.headers as Record<string, unknown>) };
  /** `ended`: the body arrived to its end, so its time is the total time. */
  const finish = (ended: boolean) => {
    clearTimeout(timer);
    const text = keep ? (encoded ? unpack(got.bytes(), encoding) : got.text()) : undefined;
    report({ ...base, ...(ended ? { totalMs: Date.now() - start } : {}), ...(text !== undefined ? { responseBody: redactBody(text, type) } : {}) });
  };
  // A response the app never reads to the end is shown as far as it got.
  const timer = setTimeout(() => finish(false), BODY_WAIT_MS);
  timer.unref?.();
  if (NODE_HTTP) {
    // Each piece of the body as Node pushes it in, read by the app or not; null is its end.
    const p = res as unknown as { push: (chunk: unknown, encoding?: unknown) => boolean };
    const push = p.push;
    p.push = function (this: unknown, chunk: unknown, encoding?: unknown) {
      try {
        if (chunk === null) finish(true);
        else if (keep) got.add(chunk, encoding);
      } catch {
        // keep going
      }
      return push.call(this, chunk, encoding);
    };
    res.on(errorMonitor, () => finish(false));
    res.on("close", () => finish(false));
    return;
  }
  const r = res as http.IncomingMessage & { emit: Emit };
  const emit = r.emit;
  r.emit = function (this: unknown, event: string | symbol, ...a: unknown[]) {
    try {
      if (event === "data" && keep) got.add(a[0], (res as unknown as { readableEncoding?: string }).readableEncoding);
      else if (event === "end") finish(true);
      else if (event === "close" || event === "aborted" || event === "error") finish(false);
    } catch {
      // keep going
    }
    return emit.call(this, event, ...a);
  };
}
