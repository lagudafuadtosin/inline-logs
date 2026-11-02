// WebSockets and EventSources in the request log: the browser's WebSocket,
// the global one in Node, Bun and Deno (the same standard class), the ws
// package's, and EventSource. Shared by the Node hook and the browser client,
// so no Node imports. It only watches: the class is wrapped in a Proxy that
// builds the very same socket, and events are seen through listeners of our
// own, which change nothing for the app's listeners. The ws package's sockets
// are event emitters, where an "error" listener of ours would stop an error
// the app does not handle from ending it: they get no error listener, and a
// failed socket shows as the close that follows its error (code 1006).
// Messages go through the same redaction as request bodies.
import { WRAPPER_MARK } from "../names";
import { redactUrl, socketData } from "./request";
import type { RequestInfo, SocketEvent } from "./types";

/** Messages recorded per socket (sent and received together). Open, close and errors always are. */
export const MAX_SOCKET_MESSAGES = 200;

export interface SocketLogOptions {
  /** Keep message text (redacted). Without it only sizes are kept. */
  bodies: boolean;
  /** "eventsource" for EventSource ("SSE" in the log), else a WebSocket ("WS"). */
  api?: "websocket" | "eventsource";
  /** The ws package: open, message and close are heard with on(), no error listener is added, and sockets its server makes for incoming connections are left alone. */
  emitter?: boolean;
}

/** Called for each event with the stack of the line it belongs to: the `new WebSocket` line, or the `send` line. */
export type OnSocket = (stack: string | undefined, info: RequestInfo) => void;

interface Watched {
  url: string;
  stack: string | undefined;
  start: number;
  messages: number;
}

type Listen = { addEventListener?: (type: string, fn: (ev: unknown) => void) => void };

/**
 * Wraps `holder[key]` (a WebSocket class) so each socket the app makes is
 * watched. Returns false when there is nothing to wrap. `stackHere` captures
 * the stack above a given function.
 */
export function wrapSocketClass(holder: Record<string, unknown>, key: string, on: OnSocket, opts: SocketLogOptions, off: () => boolean, stackHere: (fn: unknown) => string | undefined): boolean {
  const Original = holder[key] as (new (...a: unknown[]) => object) & { prototype: Record<string, unknown> };
  if (typeof Original !== "function" || !Original.prototype) return false;
  const watched = new WeakMap<object, Watched>();
  const name = `${WRAPPER_MARK}_${key}`;
  const construct = {
    [name](target: typeof Original, args: unknown[], newTarget: unknown): object {
      let stack: string | undefined;
      if (!off()) {
        try {
          stack = stackHere(construct);
        } catch {
          stack = undefined;
        }
      }
      const ws = Reflect.construct(target, args, newTarget as typeof Original);
      // The ws package's server makes its sockets with no address: those are not calls of the app's.
      if (stack !== undefined && !(opts.emitter && (args[0] === null || args[0] === undefined))) {
        try {
          watch(ws, stack);
        } catch {
          // the socket works as it is
        }
      }
      return ws;
    },
  }[name];
  const Wrapped = new Proxy(Original, { construct });

  const api = opts.api ?? "websocket";
  const record = (stack: string | undefined, w: Watched, ws: SocketEvent, extra?: Partial<RequestInfo>) => {
    try {
      if (!off()) on(stack, { api, method: api === "eventsource" ? "SSE" : "WS", url: w.url, ms: Date.now() - w.start, ws, ...extra });
    } catch {
      // nothing to record
    }
  };
  const message = (w: Watched, event: "send" | "message", data: unknown, stack: string | undefined) => {
    if (w.messages >= MAX_SOCKET_MESSAGES) return;
    w.messages++;
    const d = socketData(data);
    record(stack, w, { event, size: d.size, data: opts.bodies ? d.data : undefined });
  };

  function watch(ws: object, stack: string | undefined): void {
    const s = ws as Listen & { url?: unknown; on?: (event: string, fn: (...a: unknown[]) => void) => unknown };
    if (opts.emitter) {
      watchEmitter(s, stack);
      return;
    }
    if (typeof s.addEventListener !== "function") return;
    const w: Watched = { url: redactUrl(String(s.url ?? "")), stack, start: Date.now(), messages: 0 };
    watched.set(ws, w);
    s.addEventListener("open", () => record(w.stack, w, { event: "open" }));
    s.addEventListener("message", (ev) => message(w, "message", (ev as { data?: unknown })?.data, w.stack));
    s.addEventListener("close", (ev) => {
      const e = ev as { code?: unknown; reason?: unknown };
      record(w.stack, w, { event: "close", code: typeof e?.code === "number" ? e.code : undefined, reason: typeof e?.reason === "string" && e.reason ? e.reason.slice(0, 300) : undefined });
    });
    s.addEventListener("error", (ev) => {
      const m = (ev as { message?: unknown; error?: { message?: unknown } })?.message ?? (ev as { error?: { message?: unknown } })?.error?.message;
      record(w.stack, w, { event: "error" }, typeof m === "string" && m ? { error: m.slice(0, 300) } : undefined);
    });
  }

  /** ws package sockets: open, message (data, isBinary) and close (code, reason). */
  function watchEmitter(s: { url?: unknown; on?: (event: string, fn: (...a: unknown[]) => void) => unknown }, stack: string | undefined): void {
    const on = s.on;
    if (typeof on !== "function") return;
    const w: Watched = { url: redactUrl(String(s.url ?? "")), stack, start: Date.now(), messages: 0 };
    watched.set(s, w);
    const listen = (event: string, fn: (...a: unknown[]) => void) =>
      on.call(s, event, (...a: unknown[]) => {
        try {
          fn(...a);
        } catch {
          // the event goes on as it is
        }
      });
    listen("open", () => record(w.stack, w, { event: "open" }));
    // A text message comes as a Buffer with isBinary false.
    listen("message", (data, isBinary) => message(w, "message", isBinary === false && data !== null && typeof data === "object" && !Array.isArray(data) ? String(data) : data, w.stack));
    listen("close", (code, reason) => record(w.stack, w, { event: "close", code: typeof code === "number" ? code : undefined, reason: reason !== undefined && String(reason) ? String(reason).slice(0, 300) : undefined }));
  }

  // send is on the prototype: recorded on the line that called it, once the socket took the message.
  const send = Original.prototype.send;
  if (typeof send === "function") {
    const sendName = `${WRAPPER_MARK}_${key}_send`;
    const wrappedSend = {
      [sendName](this: object, ...args: unknown[]) {
        const result = (send as (...a: unknown[]) => unknown).apply(this, args);
        try {
          const w = watched.get(this);
          if (w && !off()) message(w, "send", args[0], stackHere(wrappedSend));
        } catch {
          // the message went out as it is
        }
        return result;
      },
    }[sendName];
    try {
      Object.defineProperty(wrappedSend, "name", { value: (send as { name?: string }).name || "send" });
      Object.defineProperty(wrappedSend, "length", { value: (send as { length?: number }).length ?? 1 });
    } catch {
      // cosmetic only
    }
    Original.prototype.send = wrappedSend;
  }

  try {
    // new WebSocket(url).constructor === WebSocket stays true.
    Object.defineProperty(Original.prototype, "constructor", { value: Wrapped, writable: true, configurable: true, enumerable: false });
  } catch {
    // keeps the class it had
  }
  const d = Object.getOwnPropertyDescriptor(holder, key);
  Object.defineProperty(holder, key, { value: Wrapped, writable: d?.writable ?? true, configurable: true, enumerable: d?.enumerable ?? false });
  return true;
}
