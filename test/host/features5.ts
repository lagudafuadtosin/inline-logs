// Host checks for the 0.5.0 work, run inside the real VS Code after the
// others (see suite.ts): calls side by side on one line, a page reload
// replacing its problems, the value graph drawn in parts, the MCP bridge
// started with VS Code's own program, keys that clash with nothing on
// Windows, Linux or Mac, bun test, and Deno coverage in the gutter.
import * as vscode from "vscode";
import * as path from "node:path";
import * as http from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

export async function runFeatures5(api: Api, check: (ok: boolean, what: string, detail?: unknown) => void): Promise<void> {
  const root = process.env.IL_TEST_ROOT!;
  const tmp = process.env.IL_TEST_TMP!;
  const fixtures = path.join(root, "test-fixtures");
  const shell: vscode.TerminalOptions = win ? { shellPath: "cmd.exe", shellArgs: ["/d", "/v:on"] } : { shellPath: "/bin/sh" };
  const terminals: vscode.Terminal[] = [];
  const conf = () => vscode.workspace.getConfiguration("inlineLogs");
  let runs = 0;

  const inTerminal = async (name: string, dir: string, cmd: string, env?: Record<string, string>) => {
    const id = `h-${name}-${runs++}`;
    const out = path.join(tmp, `${id}.out`);
    const err = path.join(tmp, `${id}.err`);
    const done = path.join(tmp, `${id}.done`);
    const t = vscode.window.createTerminal({ name, cwd: dir, env, ...shell });
    terminals.push(t);
    t.sendText(win ? `${cmd} > "${out}" 2> "${err}" & echo code=!errorlevel!> "${done}"` : `${cmd} > "${out}" 2> "${err}"; echo code=$? > "${done}"`);
    const code = () => /code=(\d+)/.exec(existsSync(done) ? readFileSync(done, "utf8") : "")?.[1];
    const finished = await waitFor(`${name} to finish`, () => code() !== undefined, 90_000);
    await wait(150);
    return { finished, stdout: finished ? readFileSync(out, "utf8") : "", stderr: finished ? readFileSync(err, "utf8") : "", status: finished ? Number(code()) : -1 };
  };
  const show = async (file: string) => {
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc, { preview: false });
    return doc;
  };
  const appliedFor = (doc: vscode.TextDocument) => api.applied.get(doc.uri.toString()) ?? [];
  const on = (doc: vscode.TextDocument, n: number) => appliedFor(doc).find((a) => a.line === n);
  const line = (file: string, name: string) => expectedLines(file).get(name)!;
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
  /** Loads a page once in headless Chrome. */
  const load = async (url: string, done: () => boolean) => {
    if (!browserExe) return false;
    const child = spawn(browserExe, ["--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${path.join(tmp, `h-profile-${profiles++}`)}`, "--virtual-time-budget=6000", "--dump-dom", url], { stdio: "ignore" });
    const ok = await waitFor(`entries from ${url}`, done, 20_000);
    child.kill();
    return ok;
  };
  const stopNode = (pattern: string) => {
    if (win) spawnSync("powershell.exe", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '${pattern}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`]);
  };
  const which = (name: string, also: string[]) => {
    const r = spawnSync(win ? "where" : "which", [name], { encoding: "utf8" });
    const found = r.status === 0 ? r.stdout.split(/\r?\n/).find((l) => l && (!win || /\.(exe|cmd)$/i.test(l))) : undefined;
    return found ?? also.find((p) => existsSync(p));
  };

  try {
    // ---- calls side by side on one line ----
    {
      await vscode.commands.executeCommand("inlineLogs.clear");
      const dir = path.join(fixtures, "requests-app");
      const file = path.join(dir, "index.js");
      const doc = await show(file);
      await inTerminal("sites", dir, "node index.js");
      await waitFor("http.get line", () => (on(doc, line(file, "http-get"))?.text ?? "").includes("┊"), 10_000);
      const a = on(doc, line(file, "http-get"));
      check(!!a && /^GET 200 · \d+ ms · http:\/\/127\.0\.0\.1:\S* {2}┊ {2}http\.get \{"name"/.test(a.text) && a.hover.includes("**Calls on this line**"), "a line with a request and the log in its callback shows both, left to right", a);
      const single = on(doc, line(file, "fetch-get"));
      check(!!single && !single.text.includes("┊"), "a line with one call shows one value", single?.text);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    }

    // ---- a page reload replaces that page's problems ----
    {
      await vscode.commands.executeCommand("inlineLogs.clear");
      const dir = path.join(fixtures, "vite-app");
      const file = path.join(dir, "src", "oops.js");
      const t = vscode.window.createTerminal({ name: "vite-oops", cwd: dir, ...shell });
      terminals.push(t);
      t.sendText(`node "${path.join(root, "node_modules", "vite", "bin", "vite.js")}" --port 5219 --strictPort`);
      const up = await waitFor("vite to start", async () => (await status("http://localhost:5219/oops.html")) === 200, 120_000);
      check(up, "reload: Vite started");
      const problemsOf = () => vscode.languages.getDiagnostics(vscode.Uri.file(file)).filter((d) => d.source === "Inline Logs");
      const first = await load("http://localhost:5219/oops.html?boom", () => problemsOf().length === 1);
      check(first && problemsOf()[0]?.range.start.line === line(file, "oops-throw") - 1 && problemsOf()[0].message.includes("page boom"), "a page's uncaught error is in the Problems panel", problemsOf().map((d) => d.message));
      const logs = () => api.store.all.filter((e) => e.line === line(file, "oops-log") && path.resolve(e.file).toLowerCase() === file.toLowerCase()).length;
      const second = await load("http://localhost:5219/oops.html", () => logs() >= 2 && problemsOf().length === 0);
      check(second && problemsOf().length === 0, "a reload of the page that no longer throws takes its error out of the Problems panel", problemsOf().map((d) => d.message));
      const err = api.store.all.find((e) => e.kind === "error" && path.resolve(e.file).toLowerCase() === file.toLowerCase());
      check(!!err && api.store.all.every((e) => !e.pageLoad), "the error stays in the log, and the notice of each load is never an entry", err?.preview);
      t.dispose();
      await wait(1_500);
      stopNode("*vite*--port 5219*");
      check(await waitFor("vite to stop", async () => (await status("http://localhost:5219/oops.html")) === 0, 15_000), "reload: Vite is stopped");
    }

    // ---- the value graph, drawn in parts ----
    {
      await vscode.commands.executeCommand("inlineLogs.clear");
      const dir = path.join(fixtures, "node-cjs");
      const file = path.join(dir, "graph.js");
      await show(file);
      await inTerminal("graph", dir, "node graph.js");
      await waitFor("big value", () => api.store.all.some((e) => e.line === line(file, "big-graph") && !!e.json), 10_000);
      const e = api.store.all.find((x) => x.line === line(file, "big-graph") && !!x.json)!;
      await vscode.commands.executeCommand("inlineLogs.showGraph", e.id);
      await waitFor("graph drawn", () => (api.graph.rendered?.nodes ?? 0) > 0, 10_000);
      const before = api.graph.rendered?.nodes;
      // n0 is the arguments, n1 the object, n2 its list of 70 items: 60 drawn, 10 waiting.
      api.graphPost({ type: "grow", id: "n2" });
      await waitFor("next rows", () => (api.graph.rendered?.nodes ?? 0) > (before ?? 0), 5_000);
      check(before === 63 && api.graph.rendered?.nodes === 73, "graph: a list past 60 rows draws its next rows when its more row is clicked", { before, after: api.graph.rendered });
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    }

    // ---- the MCP bridge on VS Code's own program ----
    {
      await conf().update("mcp", true, vscode.ConfigurationTarget.Global);
      await wait(300);
      const setup = JSON.parse(api.mcp.setup("json")) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
      const s = setup.mcpServers["inline-logs"];
      const claude = api.mcp.setup("claude");
      const launcher = process.platform === "win32" ? s.args[1] : s.command;
      const launcherOk = (process.platform !== "win32" || (s.command === "cmd" && s.args[0] === "/c")) && existsSync(launcher) && readFileSync(launcher, "utf8").includes(process.execPath);
      check(launcherOk && !/[\\/]node(\.exe)?$/i.test(s.command) && Object.keys(s.env).length === 0 && !claude.includes(" -e ") && !claude.includes(" -- "), "MCP setup: a launcher runs the bridge on VS Code's own program, with no Node, no env flag and no -- (PowerShell drops --)", { s, claude });
      const client = path.join(fixtures, "mcp-client", "client.mjs");
      const out = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(`node "${client}" stdio - graph`, { cwd: path.dirname(client), env: { ...cleanEnv(), IL_BRIDGE: JSON.stringify(s) }, shell: true, windowsHide: true });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => (stdout += d));
        child.stderr.on("data", (d: Buffer) => (stderr += d));
        const timer = setTimeout(() => child.kill(), 30_000);
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ status: code, stdout, stderr });
        });
      });
      let got: { tools?: string[]; logs?: { count: number } } = {};
      try {
        got = JSON.parse(out.stdout) as typeof got;
      } catch {
        // shown below
      }
      check(got.tools?.length === 6 && (got.logs?.count ?? 0) > 0, "MCP: the official SDK client reads the logs through the bridge started as the setup says", { status: out.status, out: out.stdout.slice(0, 300), err: out.stderr.slice(0, 300) });
      await conf().update("mcp", undefined, vscode.ConfigurationTarget.Global);
    }

    // ---- the keys clash with nothing on any platform ----
    {
      const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { contributes: { keybindings: { key: string; mac: string }[] } };
      const keys = pkg.contributes.keybindings;
      // VS Code's own keybindings, as its code holds them: Ctrl/Cmd+K is 2089, and the second key of each chord a number (KeyMod | KeyCode).
      const code: Record<string, number> = { l: 42, c: 33, u: 51, d: 34 };
      const second = (k: string) => {
        const m = /^(?:ctrl|cmd)\+k (shift\+)?([a-z])$/.exec(k);
        return m ? (m[1] ? 1024 : 0) + code[m[2]] : -1;
      };
      const workbench = readFileSync(path.join(vscode.env.appRoot, "out", "vs", "workbench", "workbench.desktop.main.js"), "utf8");
      const used = new Set([...workbench.matchAll(/[\w$]{1,3}\(2089,(\d+)\)/g)].map((m) => Number(m[1])));
      const extDir = path.join(vscode.env.appRoot, "extensions");
      const extKeys = readdirSync(extDir).flatMap((d) => {
        const f = path.join(extDir, d, "package.json");
        return existsSync(f) ? [...readFileSync(f, "utf8").matchAll(/"(?:key|mac|linux|win)"\s*:\s*"((?:ctrl|cmd)\+k [^"]+)"/g)].map((m) => m[1].replace(/^cmd/, "ctrl")) : [];
      });
      const clash = keys.filter((k) => used.has(second(k.key)) || used.has(second(k.mac)) || extKeys.includes(k.key) || extKeys.includes(k.mac.replace(/^cmd/, "ctrl")));
      check(keys.length === 4 && keys.every((k) => second(k.key) > 0 && second(k.mac) > 0 && !/alt/.test(k.key + k.mac)) && used.size > 30 && clash.length === 0, `keys: ${keys.map((k) => `${k.key} (${k.mac})`).join(", ")} are chords none of VS Code's own commands or built-in extensions use, on Windows, Linux or Mac, with no Alt (so no AltGr)`, { clash, used: used.size });
    }

    // ---- bun test in a terminal ----
    const bun = which("bun", []);
    if (bun) {
      await vscode.commands.executeCommand("inlineLogs.clear");
      const dir = path.join(fixtures, "bun-app");
      const file = path.join(dir, "math.test.js");
      const doc = await show(file);
      const r = await inTerminal("bun-test", dir, "bun test ./math.test.js");
      await waitFor("bun test value", () => !!on(doc, line(file, "bun-test-log")), 10_000);
      check(r.status === 0 && on(doc, line(file, "bun-test-log"))?.text === "bun test result { result: 5 }", "bun test: a log inside a test shows on its line", appliedFor(doc));
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    } else {
      console.log("     (bun is not installed: bun test skipped)");
    }

    // ---- Deno coverage in the gutter ----
    const deno = which("deno", [path.join(root, ".vscode-test", "deno", win ? "deno.exe" : "deno")]);
    if (deno) {
      await vscode.commands.executeCommand("inlineLogs.clearCoverage");
      await conf().update("coverage", true, vscode.ConfigurationTarget.Global);
      await wait(500);
      const dir = path.join(fixtures, "deno-app");
      const file = path.join(dir, "main.js");
      const doc = await show(file);
      const r = await inTerminal("deno-coverage", dir, `"${deno}" run main.js`, { DENO_DIR: path.join(root, ".vscode-test", "deno", "cache"), DENO_NO_UPDATE_CHECK: "1" });
      await waitFor("deno coverage", () => (api.coverage.applied.get(doc.uri.toString())?.hit.length ?? 0) > 0, 10_000);
      const c = api.coverage.applied.get(doc.uri.toString());
      check(r.finished && !!c && c.hit.includes(line(file, "deno-log")), "Deno coverage: a script run with deno shows the lines that ran", c);
      await conf().update("coverage", undefined, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    } else {
      console.log("     (deno is not installed: Deno coverage skipped)");
    }
  } finally {
    for (const t of terminals) t.dispose();
    await conf().update("mcp", undefined, vscode.ConfigurationTarget.Global);
    await conf().update("coverage", undefined, vscode.ConfigurationTarget.Global);
  }
}
