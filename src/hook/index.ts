// Loaded into Node processes started from VS Code's integrated terminal via
// NODE_OPTIONS=--require <this file> (Bun: BUN_OPTIONS=--preload, Deno reads
// NODE_OPTIONS too). It wraps console methods and watches for uncaught
// errors, then hands entries to the extension. It must never change what the
// app prints, never throw, and do nothing at all when the extension's
// variables are missing.
import { ENV_OPTS, ENV_PORT, ENV_SPOOL, ENV_TOKEN, GLOBAL_FLAG, MCP_BRIDGE_FILE, WRAPPER_MARK } from "../names";
import { formatArgs, formatCall, FULL, PREVIEW, serializeJson, textPreview } from "../shared/serialize";
import { requestFields } from "../shared/request";
import { fileUrlToPath, parseStack, pickFrame } from "../shared/stack";
import { COUNTER_METHODS, LEVELS, METHODS, type CounterMethod, type Entry, type Level, type Method, type RequestInfo } from "../shared/types";
import { ConsoleCounters, type CounterShown } from "../shared/console";
import { Console } from "node:console";
import { Transport } from "./transport";
import { installBrowserBridge, noteDevCompiler } from "./browser";
import { mapNodeFrame } from "./nodemap";
import { isToolProcess } from "./tools";
import { installRequestLog, wrapWsPackage } from "./requests";
import { patchPino, patchWinston, stripAnsi, TSLOG, tslogLine, watchConsola, watchModules, type LoggerCall } from "./loggers";

export interface HookOptions {
  sourceMaps: boolean;
  includeNodeModules: boolean;
  browser: boolean;
  /** Record fetch, XMLHttpRequest and http(s) calls. */
  requests: boolean;
  /** Keep their text and JSON bodies. */
  requestBodies: boolean;
  /** Code coverage is on: NODE_V8_COVERAGE is set and the hook writes it out every few seconds. */
  coverage: boolean;
}

function readOptions(raw: string | undefined): HookOptions {
  const o: HookOptions = { sourceMaps: true, includeNodeModules: false, browser: true, requests: true, requestBodies: true, coverage: false };
  if (!raw) return o;
  try {
    const p = JSON.parse(raw) as Partial<HookOptions>;
    if (typeof p.sourceMaps === "boolean") o.sourceMaps = p.sourceMaps;
    if (typeof p.includeNodeModules === "boolean") o.includeNodeModules = p.includeNodeModules;
    if (typeof p.browser === "boolean") o.browser = p.browser;
    if (typeof p.requests === "boolean") o.requests = p.requests;
    if (typeof p.requestBodies === "boolean") o.requestBodies = p.requestBodies;
    if (typeof p.coverage === "boolean") o.coverage = p.coverage;
  } catch {
    // defaults
  }
  return o;
}

interface DenoPermissions {
  permissions?: { querySync?(d: { name: string; variable?: string; host?: string }): { state: string } };
}

/**
 * Deno asks the user before a script reads a variable, opens a socket, reads
 * a file or starts a process. The hook never causes such a prompt: it only
 * does what the app was already allowed to do. Undefined means "stay off".
 */
function denoAllows(): { read: boolean; write: boolean; run: boolean } | undefined {
  const deno = (globalThis as { Deno?: DenoPermissions }).Deno;
  if (!deno) return { read: true, write: true, run: true };
  const granted = (d: { name: string; variable?: string; host?: string }) => {
    try {
      return deno.permissions?.querySync?.(d).state === "granted";
    } catch {
      return false;
    }
  };
  if (![ENV_PORT, ENV_TOKEN, ENV_OPTS].every((v) => granted({ name: "env", variable: v }))) return undefined;
  const port = Number(process.env[ENV_PORT]);
  if (!port || !granted({ name: "net", host: `127.0.0.1:${port}` })) return undefined;
  return { read: granted({ name: "read" }), write: granted({ name: "write" }) && granted({ name: "env", variable: ENV_SPOOL }), run: granted({ name: "run" }) };
}

