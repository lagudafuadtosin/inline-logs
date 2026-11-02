// Browser support for dev servers (Vite, webpack-dev-server, Next.js), with
// no config. The dev server runs in a Node process that has the hook, so here we:
//  1. add a small inline <script> to the HTML pages it serves, and nothing
//     else: pages with Vite's dev client (/@vite/client) in any process, and
//     every HTML page in a webpack-dev-server or `next dev` process. Pages
//     sent in one piece or streamed both work; so do pages with a
//     Content-Security-Policy (see csp.ts);
//  2. answer that script's POSTs on a private path of the same server, so the
//     page needs no CORS and no extra port;
//  3. turn the browser's stack frames back into file paths and source lines,
//     by asking the same dev server for the module (or, for webpack's eval
//     devtools, the page's scripts) and reading its source map.
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { BROWSER_PATH, CLIENT_CONFIG, WRAPPER_MARK } from "../names";
import { fileUrlToPath, isInternal, isLibrary, type Frame } from "../shared/stack";
import type { Entry, Level, RequestInfo } from "../shared/types";
import { ALL_METHODS, LEVELS } from "../shared/types";
import { evalMaps, evalSources, externalMapUrl, inlineAnyMap, lineInSource, makeMapper, parseMap, type Mapper } from "./sourcemap";
import { allowClientAll, allowClientInMeta, scriptHash } from "./csp";

declare const __CLIENT_JS__: string;

type Partial = Omit<Entry, "id" | "pid">;

/** What the browser client posts. */
interface BrowserEntry {
  kind: "log" | "error" | "request";
  level: Level;
  frames: Frame[];
  preview: string;
  full: string;
  time: number;
  method?: Entry["method"];
  group?: string;
  json?: string;
  request?: RequestInfo;
}

const MAX_BODY = 2_000_000;
const MARK = Symbol("inlineLogsResponse");
const NONCE = Symbol("inlineLogsNonce");
/** Fetched modules and scripts are read again after this long: dev servers change them in place. */
const FRESH_MS = 3_000;

interface Client {
  endpoint: string;
  /** The script's text, without the tag. */
  body: string;
  /** Its CSP hash. */
  hash: string;
}

export function installBrowserBridge(push: (e: Partial) => void, root = process.cwd(), requests = { requests: true, requestBodies: true }): void {
  const endpoint = BROWSER_PATH + randomBytes(8).toString("hex");
  const body = `window[${JSON.stringify(CLIENT_CONFIG)}]=${JSON.stringify({ endpoint, ...requests })};${typeof __CLIENT_JS__ === "string" ? __CLIENT_JS__ : ""}`;
  patchResponse({ endpoint, body, hash: scriptHash(body) });
  for (const proto of [http.Server.prototype, https.Server.prototype]) patchEmit(proto as unknown as Emitter, endpoint, push, root);
}

// ---- 1. HTML injection --------------------------------------------------

/**
 * The dev servers we inject into without a marker in the page. Vite pages
 * mostly have one (/@vite/client), but frameworks on Vite (SvelteKit, Astro,
 * React Router, Nuxt) send pages that load it later, and fix their headers
 * first: their dev commands are known here too. webpack-dev-server and next
 * dev are known by the command that started the process, the variable next
 * dev sets for its server, or modules only they load.
 */
