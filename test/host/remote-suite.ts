// Runs in a remote window: VS Code opened on a folder in WSL, so the
// extension runs on the remote side next to the apps. VS Code hands that
// side the remote files as file: URIs of the remote machine (the window shows
// them as vscode-remote: ones). Started by test/host/run-remote.ts with
// vscode-remote:// paths for the folder, the extension and this file. Checks
// that values, hovers, errors in the Problems panel, opening a line and the
// Log Map work there, and writes what it found to remote-result.json in the folder.
import * as vscode from "vscode";
import * as path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Api } from "../../src/extension";
import { expectedLines } from "../expect";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(f: () => boolean, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await wait(100);
  return f();
}

export async function run(): Promise<void> {
  const results: { ok: boolean; what: string; detail?: unknown }[] = [];
  const check = (ok: boolean, what: string, detail?: unknown) => {
    results.push({ ok, what, detail: ok ? undefined : detail });
    console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : `  [${JSON.stringify(detail)}]`}`);
  };
  const folder = vscode.workspace.workspaceFolders![0].uri;
  const out = path.join(folder.fsPath, "remote-result.json");
  try {
    const ext = vscode.extensions.getExtension("lagudafuadtosin.inline-logs")!;
    const api = (await ext.activate()) as Api;
    check(vscode.env.remoteName === "wsl" && folder.scheme === "file" && ext.extensionKind === vscode.ExtensionKind.Workspace && process.platform === "linux", "the extension runs on the remote side (WSL), next to the apps", { remote: vscode.env.remoteName, scheme: folder.scheme, kind: ext.extensionKind, platform: process.platform });

    const file = path.join(folder.fsPath, "index.js");
    const L = expectedLines(file);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, "index.js"));
    await vscode.window.showTextDocument(doc);
    const t = vscode.window.createTerminal({ name: "remote", cwd: folder });
    t.sendText(`node index.js > out.txt 2>&1; node crash.js > crash.txt 2>&1; echo "$NODE_OPTIONS" > options.txt`);
    const applied = () => api.applied.get(doc.uri.toString()) ?? [];
    const at = (n: string) => applied().find((a) => a.line === L.get(n));
    await waitFor(() => !!at("user") && !!at("later"));
    check(at("user")?.text === "user { name: 'Ada', born: 1815, tags: [ 'math', 'code' ] }" && at("later")?.text === "later { done: true }", "a value shows at the end of its line in a WSL file", applied());
    check(!!at("user")?.hover.includes("console.log") && at("warn")?.level === "warn", "the hover and the colours work there too", at("user"));
    const options = path.join(folder.fsPath, "options.txt");
    await waitFor(() => existsSync(options));
    check(/--require "\/home\/[^"]+\/hook\.cjs"/.test(readFileSync(options, "utf8")), "the remote terminal got the hook from the remote side's storage", readFileSync(options, "utf8"));

    const crash = vscode.Uri.joinPath(folder, "crash.js");
    const problems = () => vscode.languages.getDiagnostics(crash).filter((d) => d.source === "Inline Logs");
    await waitFor(() => problems().length > 0);
    check(problems()[0]?.range.start.line === expectedLines(path.join(folder.fsPath, "crash.js")).get("throw")! - 1, "an uncaught error is in the Problems panel on the WSL file", problems().map((d) => d.message));

    const entry = api.store.all.find((e) => e.line === L.get("printf"))!;
    await api.open(entry);
    const ed = vscode.window.activeTextEditor;
    check(ed?.document.uri.toString() === doc.uri.toString() && ed.selection.active.line === L.get("printf")! - 1, "opening an entry opens the remote file at its line", ed?.document.uri.toString());

    const files = (await api.logMap.getChildren()) as { type: string; file?: string }[];
    const item = files.find((n) => n.type === "file" && n.file === file);
    const ti = item ? api.logMap.getTreeItem(item as never) : undefined;
    check(!!ti && ti.resourceUri?.fsPath === file, "the Log Map links the remote file", ti?.resourceUri?.toString());
    const setup = JSON.parse(api.mcp.setup("json")) as { mcpServers: Record<string, { command: string; args: string[] }> };
    check(setup.mcpServers["inline-logs"].command === "node" && setup.mcpServers["inline-logs"].args[0].startsWith("/home/"), "the MCP setup on the remote side runs the bridge with node there, not with the server's own Node that moves with each update", setup);
    t.dispose();
  } catch (err) {
    check(false, "the remote checks ran to the end", String((err as Error)?.stack ?? err));
  }
  writeFileSync(out, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  if (failed) throw new Error(`${failed} remote checks failed`);
}
