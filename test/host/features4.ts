// Host checks for the 0.4.0 features, run inside the real VS Code after the
// others (see suite.ts): the log commands and their keys, the run list in the
// hover, console.count/time/group/assert in Node and the browser, pause and
// export, Svelte's $inspect, Copy Value, the viewer's search, logging
// libraries, WebSockets, the Problems panel, a terminal outside VS Code, a
// monorepo, and the SvelteKit, React Router, Nuxt and Astro dev servers.
import * as vscode from "vscode";
import * as path from "node:path";
import * as http from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import type { Api } from "../../src/extension";
import { cleanEnv, expectedLines } from "../expect";

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

export async function runFeatures4(api: Api, check: (ok: boolean, what: string, detail?: unknown) => void): Promise<void> {
  const root = process.env.IL_TEST_ROOT!;
  const tmp = process.env.IL_TEST_TMP!;
  const fixtures = path.join(root, "test-fixtures");
  const shell: vscode.TerminalOptions = win ? { shellPath: "cmd.exe", shellArgs: ["/d", "/v:on"] } : { shellPath: "/bin/sh" };
  const terminals: vscode.Terminal[] = [];
  const conf = () => vscode.workspace.getConfiguration("inlineLogs");
  let runs = 0;

  const inTerminal = async (name: string, dir: string, cmd: string) => {
    const id = `g-${name}-${runs++}`;
    const out = path.join(tmp, `${id}.out`);
    const err = path.join(tmp, `${id}.err`);
    const done = path.join(tmp, `${id}.done`);
    const t = vscode.window.createTerminal({ name, cwd: dir, ...shell });
    terminals.push(t);
    t.sendText(win ? `${cmd} > "${out}" 2> "${err}" & echo code=!errorlevel!> "${done}"` : `${cmd} > "${out}" 2> "${err}"; echo code=$? > "${done}"`);
    const code = () => /code=(\d+)/.exec(existsSync(done) ? readFileSync(done, "utf8") : "")?.[1];
    const finished = await waitFor(`${name} to finish`, () => code() !== undefined, 90_000);
    await wait(150);
    return { finished, stdout: finished ? readFileSync(out, "utf8") : "", stderr: finished ? readFileSync(err, "utf8") : "", status: finished ? Number(code()) : -1 };
  };
  const show = async (file: string, column = vscode.ViewColumn.One) => {
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc, { viewColumn: column, preview: false });
    return doc;
  };
  const appliedFor = (doc: vscode.TextDocument) => api.applied.get(doc.uri.toString()) ?? [];
  const on = (doc: vscode.TextDocument, n: number) => appliedFor(doc).find((a) => a.line === n);
  const line = (file: string, name: string) => expectedLines(file).get(name)!;
  const at = (file: string, name: string) => api.store.all.filter((e) => e.line === line(file, name) && path.resolve(e.file).toLowerCase() === file.toLowerCase());
  const status = (u: string) =>
    new Promise<number>((resolve) => {
      const req = http.get(u, { headers: { accept: "text/html" } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", () => resolve(0));
      req.setTimeout(60_000, () => req.destroy());
    });
  const browserExe = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
  let profiles = 0;
  const browse = async (url: string, done: () => boolean, ms = 30_000) => {
    if (!browserExe) return false;
    const end = Date.now() + ms;
    while (!done() && Date.now() < end) {
      const child = spawn(browserExe, ["--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${path.join(tmp, `g-profile-${profiles++}`)}`, "--virtual-time-budget=6000", "--dump-dom", url], { stdio: "ignore" });
      await waitFor(`entries from ${url}`, done, 15_000);
      child.kill();
    }
    return done();
  };
  const stopNode = (pattern: string) => {
    if (win) spawnSync("powershell.exe", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '${pattern}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`]);
  };
  const devServer = async (name: string, dir: string, cmd: string, readyUrl: string, stopPattern: string) => {
    const t = vscode.window.createTerminal({ name, cwd: dir, ...shell });
    terminals.push(t);
    t.sendText(cmd);
    const up = await waitFor(`${name} to start`, async () => (await status(readyUrl)) === 200, 120_000);
    return {
      up,
      stop: async () => {
        t.dispose();
        await wait(1_500);
        stopNode(stopPattern);
        return waitFor(`${name} to stop`, async () => (await status(readyUrl)) === 0, 15_000);
      },
    };
  };

  try {
    // ---- 1. log commands and their keys ----
    {
      const editDir = path.join(tmp, "edit-app");
      mkdirSync(editDir, { recursive: true });
      for (const f of ["sample.ts", "Widget.svelte"]) copyFileSync(path.join(fixtures, "edit-app", f), path.join(editDir, f));
      const file = path.join(editDir, "sample.ts");
      const doc = await show(file);
      const ed = vscode.window.activeTextEditor!;
      const labelLine = doc.getText().split("\n").findIndex((l) => l.includes("const label ="));
      ed.selection = new vscode.Selection(labelLine, 9, labelLine, 9);
      await vscode.commands.executeCommand("inlineLogs.insertLog");
      await wait(300);
      const after = doc.lineAt(labelLine + 1).text;
      check(after === `  console.log("sample.ts:${labelLine + 2} label", label);`, "insert log: a console.log for the name under the cursor on the next line, with the file and line, the file's indentation and quotes", after);
      const before = doc.getText();
      await vscode.commands.executeCommand("inlineLogs.commentLogs");
      await wait(300);
      const commented = doc.getText();
      check(commented.includes('  // console.log("label", label);') && commented.includes('  // console.info(\n  //   "multi line",') && commented.includes('const note = "console.log(not a call)";') && commented.includes("if (user.langs.length > 1) console.warn(\"many\");"), "comment out: real calls only, a call over lines as one, strings and an if body left alone", commented);
      await vscode.commands.executeCommand("inlineLogs.uncommentLogs");
      await wait(300);
      check(doc.getText() === before, "uncomment: the file is back as it was", doc.getText());
      await vscode.commands.executeCommand("inlineLogs.removeLogs");
      await wait(300);
      const removed = doc.getText();
      check(!/^\s*console\./m.test(removed) && removed.includes("if (user.langs.length > 1) {}") && removed.includes("map((n) => {})") && removed.includes('"console.log(not a call)"'), "remove: every console call goes, the code keeps its shape", removed);
      await vscode.commands.executeCommand("undo");
      await wait(200);
      check(doc.getText() === before, "remove is one step to undo");
      const sv = await show(path.join(editDir, "Widget.svelte"));
      vscode.window.activeTextEditor!.selection = new vscode.Selection(1, 7, 1, 7);
      await vscode.commands.executeCommand("inlineLogs.insertLog");
      await wait(300);
      check(sv.lineAt(2).text === '  console.log("Widget.svelte:3 count", count);', "insert log in a Svelte file's <script>", sv.lineAt(2).text);
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
      await show(file);
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
      // The keys: none is one of VS Code's own.
      await vscode.commands.executeCommand("workbench.action.openDefaultKeybindingsFile");
      await wait(1_500);
      const defaults = vscode.window.activeTextEditor?.document.getText() ?? "";
      const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { contributes: { keybindings: { key: string; command: string }[] } };
      const ours = pkg.contributes.keybindings.map((k) => k.key);
      const keyOf = (k: string) => k.split("+").sort().join("+");
      const taken = [...defaults.matchAll(/"key": "([^"]+)",\s*"command": "([^"]+)"/g)].filter((m) => !m[2].startsWith("inlineLogs.") && !m[2].startsWith("-")).map((m) => keyOf(m[1]));
      const clash = ours.filter((k) => taken.includes(keyOf(k)));
      check(defaults.length > 10_000 && ours.length === 4 && clash.length === 0, `keys ${ours.join(", ")} are none of VS Code's ${new Set(taken).size} default keys on this platform`, clash);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    }

    // ---- 2 and 3. run list in the hover; console.count, time, group and assert in Node ----
    {
      await vscode.commands.executeCommand("inlineLogs.clear");
      const dir = path.join(fixtures, "node-cjs");
      const file = path.join(dir, "counters.js");
      const doc = await show(file);
      const r = await inTerminal("counters", dir, "node counters.js");
      const plain = spawnSync("node counters.js", { cwd: dir, env: cleanEnv(), encoding: "utf8", shell: true, windowsHide: true });
      const steady = (s: string) => s.replace(/\d+\.\d+m?s/g, "<t>");
      check(r.finished && steady(r.stdout) === steady(plain.stdout) && r.stderr === plain.stderr, "counters: what the terminal shows is the same as without the extension", { hooked: r.stdout + r.stderr, plain: plain.stdout + plain.stderr });
      await waitFor("counter decorations", () => !!on(doc, line(file, "assert-fail")), 10_000);
      const count = on(doc, line(file, "count"));
      check(count?.text === "loop: 3  \u00d73" && count.count === 3 && count.hover.includes("**console.count**"), "console.count: the count and x3 at the end of the line", count);
      check(!!count && count.hover.includes("**Runs**, newest first") && /#3 {2}\d\d:\d\d:\d\d\.\d{3} {2}loop: 3\n#2 {2}\d\d:\d\d:\d\d\.\d{3} {2}loop: 2\n#1 {2}\d\d:\d\d:\d\d\.\d{3} {2}loop: 1/.test(count.hover), "run counter: the hover lists each run with its time and value", count?.hover);
      check(/^load: \d+\.\d+ms$/.test(on(doc, line(file, "time-end"))?.text ?? "") && on(doc, line(file, "time"))?.text === "load: timer started", "console.time and timeEnd", [on(doc, line(file, "time")), on(doc, line(file, "time-end"))]);
      check(on(doc, line(file, "group"))?.text === "\u25be Outer" && !!on(doc, line(file, "in-group"))?.hover.includes("in group Outer"), "console.group: the label, and the group in the hover of a log inside it", on(doc, line(file, "in-group"))?.hover);
      const fail = on(doc, line(file, "assert-fail"));
      check(fail?.text === "Assertion failed: math is broken: 3" && fail.level === "warn" && !on(doc, line(file, "assert-ok")) && !on(doc, line(file, "group-end")), "console.assert: only the failing one, as a warning", fail);
    }

    // ---- 4. pause and resume, export ----
    {
      await vscode.commands.executeCommand("inlineLogs.togglePause");
      check(api.paused && api.statusText.includes("Paused"), "pause: one command, the status bar says Paused", api.statusText);
      await vscode.commands.executeCommand("inlineLogs.togglePause");
      check(!api.paused && !api.statusText.includes("Paused"), "resume: the same command again", api.statusText);
      const jsonFile = path.join(tmp, "export.json");
      const textFile = path.join(tmp, "export.txt");
      await vscode.commands.executeCommand("inlineLogs.export", vscode.Uri.file(jsonFile));
      await vscode.commands.executeCommand("inlineLogs.export", vscode.Uri.file(textFile));
      const json = existsSync(jsonFile) ? (JSON.parse(readFileSync(jsonFile, "utf8")) as { file: string; text: string; method?: string }[]) : [];
      const text = existsSync(textFile) ? readFileSync(textFile, "utf8") : "";
      check(json.length === api.store.size && json.some((e) => e.method === "count" && e.text === "loop: 3" && /node-cjs[\\/]counters\.js$/.test(e.file)), "export: every entry as JSON", json.slice(0, 2));
      check(text.includes("console.count  node-cjs") && text.includes("    loop: 3"), "export: the same as plain text", text.slice(0, 300));
    }

    // ---- 6. copy value: command, hover link, viewer ----
    {
      const file = path.join(fixtures, "node-cjs", "counters.js");
      await vscode.commands.executeCommand("inlineLogs.copyValue", file, line(file, "time-log"));
      const copied = await vscode.env.clipboard.readText();
      check(/^"load: \d+\.\d+ms halfway \{ step: 1 \}"$/.test(copied), "copy value: the command copies the newest value on the line", copied);
      const doc = await show(file);
      const hover = on(doc, line(file, "count"))?.hover ?? "";
      check(hover.includes("command:inlineLogs.copyValue?"), "copy value: a link in the hover");
      const entry = at(file, "in-group")[0];
      await vscode.env.clipboard.writeText("");
      api.viewer.receive({ type: "copy", id: entry.id });
      await waitFor("viewer copy", async () => (await vscode.env.clipboard.readText()) !== "", 3_000);
      check((await vscode.env.clipboard.readText()) === '"inside the group"', "copy value: the viewer's copy button");
    }

    // ---- 8. logging libraries ----
    {
      await vscode.commands.executeCommand("inlineLogs.clear");
      const dir = path.join(fixtures, "loggers-app");
      const file = path.join(dir, "index.js");
      const doc = await show(file);
      const r = await inTerminal("loggers", dir, "node index.js");
      check(r.finished && r.status === 0 && r.stdout.includes('"msg":"pino order placed"'), "loggers: the app ran, the libraries printed", r.stderr);
      const names = ["pino-info", "pino-warn", "pino-error", "winston-info", "winston-warn", "winston-error", "consola-info", "consola-warn", "consola-error", "tslog-info", "tslog-warn"];
      await waitFor("logger decorations", () => names.every((n) => on(doc, line(file, n))), 10_000);
      const got = names.map((n) => `${n}:${on(doc, line(file, n))?.style}`);
      check(
        names.every((n) => {
          const a = on(doc, line(file, n));
          return !!a && a.style === (n.endsWith("info") ? "info" : n.endsWith("warn") ? "warn" : "error");
        }),
        "loggers: pino, winston, consola and tslog on their lines, in their level's colour",
        got,
      );
      check(on(doc, line(file, "winston-info"))?.text === "winston started { port: 8080 }" && !!on(doc, line(file, "pino-info"))?.hover.includes("**pino info**"), "loggers: the message and fields inline, the library in the hover", on(doc, line(file, "pino-info")));
    }

    // ---- 9a. WebSockets in Node ----
    {
      const dir = path.join(fixtures, "sockets-app");
      const file = path.join(dir, "index.js");
      const doc = await show(file);
      await inTerminal("sockets", dir, "node index.js");
      await waitFor("socket entries", () => at(file, "ws-dead").length === 2, 10_000);
      const open = at(file, "ws-open").filter((e) => e.request?.api === "websocket").map((e) => e.request?.ws?.event);
      check(JSON.stringify(open) === JSON.stringify(["open", "message", "message", "close"]), "websockets (Node): open, received messages and close on the line that opened the socket", open);
      check(on(doc, line(file, "ws-send"))?.text === 'WS \u2191 37 B \u00b7 {"type":"hello","password":"[redacted]"}', "websockets (Node): a sent message on its send line, redacted", on(doc, line(file, "ws-send")));
      check(at(file, "ws-dead").map((e) => e.level).join() === "error,warn", "websockets (Node): a failed socket in red, its close in yellow");
    }

    // ---- 10. runtime errors in the Problems panel ----
    {
      const dir = path.join(fixtures, "node-cjs");
      const file = path.join(dir, "crash.js");
      const uri = vscode.Uri.file(file);
      const throwLine = line(file, "throw");
      const problems = () => vscode.languages.getDiagnostics(uri).filter((d) => d.source === "Inline Logs");
      await inTerminal("crash-1", dir, "node crash.js");
      await waitFor("problem", () => problems().length === 1, 10_000);
      const p = problems()[0];
      check(!!p && p.range.start.line === throwLine - 1 && p.severity === vscode.DiagnosticSeverity.Error && p.message === "TypeError: bad input", "problems: an uncaught error is in the Problems panel on the line that threw", p);
      await inTerminal("crash-2", dir, "node crash.js");
      await wait(800);
      check(problems().length === 1, "problems: a new run of the same program replaces the old run's error", problems().length);
      const doc = await show(file);
      await vscode.window.activeTextEditor!.edit((e) => e.insert(new vscode.Position(throwLine - 1, 0), " "));
      await wait(300);
      check(problems().length === 0, "problems: editing the line clears it");
      await vscode.commands.executeCommand("workbench.action.files.revert");
      await inTerminal("crash-3", dir, "node crash.js");
      await waitFor("problem again", () => problems().length === 1, 10_000);
      await conf().update("problems", false, vscode.ConfigurationTarget.Global);
      await wait(300);
      check(problems().length === 0 && !!on(doc, throwLine), "problems: the setting turns it off, the red line in the editor stays");
      await conf().update("problems", undefined, vscode.ConfigurationTarget.Global);
      await wait(300);
      check(problems().length === 1, "problems: and back on");
    }

    // ---- 11. a terminal outside VS Code ----
    if (win) {
      await vscode.commands.executeCommand("inlineLogs.clear");
      const dir = path.join(fixtures, "outside-app");
      const file = path.join(dir, "index.js");
      for (const sh of ["cmd", "powershell"] as const) {
        const lineText = (await vscode.commands.executeCommand<string>("inlineLogs.copyTerminalSetup", sh)) ?? "";
        const clip = await vscode.env.clipboard.readText();
        const ran = await new Promise<number | null>((resolve) => {
          // A plain process started by the test, not an integrated terminal: none of VS Code's variables.
          const child =
            sh === "cmd"
              ? spawn("cmd.exe", ["/d", "/s", "/c", `"${lineText} & node index.js"`], { cwd: dir, env: cleanEnv(), windowsVerbatimArguments: true, windowsHide: true })
              : spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(`${lineText}; node index.js`, "utf16le").toString("base64")], { cwd: dir, env: cleanEnv(), windowsHide: true });
          child.on("close", resolve);
        });
        const got = await waitFor(`${sh} entries`, () => at(file, "outside").length > 0 && at(file, "outside-warn").length > 0, 8_000);
        check(clip === lineText && lineText.includes(String(api.port)) && ran === 0 && got, `outside terminal (${sh}): the copied line, pasted into a separate ${sh}, sends the app's values to this window`, { lineText: lineText.slice(0, 80), ran });
        await vscode.commands.executeCommand("inlineLogs.clear");
      }
    }

    // ---- 12. a monorepo: two packages at once ----
    {
      const dir = path.join(fixtures, "monorepo");
      const apiFile = path.join(dir, "packages", "api", "src", "index.js");
      const webFile = path.join(dir, "packages", "web", "src", "index.js");
      const a = await show(apiFile, vscode.ViewColumn.One);
      const w = await show(webFile, vscode.ViewColumn.Two);
      await inTerminal("monorepo", dir, "npm run dev");
      await waitFor("monorepo decorations", () => on(a, line(apiFile, "api-tick"))?.count === 6 && on(w, line(webFile, "web-tick"))?.count === 6, 10_000);
      check(on(a, line(apiFile, "api-tick"))?.text.startsWith("api tick { n: 6, pkg: 'api' }") === true && on(w, line(webFile, "web-tick"))?.text.startsWith("web tick { n: 6, pkg: 'web' }") === true, "monorepo: two packages run at once, each value on its own package's src/index.js", [on(a, line(apiFile, "api-tick")), on(w, line(webFile, "web-tick"))]);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    }

    // ---- 7. the viewer's search ----
    {
      await vscode.commands.executeCommand("inlineLogs.showViewer");
      await wait(500);
      const total = api.store.size;
      api.viewer.setQuery("file:web tick");
      await waitFor("viewer search", () => api.viewer.state?.query === "file:web tick", 5_000);
      const s = api.viewer.state;
      const want = api.store.all.filter((e) => /[\\/]web[\\/]/.test(e.file) && e.preview.includes("tick")).map((e) => e.id);
      check(!!s && s.shown === want.length && s.total === total && JSON.stringify(s.ids) === JSON.stringify(want), "viewer search: the box in the panel filters with the Search words (file:, kind:, level:, status:)", { s, want: want.length });
      api.viewer.setQuery("");
      await waitFor("viewer search cleared", () => api.viewer.state?.query === "" && api.viewer.state.shown === Math.min(total, 2000), 5_000);
      check(api.viewer.state?.shown === Math.min(total, 2000), "viewer search: cleared, every row is back", api.viewer.state);
    }

    // ---- 3b, 9b, 5. the browser: counters, a WebSocket, Svelte's $inspect ----
    {
      await vscode.commands.executeCommand("inlineLogs.clear");
      const echo = spawn(process.platform === "win32" ? "node.exe" : "node", ["echo.js", "5210"], { cwd: path.join(fixtures, "sockets-app"), env: cleanEnv(), stdio: "ignore", windowsHide: true });
      const dir = path.join(fixtures, "vite-app");
      const file = path.join(dir, "src", "console.js");
      const doc = await show(file);
      const s = await devServer("vite-console", dir, "npm run dev", "http://localhost:5199/console.html", "*vite*--port 5199*");
      check(s.up, "browser: Vite started");
      await browse("http://localhost:5199/console.html", () => at(file, "web-ws-send").length > 0 && at(file, "web-ws-open").some((e) => e.request?.ws?.event === "close") && at(file, "web-assert").length > 0);
      // The editor draws the values a moment after they arrive.
      await show(file);
      await waitFor("browser decorations", () => !!on(doc, line(file, "web-count")) && !!on(doc, line(file, "web-assert")), 5_000);
      check(on(doc, line(file, "web-count"))?.text === "clicks: 2  \u00d72" && /^paint: \d+\.\d+ms$/.test(on(doc, line(file, "web-time-end"))?.text ?? "") && on(doc, line(file, "web-group"))?.text === "\u25be Cart", "browser: console.count, timeEnd and group", appliedFor(doc));
      check(at(file, "web-in-group")[0]?.group === "Cart" && on(doc, line(file, "web-assert"))?.level === "error" && on(doc, line(file, "web-assert"))?.text === "Assertion failed: web assert", "browser: a log inside a group knows its group, a failed assert is an error", appliedFor(doc));
      const events = at(file, "web-ws-open").map((e) => e.request?.ws?.event);
      const sent = at(file, "web-ws-send")[0];
      check(JSON.stringify(events) === JSON.stringify(["open", "message", "close"]) && sent?.preview === 'WS \u2191 34 B \u00b7 {"hello":"page","secret":"[redacted]"}' && !JSON.stringify(api.store.all).includes("page-token") && !JSON.stringify(api.store.all).includes("s3cret"), "websockets (browser): open, sent, received and close, secrets redacted in the page", { events, sent: sent?.preview });
      check(await s.stop(), "browser: the dev server is stopped");
      echo.kill();

      const sDir = path.join(fixtures, "svelte-app");
      const sFile = path.join(sDir, "src", "App.svelte");
      const sDoc = await show(sFile);
      const sv = await devServer("svelte", sDir, "npm run dev", "http://localhost:5205/", "*vite*--port 5205*");
      check(sv.up, "Svelte: Vite with the Svelte plugin started");
      await browse("http://localhost:5205/", () => on(sDoc, line(sFile, "inspect-count"))?.count === 3 && !!on(sDoc, line(sFile, "inspect-user")));
      const c = on(sDoc, line(sFile, "inspect-count"));
      const u = on(sDoc, line(sFile, "inspect-user"));
      check(c?.text === "2  \u00d73" && u?.text === "{ name: 'Ada', langs: [ 'svelte', 'js' ] }  \u00d72", "Svelte 5: $inspect values on the $inspect line, each new value as a run", appliedFor(sDoc));
      check(appliedFor(sDoc).length === 3, "Svelte 5: Svelte's own folded stack trace after each value does not land on the lines that changed the state", appliedFor(sDoc).map((a) => `${a.line}:${a.text}`));
      check(await sv.stop(), "Svelte: the dev server is stopped");
    }

    // ---- 13. SvelteKit, React Router, Nuxt, Astro ----
    {
      await vscode.commands.executeCommand("inlineLogs.clear");
      const kDir = path.join(fixtures, "sveltekit-app");
      const kServer = path.join(kDir, "src", "routes", "+page.server.js");
      const kPage = path.join(kDir, "src", "routes", "+page.svelte");
      const k = await devServer("sveltekit", kDir, "npm run dev", "http://localhost:5206/", "*vite*--port 5206*");
      check(k.up, "SvelteKit: vite dev started");
      await browse("http://localhost:5206/", () => at(kServer, "kit-server").length > 0 && at(kPage, "kit-browser").length > 0 && at(kPage, "kit-inspect").some((e) => e.source === "browser"));
      check(at(kServer, "kit-server")[0]?.preview === "kit server load { title: 'Dune', year: 1965 }" && at(kPage, "kit-browser")[0]?.preview === "kit browser { title: 'Dune' }" && at(kPage, "kit-inspect").some((e) => e.source === "browser"), "SvelteKit: a server load, a browser log and $inspect on their lines", api.store.all.map((e) => `${path.basename(e.file)}:${e.line} ${e.source}`));
      check(await k.stop(), "SvelteKit: the dev server is stopped");

      const rDir = path.join(fixtures, "react-router-app");
      const rFile = path.join(rDir, "app", "routes", "home.jsx");
      const r = await devServer("react-router", rDir, "npm run dev", "http://localhost:5207/", "*inline-logs\\test-fixtures\\react-router-app*");
      check(r.up, "React Router 7: react-router dev started");
      await browse("http://localhost:5207/", () => at(rFile, "rr-browser").length > 0 && api.store.all.some((e) => e.preview.startsWith("rr loader")));
      const loader = api.store.all.find((e) => e.preview.startsWith("rr loader"));
      check(at(rFile, "rr-browser")[0]?.preview === "rr browser { name: 'Madrid' }", "React Router 7: a component's browser log on its line", api.store.all.map((e) => `${path.basename(e.file)}:${e.line}`));
      check(!!loader && path.resolve(loader.file).toLowerCase() === rFile.toLowerCase() && loader.line === line(rFile, "rr-server"), "React Router 7: a loader's server log on its line (Vite 7 runs it from code with an inline map)", loader);
      check(await r.stop(), "React Router 7: the dev server is stopped");

      const nDir = path.join(fixtures, "nuxt-app");
      const nApp = path.join(nDir, "app.vue");
      const nApi = path.join(nDir, "server", "api", "hello.js");
      const n = await devServer("nuxt", nDir, "npm run dev", "http://localhost:5208/", "*inline-logs\\test-fixtures\\nuxt-app*");
      check(n.up, "Nuxt: nuxt dev started");
      await status("http://localhost:5208/api/hello");
      await browse("http://localhost:5208/", () => at(nApp, "nuxt-server").length > 0 && at(nApp, "nuxt-browser").length > 0 && at(nApi, "nuxt-api").length > 0);
      check(at(nApp, "nuxt-server").length > 0 && at(nApp, "nuxt-browser")[0]?.source === "browser" && at(nApi, "nuxt-api")[0]?.preview === "nuxt api { hello: 'nitro' }", "Nuxt: server render, browser and a server API route on their lines", api.store.all.map((e) => `${path.basename(e.file)}:${e.line} ${e.source}`));
      check(await n.stop(), "Nuxt: the dev server is stopped");

      const aDir = path.join(fixtures, "astro-app");
      const aFile = path.join(aDir, "src", "pages", "index.astro");
      const as = await devServer("astro", aDir, "npm run dev", "http://localhost:5209/", "*inline-logs\\test-fixtures\\astro-app*");
      check(as.up, "Astro: astro dev started");
      await browse("http://localhost:5209/", () => at(aFile, "astro-server").length > 0 && at(aFile, "astro-browser").length > 0 && at(aFile, "astro-twin-2").length > 0);
      check(at(aFile, "astro-server")[0]?.preview === "astro frontmatter { name: 'Mars', moons: 2 }" && at(aFile, "astro-browser")[0]?.preview === "astro script { where: 'browser', ok: true }", "Astro: the frontmatter's log and a <script>'s browser log on their lines in the .astro file", api.store.all.map((e) => `${path.basename(e.file)}:${e.line} ${e.source}`));
      check(at(aFile, "astro-twin-1")[0]?.preview === "astro twin 1" && at(aFile, "astro-twin-2")[0]?.preview === "astro twin 2", "Astro: two identical lines in one <script> each land on their own line", api.store.all.map((e) => `${path.basename(e.file)}:${e.line} ${e.preview}`));
      check(await as.stop(), "Astro: the dev server is stopped");
    }
  } finally {
    for (const t of terminals) t.dispose();
    await conf().update("problems", undefined, vscode.ConfigurationTarget.Global);
  }
}