function main(): void {
  const allowed = denoAllows();
  if (!allowed) return;
  const port = Number(process.env[ENV_PORT]);
  const token = process.env[ENV_TOKEN];
  if (!port || !token) return;
  const g = globalThis as Record<string, unknown>;
  if (g[GLOBAL_FLAG]) return;
  g[GLOBAL_FLAG] = true;
  if (isToolProcess(process.argv[1])) return;
  // The MCP bridge for CLI tools sits next to this file, and is not an app.
  if (typeof __filename === "string" && process.argv[1] && process.argv[1].replace(/\\/g, "/").toLowerCase() === __filename.replace(/\\/g, "/").replace(/[^/]*$/, MCP_BRIDGE_FILE).toLowerCase()) return;

  const opts = readOptions(process.env[ENV_OPTS]);
  if (opts.sourceMaps) {
    try {
      // Stack traces then point at the .ts (or other source) line when the
      // code ships a source map. tsx and many build tools turn this on too.
      process.setSourceMapsEnabled?.(true);
    } catch {
      // older Node
    }
  }

  const transport = new Transport(port, token, allowed.run, allowed.write ? process.env[ENV_SPOOL] || undefined : undefined);
  const pid = process.pid;
  let seq = 0;
  const run = runKey(process.cwd(), process.argv[1] ?? "");
  const ownFile = typeof __filename === "string" ? __filename.replace(/\\/g, "/").toLowerCase() : "";
  const skipOwn = (f: string) => ownFile !== "" && fileUrlToPath(f).replace(/\\/g, "/").toLowerCase() === ownFile;
  // Bundled server code (Next.js, webpack) is mapped back to the source line here when Node has not done it.
  const map = allowed.read ? (f: Parameters<typeof mapNodeFrame>[0]) => mapNodeFrame(f) : undefined;

  // console.count, time and group keep their own state per process, as the console does.
  const counters = new ConsoleCounters();

  /** `text`: output the console already made (Jest), shown as it is instead of the arguments. `shown`: a counter call's own text. */
  const emit = (kind: Entry["kind"], level: Level, stack: string | undefined, args: readonly unknown[], method?: Method, text?: string, shown?: CounterShown) => {
    if (transport.off) return;
    const picked = pickFrame(parseStack(stack), skipOwn, map);
    if (!picked) return;
    if (picked.lib && !opts.includeNodeModules) return;
    const call = method === "table" || method === "dir" || method === "trace" ? method : undefined;
    transport.push({
      id: `${pid}:${seq++}`,
      kind,
      level,
      file: fileUrlToPath(picked.frame.file),
      line: picked.frame.line,
      col: picked.frame.col,
      preview: shown ? shown.preview : text !== undefined ? textPreview(text, call) : call ? formatCall(call, args, PREVIEW, stack) : formatArgs(args, PREVIEW),
      full: shown ? shown.full : text !== undefined ? text.slice(0, FULL.maxTotal) : call ? formatCall(call, args, FULL, stack) : formatArgs(args, FULL),
      time: Date.now(),
      source: "node",
      pid,
      run,
      lib: picked.lib || undefined,
      method,
      group: shown ? shown.group : counters.groupPath(),
      json: shown || text !== undefined || method === "trace" ? undefined : serializeJson(method ? args.slice(0, 1) : args),
    });
  };

  const emitRequest = (stack: string | undefined, info: RequestInfo) => {
    if (transport.off) return;
    const picked = pickFrame(parseStack(stack), skipOwn, map);
    if (!picked) return;
    if (picked.lib && !opts.includeNodeModules) return;
    transport.push({
      id: `${pid}:${seq++}`,
      kind: "request",
      ...requestFields(info),
      file: fileUrlToPath(picked.frame.file),
      line: picked.frame.line,
      col: picked.frame.col,
      time: Date.now(),
      source: "node",
      pid,
      run,
      lib: picked.lib || undefined,
      request: info,
    });
  };

  /** A logging library's call (pino, winston, consola, tslog), on the app line that made it. */
  const emitLogger = (c: LoggerCall) => {
    if (transport.off) return;
    const picked = pickFrame(parseStack(c.stack), skipOwn, map);
    if (!picked) return;
    if (picked.lib && !opts.includeNodeModules) return;
    transport.push({
      id: `${pid}:${seq++}`,
      kind: "log",
      level: c.level,
      file: fileUrlToPath(picked.frame.file),
      line: picked.frame.line,
      col: picked.frame.col,
      preview: c.preview,
      full: c.full,
      time: Date.now(),
      source: "node",
      pid,
      run,
      lib: picked.lib || undefined,
      logger: c.logger,
      group: counters.groupPath(),
      json: c.json,
    });
  };

  // One flag for every wrapper: a console call made while we record, or
  // from inside console.table/dir, is not a call of the app's.
  let busy = false;
  // Above zero while a plain console call prints: its writes to stdout are not a library's.
  let inConsole = 0;
  // Set while console.count, time, group or assert runs: what it prints through console.log or console.warn.
  let listening: { args?: readonly unknown[] } | undefined;
  /**
   * Wraps the console methods `target` has as own properties (or all, for
   * the global console). console.trace is not wrapped: Node prints the stack
   * from its caller, which would then be our wrapper. Node's trace hands its
   * text to console.error, and that is where it is picked up.
   */
  const wrapConsole = (target: Record<string, unknown>, ownOnly: boolean) => {
    for (const key of [...LEVELS, ...METHODS, ...COUNTER_METHODS]) {
      if (key === "trace" || (ownOnly && !Object.prototype.hasOwnProperty.call(target, key))) continue;
      const original = target[key];
      if (typeof original !== "function") continue;
      if ((COUNTER_METHODS as readonly string[]).includes(key)) {
        target[key] = wrapCounter(key as CounterMethod, original as (...a: unknown[]) => unknown);
        continue;
      }
      const method = (METHODS as readonly string[]).includes(key) ? (key as Method) : undefined;
      const level: Level = method ? "log" : (key as Level);
      const name = `${WRAPPER_MARK}_${key}`;
      const wrapped = {
        [name](this: unknown, ...args: unknown[]) {
          if (busy || transport.off) {
            if (listening && !listening.args) listening.args = args;
            return (original as (...a: unknown[]) => unknown).apply(this, args);
          }
          busy = true;
          try {
            const holder: { stack?: string } = {};
            const limit = Error.stackTraceLimit;
            Error.stackTraceLimit = 30;
            Error.captureStackTrace(holder, wrapped);
            Error.stackTraceLimit = limit;
            const caller = key === "error" ? parseStack(holder.stack)[0] : undefined;
            if (caller && /(^|\.)trace$/.test(caller.fn ?? "") && caller.file.startsWith("node:internal/console") && typeof args[0] === "string") {
              // console.trace's own output: "Trace: <message>" and the stack, as Node prints it.
              emit("log", "log", holder.stack, args, "trace", args[0]);
            } else if (!method && TSLOG.test(holder.stack ?? "")) {
              // tslog's pretty output: its level, and the message without its colour codes.
              const t = tslogLine(stripAnsi(formatArgs(args, FULL)));
              emitLogger({ logger: "tslog", level: t.level, stack: holder.stack, preview: t.message.replace(/\s*\n\s*/g, " ").slice(0, PREVIEW.maxTotal), full: t.message });
            } else {
              emit("log", level, holder.stack, args, method);
            }
          } catch {
            // never let the hook break a console call
          } finally {
            busy = false;
          }
          if (!method) {
            inConsole++;
            try {
              return (original as (...a: unknown[]) => unknown).apply(this, args);
            } finally {
              inConsole--;
            }
          }
          busy = true;
          try {
            return (original as (...a: unknown[]) => unknown).apply(this, args);
          } finally {
            busy = false;
          }
        },
      }[name];
      try {
        Object.defineProperty(wrapped, "name", { value: (original as { name: string }).name || key });
      } catch {
        // cosmetic only
      }
      target[key] = wrapped;
    }
  };
  /**
   * console.count, time, group and assert. The console runs first, exactly
   * as it would (in Node it prints through console.log or console.warn, which
   * are heard here and not sent twice), then one entry goes to the caller's line.
   */
  function wrapCounter(key: CounterMethod, original: (...a: unknown[]) => unknown) {
    const name = `${WRAPPER_MARK}_${key}`;
    const wrapped = {
      [name](this: unknown, ...args: unknown[]) {
        if (busy || transport.off) return original.apply(this, args);
        let stack: string | undefined;
        try {
          const holder: { stack?: string } = {};
          const limit = Error.stackTraceLimit;
          Error.stackTraceLimit = 30;
          Error.captureStackTrace(holder, wrapped);
          Error.stackTraceLimit = limit;
          stack = holder.stack;
        } catch {
          // no stack, no entry
        }
        const heard: { args?: readonly unknown[] } = {};
        busy = true;
        listening = heard;
        try {
          return original.apply(this, args);
        } finally {
          listening = undefined;
          try {
            const shown = counters.call(key, args, heard.args, "warn");
            if (shown && stack) emit("log", shown.level, stack, args, key, undefined, shown);
          } catch {
            // never let the hook break a console call
          }
          busy = false;
        }
      },
    }[name];
    try {
      Object.defineProperty(wrapped, "name", { value: original.name || key });
    } catch {
      // cosmetic only
    }
    return wrapped;
  }

  wrapConsole(console as unknown as Record<string, unknown>, false);

  // Test runners give tests their own console. Jest's consoles are its own
  // classes, and Jest prints where each log came from by counting stack
  // frames, so a wrapper in between would change what it prints. Jest is met
  // where every console call of a test ends up instead: one static method,
  // which Jest itself cuts the stack at. It gets the text Jest prints, and the
  // values themselves: Jest makes that text with util.format just before, so
  // util.format's last arguments are the values when its text is the one
  // written. With --silent Jest's console is one that prints nothing, so its
  // methods are wrapped as they are: no output to keep the same there.
  if (/[\\/](jest|jest-cli)[\\/]bin[\\/]jest\.js$|[\\/]jest-worker[\\/]build[\\/]/i.test(process.argv[1] ?? "")) {
    try {
      // The module object itself (not an import's copy of it), to wrap its loader.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Module = require("node:module") as { _load?: (...a: unknown[]) => unknown };
      const load = Module._load;
      if (typeof load === "function") {
        let done = false;
        Module._load = function (this: unknown, ...a: unknown[]) {
          const exp = load.apply(this, a) as { BufferedConsole?: { write?: (...a: unknown[]) => unknown }; NullConsole?: { prototype?: Record<string, unknown> } } | undefined;
          if (!done && a[0] === "@jest/console" && exp?.BufferedConsole && typeof exp.BufferedConsole.write === "function") {
            done = true;
            let last: { args: unknown[]; text: string } | undefined;
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const util = require("node:util") as { format: (...f: unknown[]) => string };
              const format = util.format;
              const fname = `${WRAPPER_MARK}_format`;
              const wrappedFormat = {
                [fname](this: unknown, ...f: unknown[]) {
                  const text = format.apply(this, f);
                  last = { args: f, text };
                  return text;
                },
              }[fname];
              Object.defineProperty(wrappedFormat, "name", { value: format.name || "format" });
              Object.defineProperty(wrappedFormat, "length", { value: format.length });
              util.format = wrappedFormat;
            } catch {
              // the text Jest prints, as it prints it
            }
            try {
              const silent = exp.NullConsole?.prototype;
              for (const key of [...LEVELS, "dir"]) {
                const original = silent?.[key];
                if (!silent || typeof original !== "function") continue;
                const name = `${WRAPPER_MARK}_jestSilent_${key}`;
                const wrapped = {
                  [name](this: unknown, ...args: unknown[]) {
                    if (!busy && !transport.off) {
                      busy = true;
                      try {
                        const holder: { stack?: string } = {};
                        const limit = Error.stackTraceLimit;
                        Error.stackTraceLimit = 30;
                        Error.captureStackTrace(holder, wrapped);
                        Error.stackTraceLimit = limit;
                        emit("log", key === "dir" ? "log" : (key as Level), holder.stack, args, key === "dir" ? "dir" : undefined);
                      } catch {
                        // Jest's console stays as it is
                      } finally {
                        busy = false;
                      }
                    }
                    return (original as (...x: unknown[]) => unknown).apply(this, args);
                  },
                }[name];
                silent[key] = wrapped;
              }
            } catch {
              // --silent stays silent here too
            }
            try {
              const BC = exp.BufferedConsole;
              const write = BC.write!;
              const name = `${WRAPPER_MARK}_jestWrite`;
              const wrapped = {
                [name](this: unknown, ...w: unknown[]) {
                  const [, type, message] = w;
                  const heard = last;
                  last = undefined;
                  if (!busy && !transport.off && typeof message === "string" && typeof type === "string") {
                    busy = true;
                    try {
                      const holder: { stack?: string } = {};
                      const limit = Error.stackTraceLimit;
                      Error.stackTraceLimit = 30;
                      Error.captureStackTrace(holder, wrapped);
                      Error.stackTraceLimit = limit;
                      const table = type === "log" && message.trimStart().startsWith("┌");
                      const level: Level = LEVELS.includes(type as Level) ? (type as Level) : type === "assert" ? "warn" : "log";
                      const method: Method | undefined = table ? "table" : ["dir", "trace", "count", "time", "group", "groupCollapsed", "assert"].includes(type) ? (type as Method) : undefined;
                      // A plain log whose text util.format just made from these values.
                      if (!method && LEVELS.includes(type as Level) && heard && heard.text === message) emit("log", level, holder.stack, heard.args);
                      else emit("log", level, holder.stack, [message], method, message);
                    } catch {
                      // Jest's console stays as it is
                    } finally {
                      busy = false;
                    }
                  }
                  return write.apply(this, w);
                },
              }[name];
              BC.write = wrapped;
            } catch {
              // Jest's console stays as it is
            }
          }
          return exp;
        };
      }
    } catch {
      // not Node's module loader
    }
  } else {
    // Vitest (and others) make the test console with node:console's Console
    // class, so its prototype is wrapped too: the global console above does not use it.
    try {
      wrapConsole(Console.prototype as unknown as Record<string, unknown>, true);
    } catch {
      // no node:console
    }
  }

  // uncaughtExceptionMonitor watches without changing what Node does next
  // (unlike 'uncaughtException'). With the default --unhandled-rejections=throw
  // an unhandled rejection arrives here too, with origin 'unhandledRejection'.
  process.on("uncaughtExceptionMonitor", (err: unknown) => {
    try {
      const stack = err instanceof Error ? err.stack : undefined;
      emit("error", "error", stack, [err]);
    } catch {
      // ignore
    }
  });

  // Logging libraries, in Node itself.
  if (!process.versions.bun && !(globalThis as { Deno?: unknown }).Deno) {
    const quiet = <T>(f: () => T): T => {
      const was = busy;
      busy = true;
      try {
        return f();
      } finally {
        busy = was;
      }
    };
    const off = () => transport.off;
    try {
      watchModules({
        pino: (p) => patchPino(p, emitLogger, off, quiet),
        winston: (L) => patchWinston(L, emitLogger, off, quiet),
        ws: opts.requests ? (_exp, mod) => wrapWsPackage(mod, emitRequest, { bodies: opts.requestBodies }, off) : undefined,
        webpack: opts.browser ? (C) => noteDevCompiler(C) : undefined,
      });
      watchConsola(emitLogger, off, () => busy || inConsole > 0);
    } catch {
      // the libraries print as they do, unrecorded
    }
  }

  if (opts.requests) {
    try {
      installRequestLog(emitRequest, { bodies: opts.requestBodies, http: true }, () => transport.off);
    } catch {
      // the request log is optional
    }
  }

  // Coverage: Node writes what ran to NODE_V8_COVERAGE when the process
  // ends. Taking it every few seconds too means a dev server that runs for
  // hours, or a process stopped with Ctrl+C, still shows what it ran.
  if (opts.coverage && process.env.NODE_V8_COVERAGE && !process.versions.bun && !(globalThis as { Deno?: unknown }).Deno) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const v8 = require("node:v8") as { takeCoverage?: () => void };
      if (typeof v8.takeCoverage === "function") {
        const timer = setInterval(() => {
          try {
            v8.takeCoverage!();
          } catch {
            // coverage stopped
          }
        }, 3_000);
        timer.unref();
      }
    } catch {
      // no coverage
    }
  }

  if (opts.browser && allowed.read) {
    try {
      installBrowserBridge((e) => {
        if (transport.off) return;
        if (e.lib && !opts.includeNodeModules) return;
        // A page's entries are a run of their own: the dev server's and the page's path.
        transport.push({ ...e, id: `${pid}:b${seq++}`, pid, run: e.run !== undefined ? `${run}:${e.run}` : run });
      }, undefined, { requests: opts.requests, requestBodies: opts.requestBodies });
    } catch {
      // browser support is optional
    }
  }

  // A natural exit: the loop is empty, so start the send (it keeps the loop
  // alive until it is done) and Node comes back here once more, with nothing left.
  process.on("beforeExit", () => {
    if (transport.pending) transport.flush();
  });
  // process.exit() and crashes: last chance, synchronous.
  process.on("exit", () => transport.flushSync());
}

/** A short, stable name for "this folder, this script": the same for every run of the same program. */
function runKey(cwd: string, script: string): string {
  let h = 5381;
  const text = `${cwd}|${script}`.replace(/\\/g, "/").toLowerCase();
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

try {
  main();
} catch {
  // The hook must never stop the app from starting.
}