let devServer = false;
let modulesSeen = -1;
export function isDevServerProcess(
  argv: readonly string[] = process.argv,
  cache: Record<string, unknown> | undefined = typeof require === "function" ? require.cache : undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (devServer) return true;
  if (env.__NEXT_DEV_SERVER) return (devServer = true);
  const script = argv[1] ?? "";
  if (/[\\/]webpack-dev-server[\\/]bin[\\/]/.test(script)) return (devServer = true);
  if (/[\\/](webpack|webpack-cli)[\\/]bin[\\/]/.test(script) && argv.slice(2).some((a) => a === "serve" || a === "server" || a === "s")) return (devServer = true);
  // Vite and the frameworks that run their dev server on it, started for development.
  const sub = argv.slice(2).find((a) => !a.startsWith("-"));
  if (/[\\/]vite[\\/]bin[\\/]vite\.js$/.test(script) && (sub === undefined || sub === "dev" || sub === "serve")) return (devServer = true);
  if (/[\\/](astro[\\/]astro\.js|@react-router[\\/]dev[\\/]bin\.js|nuxi[\\/]bin[\\/]nuxi\.mjs|nuxt[\\/]bin[\\/]nuxt\.mjs)$/.test(script) && sub === "dev") return (devServer = true);
  // Nuxt starts its dev server in a child process of its own.
  if (/[\\/](nuxi|@nuxt[\\/]cli)[\\/]dist[\\/]dev[\\/]/.test(script)) return (devServer = true);
  // Called for every response: the module list is only read again when it has grown.
  const keys = Object.keys(cache ?? {});
  if (keys.length === modulesSeen) return false;
  modulesSeen = keys.length;
  for (const k of keys) {
    if (/[\\/]node_modules[\\/](webpack-dev-server|webpack-dev-middleware)[\\/]/.test(k) || /[\\/]node_modules[\\/]next[\\/]dist[\\/]server[\\/]dev[\\/]/.test(k)) return (devServer = true);
  }
  return false;
}

/**
 * webpack's Compiler and MultiCompiler: a watch that webpack-dev-middleware
 * or webpack-dev-server starts makes this process a dev server, however they
 * were loaded (as ES modules they are not in require.cache). webpack itself
 * is always loaded through CommonJS, so this is seen.
 */
export function noteDevCompiler(Compiler: { prototype: Record<string, unknown> }): void {
  const proto = Compiler?.prototype;
  const watch = proto?.watch;
  if (!proto || typeof watch !== "function") return;
  const name = `${WRAPPER_MARK}_webpackWatch`;
  const wrapped = {
    [name](this: unknown, ...args: unknown[]) {
      try {
        if (!devServer) {
          const holder: { stack?: string } = {};
          const limit = Error.stackTraceLimit;
          Error.stackTraceLimit = 20;
          Error.captureStackTrace(holder, wrapped);
          Error.stackTraceLimit = limit;
          if (/[\\/]webpack-dev-(middleware|server)[\\/]/.test(holder.stack ?? "")) devServer = true;
        }
      } catch {
        // the watch goes on as it is
      }
      return (watch as (...a: unknown[]) => unknown).apply(this, args);
    },
  }[name];
  try {
    Object.defineProperty(wrapped, "name", { value: watch.name || "watch" });
    Object.defineProperty(wrapped, "length", { value: watch.length });
  } catch {
    // cosmetic only
  }
  proto.watch = wrapped;
}

type Res = http.ServerResponse & { [MARK]?: "ready" | "done"; [NONCE]?: string; _header?: string | null };

/** Adds the script to a dev server's HTML page (or the first piece of it). Pages from other servers, and fragments, are returned as they are. */
export function injectInto(html: string, script: string, dev = false): string {
  if (!wantsClient(html, dev)) return html;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + script + html.slice(head.index + head[0].length);
  const firstScript = html.search(/<script/i);
  if (firstScript >= 0) return html.slice(0, firstScript) + script + html.slice(firstScript);
  return script + html;
}

function wantsClient(html: string, dev: boolean): boolean {
  if (html.includes(CLIENT_CONFIG)) return false;
  // SvelteKit's dev pages load Vite's client later, from a script that imports through /@fs/.
  return html.includes("/@vite/client") || (html.includes("__sveltekit_dev") && html.includes("/@fs/")) || (dev && /<(!doctype html|html|head)[\s>]/i.test(html));
}

function tag(c: Client, nonce: string | undefined): string {
  return `<script${nonce ? ` nonce="${nonce.replace(/[^\w+/=-]/g, "")}"` : ""}>${c.body}</script>`;
}

function header(res: Res, name: string): string | undefined {
  const v = res.getHeader(name);
  return v === undefined ? undefined : Array.isArray(v) ? v.join(", ") : String(v);
}

/** From the raw header block once headers are fixed. */
function rawHeader(raw: string, name: string): string | undefined {
  const m = new RegExp(`\\r\\n${name}:\\s*([^\\r\\n]*)`, "i").exec(raw);
  return m?.[1];
}

