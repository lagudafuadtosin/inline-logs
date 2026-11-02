// Reads V8 (Node, Chrome, Edge) and SpiderMonkey/JavaScriptCore (Firefox,
// Safari) stack strings into frames, and picks the frame that made the call.
// Browser-safe: no Node imports.
import { WRAPPER_MARK } from "../names";

export interface Frame {
  /** As printed: a path, a file:// URL, an http(s) URL, node:internal/..., etc. */
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  col: number;
  fn?: string;
}

// Bun leaves the column off top-level frames ("at /app/x.js:2").
const V8 = /^\s*at (?:(.+?) \()?(.+?):(\d+)(?::(\d+))?\)?\s*$/;
const GECKO = /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/;

export function parseStack(stack: string | undefined): Frame[] {
  if (typeof stack !== "string") return [];
  const out: Frame[] = [];
  for (const raw of stack.split("\n")) {
    let m = V8.exec(raw);
    if (m) {
      // "at eval (eval at f (file.js:1:2), <anonymous>:1:1)" has no real file.
      if (m[2].includes("(eval at") || m[2].startsWith("eval at")) continue;
      out.push({ fn: m[1]?.replace(/^async /, ""), file: m[2], line: Number(m[3]), col: Number(m[4] ?? 1) });
      continue;
    }
    if (raw.trimStart().startsWith("at ")) continue;
    m = GECKO.exec(raw);
    if (m) {
      const file = m[2].replace(/^.* line \d+ > (eval|Function)$/, "");
      if (!file || file.includes(" > eval") || file.includes(" > Function")) continue;
      out.push({ fn: m[1] || undefined, file, line: Number(m[3]), col: Number(m[4]) });
    }
  }
  return out;
}

/** True for frames that are never the user's code. */
export function isInternal(f: Frame): boolean {
  const file = f.file;
  if (f.fn?.includes(WRAPPER_MARK)) return true;
  return (
    file.startsWith("node:") ||
    file.startsWith("internal/") ||
    file === "native" ||
    file === "<anonymous>" ||
    file.startsWith("<") ||
    // node -e "...": no file to show a value in (tools run these, such as a check of the C library).
    file.startsWith("[eval") ||
    file.startsWith("data:") ||
    file.startsWith("blob:") ||
    /\/@vite\/(client|env)\b/.test(file) ||
    /^webpack:\/\/[^/]*\/webpack\/(runtime|bootstrap)\b/.test(file)
  );
}

export function isLibrary(file: string): boolean {
  return /[\\/]node_modules[\\/]/.test(file) || /\/@id\//.test(file) || /\/\.vite\/deps\//.test(file);
}

export interface Picked {
  frame: Frame;
  /** The frame is inside node_modules (no app frame was on the stack). */
  lib: boolean;
}

/**
 * The frame to show the value on: the first app frame (not internal, not in
 * node_modules). So a log made through a logging library lands on the app
 * line that called the library. When the whole stack is library code, the
 * first library frame is returned with lib=true.
 */
export function pickFrame(frames: readonly Frame[], skip?: (file: string) => boolean, map?: (f: Frame) => Frame | undefined): Picked | undefined {
  // Our own wrapper frames, and everything before them, are not the caller.
  let start = 0;
  for (let i = 0; i < frames.length; i++) if (frames[i].fn?.includes(WRAPPER_MARK)) start = i + 1;
  let firstLib: Frame | undefined;
  for (let i = start; i < frames.length; i++) {
    let f: Frame | undefined = frames[i];
    if (isInternal(f) || skip?.(f.file)) continue;
    // Bundled code: the frame where the source map says it came from (undefined for bundler runtime code).
    if (map && !(f = map(f))) continue;
    if (isLibrary(f.file)) {
      firstLib ??= f;
      continue;
    }
    return { frame: f, lib: false };
  }
  return firstLib ? { frame: firstLib, lib: true } : undefined;
}

/** file:///C:/a%20b/x.js -> C:/a b/x.js ; file:///home/x.js -> /home/x.js. Others unchanged. */
export function fileUrlToPath(file: string): string {
  if (!file.startsWith("file://")) return file;
  let p = file.slice("file://".length);
  // file://host/share (UNC) keeps the host.
  if (!p.startsWith("/")) p = "//" + p;
  p = p.replace(/[?#].*$/, "");
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep as is
  }
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p;
}
