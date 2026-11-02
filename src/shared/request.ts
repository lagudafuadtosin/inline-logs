// What the request log keeps of a fetch, XMLHttpRequest or http(s) call, and
// how it is shown. Shared by the Node hook and the browser client, so no
// Node imports. Secrets never leave the app's process: secret headers, and
// secret-looking fields in JSON and form bodies, are replaced here.
import type { Level, RequestInfo } from "./types";

/** Longest body kept, in characters. */
export const MAX_BODY = 16_000;
/** A response body still not finished after this long is shown as far as it got. */
export const BODY_WAIT_MS = 10_000;
export const REDACTED = "[redacted]";

const SECRET_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;
const SECRET_FIELDS = /pass(word|wd)?$|secret|token|api[-_]?key|^auth|authorization|cookie|session|credential|private[-_]?key/i;

/** Headers as a plain object, lower-case names, secret ones redacted. */
export function redactHeaders(headers: Iterable<[string, string]> | Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const pairs: Iterable<[string, unknown]> = Symbol.iterator in Object(headers) ? (headers as Iterable<[string, string]>) : Object.entries(headers);
  for (const [k, v] of pairs) {
    if (v === undefined || v === null) continue;
    const name = String(k).toLowerCase();
    out[name] = SECRET_HEADERS.test(name) ? REDACTED : Array.isArray(v) ? v.map(String).join(", ") : String(v);
  }
  return out;
}

/** True for content types whose body is text worth showing: JSON, text (not event streams), XML, forms, GraphQL, JavaScript. */
export function isTextType(type: string | null | undefined): boolean {
  if (!type) return false;
  const t = type.toLowerCase();
  if (t.includes("text/event-stream")) return false;
  return /json|^text\/|xml|x-www-form-urlencoded|graphql|javascript/.test(t);
}