function isHtmlType(type: string | undefined, encoding: string | undefined): boolean {
  return !!type && /text\/html/i.test(type) && (encoding === undefined || /^\s*identity\s*$/i.test(encoding));
}

function endpointUrl(res: Res, c: Client): string {
  const req = res.req as http.IncomingMessage | undefined;
  const secure = !!(req?.socket as { encrypted?: boolean } | undefined)?.encrypted;
  return `${secure ? "https" : "http"}://${req?.headers.host ?? "localhost"}${c.endpoint}`;
}

/** Makes the page's CSP header (still unsent) allow the client. Returns the nonce to use, if the policy has one. */
function fixCspHeader(res: Res, c: Client, headers?: Record<string, unknown>): string | undefined {
  let nonce: string | undefined;
  const key = headers && Object.keys(headers).find((k) => k.toLowerCase() === "content-security-policy");
  const value = key ? headers[key] : res.getHeader("content-security-policy");
  if (value === undefined) return undefined;
  const fix = (v: string) => {
    const a = allowClientAll(v, c.hash, endpointUrl(res, c));
    nonce ??= a.nonce;
    return a.policy;
  };
  const next = Array.isArray(value) ? value.map((v) => fix(String(v))) : fix(String(value));
  if (key) headers[key] = next;
  else res.setHeader("content-security-policy", next);
  return nonce;
}

