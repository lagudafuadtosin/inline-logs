// Runs in the page, injected by the hook into HTML a dev server (Vite,
// webpack, Next.js) sends. Wraps console methods and listens for errors,
// then posts the entries to the same dev server. Never throws into the page,
// never changes what the console shows. Also records the page's fetch and
// XMLHttpRequest calls, WebSockets, EventSources and beacons without
// changing them (bodies are read from a clone).
import { CLIENT_CONFIG, GLOBAL_FLAG, WRAPPER_MARK } from "../names";
import { formatArgs, formatCall, FULL, PREVIEW, serializeJson } from "../shared/serialize";
import { bodyText, cleanUrl, isTextType, readLimited, redactBody, redactHeaders, requestFields } from "../shared/request";
import { parseStack, type Frame } from "../shared/stack";
import { COUNTER_METHODS, LEVELS, METHODS, type CounterMethod, type Level, type Method, type RequestInfo } from "../shared/types";
import { ConsoleCounters, type CounterShown } from "../shared/console";
import { wrapSocketClass } from "../shared/socket";

interface Out {
  kind: "log" | "error" | "request";
  level: Level;
  frames: Frame[];
  preview: string;
  full: string;
  time: number;
  method?: Method;
  group?: string;
  json?: string;
  request?: RequestInfo;
}

