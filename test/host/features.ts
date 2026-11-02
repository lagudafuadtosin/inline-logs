// Host checks for the 0.3.0 features, run inside the real VS Code after the
// others (see suite.ts): the request log (Node and the browser), the MCP
// server, the diff editor, Search and the Log Map, code coverage, and the
// value graph. Apps run in real integrated terminals, like a user's.
import * as vscode from "vscode";
import * as path from "node:path";
import * as http from "node:http";
import { existsSync, readFileSync } from "node:fs";
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

function mcpPost(port: number, token: string, body: unknown): Promise<{ status: number; json: { result?: { structuredContent?: Record<string, unknown> } } | undefined }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: b ? JSON.parse(b) : undefined }));
    });
    req.on("error", reject);
    req.end(text);
  });
}

export async function runFeatures(api: Api, check: (ok: boolean, what: string, detail?: unknown) => void): Promise<void> {
  const root = process.env.IL_TEST_ROOT!;
  const tmp = process.env.IL_TEST_TMP!;
  const fixtures = path.join(root, "test-fixtures");
  const shell: vscode.TerminalOptions = win ? { shellPath: "cmd.exe", shellArgs: ["/d", "/v:on"] } : { shellPath: "/bin/sh" };
  const terminals: vscode.Terminal[] = [];
  const conf = () => vscode.workspace.getConfiguration("inlineLogs");
  let runs = 0;

  const inTerminal = async (name: string, dir: string, cmd: string) => {
    const id = `f-${name}-${runs++}`;
    const out = path.join(tmp, `${id}.out`);
    const err = path.join(tmp, `${id}.err`);
    const done = path.join(tmp, `${id}.done`);
    const t = vscode.window.createTerminal({ name, cwd: dir, ...shell });
    terminals.push(t);
    t.sendText(win ? `${cmd} > "${out}" 2> "${err}" & echo code=!errorlevel!> "${done}"` : `${cmd} > "${out}" 2> "${err}"; echo code=$? > "${done}"`);
    const code = () => /code=(\d+)/.exec(existsSync(done) ? readFileSync(done, "utf8") : "")?.[1];
    const finished = await waitFor(`${name} to finish`, () => code() !== undefined, 60_000);
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
  const requestsAt = (file: string, n: number) => api.store.all.filter((e) => e.kind === "request" && e.line === n && path.resolve(e.file).toLowerCase() === file.toLowerCase());

  try {
    // ---- 1. request log, Node ----
    const rDir = path.join(fixtures, "requests-app");
    const rFile = path.join(rDir, "index.js");
    await vscode.commands.executeCommand("inlineLogs.clear");
    const rDoc = await show(rFile);
    const r = await inTerminal("requests", rDir, "node index.js");
    const plain = spawnSync("node index.js", { cwd: rDir, env: cleanEnv(), encoding: "utf8", shell: true, timeout: 60_000, windowsHide: true });
    check(r.finished && r.stdout === plain.stdout && r.status === plain.status, "requests: the app's output and exit code are unchanged", { hooked: r.stdout, plain: plain.stdout });
    const names = ["fetch-get", "fetch-post", "fetch-404", "fetch-fail", "http-get", "http-post"];
    await waitFor("request decorations", () => names.every((n) => on(rDoc, line(rFile, n))), 15_000);
    const get = on(rDoc, line(rFile, "fetch-get"));
    check(!!get && /^GET 200 · \d+ ms · http:\/\/127\.0\.0\.1:\d+\/user$/.test(get.text) && get.kind === "request", "requests: a fetch shows method, status, time and URL on its line", get);
    // The refused fetch and the http calls share their line with a console.log in a callback, so the store is checked for those.
    const failed = requestsAt(rFile, line(rFile, "fetch-fail"))[0];
    check(on(rDoc, line(rFile, "fetch-404"))?.level === "warn" && failed?.level === "error" && /^GET failed/.test(failed.preview), "requests: a 404 is a warning, a refused connection an error", { on404: on(rDoc, line(rFile, "fetch-404")), failed });
    const post = on(rDoc, line(rFile, "fetch-post"));
    check(!!post && post.hover.includes("authorization: [redacted]") && post.hover.includes('"password": "[redacted]"') && !post.hover.includes("secret-1") && post.hover.includes("Request body"), "requests: the hover has headers and bodies, secrets redacted", post?.hover);
    const hget = requestsAt(rFile, line(rFile, "http-get"))[0];
    const hpost = requestsAt(rFile, line(rFile, "http-post"))[0];
    check(hget?.request?.api === "http" && /^GET 200/.test(hget.preview) && /^POST 200/.test(hpost?.preview ?? "") && hpost?.request?.requestBody === '{"n":2}', "requests: node:http get and request too", { hget, hpost });

    // A second run: two values on each line, so the hover offers a diff.
    await inTerminal("requests-2", rDir, "node index.js");
    await waitFor("second run", () => requestsAt(rFile, line(rFile, "fetch-get")).length === 2, 10_000);
    const get2 = on(rDoc, line(rFile, "fetch-get"));
    check(get2?.count === 2 && get2.hover.includes("command:inlineLogs.diffPrevious") && get2.hover.includes("command:inlineLogs.showGraph"), "requests: the hover links to Compare with previous and Show as graph", get2?.hover.slice(-300));

    const logsIn = () => api.store.all.filter((e) => e.kind === "log" && path.resolve(e.file).toLowerCase() === rFile.toLowerCase()).length;
    const logsBefore = logsIn();
    await vscode.commands.executeCommand("inlineLogs.toggleRequests");
    await inTerminal("requests-paused", rDir, "node index.js");
    await waitFor("paused run logs", () => logsIn() > logsBefore, 5_000);
    await wait(500);
    check(api.requestsPaused && requestsAt(rFile, line(rFile, "fetch-get")).length === 2 && logsIn() > logsBefore, "requests: Pause Request Log stops requests, console logs still arrive", { before: logsBefore, after: logsIn() });
    await vscode.commands.executeCommand("inlineLogs.toggleRequests");
    await conf().update("requests", false, vscode.ConfigurationTarget.Global);
    await wait(300);
    const opts = await inTerminal("requests-off-env", fixtures, `node -e "console.log(process.env.INLINE_LOGS_OPTS)"`);
    await inTerminal("requests-off", rDir, "node index.js");
    await wait(800);
    check(opts.stdout.includes('"requests":false') && requestsAt(rFile, line(rFile, "fetch-get")).length === 2, "requests: with the setting off, new terminals record no requests", opts.stdout);
    await conf().update("requests", undefined, vscode.ConfigurationTarget.Global);
    await wait(300);

    // ---- 3. diff ----
    {
      const logLine = expectedLines(rFile).get("fetch-get")! + 1; // console.log("user", ...)
      const logs = api.store.all.filter((e) => e.kind === "log" && e.line === logLine && path.resolve(e.file).toLowerCase() === rFile.toLowerCase());
      await vscode.commands.executeCommand("inlineLogs.diffPrevious", rFile, logLine);
      await wait(800);
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      const input = tab?.input as vscode.TabInputTextDiff | undefined;
      const isDiff = !!input && input instanceof vscode.TabInputTextDiff && input.original.scheme === "inline-logs-value" && input.modified.scheme === "inline-logs-value";
      check(isDiff && logs.length >= 2, "diff: Compare With Previous Value opens VS Code's diff editor on two value documents", { tab: tab?.label, logs: logs.length });
      if (isDiff) {
        const left = (await vscode.workspace.openTextDocument(input.original)).getText();
        const right = (await vscode.workspace.openTextDocument(input.modified)).getText();
        check(left.startsWith('[\n  "user",\n  {\n    "name": "Ada"') && input.modified.path.endsWith(".json") && right.length > 0, "diff: values are pretty JSON documents", left.slice(0, 80));
      }
      const reqs = requestsAt(rFile, line(rFile, "fetch-get"));
      const post2 = requestsAt(rFile, line(rFile, "fetch-post"))[0];
      await vscode.commands.executeCommand("inlineLogs.compareEntries", reqs[0].id, post2.id);
      await wait(800);
      const t2 = vscode.window.tabGroups.activeTabGroup.activeTab?.input as vscode.TabInputTextDiff | undefined;
      const r2 = t2 instanceof vscode.TabInputTextDiff ? (await vscode.workspace.openTextDocument(t2.modified)).getText() : "";
      check(r2.includes('"method": "POST"') && r2.includes('"password": "[redacted]"'), "diff: Compare Two Values compares any two entries (a GET and a POST here)", r2.slice(0, 200));
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    }

    // ---- 4. search and Log Map ----
    {
      await show(rFile);
      const files = api.logMap.getChildren();
      const fileNode = files.find((n) => n.type === "file" && n.file.toLowerCase() === rFile.toLowerCase());
      const lines = fileNode ? api.logMap.getChildren(fileNode) : [];
      check(!!fileNode && lines.some((n) => n.type === "line" && n.line === line(rFile, "fetch-404")) && lines.every((n, i) => i === 0 || (n.type === "line" && lines[i - 1].type === "line" && n.line > (lines[i - 1] as { line: number }).line)), "Log Map: the file, then its lines in order", lines.map((n) => (n.type === "line" ? n.line : 0)));
      const item = lines.find((n) => n.type === "line" && n.line === line(rFile, "http-get"));
      const ti = item ? api.logMap.getTreeItem(item) : undefined;
      if (ti?.command) await vscode.commands.executeCommand(ti.command.command, ...(ti.command.arguments ?? []));
      await wait(300);
      check(vscode.window.activeTextEditor?.selection.active.line === line(rFile, "http-get") - 1 && String(ti?.description).length > 0, "Log Map: clicking a line opens it", { at: vscode.window.activeTextEditor?.selection.active.line, desc: ti?.description });
      api.logMap.setQuery("kind:request status:404");
      const filtered = api.logMap.getChildren().flatMap((f) => api.logMap.getChildren(f));
      check(filtered.length === 1 && filtered[0].type === "line" && filtered[0].line === line(rFile, "fetch-404"), "Log Map: the filter narrows it to matching entries", filtered.map((n) => (n.type === "line" ? n.line : n.file)));
      api.logMap.setQuery("");
      // Search: a real quick pick, the first match accepted as a user would with Enter.
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      void vscode.commands.executeCommand("inlineLogs.search", "kind:request status:404");
      await wait(800);
      await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
      await waitFor("search result opened", () => vscode.window.activeTextEditor?.selection.active.line === line(rFile, "fetch-404") - 1, 5_000);
      check(vscode.window.activeTextEditor?.document.fileName.toLowerCase() === rFile.toLowerCase() && vscode.window.activeTextEditor.selection.active.line === line(rFile, "fetch-404") - 1, "Search: the quick pick finds a request by status and opens its line", vscode.window.activeTextEditor?.selection.active.line);
    }

    // ---- 6. value graph ----
    {
      const req = requestsAt(rFile, line(rFile, "fetch-get"))[0];
      await vscode.commands.executeCommand("inlineLogs.showGraph", req.id);
      await waitFor("graph drawn", () => (api.graph.rendered?.nodes ?? 0) > 0, 10_000);
      const g = api.graph.rendered;
      check(!!g && g.nodes >= 5 && g.edges === g.nodes - 1 && api.graph.entryId === req.id, "graph: a request opens as boxes and edges (request, headers, body)", g);
      const html = api.graph.html ?? "";
      const nonce = /script-src 'nonce-([^']+)'/.exec(html)?.[1];
      check(!!nonce && html.includes("default-src 'none'") && html.includes(`<script nonce="${nonce}">`) && !/<script[^>]+src=/i.test(html) && !/https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(html), "graph: strict CSP with a nonce, no outside scripts or URLs");
      api.graphPost({ type: "toggle" });
      await waitFor("collapse", () => api.graph.rendered?.nodes === 1, 5_000);
      check(api.graph.rendered?.nodes === 1 && api.graph.rendered.collapsed === 1, "graph: collapsing the root hides every box under it", api.graph.rendered);
      api.graphPost({ type: "toggle" });
      await waitFor("expand", () => api.graph.rendered?.nodes === g?.nodes, 5_000);
      const before = api.graph.rendered?.zoom ?? 0;
      api.graphPost({ type: "zoom", factor: 2 });
      await waitFor("zoom", () => (api.graph.rendered?.zoom ?? 0) > before, 5_000);
      check((api.graph.rendered?.zoom ?? 0) > before && api.graph.rendered?.nodes === g?.nodes, "graph: zoom and expand work", { before, after: api.graph.rendered });
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    }

    // ---- 2. MCP ----
    {
      check(api.mcp.currentToken() === undefined && api.mcp.definitions().length === 0, "MCP: off by default, nothing offered to AI tools");
      await conf().update("mcp", true, vscode.ConfigurationTarget.Global);
      await wait(300);
      const token = api.mcp.currentToken();
      const defs = api.mcp.definitions() as { uri?: vscode.Uri; label?: string; headers?: Record<string, string> }[];
      check(api.mcp.registered && defs.length === 1 && defs[0].uri?.toString() === `http://127.0.0.1:${api.port}/mcp` && defs[0].headers?.Authorization === `Bearer ${token}`, "MCP: VS Code's MCP server definition provider offers the local HTTP server", { registered: api.mcp.registered, defs: defs.map((d) => d.uri?.toString()) });
      const res = await mcpPost(api.port, token!, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recent_requests", arguments: { file: "requests-app", status: "404" } } });
      const found = res.json?.result?.structuredContent as { entries?: { line: number }[] } | undefined;
      check(res.status === 200 && found?.entries?.[0]?.line === line(rFile, "fetch-404"), "MCP: recent_requests over HTTP returns the 404 from the app that just ran", res.json);
      const client = path.join(fixtures, "mcp-client", "client.mjs");
      // Not spawnSync: the server it talks to runs in this same process, which must stay free to answer.
      const sdk = await new Promise<{ status: number | null; stdout: string; stderr: string; error?: unknown }>((resolve) => {
        const child = spawn(`node "${client}" stdio "${api.mcp.bridgePath}" requests-app`, { cwd: path.dirname(client), env: cleanEnv(), shell: true, windowsHide: true });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => (stdout += d));
        child.stderr.on("data", (d: Buffer) => (stderr += d));
        const timer = setTimeout(() => child.kill(), 30_000);
        child.on("error", (error) => resolve({ status: null, stdout, stderr, error }));
        child.on("close", (status) => {
          clearTimeout(timer);
          resolve({ status, stdout, stderr });
        });
      });
      let out: { tools?: string[]; logs?: { count: number }; requests?: { count: number } } = {};
      try {
        out = JSON.parse(sdk.stdout) as typeof out;
      } catch {
        // shown below
      }
      check(out.tools?.length === 6 && (out.logs?.count ?? 0) > 0 && (out.requests?.count ?? 0) > 0, "MCP: the official SDK client reads logs and requests through the stdio bridge", { status: sdk.status, error: String(sdk.error ?? ""), out: sdk.stdout.slice(0, 500), err: sdk.stderr.slice(0, 500) });
      await conf().update("mcp", undefined, vscode.ConfigurationTarget.Global);
      await wait(300);
      const offRes = await mcpPost(api.port, token!, { jsonrpc: "2.0", id: 1, method: "ping" });
      check(offRes.status === 404 && api.mcp.definitions().length === 0, "MCP: turned off, the endpoint is gone and the old token is useless", offRes.status);
    }

    // ---- 5. coverage ----
    {
      const cDir = path.join(fixtures, "coverage-app");
      const cFile = path.join(cDir, "index.js");
      const cDoc = await show(cFile);
      await conf().update("coverage", true, vscode.ConfigurationTarget.Global);
      await wait(300);
      const env = await inTerminal("coverage-env", fixtures, `node -e "console.log(process.env.NODE_V8_COVERAGE || 'none')"`);
      check(env.stdout.trim() === api.coverage.dir, "coverage: new terminals get NODE_V8_COVERAGE pointing at this window's folder", env.stdout);
      const L = expectedLines(cFile);
      const covered = () => api.coverage.applied.get(cDoc.uri.toString());
      await inTerminal("coverage-a", cDir, "node index.js a");
      await waitFor("coverage a", () => !!covered()?.hit.includes(L.get("a-branch")!), 10_000);
      const a = covered();
      check(!!a && a.hit.includes(L.get("a-branch")!) && a.missed.includes(L.get("b-branch")!) && a.missed.includes(L.get("never")!) && a.hit.includes(L.get("top")!), "coverage: the gutter shows lines that ran and code that did not", a);
      await inTerminal("coverage-b", cDir, "node index.js b");
      await waitFor("coverage b", () => !!covered()?.hit.includes(L.get("b-branch")!), 10_000);
      const b = covered();
      check(!!b && b.hit.includes(L.get("a-branch")!) && b.hit.includes(L.get("b-branch")!) && b.missed.includes(L.get("never")!), "coverage: a second run adds up (both branches green)", b);
      await vscode.commands.executeCommand("inlineLogs.clearCoverage");
      check(covered()?.hit.length === 0 && covered()?.missed.length === 0, "coverage: Clear Coverage removes the marks");
      await conf().update("coverage", undefined, vscode.ConfigurationTarget.Global);
      await wait(300);
      const off = await inTerminal("coverage-off", fixtures, `node -e "console.log(process.env.NODE_V8_COVERAGE || 'none')"`);
      check(off.stdout.trim() === "none", "coverage: off again, new terminals have no NODE_V8_COVERAGE", off.stdout);
    }

    // ---- 1b. request log in the browser (Vite) ----
    {
      const vDir = path.join(fixtures, "vite-app");
      const vFile = path.join(vDir, "src", "requests.js");
      const vDoc = await show(vFile);
      const t = vscode.window.createTerminal({ name: "vite-requests", cwd: vDir, ...shell });
      terminals.push(t);
      t.sendText("npm run dev");
      const status = (u: string) =>
        new Promise<number>((resolve) => {
          const req = http.get(u, (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          });
          req.on("error", () => resolve(0));
        });
      const up = await waitFor("vite", async () => (await status("http://localhost:5199/requests.html")) === 200, 60_000);
      check(up, "browser requests: Vite started");
      const browser = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
      const done = () => ["web-fetch", "web-404", "web-xhr"].every((n) => !!on(vDoc, line(vFile, n)));
      let profiles = 0;
      for (let i = 0; i < 3 && browser && !done(); i++) {
        const child = spawn(browser, ["--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${path.join(tmp, `req-profile-${profiles++}`)}`, "--virtual-time-budget=5000", "--dump-dom", "http://localhost:5199/requests.html"], { stdio: "ignore" });
        await waitFor("browser requests", done, 12_000);
        child.kill();
      }
      const f = on(vDoc, line(vFile, "web-fetch"));
      const fe = api.store.all.find((e) => e.kind === "request" && e.source === "browser" && e.line === line(vFile, "web-fetch"));
      check(!!f && /^GET 200 · \d+ ms · http:\/\/localhost:5199\/data\.json$/.test(f.text), `browser requests: a page's fetch shows on its line (${browser ? path.basename(browser) : "no browser"})`, appliedFor(vDoc));
      check(fe?.request?.requestHeaders?.authorization === "[redacted]" && JSON.parse(fe.request.responseBody ?? "{}").token === "[redacted]" && JSON.parse(fe.request.responseBody ?? "{}").name === "Grace", "browser requests: headers and body, secrets redacted", fe?.request);
      check(on(vDoc, line(vFile, "web-404"))?.level === "warn", "browser requests: a 404 is a warning", on(vDoc, line(vFile, "web-404")));
      const x = api.store.all.find((e) => e.kind === "request" && e.request?.api === "xhr" && e.line === line(vFile, "web-xhr"));
      check(!!x && x.request!.status === 200 && x.request!.requestHeaders?.["x-api-key"] === "[redacted]" && (x.request!.responseBody ?? "").includes("Grace"), "browser requests: XMLHttpRequest too", x?.request);
      t.dispose();
      await wait(1_500);
      if (win) spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*vite*--port 5199*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"]);
      check(await waitFor("vite to stop", async () => (await status("http://localhost:5199/")) === 0, 10_000), "browser requests: the dev server is stopped");
    }
  } finally {
    for (const t of terminals) t.dispose();
    await conf().update("mcp", undefined, vscode.ConfigurationTarget.Global);
    await conf().update("coverage", undefined, vscode.ConfigurationTarget.Global);
    await conf().update("requests", undefined, vscode.ConfigurationTarget.Global);
  }
}