function patchResponse(c: Client): void {
  const proto = http.ServerResponse.prototype as Res;
  const writeHead = proto.writeHead;
  const write = proto.write;
  const end = proto.end;

  // Streamed pages (webpack-dev-server, Next.js) fix their headers before
  // the first piece of the page. In a dev server process an HTML page drops
  // its Content-Length here (it goes out chunked), so the first piece can grow.
  proto.writeHead = function (this: Res, ...args: unknown[]) {
    try {
      if (this[MARK] === undefined && !this._header && isDevServerProcess()) {
        const status = typeof args[0] === "number" ? args[0] : this.statusCode;
        const obj = args.find((a, i) => i > 0 && a && typeof a === "object" && !Array.isArray(a)) as Record<string, unknown> | undefined;
        const get = (name: string) => {
          const k = obj && Object.keys(obj).find((x) => x.toLowerCase() === name);
          const v = k ? obj[k] : this.getHeader(name);
          return v === undefined ? undefined : String(v);
        };
        const method = (this.req as http.IncomingMessage | undefined)?.method;
        if (status === 200 && method !== "HEAD" && isHtmlType(get("content-type"), get("content-encoding"))) {
          this.removeHeader("content-length");
          if (obj) for (const k of Object.keys(obj)) if (k.toLowerCase() === "content-length") delete obj[k];
          this[NONCE] = fixCspHeader(this, c, obj);
          this[MARK] = "ready";
        }
      }
    } catch {
      // send the headers as they were
    }
    return (writeHead as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof proto.writeHead;

  proto.write = function (this: Res, ...args: unknown[]) {
    if (this[MARK] !== "done") inject(this, args, c);
    return (write as (...a: unknown[]) => boolean).apply(this, args);
  } as typeof proto.write;

  proto.end = function (this: Res, ...args: unknown[]) {
    if (this[MARK] !== "done" && args[0] !== undefined && typeof args[0] !== "function") inject(this, args, c);
    return (end as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof proto.end;
}

/** Looks at the first non-empty piece of a response, and adds the script to it when the response is a dev server page that can take it. */
function inject(res: Res, args: unknown[], c: Client): void {
  try {
    const chunk = args[0];
    if (!(typeof chunk === "string" || Buffer.isBuffer(chunk) || chunk instanceof Uint8Array)) return;
    if (chunk.length === 0) return;
    const ready = res[MARK] === "ready";
    res[MARK] = "done";
    const fixed = res.headersSent || !!res._header;
    let nonce = res[NONCE];
    if (!ready) {
      if (fixed) {
        // Fixed without us: only a chunked, uncompressed HTML page can grow.
        const raw = res._header ?? "";
        if (!isHtmlType(rawHeader(raw, "content-type"), rawHeader(raw, "content-encoding")) || rawHeader(raw, "content-length") !== undefined) return;
        const csp = rawHeader(raw, "content-security-policy");
        if (csp) nonce = allowClientAll(csp, c.hash, endpointUrl(res, c)).nonce;
      } else if (!isHtmlType(header(res, "content-type"), header(res, "content-encoding"))) {
        return;
      }
    }
    const enc = typeof args[1] === "string" ? (args[1] as BufferEncoding) : "utf8";
    const text = typeof chunk === "string" ? (enc === "utf8" ? chunk : Buffer.from(chunk, enc).toString("utf8")) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("utf8");
    const dev = isDevServerProcess();
    if (!wantsClient(text, dev)) return;
    // The page can change from here on: its CSP first, then the script.
    if (!fixed && !ready) nonce = fixCspHeader(res, c);
    const meta = allowClientInMeta(text, c.hash, endpointUrl(res, c));
    const out = injectInto(meta.html, tag(c, nonce ?? meta.nonce), dev);
    if (out === text) return;
    args[0] = typeof chunk === "string" ? out : Buffer.from(out, "utf8");
    if (typeof chunk === "string" && enc !== "utf8") args[1] = "utf8";
    if (!fixed && res.hasHeader("content-length")) {
      const before = Number(res.getHeader("content-length"));
      const added = Buffer.byteLength(out) - Buffer.byteLength(text);
      if (Number.isFinite(before)) res.setHeader("content-length", before + added);
    }
  } catch {
    // serve the page as it was
  }
}

// ---- 2. Endpoint ---------------------------------------------------------

interface Emitter {
  emit(event: string | symbol, ...args: unknown[]): boolean;
}

function patchEmit(proto: Emitter, endpoint: string, push: (e: Partial) => void, root: string): void {
  const emit = proto.emit;
  proto.emit = function (this: unknown, event: string | symbol, ...args: unknown[]) {
    if (event === "request") {
      const req = args[0] as http.IncomingMessage | undefined;
      if (req && typeof req.url === "string" && req.url === endpoint) {
        try {
          handle(req, args[1] as http.ServerResponse, push, root);
          return true;
        } catch {
          // fall through to the app
        }
      }
      try {
        // A dev server would compress the page, and a compressed page cannot take the script.
        if (req && req.headers["accept-encoding"] && isPageRequest(req) && isDevServerProcess()) delete req.headers["accept-encoding"];
      } catch {
        // leave the request alone
      }
    }
    return emit.call(this, event, ...args);
  };
}

function isPageRequest(req: http.IncomingMessage): boolean {
  if (req.method !== "GET") return false;
  const dest = req.headers["sec-fetch-dest"];
  if (dest) return dest === "document" || dest === "iframe";
  return /^text\/html/i.test(String(req.headers.accept ?? ""));
}

/** Every page's entries go out one after another, in the order their posts came. */
let inOrder = Promise.resolve();

function handle(req: http.IncomingMessage, res: http.ServerResponse, push: (e: Partial) => void, root: string): void {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end();
    return;
  }
  let size = 0;
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size <= MAX_BODY) chunks.push(c);
  });
  req.on("error", () => undefined);
  req.on("end", () => {
    res.statusCode = 204;
    res.end();
    if (size > MAX_BODY) return;
    let entries: BrowserEntry[];
    let scripts: string[] = [];
    let page: string | undefined;
    let load: string | undefined;
    let hello: boolean;
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { entries: BrowserEntry[]; scripts?: unknown; page?: unknown; load?: unknown; hello?: unknown };
      entries = body.entries;
      if (!Array.isArray(entries)) return;
      if (Array.isArray(body.scripts)) scripts = body.scripts.filter((s): s is string => typeof s === "string").slice(-300);
      if (typeof body.page === "string") page = body.page.slice(0, 500);
      if (typeof body.load === "string") load = body.load.slice(0, 40);
      hello = body.hello === true;
    } catch {
      return;
    }
    const origin = originOf(req);
    // Keep the order the browser logged in, across its posts too: a later post waits for the one before.
    // A page that just loaded says so first: its earlier load's problems go.
    if (hello && page !== undefined && load !== undefined) {
      const notice: Partial = { kind: "log", level: "log", file: page, line: 1, col: 1, preview: "", full: "", time: Date.now(), source: "browser", run: page, load, pageLoad: true };
      inOrder = inOrder.then(() => push(notice), () => undefined);
    }
    for (const be of entries.slice(0, 1000)) {
      inOrder = inOrder.then(() => resolveEntry(be, origin, root, scripts).then((e) => e && push(page !== undefined && load !== undefined ? { ...e, run: page, load } : e)), () => undefined).catch(() => undefined);
    }
  });
}