(function start() {
  // Out of the DOM before a framework hydrates the page, so React and friends never see it.
  try {
    document.currentScript?.remove();
  } catch {
    // stays, harmless
  }
  const w = window as unknown as Record<string, unknown>;
  const cfg = w[CLIENT_CONFIG] as { endpoint?: string; requests?: boolean; requestBodies?: boolean } | undefined;
  if (!cfg || typeof cfg.endpoint !== "string" || w[GLOBAL_FLAG]) return;
  w[GLOBAL_FLAG] = true;
  const endpoint = cfg.endpoint;
  // Taken before the app can wrap them (mock service workers, analytics).
  const fetchFn = typeof fetch === "function" ? fetch.bind(window) : undefined;
  const beacon = navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : undefined;
  // This load of the page: a reload is a new one, which replaces this one's problems.
  const load = Math.random().toString(36).slice(2, 12);
  const page = location.pathname;
  const ErrorCtor = Error as ErrorConstructor & { captureStackTrace?: (o: object, f?: unknown) => void; stackTraceLimit?: number };

  let queue: Out[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let busy = false;

  // webpack's eval devtools give frames like webpack-internal:///./src/a.js
  // that are not URLs the dev server can send. Their code (and map) sits in
  // the page's scripts, so the dev server gets the list to look in.
  const scripts = () => {
    const out = new Set<string>();
    try {
      for (const s of Array.from(document.scripts)) if (s.src) out.add(s.src);
      for (const r of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) if (r.initiatorType === "script") out.add(r.name);
    } catch {
      // no list, no eval frames
    }
    return [...out].slice(-300);
  };

  let hello = true;
  const send = (useBeacon: boolean) => {
    timer = undefined;
    if ((!queue.length && !hello) || failures >= 3) return;
    const entries = queue.splice(0, 200);
    const evalFrames = entries.some((e) => e.frames.some((f) => /^webpack(-internal)?:/.test(f.file)));
    const body = JSON.stringify({ entries, page, load, ...(hello ? { hello } : {}), ...(evalFrames ? { scripts: scripts() } : {}) });
    hello = false;
    try {
      if (useBeacon && beacon) {
        beacon(endpoint, new Blob([body], { type: "text/plain" }));
      } else if (fetchFn) {
        fetchFn(endpoint, { method: "POST", body, keepalive: body.length < 60_000, headers: { "content-type": "text/plain" } }).then(
          (r) => {
            failures = r.ok ? 0 : failures + 1;
          },
          () => {
            failures++;
          },
        );
      }
    } catch {
      failures++;
    }
    if (queue.length) timer = setTimeout(() => send(false), 30);
  };

  const push = (o: Out) => {
    if (failures >= 3) return;
    queue.push(o);
    if (queue.length > 2000) queue = queue.slice(-2000);
    timer ??= setTimeout(() => send(false), 30);
  };
  // The first post says this load started, with or without entries.
  timer = setTimeout(() => send(false), 30);

  // console.count, time and group: browsers print these themselves, so the page keeps its own copy of the counters.
  // Above zero inside a console group that is not the app's own (see below).
  let quietGroups = 0;
  const counters = new ConsoleCounters(() => (typeof performance !== "undefined" ? performance.now() : Date.now()));

  const record = (kind: Out["kind"], level: Level, stack: string | undefined, args: readonly unknown[], method?: "table" | "dir" | "trace", shown?: CounterShown & { method: CounterMethod }) => {
    const frames = parseStack(stack).slice(0, 20);
    if (!frames.length) return;
    if (shown) {
      push({ kind, level, frames, preview: shown.preview, full: shown.full, time: Date.now(), method: shown.method, group: shown.group });
      return;
    }
    const group = counters.groupPath();
    const json = method === "trace" ? undefined : serializeJson(method ? args.slice(0, 1) : args);
    if (method) push({ kind, level, frames, preview: formatCall(method, args, PREVIEW, stack), full: formatCall(method, args, FULL, stack), time: Date.now(), method, json, group });
    else push({ kind, level, frames, preview: formatArgs(args, PREVIEW), full: formatArgs(args, FULL), time: Date.now(), json, group });
  };

  const stackHere = (fn: unknown) => {
    const holder: { stack?: string } = {};
    if (ErrorCtor.captureStackTrace) {
      const limit = ErrorCtor.stackTraceLimit;
      ErrorCtor.stackTraceLimit = 30;
      ErrorCtor.captureStackTrace(holder, fn);
      ErrorCtor.stackTraceLimit = limit;
    } else {
      holder.stack = new Error().stack;
    }
    return holder.stack;
  };

  const recordRequest = (stack: string | undefined, info: RequestInfo) => {
    try {
      const frames = parseStack(stack).slice(0, 20);
      if (frames.length) push({ kind: "request", ...requestFields(info), frames, time: Date.now(), request: info });
    } catch {
      // ignore
    }
  };
  const absolute = (u: unknown) => {
    try {
      return cleanUrl(new URL(String(u), location.href).href);
    } catch {
      return String(u);
    }
  };
  const bodies = cfg.requestBodies !== false;

  const con = console as unknown as Record<string, unknown>;
  for (const key of [...LEVELS, ...METHODS]) {
    const original = con[key];
    if (typeof original !== "function") continue;
    const method = (METHODS as readonly string[]).includes(key) ? (key as "table" | "dir" | "trace") : undefined;
    const level: Level = method ? "log" : (key as Level);
    const name = `${WRAPPER_MARK}_${key}`;
    const wrapped = {
      [name](this: unknown, ...args: unknown[]) {
        if (!busy && !quietGroups) {
          busy = true;
          try {
            const holder: { stack?: string } = {};
            if (ErrorCtor.captureStackTrace) {
              const limit = ErrorCtor.stackTraceLimit;
              ErrorCtor.stackTraceLimit = 30;
              ErrorCtor.captureStackTrace(holder, wrapped);
              ErrorCtor.stackTraceLimit = limit;
            } else {
              holder.stack = new Error().stack;
            }
            record("log", level, holder.stack, args, method);
          } catch {
            // never break a console call
          } finally {
            busy = false;
          }
        }
        if (!method) return (original as (...a: unknown[]) => unknown).apply(this, args);
        // table, dir and trace may call console.log themselves: that is not a second call of the app's.
        const was = busy;
        busy = true;
        try {
          return (original as (...a: unknown[]) => unknown).apply(this, args);
        } finally {
          busy = was;
        }
      },
    }[name];
    con[key] = wrapped;
  }

  // console.count, time, group and assert: the browser prints them, then one entry goes to the caller's line.
  for (const key of COUNTER_METHODS) {
    const original = con[key];
    if (typeof original !== "function") continue;
    const name = `${WRAPPER_MARK}_${key}`;
    const wrapped = {
      [name](this: unknown, ...args: unknown[]) {
        let stack: string | undefined;
        const mine = !busy;
        if (mine) {
          try {
            stack = stackHere(wrapped);
          } catch {
            stack = undefined;
          }
        }
        const was = busy;
        busy = true;
        try {
          return (original as (...a: unknown[]) => unknown).apply(this, args);
        } finally {
          busy = was;
          if (mine) {
            try {
              // Svelte's $inspect follows each new value with a folded "stack trace" group of its own:
              // the value shows on the $inspect line, and the group is left to the browser's console.
              if (quietGroups || (key === "groupCollapsed" && args.length === 1 && args[0] === "stack trace" && /\/node_modules\//.test(parseStack(stack)[0]?.file ?? ""))) {
                if (key === "group" || key === "groupCollapsed") quietGroups++;
                else if (key === "groupEnd") quietGroups--;
              } else {
                const shown = counters.call(key, args, undefined, "error");
                if (shown) record("log", shown.level, stack, args, undefined, { ...shown, method: key });
              }
            } catch {
              // never break a console call
            }
          }
        }
      },
    }[name];
    con[key] = wrapped;
  }

  // ---- fetch and XMLHttpRequest ----
  // Our own posts use fetchFn, taken above, so they are never recorded.
  if (cfg.requests !== false && fetchFn) {
    const original = window.fetch;
    const name = `${WRAPPER_MARK}_fetch`;
    const wrapped = {
      [name](this: unknown, ...args: unknown[]) {
        let stack: string | undefined;
        let info: RequestInfo | undefined;
        // A Request object's own text body, read from a clone made before fetch takes it.
        let sent: Promise<string | undefined> | undefined;
        let sentType: string | null = null;
        const start = Date.now();
        try {
          stack = stackHere(wrapped);
          const input = args[0];
          const init = args[1] as RequestInit | undefined;
          const isRequest = typeof Request === "function" && input instanceof Request;
          const headers = new Headers(isRequest ? (input as Request).headers : undefined);
          if (init?.headers) new Headers(init.headers).forEach((v, k) => headers.set(k, v));
          info = {
            api: "fetch",
            method: String(init?.method ?? (isRequest ? (input as Request).method : "GET")).toUpperCase(),
            url: absolute(isRequest ? (input as Request).url : input instanceof URL ? input.href : input),
            ms: 0,
            requestHeaders: redactHeaders(headers),
          };
          const text = bodies && init ? bodyText(init.body) : undefined;
          if (text !== undefined) info.requestBody = redactBody(text, headers.get("content-type"));
          else if (bodies && isRequest && (init?.body === undefined || init.body === null)) {
            const r = input as Request;
            sentType = r.headers.get("content-type");
            if (r.body && !r.bodyUsed && isTextType(sentType)) sent = readLimited(r.clone().body);
          }
        } catch {
          info = undefined;
        }
        const p = (original as (...a: unknown[]) => Promise<Response>).apply(this, args);
        if (!info) return p;
        const req = info;
        const record = (done: RequestInfo) => {
          if (!sent) return recordRequest(stack, done);
          sent.then(
            (t) => recordRequest(stack, t === undefined ? done : { ...done, requestBody: redactBody(t, sentType) }),
            () => recordRequest(stack, done),
          );
        };
        // Settles the same way as the page's own promise, so an unhandled rejection stays unhandled.
        return p.then(
          (res) => {
            try {
              const done: RequestInfo = { ...req, status: res.status, statusText: res.statusText || undefined, ms: Date.now() - start, responseHeaders: redactHeaders(res.headers) };
              const type = res.headers.get("content-type");
              if (bodies && res.body && !res.bodyUsed && isTextType(type)) {
                // Read on to the body's end (up to a limit), for the total time.
                readLimited(res.clone().body, () => (done.totalMs = Date.now() - start)).then(
                  (t) => record(t === undefined ? done : { ...done, responseBody: redactBody(t, type) }),
                  () => record(done),
                );
              } else {
                record(done);
              }
            } catch {
              // the page still gets its response
            }
            return res;
          },
          (err: unknown) => {
            try {
              record({ ...req, ms: Date.now() - start, error: String((err as { message?: unknown })?.message ?? err).slice(0, 300) });
            } catch {
              // ignore
            }
            throw err;
          },
        );
      },
    }[name];
    try {
      window.fetch = wrapped as typeof window.fetch;
    } catch {
      // fetch stays as it is
    }
  }

  if (cfg.requests !== false && typeof XMLHttpRequest === "function") {
    try {
      interface Pending {
        method: string;
        url: string;
        headers: Record<string, string>;
      }
      const pending = new WeakMap<XMLHttpRequest, Pending>();
      const proto = XMLHttpRequest.prototype;
      const open = proto.open;
      const setHeader = proto.setRequestHeader;
      const sendFn = proto.send;
      proto.open = function (this: XMLHttpRequest, ...args: unknown[]) {
        try {
          pending.set(this, { method: String(args[0] ?? "GET").toUpperCase(), url: absolute(args[1]), headers: {} });
        } catch {
          // not recorded
        }
        return (open as (...a: unknown[]) => void).apply(this, args);
      } as typeof proto.open;
      proto.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
        try {
          const p = pending.get(this);
          if (p) Object.assign(p.headers, redactHeaders({ [name]: value }));
        } catch {
          // not recorded
        }
        return setHeader.call(this, name, value);
      };
      const name = `${WRAPPER_MARK}_send`;
      const send = {
        [name](this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
          try {
            const p = pending.get(this);
            if (p) {
              const stack = stackHere(send);
              const start = Date.now();
              const text = bodies ? bodyText(body) : undefined;
              const sentType = p.headers["content-type"];
              // When the response headers arrived (readyState 2), to tell that time from the body's end.
              let headersAt: number | undefined;
              this.addEventListener("readystatechange", (ev) => {
                if (headersAt === undefined && (ev.currentTarget as XMLHttpRequest).readyState >= 2) headersAt = Date.now() - start;
              });
              this.addEventListener("loadend", (ev) => {
                try {
                  const xhr = ev.currentTarget as XMLHttpRequest;
                  const ended = Date.now() - start;
                  const info: RequestInfo = { api: "xhr", method: p.method, url: p.url, ms: headersAt === undefined ? ended : headersAt, requestHeaders: p.headers };
                  if (headersAt !== undefined && xhr.status !== 0) info.totalMs = ended;
                  if (text !== undefined) info.requestBody = redactBody(text, sentType);
                  if (xhr.status === 0) {
                    info.error = "network error or aborted";
                  } else {
                    info.status = xhr.status;
                    info.statusText = xhr.statusText || undefined;
                    info.responseHeaders = redactHeaders(
                      xhr
                        .getAllResponseHeaders()
                        .split(/[\r\n]+/)
                        .filter((l) => l.includes(":"))
                        .map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()] as [string, string]),
                    );
                    const type = xhr.getResponseHeader("content-type");
                    if (bodies && isTextType(type)) {
                      const rt = xhr.responseType;
                      const t = rt === "" || rt === "text" ? xhr.responseText : rt === "json" ? JSON.stringify(xhr.response) : undefined;
                      if (typeof t === "string") info.responseBody = redactBody(t, type);
                    }
                  }
                  recordRequest(stack, info);
                } catch {
                  // ignore
                }
              });
            }
          } catch {
            // the request goes out as it is
          }
          return sendFn.call(this, body);
        },
      }[name];
      proto.send = send;
    } catch {
      // XMLHttpRequest stays as it is
    }
  }

  if (cfg.requests !== false) {
    try {
      wrapSocketClass(window as unknown as Record<string, unknown>, "WebSocket", recordRequest, { bodies }, () => false, stackHere);
    } catch {
      // WebSocket stays as it is
    }
    try {
      wrapSocketClass(window as unknown as Record<string, unknown>, "EventSource", recordRequest, { bodies, api: "eventsource" }, () => false, stackHere);
    } catch {
      // EventSource stays as it is
    }
  }

  // navigator.sendBeacon: the page's own beacons, on the line that sent them. Ours go through `beacon`, taken above.
  if (cfg.requests !== false && beacon) {
    try {
      const original = navigator.sendBeacon;
      const name = `${WRAPPER_MARK}_sendBeacon`;
      const wrapped = {
        [name](this: Navigator, ...args: unknown[]) {
          const queued = (original as (...a: unknown[]) => boolean).apply(this, args);
          try {
            const data = args[1];
            const type = data && typeof data === "object" && "type" in data && typeof (data as Blob).type === "string" ? (data as Blob).type : typeof data === "string" ? "text/plain;charset=UTF-8" : "";
            const info: RequestInfo = { api: "beacon", method: "POST", url: absolute(args[0]), ms: 0, requestHeaders: type ? { "content-type": type } : {} };
            const text = bodies ? bodyText(data) : undefined;
            // A string goes as text/plain, but is often JSON: its secret fields are redacted as JSON.
            if (text !== undefined) info.requestBody = redactBody(text, typeof data === "string" ? undefined : type);
            if (!queued) info.error = "the browser did not queue it";
            recordRequest(stackHere(wrapped), info);
          } catch {
            // the beacon went as it is
          }
          return queued;
        },
      }[name];
      Object.defineProperty(navigator, "sendBeacon", { value: wrapped, writable: true, configurable: true, enumerable: true });
    } catch {
      // sendBeacon stays as it is
    }
  }

  window.addEventListener("error", (ev: ErrorEvent) => {
    try {
      const err = ev.error as { stack?: unknown } | undefined;
      let stack = err && typeof err.stack === "string" ? err.stack : undefined;
      if (!stack || !parseStack(stack).length) {
        if (!ev.filename) return;
        stack = `    at ${ev.filename}:${ev.lineno}:${ev.colno}`;
      }
      record("error", "error", stack, [ev.error ?? ev.message]);
    } catch {
      // ignore
    }
  });

  window.addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
    try {
      const r = ev.reason as { stack?: unknown } | undefined;
      const stack = r && typeof r.stack === "string" ? r.stack : undefined;
      if (stack) record("error", "error", stack, [ev.reason]);
    } catch {
      // ignore
    }
  });

  addEventListener("pagehide", () => send(true));
})();