/** user:password@ in a URL is dropped. */
export function cleanUrl(url: string): string {
  return url.replace(/^([a-z][\w+.-]*:\/\/)[^/@?#]*@/i, "$1");
}

/** cleanUrl, and query values named like a secret (?token=, ?api_key=) replaced. WebSocket URLs often carry one. */
export function redactUrl(url: string): string {
  const clean = cleanUrl(url);
  const q = clean.indexOf("?");
  if (q < 0) return clean;
  const hash = clean.indexOf("#", q);
  const query = clean.slice(q + 1, hash < 0 ? undefined : hash);
  const fixed = query
    .split("&")
    .map((pair) => {
      const k = pair.split("=")[0];
      let name = k;
      try {
        name = decodeURIComponent(k.replace(/\+/g, " "));
      } catch {
        // keep the raw name
      }
      return SECRET_FIELDS.test(name) && pair.includes("=") ? `${k}=${encodeURIComponent(REDACTED)}` : pair;
    })
    .join("&");
  return clean.slice(0, q + 1) + fixed + (hash < 0 ? "" : clean.slice(hash));
}

/** A WebSocket message as text for the log: strings redacted like a body, binary data and blobs as a short note. Never reads a Blob. */
export function socketData(data: unknown): { data?: string; size?: number } {
  try {
    if (typeof data === "string") return { data: redactBody(data), size: data.length };
    const tag = Object.prototype.toString.call(data).slice(8, -1);
    if (tag === "ArrayBuffer") return { data: `[binary, ${(data as ArrayBuffer).byteLength} bytes]`, size: (data as ArrayBuffer).byteLength };
    if (ArrayBuffer.isView(data)) return { data: `[binary, ${data.byteLength} bytes]`, size: data.byteLength };
    if (tag === "Blob" || tag === "File") return { data: `[Blob, ${(data as { size: number }).size} bytes]`, size: (data as { size: number }).size };
    if (Array.isArray(data)) {
      // ws hands fragmented messages over as an array of Buffers.
      const size = data.reduce((n: number, b: { byteLength?: number }) => n + (Number(b?.byteLength) || 0), 0);
      return { data: `[binary, ${size} bytes]`, size };
    }
  } catch {
    // unknown data
  }
  return {};
}

/** Secret-looking fields in a JSON or form body are replaced; other text is kept as it is. Cut at MAX_BODY. */
export function redactBody(text: string, type?: string | null): string {
  let out = text;
  try {
    const t = (type ?? "").toLowerCase();
    if (t.includes("json") || (!t && /^\s*[[{]/.test(text))) {
      out = JSON.stringify(redactValue(JSON.parse(text) as unknown, 0));
    } else if (t.includes("x-www-form-urlencoded")) {
      out = text
        .split("&")
        .map((pair) => {
          const k = pair.split("=")[0];
          let name = k;
          try {
            name = decodeURIComponent(k.replace(/\+/g, " "));
          } catch {
            // keep the raw name
          }
          return SECRET_FIELDS.test(name) ? `${k}=${encodeURIComponent(REDACTED)}` : pair;
        })
        .join("&");
    }
  } catch {
    // not JSON after all (or cut): kept as it is
  }
  return out.length > MAX_BODY ? out.slice(0, MAX_BODY) + "…" : out;
}

function redactValue(v: unknown, depth: number): unknown {
  if (depth > 20 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = SECRET_FIELDS.test(k) && x !== null && typeof x !== "object" ? REDACTED : redactValue(x, depth + 1);
  return out;
}

/**
 * A request body as text, without reading anything the app still needs:
 * strings and URLSearchParams as they are, binary data and streams as a
 * short note, everything else not at all.
 */
export function bodyText(body: unknown): string | undefined {
  try {
    if (body === undefined || body === null) return undefined;
    if (typeof body === "string") return body;
    const tag = Object.prototype.toString.call(body).slice(8, -1);
    if (tag === "URLSearchParams") return String(body);
    if (tag === "ArrayBuffer") return `[binary, ${(body as ArrayBuffer).byteLength} bytes]`;
    if (ArrayBuffer.isView(body)) return `[binary, ${body.byteLength} bytes]`;
    if (tag === "Blob" || tag === "File") return `[${tag}, ${(body as { size: number }).size} bytes]`;
    if (tag === "FormData") return "[FormData]";
    if (tag === "ReadableStream") return "[stream]";
  } catch {
    // unknown body
  }
  return undefined;
}

/** error for a failed request or a 5xx answer, warn for 4xx, log for the rest. A WebSocket or EventSource: error for an error, warn for a close that was not normal. A beacon: warn when the browser would not queue it. */
export function requestLevel(r: RequestInfo): Level {
  if (r.api === "beacon") return r.error ? "warn" : "log";
  if (r.ws) return r.ws.event === "error" ? "error" : r.ws.event === "close" && r.ws.code !== undefined && r.ws.code !== 1000 && r.ws.code !== 1005 ? "warn" : "log";
  if (r.status === undefined || r.status >= 500) return "error";
  return r.status >= 400 ? "warn" : "log";
}

const ARROWS = { open: "open", send: "↑", message: "↓", close: "close", error: "error" } as const;

function bytes(n: number | undefined): string {
  if (n === undefined) return "";
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/** One line for a WebSocket or EventSource event: "WS ↑ 12 B · {"type":"hi"}", "WS open · ws://host/path", "SSE ↓ 9 B · tick", "WS close 1000 · ws://host/path". */
function socketPreview(r: RequestInfo, ws: NonNullable<RequestInfo["ws"]>): string {
  const what = r.method;
  if (ws.event === "send" || ws.event === "message") return `${what} ${ARROWS[ws.event]} ${bytes(ws.size)}${ws.data !== undefined ? ` · ${ws.data.replace(/\s+/g, " ").slice(0, 300)}` : ""}`;
  if (ws.event === "close") return `${what} close${ws.code !== undefined ? ` ${ws.code}` : ""}${ws.reason ? ` ${ws.reason}` : ""} · ${r.url}`;
  if (ws.event === "error") return `${what} error${r.error ? ` (${r.error})` : ""} · ${r.url}`;
  return `${what} open · ${Math.round(r.ms)} ms · ${r.url}`;
}

/** One line for the end of the code line: "GET 200 · 12 ms · http://host/path", "POST beacon queued · http://host/path". */
export function requestPreview(r: RequestInfo): string {
  if (r.ws) return socketPreview(r, r.ws);
  if (r.api === "beacon") return `${r.method} beacon ${r.error ? "refused" : "queued"} · ${r.url}`;
  const what = r.status === undefined ? `failed${r.error ? ` (${r.error})` : ""}` : String(r.status);
  return `${r.method} ${what} · ${Math.round(r.ms)} ms · ${r.url}`;
}

const API_NAMES: Record<RequestInfo["api"], string> = { fetch: "fetch", xhr: "XMLHttpRequest", http: "http request", websocket: "WebSocket", eventsource: "EventSource", beacon: "sendBeacon" };

/** The full form for the hover and the viewer: status, headers, bodies. */
export function requestFull(r: RequestInfo): string {
  if (r.ws) {
    const ws = r.ws;
    const lines = [`${API_NAMES[r.api] ?? "WebSocket"} ${ws.event === "send" ? "message sent" : ws.event === "message" ? "message received" : ws.event} ${r.url}`];
    if (ws.event === "open") lines.push(`Open after ${Math.round(r.ms)} ms`);
    if (ws.size !== undefined) lines.push(`${bytes(ws.size)}`);
    if (ws.code !== undefined || ws.reason) lines.push(`Code ${ws.code ?? "none"}${ws.reason ? `, reason: ${ws.reason}` : ""}`);
    if (r.error) lines.push(r.error);
    if (ws.data !== undefined) lines.push("", pretty(ws.data));
    return lines.join("\n");
  }
  const lines = [`${API_NAMES[r.api] ?? r.api} ${r.method} ${r.url}`];
  if (r.api === "beacon") lines.push(r.error ? `Not queued: ${r.error}` : "Queued by the browser, which sends it on its own. A beacon has no answer the page can see.");
  else lines.push(r.status === undefined ? `Failed after ${Math.round(r.ms)} ms${r.error ? `: ${r.error}` : ""}` : `${r.status}${r.statusText ? ` ${r.statusText}` : ""} in ${Math.round(r.ms)} ms${r.totalMs !== undefined ? `, body done after ${Math.round(r.totalMs)} ms` : ""}`);
  const headers = (title: string, h: Record<string, string> | undefined) => {
    const keys = Object.keys(h ?? {});
    if (!keys.length) return;
    lines.push("", title);
    for (const k of keys) lines.push(`  ${k}: ${h![k]}`);
  };
  headers("Request headers", r.requestHeaders);
  if (r.requestBody !== undefined) lines.push("", "Request body", pretty(r.requestBody));
  headers("Response headers", r.responseHeaders);
  if (r.responseBody !== undefined) lines.push("", "Response body", pretty(r.responseBody));
  return lines.join("\n");
}

/** The request as JSON for the diff and the graph: JSON bodies are parsed. */
export function requestJson(r: RequestInfo): string {
  const body = (b: string | undefined) => {
    if (b === undefined) return undefined;
    try {
      return JSON.parse(b) as unknown;
    } catch {
      return b;
    }
  };
  if (r.ws) return JSON.stringify({ [r.api]: r.ws.event, url: r.url, size: r.ws.size, code: r.ws.code, reason: r.ws.reason, error: r.error, data: body(r.ws.data) });
  return JSON.stringify({
    method: r.method,
    url: r.url,
    status: r.status ?? null,
    ms: Math.round(r.ms),
    totalMs: r.totalMs === undefined ? undefined : Math.round(r.totalMs),
    error: r.error,
    request: { headers: r.requestHeaders ?? {}, body: body(r.requestBody) },
    response: { headers: r.responseHeaders ?? {}, body: body(r.responseBody) },
  });
}

function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/** A copy read for its end time goes on past MAX_BODY up to this many bytes, then stops: a big body the app never reads is not pulled in for it. */
export const MAX_TIMED_BODY = 1_000_000;

/**
 * Reads at most MAX_BODY characters of a body stream (a clone's), then stops
 * reading. With `onEnd`, the copy is read on (and not kept) to its end, up to
 * MAX_TIMED_BODY bytes, and `onEnd` is called when the end arrives. Never throws.
 */
export async function readLimited(stream: ReadableStream<Uint8Array> | null | undefined, onEnd?: () => void): Promise<string | undefined> {
  if (!stream) return undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    const until = Date.now() + BODY_WAIT_MS;
    for (;;) {
      const left = until - Date.now();
      if (left <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const r = await Promise.race([
        reader.read(),
        new Promise<"late">((res) => {
          timer = setTimeout(() => res("late"), left);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
      clearTimeout(timer);
      if (r === "late") break;
      if (r.done) {
        onEnd?.();
        break;
      }
      size += r.value.byteLength;
      if (text.length <= MAX_BODY) text += decoder.decode(r.value, { stream: true });
      if (text.length > MAX_BODY && (!onEnd || size > MAX_TIMED_BODY)) break;
    }
    return text;
  } catch {
    return undefined;
  } finally {
    try {
      // Only this copy stops: the app's own body is a separate branch.
      void reader?.cancel().catch(() => undefined);
    } catch {
      // nothing to stop
    }
  }
}

/** Builds the entry fields for a finished request. */
export function requestFields(r: RequestInfo): { level: Level; preview: string; full: string; json: string } {
  return { level: requestLevel(r), preview: requestPreview(r), full: requestFull(r), json: requestJson(r) };
}