interface Origin {
  secure: boolean;
  host: string;
  port: number;
  hostHeader: string | undefined;
}

function originOf(req: http.IncomingMessage): Origin {
  const sock = req.socket as { localAddress?: string; localPort?: number; encrypted?: boolean };
  let host = sock.localAddress || "127.0.0.1";
  if (host.startsWith("::ffff:")) host = host.slice(7);
  if (host === "::" || host === "0.0.0.0") host = "127.0.0.1";
  return { secure: !!sock.encrypted, host, port: sock.localPort || 80, hostHeader: req.headers.host };
}

// ---- 3. Frames to files --------------------------------------------------

type Pos = { file: string; line: number; col: number };

async function resolveEntry(be: BrowserEntry, origin: Origin, root: string, scripts: string[] = []): Promise<Partial | undefined> {
  if (!be || typeof be !== "object" || !Array.isArray(be.frames)) return undefined;
  const level: Level = LEVELS.includes(be.level) ? be.level : "log";
  let lib: Pos | undefined;
  for (const f of be.frames.slice(0, 20)) {
    if (!f || typeof f.file !== "string" || isInternal(f)) continue;
    let url: URL;
    try {
      url = new URL(f.file);
    } catch {
      continue;
    }
    const pos = await mapFrame(url, f.file, Number(f.line), Number(f.col), origin, root, scripts);
    if (!pos) continue;
    if (isLibrary(pos.file) || isLibrary(url.pathname)) {
      lib ??= pos;
      continue;
    }
    return entryAt(be, level, pos, false);
  }
  return lib ? entryAt(be, level, lib, true) : undefined;
}

function entryAt(be: BrowserEntry, level: Level, pos: Pos, lib: boolean): Partial {
  const request = be.kind === "request" ? requestOf(be.request) : undefined;
  return {
    kind: be.kind === "error" ? "error" : request ? "request" : "log",
    level,
    file: pos.file,
    line: pos.line,
    col: pos.col,
    preview: String(be.preview ?? "").slice(0, 2_000),
    full: String(be.full ?? "").slice(0, 50_000),
    time: Number(be.time) || Date.now(),
    source: "browser",
    lib: lib || undefined,
    method: be.method && ALL_METHODS.includes(be.method) ? be.method : undefined,
    group: typeof be.group === "string" && be.group ? be.group.slice(0, 500) : undefined,
    json: typeof be.json === "string" && be.json.length <= 100_000 ? be.json : undefined,
    request,
  };
}

/** The request the page sent, with only the fields and sizes we expect. */
function requestOf(r: unknown): RequestInfo | undefined {
  if (!r || typeof r !== "object") return undefined;
  const o = r as Record<string, unknown>;
  if (typeof o.method !== "string" || typeof o.url !== "string") return undefined;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
  const headers = (v: unknown) => {
    if (!v || typeof v !== "object") return undefined;
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 100)) if (typeof x === "string") out[k.slice(0, 200)] = x.slice(0, 2_000);
    return out;
  };
  const ws = o.ws && typeof o.ws === "object" ? (o.ws as Record<string, unknown>) : undefined;
  const events = ["open", "send", "message", "close", "error"];
  const api = o.api === "xhr" || o.api === "beacon" ? o.api : (o.api === "websocket" || o.api === "eventsource") && ws ? o.api : "fetch";
  return {
    api,
    method: o.method.slice(0, 20),
    url: o.url.slice(0, 4_000),
    status: Number.isInteger(o.status) ? (o.status as number) : undefined,
    statusText: text(o.statusText, 200),
    ms: Number(o.ms) || 0,
    totalMs: Number.isFinite(o.totalMs) ? (o.totalMs as number) : undefined,
    error: text(o.error, 300),
    requestHeaders: headers(o.requestHeaders),
    responseHeaders: headers(o.responseHeaders),
    requestBody: text(o.requestBody, 20_000),
    responseBody: text(o.responseBody, 20_000),
    ws:
      ws && events.includes(String(ws.event))
        ? {
            event: ws.event as "open",
            data: text(ws.data, 20_000),
            size: Number.isFinite(ws.size) ? (ws.size as number) : undefined,
            code: Number.isInteger(ws.code) ? (ws.code as number) : undefined,
            reason: text(ws.reason, 300),
          }
        : undefined,
  };
}

