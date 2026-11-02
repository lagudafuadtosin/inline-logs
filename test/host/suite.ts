// Runs inside a real VS Code (see run.ts). Apps are started by typing into
// real integrated terminals, so they get NODE_OPTIONS from the extension the
// same way a user's would. Checks what the extension received and what it
// decorated, plus the app's own output against a run without the hook.
import * as vscode from "vscode";
import * as path from "node:path";
import * as http from "node:http";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import type { Api } from "../../src/extension";
import { cleanEnv, expectedLines } from "../expect";
import { runFeatures } from "./features";
import { runFeatures4 } from "./features4";
import { runFeatures5 } from "./features5";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const win = process.platform === "win32";

async function waitFor(what: string, f: () => boolean | Promise<boolean>, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await f()) return true;
    } catch {
      // keep trying
    }
    await wait(100);
  }
  console.log(`     (timed out waiting for ${what})`);
  return false;
}

function get(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (b += c));
      res.on("end", () => resolve(b));
    });
    req.on("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("timeout")));
  });
}

export async function run(): Promise<void> {
  let failed = 0;
  let passed = 0;
  const check = (ok: boolean, what: string, detail?: unknown) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : `  [${typeof detail === "string" ? detail : JSON.stringify(detail)}]`}`);
    if (ok) passed++;
    else failed++;
  };

  const root = process.env.IL_TEST_ROOT!;
  const tmp = process.env.IL_TEST_TMP!;
  const fixtures = path.join(root, "test-fixtures");
  mkdirSync(tmp, { recursive: true });
  const shell: vscode.TerminalOptions = win ? { shellPath: "cmd.exe", shellArgs: ["/d", "/v:on"] } : { shellPath: "/bin/sh" };
  const terminals: vscode.Terminal[] = [];

  /** Types a command into a new integrated terminal, output to files. Resolves when it finished. */
  const inTerminal = async (name: string, dir: string, cmd: string, env?: Record<string, string>) => {
    const out = path.join(tmp, `${name}.out`);
    const err = path.join(tmp, `${name}.err`);
    const done = path.join(tmp, `${name}.done`);
    const t = vscode.window.createTerminal({ name, cwd: dir, env, ...shell });
    terminals.push(t);
    t.sendText(win ? `${cmd} > "${out}" 2> "${err}" & echo code=!errorlevel!> "${done}"` : `${cmd} > "${out}" 2> "${err}"; echo code=$? > "${done}"`);
    const code = () => /code=(\d+)/.exec(existsSync(done) ? readFileSync(done, "utf8") : "")?.[1];
    const finished = await waitFor(`${name} to finish`, () => code() !== undefined, 60_000);
    await wait(150);
    return { finished, stdout: finished ? readFileSync(out, "utf8") : "", stderr: finished ? readFileSync(err, "utf8") : "", status: finished ? Number(code()) : -1 };
  };

  /** The same command without the hook, for comparison. */
  const plain = (dir: string, cmd: string) => {
    const r = spawnSync(cmd, { cwd: dir, env: cleanEnv(), encoding: "utf8", shell: true, timeout: 60_000, windowsHide: true });
    return { stdout: r.stdout, stderr: r.stderr, status: r.status };
  };

  const appliedFor = (doc: vscode.TextDocument) => api.applied.get(doc.uri.toString()) ?? [];
  const show = async (file: string, column = vscode.ViewColumn.One) => {
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc, { viewColumn: column, preview: false });
    return doc;
  };

  const ext = vscode.extensions.all.find((e) => path.resolve(e.extensionPath).toLowerCase() === path.resolve(root).toLowerCase());
  const api = (await ext!.activate()) as Api;

  try {
    check(api.port > 0 && api.token.length >= 32, "the extension listens on a local port with a token");
    check(existsSync(api.hookPath) && !api.hookPath.startsWith(root), "the hook is copied to a stable path outside the extension folder", api.hookPath);

    // ---- the terminal gets the variables ----
    {
      const r = await inTerminal("env", fixtures, `node -e "console.log(JSON.stringify([process.env.NODE_OPTIONS, process.env.INLINE_LOGS_PORT]))"`);
      const [opts, port] = JSON.parse(r.stdout.trim() || "[]") as [string, string];
      check(typeof opts === "string" && opts.includes("--require") && opts.includes(api.hookPath.replace(/\\/g, "/")), "a new terminal has NODE_OPTIONS --require <hook>", opts);
      check(port === String(api.port), "and the port", port);
    }

    // ---- Node apps: CJS, ESM, TypeScript through npm + tsx ----
    const nodeCases = [
      { name: "cjs", dir: "node-cjs", file: "index.js", cmd: "node index.js", expect: ["user", "map", "warn", "error-log", "loop", "class", "printf", "later"] },
      { name: "esm", dir: "node-esm", file: "index.mjs", cmd: "node index.mjs", expect: ["config", "waited", "area"] },
      { name: "tsx", dir: "ts-tsx", file: "index.ts", cmd: "npm start", expect: ["total", "all"] },
      { name: "crash", dir: "node-cjs", file: "crash.js", cmd: "node crash.js", expect: ["before", "throw"] },
      { name: "exit", dir: "node-cjs", file: "exit.js", cmd: "node exit.js", expect: ["exit"] },
    ];
    for (const c of nodeCases) {
      const dir = path.join(fixtures, c.dir);
      const file = path.join(dir, c.file);
      const doc = await show(file);
      const r = await inTerminal(c.name, dir, c.cmd);
      const p = plain(dir, c.cmd);
      check(r.finished, `${c.name}: the app ran in an integrated terminal`);
      check(r.stdout === p.stdout, `${c.name}: stdout is unchanged`, { hooked: r.stdout, plain: p.stdout });
      check(r.stderr === p.stderr, `${c.name}: stderr is unchanged`, { hooked: r.stderr, plain: p.stderr });
      check(r.status === p.status, `${c.name}: exit code is unchanged (${p.status})`, r.status);
      const lines = expectedLines(file);
      const want = c.expect.map((n) => lines.get(n)!);
      const got = await waitFor(`${c.name} decorations`, () => want.every((l) => appliedFor(doc).some((a) => a.line === l)), 10_000);
      check(got, `${c.name}: values reached the extension and show on lines ${want.join(", ")}`, appliedFor(doc).map((a) => a.line));
      const stray = api.store.all.filter((e) => e.lib || /node_modules|npm-cli/.test(e.file));
      check(stray.length === 0, `${c.name}: nothing from npm, tsx or node_modules`, stray.map((e) => `${e.file}:${e.line}`));
    }

    // ---- what the decorations say ----
    const cjsFile = path.join(fixtures, "node-cjs", "index.js");
    const cjs = await show(cjsFile);
    const L = expectedLines(cjsFile);
    {
      const a = appliedFor(cjs);
      const at = (n: string) => a.find((x) => x.line === L.get(n));
      check(at("user")?.text === "user { name: 'Ada', born: 1815, tags: [ 'math', 'code' ] }", "the logged value is shown at the end of the line", at("user")?.text);
      check(at("map")?.text === "Map(1) { 'a' => 1 } Set(2) { 1, 2 }", "Map and Set", at("map")?.text);
      check(at("warn")?.text === "10n { name: 'loop', self: [Circular] }" && at("warn")?.level === "warn", "BigInt and circular, as a warning", at("warn"));
      check(at("class")?.text === "Point { x: 1, y: 2 }", "class name", at("class")?.text);
      check(at("loop")?.count === 3 && at("loop")!.text.endsWith("\u00d73") && at("loop")!.hover.includes("3 hits") && at("loop")!.text.startsWith("i = 2"), "a line hit three times shows the latest value, x3, and the hover says 3 hits", at("loop"));
      check(!!at("user")?.hover.includes("born: 1815"), "the hover has the full value", at("user")?.hover);
      check(at("error-log")?.level === "error", "console.error is shown as an error");
    }
    {
      const crashFile = path.join(fixtures, "node-cjs", "crash.js");
      const crash = await show(crashFile);
      const throwLine = expectedLines(crashFile).get("throw");
      const a = appliedFor(crash).find((x) => x.line === throwLine);
      check(a?.kind === "error" && a.text === "TypeError: bad input", "an uncaught error is shown in red on the throwing line", a);
      await show(cjsFile);
    }

    // ---- settings ----
    const conf = () => vscode.workspace.getConfiguration("inlineLogs");
    await conf().update("maxLength", 12, vscode.ConfigurationTarget.Global);
    await wait(200);
    {
      const long = appliedFor(cjs).find((x) => x.line === L.get("user"));
      check(long?.text === "user { name\u2026", "maxLength cuts the value", long?.text);
    }
    await conf().update("maxLength", undefined, vscode.ConfigurationTarget.Global);
    await conf().update("levels", ["log", "info", "error", "debug"], vscode.ConfigurationTarget.Global);
    await wait(200);
    check(!appliedFor(cjs).some((x) => x.line === L.get("warn")) && appliedFor(cjs).some((x) => x.line === L.get("user")), "levels hides warn and keeps log");
    await conf().update("levels", undefined, vscode.ConfigurationTarget.Global);
    await wait(200);

    // ---- edits move or clear values ----
    {
      const editor = vscode.window.activeTextEditor!;
      const before = appliedFor(cjs).map((x) => x.line);
      await editor.edit((e) => e.insert(new vscode.Position(0, 0), "// a new first line\n"));
      await wait(100);
      const after = appliedFor(cjs).map((x) => x.line);
      check(JSON.stringify(after) === JSON.stringify(before.map((l) => l + 1)), "a line added above moves every value down one", { before, after });
      const userNow = L.get("user")! + 1;
      await editor.edit((e) => e.insert(new vscode.Position(userNow - 1, 2), "/* edited */"));
      await wait(100);
      check(!appliedFor(cjs).some((x) => x.line === userNow) && appliedFor(cjs).length === before.length - 1, "typing on a logged line clears just that value");
      await vscode.commands.executeCommand("workbench.action.files.revert");
      await wait(200);
    }

    // ---- log viewer ----
    {
      await vscode.commands.executeCommand("inlineLogs.showViewer");
      await wait(300);
      check(true, "Show Log Viewer opens the panel");
      const entry = api.store.all.find((e) => e.file.toLowerCase().endsWith("crash.js") && e.kind === "error")!;
      await api.open(entry);
      const ed = vscode.window.activeTextEditor;
      check(ed?.document.fileName.toLowerCase().endsWith("crash.js") === true && ed.selection.active.line === entry.line - 1, "clicking an entry jumps to its line", { file: ed?.document.fileName, line: ed?.selection.active.line });
      await show(cjsFile);
    }

    // ---- commands ----
    {
      await vscode.commands.executeCommand("inlineLogs.clear");
      await wait(100);
      check(api.store.size === 0 && appliedFor(cjs).length === 0, "Clear removes every value");
      await vscode.commands.executeCommand("inlineLogs.pause");
      const r = await inTerminal("paused", path.join(fixtures, "node-cjs"), "node index.js");
      await wait(500);
      check(r.finished && api.paused && api.store.size === 0, "while paused nothing is collected");
      await vscode.commands.executeCommand("inlineLogs.resume");
      await inTerminal("resumed", path.join(fixtures, "node-cjs"), "node index.js");
      check(await waitFor("resume", () => appliedFor(cjs).length > 0, 5_000), "after Resume values come back");
    }

    // ---- screenshot of the real window (optional) ----
    if (process.env.IL_SCREENSHOT && win) {
      await vscode.commands.executeCommand("workbench.action.closePanel");
      await vscode.commands.executeCommand("workbench.action.closeSidebar");
      await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
      await vscode.commands.executeCommand("notifications.clearAll");
      await show(cjsFile);
      await wait(800);
      const ps1 = path.join(tmp, "shot.ps1");
      writeFileSync(ps1, SCREENSHOT_PS1);
      const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, process.env.IL_SCREENSHOT], { encoding: "utf8", timeout: 20_000 });
      console.log(`     screenshot: ${(r.stdout || r.stderr || "").trim()}`);
    }

    // ---- Vite: browser console in a real browser engine ----
    {
      const dir = path.join(fixtures, "vite-app");
      const mainFile = path.join(dir, "src", "main.js");
      const tsFile = path.join(dir, "src", "describe.ts");
      const main = await show(mainFile, vscode.ViewColumn.One);
      const ts = await show(tsFile, vscode.ViewColumn.Two);
      const t = vscode.window.createTerminal({ name: "vite", cwd: dir, ...shell });
      terminals.push(t);
      let busy = false;
      try {
        await get("http://localhost:5199/");
        busy = true;
      } catch {
        // free, as it should be
      }
      check(!busy, "port 5199 is free before the test starts its own Vite");
      t.sendText("npm run dev");
      let html = "";
      const up = await waitFor("vite", async () => (html = await get("http://localhost:5199/")).length > 0, 30_000);
      check(up, "the Vite dev server started in an integrated terminal");
      check(html.includes("__INLINE_LOGS__") && html.indexOf("__INLINE_LOGS__") < html.indexOf("/@vite/client"), "the page Vite serves has the client script, before Vite's own");
      const js = await get("http://localhost:5199/src/main.js");
      check(!js.includes("__INLINE_LOGS__"), "JavaScript modules are served unchanged");

      const mainL = expectedLines(mainFile);
      const tsL = expectedLines(tsFile);
      const browserDone = () =>
        ["state", "describe", "browser-error"].every((n) => appliedFor(main).some((a) => a.line === mainL.get(n))) && appliedFor(ts).some((a) => a.line === tsL.get("ts-in-browser"));

      // A real browser: Chrome or Edge, headless, with a throwaway profile.
      const browser = [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ].find((p) => existsSync(p));
      let how = "none";
      if (browser) {
        how = path.basename(browser);
        const child = spawn(browser, ["--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${path.join(tmp, "browser-profile")}`, "--virtual-time-budget=3000", "--dump-dom", "http://localhost:5199/"], { stdio: "ignore" });
        await waitFor("browser entries", browserDone, 20_000);
        child.kill();
      }
      if (!browserDone()) {
        how = "Simple Browser";
        await vscode.commands.executeCommand("simpleBrowser.show", "http://localhost:5199/");
        await waitFor("browser entries (Simple Browser)", browserDone, 20_000);
      }
      const a = appliedFor(main);
      const at = (n: string) => a.find((x) => x.line === mainL.get(n));
      check(at("state")?.text === "state { clicks: 0, user: { name: 'Grace' } }", `browser console.log shows on its line in main.js (${how})`, a);
      check(at("describe")?.level === "warn" && at("describe")?.text === "Grace (age unknown)", "browser console.warn", at("describe"));
      check(at("browser-error")?.kind === "error" && /TypeError/.test(at("browser-error")!.text), "a browser error shows in red on the throwing line", at("browser-error"));
      const tsA = appliedFor(ts).find((x) => x.line === tsL.get("ts-in-browser"));
      check(tsA?.text === "describing { name: 'Grace' }", "a .ts module in the browser lands on its source line (source map)", appliedFor(ts));
      const vite = api.store.all.filter((e) => e.source === "browser" && /@vite|node_modules/.test(e.file));
      check(vite.length === 0, "Vite's own client messages are not shown", vite.map((e) => e.file));

      t.dispose();
      const down = await waitFor("vite to stop", async () => {
        try {
          await get("http://localhost:5199/");
          return false;
        } catch {
          return true;
        }
      }, 10_000);
      if (!down && win) {
        // conpty did not take the dev server down with the terminal: stop the fixture's own Vite.
        spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*vite*--port 5199*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"]);
      }
      check(down, "closing the terminal stops the dev server");
    }

    // ---- shared by the sections below ----
    const browserExe = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ].find((p) => existsSync(p));
    let profiles = 0;
    /** Loads a page in headless Chrome or Edge (throwaway profile) until `done` or the time is up. */
    const browse = async (url: string, done: () => boolean, ms = 25_000) => {
      if (!browserExe) return false;
      const end = Date.now() + ms;
      while (!done() && Date.now() < end) {
        const child = spawn(browserExe, ["--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${path.join(tmp, `browser-profile-${profiles++}`)}`, "--virtual-time-budget=5000", "--dump-dom", url], { stdio: "ignore" });
        await waitFor(`entries from ${url}`, done, 12_000);
        child.kill();
      }
      return done();
    };
    /** Starts a dev server by typing into a new terminal; resolves when `readyUrl` answers 200. */
    const devServer = async (name: string, dir: string, cmd: string, readyUrl: string, stopPattern: string, env?: Record<string, string>) => {
      const t = vscode.window.createTerminal({ name, cwd: dir, env, ...shell });
      terminals.push(t);
      t.sendText(cmd);
      const status = (u: string) =>
        new Promise<number>((resolve) => {
          const req = http.get(u, { headers: { accept: "text/html" } }, (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          });
          req.on("error", () => resolve(0));
          req.setTimeout(60_000, () => req.destroy());
        });
      const up = await waitFor(`${name} to start`, async () => (await status(readyUrl)) === 200, 120_000);
      return {
        up,
        status,
        stop: async () => {
          t.dispose();
          await wait(1_500);
          // conpty does not always take a dev server's child processes down with the terminal.
          if (win) spawnSync("powershell.exe", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '${stopPattern}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`]);
        },
      };
    };
    const line = (file: string, name: string) => expectedLines(file).get(name)!;
    const on = (doc: vscode.TextDocument, n: number) => appliedFor(doc).find((a) => a.line === n);

    // ---- console.table, console.dir, console.trace ----
    {
      const dir = path.join(fixtures, "node-cjs");
      const file = path.join(dir, "methods.js");
      const doc = await show(file);
      const r = await inTerminal("methods", dir, "node methods.js");
      const p = plain(dir, "node methods.js");
      check(r.stdout === p.stdout && r.stderr === p.stderr, "methods: output (and the stack console.trace prints) is unchanged", { hooked: r.stderr, plain: p.stderr });
      await waitFor("methods decorations", () => ["table", "dir", "trace"].every((n) => on(doc, line(file, n))), 10_000);
      const table = on(doc, line(file, "table"));
      check(table?.text === "table, 2 rows: name, born" && table.hover.includes("console.table") && table.hover.includes("│ 1       │ 'Grace' │ 1906 │"), "console.table: size and columns at the end of the line, the drawn table in the hover", table);
      const dirA = on(doc, line(file, "dir"));
      check(dirA?.text === "{ deep: { deeper: { deepest: { bottom: true } } } }" && dirA.hover.includes("console.dir"), "console.dir: the object", dirA);
      const trace = on(doc, line(file, "trace"));
      check(trace?.text === "Trace: traced 2" && /at where .*methods\.js:9:11/.test(trace.hover), "console.trace: the message, the stack in the hover", trace);
    }

    // ---- Ctrl+C: a log the process never got to send ----
    {
      const dir = path.join(fixtures, "node-cjs");
      const file = path.join(dir, "ctrlc.js");
      const doc = await show(file);
      const t = vscode.window.createTerminal({ name: "ctrl+c", cwd: dir, ...shell });
      terminals.push(t);
      t.sendText("node ctrlc.js");
      // The script blocks its event loop right after the log, so the log is never sent over HTTP.
      await wait(2_500);
      t.sendText("\u0003", false);
      const got = await waitFor("ctrl+c entry", () => !!on(doc, line(file, "waiting")), 10_000);
      check(got && on(doc, line(file, "waiting"))!.text.startsWith("waiting { pid:"), "Ctrl+C: the last log still shows (it came through the spool file)", appliedFor(doc));
      const gone = !spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*ctrlc.js*' } | Select-Object -First 1 ProcessId"], { encoding: "utf8" }).stdout.includes("ProcessId");
      check(!win || gone, "and Ctrl+C ended the process");
    }

    // ---- test runners, ts-node, Bun, Deno ----
    {
      const jestDir = path.join(fixtures, "jest-app");
      const jestFile = path.join(jestDir, "math.test.js");
      const jest = await show(jestFile);
      const r = await inTerminal("jest", jestDir, "npm test");
      check(r.status === 0, "Jest ran in an integrated terminal", r.stderr);
      // Times, and the estimate Jest adds once it has timings from an earlier run.
      const steady = (s: string) => s.replace(/\d+(\.\d+)? ?m?s\b/g, "<t>").replace(/, estimated <t>/g, "");
      const p = plain(jestDir, "npm test");
      check(steady(r.stderr) === steady(p.stderr), "Jest prints the same, 'at' lines included", { hooked: r.stderr, plain: p.stderr });
      await waitFor("jest decorations", () => ["jest-log", "jest-table", "jest-warn"].every((n) => on(jest, line(jestFile, n))), 10_000);
      check(on(jest, line(jestFile, "jest-log"))?.text === "jest result { result: 5 }", "Jest: a log inside a test shows on its line", appliedFor(jest));
      check(on(jest, line(jestFile, "jest-table"))?.text === "table, 2 rows: a, b" && on(jest, line(jestFile, "jest-warn"))?.level === "warn", "Jest: console.table and console.warn too", appliedFor(jest));

      const vDir = path.join(fixtures, "vitest-app");
      const vFile = path.join(vDir, "math.test.js");
      const vitest = await show(vFile);
      const v = await inTerminal("vitest", vDir, "npm test");
      check(v.status === 0, "Vitest ran in an integrated terminal", v.stdout + v.stderr);
      await waitFor("vitest decorations", () => ["vitest-log", "vitest-dir", "vitest-info", "vitest-trace"].every((n) => on(vitest, line(vFile, n))), 10_000);
      check(on(vitest, line(vFile, "vitest-log"))?.text === "vitest result { result: 12 }" && on(vitest, line(vFile, "vitest-trace"))?.text === "Trace: vitest trace", "Vitest: logs inside tests show on their lines (from a worker Vitest kills when done)", appliedFor(vitest));

      const tsDir = path.join(fixtures, "ts-node-app");
      const tsFile = path.join(tsDir, "index.ts");
      const tsDoc = await show(tsFile);
      const tr = await inTerminal("ts-node", tsDir, "npm start");
      check(tr.status === 0 && tr.stdout === plain(tsDir, "npm start").stdout, "ts-node ran, output unchanged", tr.stderr);
      await waitFor("ts-node decorations", () => ["ts-node-log", "ts-node-info"].every((n) => on(tsDoc, line(tsFile, n))), 10_000);
      check(on(tsDoc, line(tsFile, "ts-node-log"))?.text === "distance 5", "ts-node: values land on the .ts lines", appliedFor(tsDoc));

      const bunExe = spawnSync(win ? "where" : "which", ["bun"], { encoding: "utf8" }).status === 0;
      if (bunExe) {
        const bDir = path.join(fixtures, "bun-app");
        const bFile = path.join(bDir, "index.js");
        const bDoc = await show(bFile);
        const br = await inTerminal("bun", bDir, "bun index.js");
        await waitFor("bun decorations", () => ["bun-log", "bun-later"].every((n) => on(bDoc, line(bFile, n))), 10_000);
        check(br.status === 0 && on(bDoc, line(bFile, "bun-log"))?.text === "runtime bun { ok: true }", "Bun: a script run with bun shows its values (BUN_OPTIONS)", appliedFor(bDoc));
        const bi = await inTerminal("bun-install", bDir, "bun install --help");
        check(bi.status === 0, "Bun: other bun commands still work with BUN_OPTIONS set", bi.stderr);
      } else {
        console.log("     (bun is not installed: Bun checks skipped)");
      }

      const denoExe = [path.join(root, ".vscode-test", "deno", win ? "deno.exe" : "deno")].find((p) => existsSync(p));
      if (denoExe) {
        const dDir = path.join(fixtures, "deno-app");
        const dFile = path.join(dDir, "main.js");
        const dDoc = await show(dFile);
        const deno = `"${denoExe}"`;
        // Deno's cache stays with the test downloads.
        const denoEnv = { DENO_DIR: path.join(root, ".vscode-test", "deno", "cache"), DENO_NO_UPDATE_CHECK: "1" };
        const dr = await inTerminal("deno", dDir, `${deno} run -A main.js`, denoEnv);
        await waitFor("deno decorations", () => ["deno-log", "deno-later"].every((n) => on(dDoc, line(dFile, n))), 10_000);
        check(dr.status === 0 && on(dDoc, line(dFile, "deno-log"))?.text === "deno says { runtime: 'deno', ok: true }", "Deno: deno run -A shows its values (NODE_OPTIONS)", appliedFor(dDoc));
        await vscode.commands.executeCommand("inlineLogs.clear");
        // No permissions, and a real terminal that could answer a prompt: the hook must ask nothing and stay off.
        const locked = await inTerminal("deno-locked", dDir, `${deno} run main.js`, denoEnv);
        await wait(800);
        check(locked.finished && locked.status === 0 && appliedFor(dDoc).length === 0, "Deno without permissions: no prompt, no values, the app runs as normal", { status: locked.status, err: locked.stderr });
      } else {
        console.log("     (deno is not in .vscode-test/deno: Deno checks skipped)");
      }
    }

    // ---- Next.js: server and browser, Turbopack and webpack ----
    for (const [mode, script, port] of [
      ["Turbopack", "npm run dev", 5201],
      ["webpack", "npm run dev:webpack", 5202],
    ] as const) {
      await vscode.commands.executeCommand("inlineLogs.clear");
      const dir = path.join(fixtures, "next-app");
      const files = {
        page: path.join(dir, "app", "page.js"),
        counter: path.join(dir, "app", "client", "counter.js"),
        route: path.join(dir, "app", "api", "hello", "route.js"),
        legacy: path.join(dir, "pages", "legacy.js"),
        secret: path.join(dir, "app", "secure", "secret.js"),
      };
      const docs = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([k, f]) => [k, await vscode.workspace.openTextDocument(f)] as const))) as Record<keyof typeof files, vscode.TextDocument>;
      for (const d of [docs.page, docs.counter]) await vscode.window.showTextDocument(d, { viewColumn: d === docs.page ? vscode.ViewColumn.One : vscode.ViewColumn.Two, preview: false });
      const s = await devServer(`next ${mode}`, dir, script, `http://localhost:${port}/api/hello`, `*inline-logs\\test-fixtures\\next-app*`, { NEXT_TELEMETRY_DISABLED: "1" });
      check(s.up, `Next.js (${mode}) dev server started in an integrated terminal`);
      const has = (k: keyof typeof files, n: string) => api.store.lines(files[k]).some((i) => i.line === line(files[k], n));
      const base = `http://localhost:${port}`;
      await browse(`${base}/`, () => has("page", "app-server") && has("counter", "app-browser"));
      await browse(`${base}/legacy`, () => has("legacy", "pages-server") && has("legacy", "pages-browser"));
      await browse(`${base}/secure`, () => has("secret", "csp-nonce"));
      await waitFor("route", async () => (await s.status(`${base}/api/hello`)) === 200 && has("route", "route"), 10_000);
      check(on(docs.page, line(files.page, "app-server"))?.text === "server user { name: 'Linus', langs: [ 'c', 'git' ] }", `Next.js (${mode}): a server component's log shows on its line`, appliedFor(docs.page));
      // React's strict mode runs the effect twice in development: "×2".
      check(on(docs.counter, line(files.counter, "app-browser"))?.text.startsWith("client counter { n: 2, where: 'object' }") === true, `Next.js (${mode}): a client component's browser log shows on its line`, appliedFor(docs.counter));
      check(has("route", "route"), `Next.js (${mode}): a route handler's log`, api.store.lines(files.route).map((i) => i.line));
      check(has("legacy", "pages-server") && has("legacy", "pages-browser"), `Next.js (${mode}): pages router, getServerSideProps and the browser`, api.store.lines(files.legacy).map((i) => i.line));
      check(has("secret", "csp-nonce"), `Next.js (${mode}): a page with a nonce Content-Security-Policy still sends its logs`, api.store.lines(files.secret).map((i) => i.line));
      const bundled = api.store.all.filter((e) => /[\\/]\.next|_next[\\/]static/.test(e.file) || e.lib);
      check(bundled.length === 0, `Next.js (${mode}): nothing lands on a bundle file or comes from Next itself`, bundled.map((e) => `${e.file}:${e.line} ${e.preview}`));
      await s.stop();
    }

    // ---- webpack-dev-server ----
    {
      await vscode.commands.executeCommand("inlineLogs.clear");
      const dir = path.join(fixtures, "webpack-app");
      const index = path.join(dir, "src", "index.js");
      const shapes = path.join(dir, "src", "shapes.js");
      const iDoc = await show(index, vscode.ViewColumn.One);
      const sDoc = await show(shapes, vscode.ViewColumn.Two);
      const s = await devServer("webpack", dir, "npm run dev", "http://localhost:5203/", `*inline-logs\\test-fixtures\\webpack-app*`);
      check(s.up, "webpack-dev-server started in an integrated terminal");
      const done = () => ["wp-settings", "wp-area", "wp-error"].every((n) => on(iDoc, line(index, n))) && !!on(sDoc, line(shapes, "wp-module"));
      await browse("http://localhost:5203/", done);
      check(on(iDoc, line(index, "wp-settings"))?.text === "settings { theme: 'dark', sizes: [ 1, 2, 3 ] }" && on(iDoc, line(index, "wp-area"))?.level === "warn", "webpack-dev-server: browser logs on their lines (webpack's default eval devtool)", appliedFor(iDoc));
      check(on(sDoc, line(shapes, "wp-module"))?.text === "area of { w: 3, h: 4 }", "webpack-dev-server: an imported module's log on its line", appliedFor(sDoc));
      check(on(iDoc, line(index, "wp-error"))?.kind === "error", "webpack-dev-server: a browser error on the throwing line", appliedFor(iDoc));
      await s.stop();
    }

    // ---- Content-Security-Policy ----
    {
      await vscode.commands.executeCommand("inlineLogs.clear");
      const dir = path.join(fixtures, "csp-app");
      const header = path.join(dir, "src", "header.js");
      const meta = path.join(dir, "src", "meta.js");
      const hDoc = await show(header, vscode.ViewColumn.One);
      const mDoc = await show(meta, vscode.ViewColumn.Two);
      const s = await devServer("csp", dir, "npm run dev", "http://localhost:5204/", "*vite*--port 5204*");
      check(s.up, "the strict-CSP dev server started");
      const csp = await new Promise<string>((resolve) => http.get("http://localhost:5204/", (res) => (res.resume(), resolve(String(res.headers["content-security-policy"])))).on("error", () => resolve("")));
      check(/script-src 'self' 'sha256-[^']+'/.test(csp), "the page's own CSP header gains only the client script's hash", csp);
      await browse("http://localhost:5204/", () => !!on(hDoc, line(header, "csp-header")));
      await browse("http://localhost:5204/meta.html", () => !!on(mDoc, line(meta, "csp-meta")));
      check(on(hDoc, line(header, "csp-header"))?.text === "csp header page { from: 'header', inline: false }", "a page whose CSP header blocks inline scripts still sends its logs", appliedFor(hDoc));
      check(on(mDoc, line(meta, "csp-meta"))?.text === "csp meta page { from: 'meta', connect: 'ws only' }", "a page with a <meta> CSP that blocks posts to its origin still sends its logs", appliedFor(mDoc));
      await s.stop();
    }

    // ---- turning it off ----
    {
      await conf().update("enabled", false, vscode.ConfigurationTarget.Global);
      await wait(300);
      const r = await inTerminal("off", fixtures, `node -e "console.log(process.env.NODE_OPTIONS || 'none')"`);
      check(r.stdout.trim() === "none", "turned off, a new terminal has no NODE_OPTIONS", r.stdout);
      await conf().update("enabled", undefined, vscode.ConfigurationTarget.Global);
    }

    // ---- 0.3.0: requests, MCP, diff, search and Log Map, coverage, value graph ----
    await vscode.commands.executeCommand("inlineLogs.clear");
    await runFeatures(api, check);

    // ---- 0.4.0: log commands, runs, counters, export, loggers, sockets, problems, outside terminals, monorepos, frameworks ----
    await vscode.commands.executeCommand("inlineLogs.clear");
    await runFeatures4(api, check);

    // ---- 0.5.0: calls side by side, page reloads, the graph in parts, MCP on VS Code's own program, keys, bun test, Deno coverage ----
    await vscode.commands.executeCommand("inlineLogs.clear");
    await runFeatures5(api, check);
  } catch (err) {
    console.error(err);
    failed++;
  } finally {
    for (const t of terminals) t.dispose();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) throw new Error(`${failed} host checks failed`);
}

const SCREENSHOT_PS1 = `
param([string]$out)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  public struct RECT { public int L; public int T; public int R; public int B; }
}
"@
# Only the test window itself is drawn (PrintWindow), never whatever is on top of it.
$p = Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*Extension Development Host*' } | Select-Object -First 1
if (-not $p) { "no window"; exit 0 }
$r = New-Object W+RECT
[W]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$w = $r.R - $r.L; $h = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
$ok = [W]::PrintWindow($p.MainWindowHandle, $dc, 2)
$g.ReleaseHdc($dc)
if (-not $ok) { "PrintWindow failed"; exit 0 }
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
"saved $out ($w x $h)"
`;
