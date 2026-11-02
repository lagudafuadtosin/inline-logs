// Runs in a second VS Code window opened on a workspace with two folders
// (test-fixtures/multi-root.code-workspace: the monorepo's two packages as
// folders of their own). Both run at once in their own integrated terminals;
// each value lands on its own folder's file, and paths say which folder.
import * as vscode from "vscode";
import * as path from "node:path";
import type { Api } from "../../src/extension";
import { expectedLines } from "../expect";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function run(): Promise<void> {
  let failed = 0;
  let passed = 0;
  const check = (ok: boolean, what: string, detail?: unknown) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : `  [${typeof detail === "string" ? detail : JSON.stringify(detail)}]`}`);
    if (ok) passed++;
    else failed++;
  };
  const root = process.env.IL_TEST_ROOT!;
  const ext = vscode.extensions.all.find((e) => path.resolve(e.extensionPath).toLowerCase() === path.resolve(root).toLowerCase());
  const api = (await ext!.activate()) as Api;
  const terminals: vscode.Terminal[] = [];
  try {
    const folders = vscode.workspace.workspaceFolders ?? [];
    check(folders.map((f) => f.name).join() === "api,web", "multi-root: the window has two folders", folders.map((f) => f.name));
    const files = folders.map((f) => path.join(f.uri.fsPath, "src", "index.js"));
    const docs: vscode.TextDocument[] = [];
    for (const [i, f] of files.entries()) {
      const doc = await vscode.workspace.openTextDocument(f);
      await vscode.window.showTextDocument(doc, { viewColumn: i === 0 ? vscode.ViewColumn.One : vscode.ViewColumn.Two, preview: false });
      docs.push(doc);
    }
    // Both at once, each in a terminal opened in its own folder.
    for (const f of folders) {
      const t = vscode.window.createTerminal({ name: f.name, cwd: f.uri.fsPath, ...(process.platform === "win32" ? { shellPath: "cmd.exe", shellArgs: ["/d"] } : { shellPath: "/bin/sh" }) });
      terminals.push(t);
      t.sendText("npm start");
    }
    const applied = (i: number) => api.applied.get(docs[i].uri.toString()) ?? [];
    const lineOf = (i: number) => expectedLines(files[i]).get(i === 0 ? "api-tick" : "web-tick")!;
    const end = Date.now() + 30_000;
    while (Date.now() < end && !(applied(0).find((a) => a.line === lineOf(0))?.count === 6 && applied(1).find((a) => a.line === lineOf(1))?.count === 6)) await wait(100);
    const a = applied(0).find((x) => x.line === lineOf(0));
    const w = applied(1).find((x) => x.line === lineOf(1));
    check(a?.text.startsWith("api tick { n: 6, pkg: 'api' }") === true && w?.text.startsWith("web tick { n: 6, pkg: 'web' }") === true, "multi-root: two folders' apps at once, each value on its own folder's src/index.js", { a, w });
    const pids = new Set(api.store.all.map((e) => e.pid));
    const times = (k: string) => api.store.all.filter((e) => e.preview.startsWith(k)).map((e) => e.time);
    check(pids.size === 2 && Math.min(...times("api")) < Math.max(...times("web")) && Math.min(...times("web")) < Math.max(...times("api")), "multi-root: the two ran side by side", [...pids]);
    const mapFiles = api.logMap.getChildren().map((n) => String(api.logMap.getTreeItem(n).description));
    check(mapFiles.some((d) => d.startsWith("api")) && mapFiles.some((d) => d.startsWith("web")), "multi-root: the Log Map says which folder each file is in", mapFiles);
    check(vscode.workspace.asRelativePath(files[0]) === "api/src/index.js", "multi-root: paths in the viewer and Search start with the folder's name", vscode.workspace.asRelativePath(files[0]));
  } catch (err) {
    console.error(err);
    failed++;
  } finally {
    for (const t of terminals) t.dispose();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) throw new Error(`${failed} host checks failed`);
}