interface Loaded {
  at: number;
  mapper?: Mapper;
  /** The map's own copy of each source's text, by source name (Astro's scripts need it). */
  contents?: Map<string, string>;
}
const cache = new Map<string, Promise<Loaded>>();

/** `raw` is the frame's file as the browser printed it: a URL object drops the "./" a webpack module name has. */
async function mapFrame(url: URL, raw: string, line: number, col: number, origin: Origin, root: string, scripts: string[]): Promise<Pos | undefined> {
  if (url.protocol === "webpack-internal:" || url.protocol === "webpack:") return mapEvalFrame(raw, line, col, origin, root, scripts);
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const key = url.pathname + url.search;
  let loaded = cache.get(key);
  const now = Date.now();
  if (!loaded || ((await loaded).at < now - FRESH_MS)) {
    loaded = fetchText(key, origin).then(async (code) => {
      let map = code ? inlineAnyMap(code) : undefined;
      const ext = code && !map ? externalMapUrl(code) : undefined;
      if (ext) {
        const mapUrl = new URL(ext, `http://x${url.pathname}`);
        const text = await fetchText(mapUrl.pathname + mapUrl.search, origin);
        if (text) map = parseMap(text);
      }
      const contents = new Map<string, string>();
      if (map && "sources" in map) map.sources.forEach((src, i) => typeof map.sourcesContent?.[i] === "string" && contents.set(src, map.sourcesContent[i] as string));
      return { at: Date.now(), mapper: map ? makeMapper(map) : undefined, contents };
    }, () => ({ at: Date.now() }));
    cache.set(key, loaded);
    if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  }
  const { mapper, contents } = await loaded;
  const o = mapper?.original(line, col);
  if (o) {
    const file = sourceToFile(o.source, url.pathname, root);
    const astro = file && /^(.*\.astro)\?astro&type=script&index=(\d+)/.exec(file);
    if (astro) {
      const copy = contents?.get(o.source)?.split(/\r?\n/);
      const text = copy?.[o.line - 1];
      // The same text earlier in Astro's copy: this is a later one of identical lines.
      const nth = text === undefined || !copy ? 0 : copy.slice(0, o.line - 1).filter((l) => l.trim() === text.trim()).length;
      return astroScriptLine(astro[1], Number(astro[2]), text, o.col, nth);
    }
    return file ? { file, line: o.line, col: o.col } : undefined;
  }
  // A bundle with no map (webpack's own runtime) is not a file to show a value in.
  const file = urlPathToFile(url.pathname, root);
  return existsSync(file) ? { file, line, col } : undefined;
}

/**
 * A <script> in an .astro file is its own module, which Astro writes out
 * again in its own layout, so its map points at that copy and not at the
 * file. The line is found by its text in the file, from the script's tag on.
 * `nth` counts the lines with the same text before it in Astro's copy, so
 * the second of two identical lines lands on the second.
 */
