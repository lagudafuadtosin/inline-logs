// Maps Node stack frames in bundled server code back to the source line,
// for bundlers whose frames Node's own source map support does not fix:
//  - files with a source map (inline or a .map file next to them), such as
//    Turbopack's server chunks in Next.js;
//  - webpack's eval devtools (Next.js with webpack), where a frame names a
//    module (webpack-internal:///./app/page.js) whose code and map live
//    inside an eval() string in a chunk Node loaded with require(), or in a
//    chunk of the build folder that Next.js runs in its Edge sandbox;
//  - code a Vite dev server runs with new AsyncFunction (Vite 7 and earlier
//    run server code this way), whose map is inline in that code. Node does
//    not apply it, and the code is nowhere on disk: its map is read from V8's
//    own list of scripts, through the inspector in this process. That is
//    only turned on in a Vite dev server, the first time such a frame comes by.
// Everything is read synchronously and cached; a failure leaves the frame as it was.
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileUrlToPath, isLibrary, type Frame } from "../shared/stack";
import { evalMaps, evalSources, externalMapUrl, inlineAnyMap, lineInSource, makeMapper, parseMap, type Mapper } from "./sourcemap";
import { sourceToFile } from "./browser";

/** A Vite dev server, or a framework's dev command that runs one (the same commands browser.ts knows). */
export function isViteDevProcess(argv: readonly string[] = process.argv): boolean {
  const script = argv[1] ?? "";
  const sub = argv.slice(2).find((a) => !a.startsWith("-"));
  if (/[\\/]vite[\\/]bin[\\/]vite\.js$/.test(script)) return sub === undefined || sub === "dev" || sub === "serve";
  return /[\\/](astro[\\/]astro\.js|@react-router[\\/]dev[\\/]bin\.js|nuxi[\\/]bin[\\/]nuxi\.mjs|nuxt[\\/]bin[\\/]nuxt\.mjs)$/.test(script) && sub === "dev";
}

const MAX_FILE = 50_000_000;
const RECHECK_MS = 1_000;

interface FileMap {
  mtime: number;
  checked: number;
  mapper?: Mapper;
}
const files = new Map<string, FileMap>();

/** sourceURL -> base64 map, or the eval'd code itself for webpack's plain "eval" devtool. */
const evalIndex = new Map<string, { b64?: string; code?: string; mapper?: Mapper }>();
const scanned = new Map<string, number>();
let lastScan = 0;

export function mapNodeFrame(f: Frame, root = process.cwd()): Frame | undefined {
  try {
    // Library code is skipped either way: no need to read it.
    if (isLibrary(f.file)) return f;
    if (/^webpack(-internal)?:\/\//.test(f.file)) return mapEval(f, root);
    if (f.file.startsWith("turbopack:")) {
      const src = sourceToFile(f.file, "", root);
      return src ? { ...f, file: src } : undefined;
    }
    const file = fileUrlToPath(f.file);
    if (!path.isAbsolute(file)) return f;
    const mapper = fileMapper(file) ?? (vite && !f.file.startsWith("file:") ? scriptMapper(file) : undefined);
    const o = mapper?.original(f.line, f.col);
    if (!o) return f;
    const src = sourceToFile(o.source, "", root, path.dirname(file));
    return src ? { ...f, file: src, line: o.line, col: o.col } : undefined;
  } catch {
    return f;
  }
}

function fileMapper(file: string): Mapper | undefined {
  const now = Date.now();
  const known = files.get(file);
  if (known && now - known.checked < RECHECK_MS) return known.mapper;
  let mtime: number;
  try {
    const st = statSync(file);
    if (st.size > MAX_FILE) return undefined;
    mtime = st.mtimeMs;
  } catch {
    return undefined;
  }
  if (known && known.mtime === mtime) {
    known.checked = now;
    return known.mapper;
  }
  let mapper: Mapper | undefined;
  try {
    const code = readFileSync(file, "utf8");
    let map = inlineAnyMap(code);
    const ext = map ? undefined : externalMapUrl(code);
    if (ext) map = parseMap(readFileSync(path.resolve(path.dirname(file), decodeURIComponent(ext)), "utf8"));
    if (map) mapper = makeMapper(map);
  } catch {
    // no map
  }
  files.set(file, { mtime, checked: now, mapper });
  if (files.size > 2_000) files.delete(files.keys().next().value as string);
  return mapper;
}

function mapEval(f: Frame, root: string): Frame | undefined {
  let hit = evalIndex.get(f.file);
  if (!hit && Date.now() - lastScan > 250) {
    scanLoaded();
    hit = evalIndex.get(f.file);
  }
  if (!hit && Date.now() - lastBuildScan > 1_000) {
    scanBuildFolders(root);
    hit = evalIndex.get(f.file);
  }
  const fallback = sourceToFile(f.file, "", root);
  if (!fallback) return undefined;
  if (hit?.b64) {
    if (!hit.mapper) {
      const map = parseMap(Buffer.from(hit.b64, "base64").toString("utf8"));
      hit.mapper = map ? makeMapper(map) : { original: () => undefined };
    }
    const o = hit.mapper.original(f.line, f.col);
    if (o) {
      const src = sourceToFile(o.source, "", root, root);
      return src ? { ...f, file: src, line: o.line, col: o.col } : undefined;
    }
  }
  if (hit?.code) {
    try {
      const line = lineInSource(hit.code, readFileSync(fallback, "utf8"), f.line);
      if (line) return { ...f, file: fallback, line };
    } catch {
      // keep the module's own position
    }
  }
  return { ...f, file: fallback };
}

/** Reads the chunks Node has loaded (outside node_modules) that changed since the last look, and indexes their eval'd modules. */
function scanLoaded(): void {
  lastScan = Date.now();
  const cache = (typeof require === "function" ? require.cache : undefined) ?? {};
  for (const file of Object.keys(cache)) scanChunk(file);
}

let lastBuildScan = 0;
const MAX_BUILD_FILES = 3_000;

/**
 * Next.js runs Edge runtime code in a sandbox of its own, from chunks in the
 * build folder's server directory that never pass through require(). The
 * build folders in the project (.next and the like), and the server
 * directories of chunks already loaded, are read instead.
 */
function scanBuildFolders(root: string): void {
  lastBuildScan = Date.now();
  const dirs = new Set<string>();
  try {
    for (const name of readdirSync(root)) if (name.startsWith(".next")) dirs.add(path.join(root, name));
  } catch {
    // no folder to read
  }
  for (const file of Object.keys((typeof require === "function" ? require.cache : undefined) ?? {})) {
    const m = /^(.*?[\\/]server)[\\/]/.exec(file);
    if (m && !isLibrary(file)) dirs.add(path.dirname(m[1]));
  }
  let left = MAX_BUILD_FILES;
  const walk = (dir: string, depth: number) => {
    let names: import("node:fs").Dirent[];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      if (left <= 0) return;
      if (d.isDirectory() && depth < 10 && d.name !== "node_modules" && d.name !== "cache") walk(path.join(dir, d.name), depth + 1);
      else if (d.isFile() && d.name.endsWith(".js")) {
        left--;
        scanChunk(path.join(dir, d.name));
      }
    }
  };
  for (const dir of dirs) walk(dir, 0);
}