export function astroScriptLine(file: string, index: number, text: string | undefined, col: number, nth = 0): Pos | undefined {
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const lines = src.split(/\r?\n/);
  // The scripts Astro bundles: not is:inline ones, and not in the frontmatter.
  let fence = 0;
  let n = -1;
  let start = -1;
  for (let i = 0; i < lines.length && start < 0; i++) {
    if (i === fence && /^\s*---\s*$/.test(lines[i])) {
      const close = lines.findIndex((l, j) => j > i && /^\s*---\s*$/.test(l));
      if (close > 0) {
        fence = -1;
        i = close;
        continue;
      }
    }
    for (const m of lines[i].matchAll(/<script\b([^>]*)>/gi)) if (!/\bis:inline\b/.test(m[1]) && ++n === index) start = i;
  }
  if (start < 0) return undefined;
  const want = text?.trim();
  if (want) {
    let first: Pos | undefined;
    let seen = 0;
    for (let i = start; i < lines.length; i++) {
      if (i > start && /<\/script>/i.test(lines[i - 1])) break;
      // Astro drops comments, so the file's line can go on after the text.
      if (!lines[i].trim().startsWith(want)) continue;
      const pos = { file, line: i + 1, col: lines[i].indexOf(want) + 1 || col };
      if (seen++ === nth) return pos;
      first ??= pos;
    }
    if (first) return first;
  }
  return { file, line: start + 1, col: 1 };
}

// webpack's eval devtools: the module's code and map are inside one of the page's scripts.

interface Scanned {
  at: number;
  maps: Map<string, string>;
  codes: Map<string, string>;
  mappers: Map<string, Mapper>;
}
const scriptCache = new Map<string, Promise<Scanned>>();

async function scanScript(src: string, origin: Origin, maxAge: number): Promise<Scanned | undefined> {
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return undefined;
  }
  // Only scripts from this same dev server.
  if (u.port && Number(u.port) !== origin.port) return undefined;
  const key = u.pathname + u.search;
  let s = scriptCache.get(key);
  if (!s || (await s).at < Date.now() - maxAge) {
    s = fetchText(key, origin).then(
      (code) => {
        const maps = code ? evalMaps(code) : new Map<string, string>();
        return { at: Date.now(), maps, codes: code && maps.size === 0 ? evalSources(code) : new Map<string, string>(), mappers: new Map() };
      },
      () => ({ at: Date.now(), maps: new Map(), codes: new Map(), mappers: new Map() }),
    );
    scriptCache.set(key, s);
    if (scriptCache.size > 300) scriptCache.delete(scriptCache.keys().next().value as string);
  }
  return s;
}

async function mapEvalFrame(sourceUrl: string, line: number, col: number, origin: Origin, root: string, scripts: string[]): Promise<Pos | undefined> {
  const file = sourceToFile(sourceUrl, "", root);
  if (!file) return undefined;
  // Newest scripts first: a hot update holds the latest code of a module.
  // Scripts already read are used as they are, then read again when stale.
  const look = async (maxAge: number): Promise<Pos | null | undefined> => {
    for (const src of [...scripts].reverse()) {
      const s = await scanScript(src, origin, maxAge);
      if (!s) continue;
      const b64 = s.maps.get(sourceUrl);
      if (b64) {
        let mapper = s.mappers.get(sourceUrl);
        if (!mapper) {
          const map = parseMap(Buffer.from(b64, "base64").toString("utf8"));
          s.mappers.set(sourceUrl, (mapper = map ? makeMapper(map) : { original: () => undefined }));
        }
        const o = mapper.original(line, col);
        if (o) {
          const src = sourceToFile(o.source, "", root, root);
          return src ? { file: src, line: o.line, col: o.col } : null;
        }
      }
      const code = s.codes.get(sourceUrl);
      if (code) {
        try {
          const l = lineInSource(code, readFileSync(file, "utf8"), line);
          if (l) return { file, line: l, col };
        } catch {
          // keep the module's own position
        }
      }
    }
    return undefined;
  };
  try {
    let hit = await look(FRESH_MS * 3);
    if (hit === undefined) hit = await look(FRESH_MS);
    if (hit === null) return undefined;
    if (hit) return hit;
  } catch {
    // fall back to the file
  }
  return { file, line, col };
}

export function urlPathToFile(urlPath: string, root: string): string {
  let p = urlPath;
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep
  }
  // A dev server with a base path (Nuxt serves from /_nuxt/): the path below it.
  const base = /^\/[^/]+(\/@fs\/.*)$/.exec(p);
  if (base) p = base[1];
  if (p.startsWith("/@fs/")) {
    p = p.slice(4);
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return path.normalize(p);
  }
  const file = path.join(root, p);
  if (!existsSync(file)) {
    const below = /^\/[^/]+\/(.+)$/.exec(p);
    if (below && existsSync(path.join(root, below[1]))) return path.join(root, below[1]);
  }
  return file;
}

/**
 * A source named in a map (or a bundler's module URL) as a file path.
 * Undefined for bundler runtime code that has no file. `root` is the
 * project folder, which bundler URLs are relative to. Other relative sources
 * are relative to `baseDir` (a folder on disk) when given, else to `urlPath`
 * (the served URL of the module).
 */
export function sourceToFile(source: string, urlPath: string, root: string, baseDir?: string): string | undefined {
  let s = source;
  // Bundler URLs: webpack://name/./src/a.js, webpack-internal:///(layer)/./src/a.js, turbopack:///[project]/src/a.js
  const bundler = /^(?:webpack(?:-internal)?|turbopack):\/\/([^/]*)\/(.*)$/.exec(s);
  if (bundler) {
    let rest = bundler[2].replace(/[?#].*$/, "");
    if (/^(webpack\/(runtime|bootstrap)|\[turbopack\])/.test(rest)) return undefined;
    rest = rest.replace(/^\([^)]*\)\//, "").replace(/^\[project\]\//, "");
    if (/^\/?[A-Za-z]:[\\/]/.test(rest)) return path.normalize(rest.replace(/^\//, ""));
    if (rest.startsWith("/") && !bundler[1]) return path.normalize(rest);
    return path.join(root, rest);
  }
  if (s.startsWith("file://")) return path.normalize(fileUrlToPath(s));
  if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
  if (/^[A-Za-z]:[\\/]/.test(s)) return path.normalize(s);
  if (s.startsWith("/")) {
    // Either an absolute file path (POSIX) or a URL path on the dev server.
    if (baseDir !== undefined || (existsSync(s) && !existsSync(path.join(root, s)))) return s;
    return urlPathToFile(s, root);
  }
  if (baseDir !== undefined) return path.resolve(baseDir, s);
  // Relative to the module's own URL.
  const dir = urlPath.slice(0, urlPath.lastIndexOf("/") + 1);
  return urlPathToFile(path.posix.normalize(dir + s), root);
}

/**
 * Reads a module from the dev server that served the page. A page served
 * through a proxy in front of a worker (Nuxt's dev server) reaches this
 * process on the worker's own address, which does not serve the modules:
 * then the address the browser used is tried, when it is this machine.
 */
async function fetchText(pathAndQuery: string, o: Origin): Promise<string | undefined> {
  const text = await fetchFrom(pathAndQuery, o);
  if (text !== undefined) return text;
  const m = /^(localhost|127\.0\.0\.1|\[::1\]):(\d+)$/i.exec(o.hostHeader ?? "");
  if (!m || Number(m[2]) === o.port) return undefined;
  return fetchFrom(pathAndQuery, { ...o, host: m[1] === "[::1]" ? "::1" : m[1] === "localhost" ? "localhost" : "127.0.0.1", port: Number(m[2]) });
}

function fetchFrom(pathAndQuery: string, o: Origin): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      const mod = o.secure ? https : http;
      const req = mod.request(
        {
          host: o.host,
          port: o.port,
          path: pathAndQuery,
          method: "GET",
          agent: false,
          rejectUnauthorized: false,
          headers: { host: o.hostHeader ?? `${o.host}:${o.port}`, accept: "*/*" },
        },
        (res) => {
          if ((res.statusCode ?? 500) >= 400) {
            res.resume();
            resolve(undefined);
            return;
          }
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => {
            if (body.length < 30_000_000) body += c;
          });
          res.on("end", () => resolve(body));
          res.on("error", () => resolve(undefined));
        },
      );
      req.on("error", () => resolve(undefined));
      req.setTimeout(5_000, () => req.destroy());
      req.end();
    } catch {
      resolve(undefined);
    }
  });
}