/** Indexes the eval'd modules of one chunk, when it changed since it was last read. */
function scanChunk(file: string): void {
  if (isLibrary(file) || !file.endsWith(".js")) return;
  let stamp: number;
  try {
    const st = statSync(file);
    if (st.size > MAX_FILE) return;
    stamp = st.mtimeMs + st.size;
  } catch {
    return;
  }
  if (scanned.get(file) === stamp) return;
  scanned.set(file, stamp);
  try {
    const code = readFileSync(file, "utf8");
    if (!code.includes("sourceURL=webpack")) return;
    const maps = evalMaps(code);
    for (const [url, b64] of maps) if (!isLibrary(url)) evalIndex.set(url, { b64 });
    if (maps.size === 0) for (const [url, src] of evalSources(code)) if (!isLibrary(url)) evalIndex.set(url, { code: src });
  } catch {
    // unreadable: skip
  }
}

// ---- code a Vite dev server runs with new AsyncFunction ----

const vite = isViteDevProcess();

interface Script {
  /** The data: URL of its source map. */
  url: string;
  mapper?: Mapper;
}
/** By file path: scripts V8 compiled with an inline map and a sourceURL. Null when the inspector could not be used. */
let scripts: Map<string, Script> | null | undefined;

const scriptKey = (file: string) => (process.platform === "win32" || process.platform === "darwin" ? path.normalize(file).toLowerCase() : path.normalize(file));

function scriptMapper(file: string): Mapper | undefined {
  if (scripts === undefined) scripts = watchScripts();
  const s = scripts?.get(scriptKey(file));
  if (!s) return undefined;
  if (!s.mapper) {
    let map: ReturnType<typeof parseMap>;
    try {
      const comma = s.url.indexOf(",");
      const data = s.url.slice(comma + 1);
      map = parseMap(/;base64$/i.test(s.url.slice(0, comma)) ? Buffer.from(data, "base64").toString("utf8") : decodeURIComponent(data));
    } catch {
      map = undefined;
    }
    s.mapper = map ? makeMapper(map) : { original: () => undefined };
  }
  return s.mapper;
}

/**
 * Turns on V8's script list for this process. Every script compiled from
 * then on, and every one compiled before, is reported once; the ones with
 * an inline map and a file path for a name are kept. Pauses are skipped,
 * so a debugger statement never stops the app because of this.
 */
function watchScripts(): Map<string, Script> | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const inspector = require("node:inspector") as typeof import("node:inspector");
    const session = new inspector.Session();
    session.connect();
    const found = new Map<string, Script>();
    session.on("Debugger.scriptParsed", (m: { params: { url?: string; sourceMapURL?: string } }) => {
      try {
        const { url, sourceMapURL } = m.params;
        if (!url || !sourceMapURL?.startsWith("data:") || !path.isAbsolute(url) || isLibrary(url)) return;
        // A module run again after an edit replaces its old map.
        found.set(scriptKey(url), { url: sourceMapURL });
        if (found.size > 5_000) found.delete(found.keys().next().value as string);
      } catch {
        // skip this one
      }
    });
    session.post("Debugger.enable");
    session.post("Debugger.setSkipAllPauses", { skip: true });
    return found;
  } catch {
    return null;
  }
}
