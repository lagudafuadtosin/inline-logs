import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { DISPLAY_NAME, ENV_OPTS, ENV_PORT, ENV_SPOOL, ENV_TOKEN, EXPORT_FILE, ID, VALUE_SCHEME } from "./names";
import { startServer, type LogServer } from "./server";
import { startSpool } from "./spool";
import { Store, type LineChange, type LineInfo } from "./store";
import { ALL_METHODS, type Entry, type Level } from "./shared/types";
import { ViewerProvider } from "./viewer";
import { handleRpc } from "./mcp";
import { McpHost } from "./mcphost";
import { search, previousOf } from "./search";
import { ValueDocuments, showDiff } from "./diff";
import { LogMapProvider } from "./logmap";
import { GraphPanel, type GraphState } from "./graph/panel";
import { CoverageView } from "./coverageview";
import { exportJson, exportText, valueJson } from "./export";
import { setupLine, type Shell } from "./setup";
import type * as LogEdit from "./logedit";

/** What the editor shows on one line; kept so tests can check it. */
export interface Applied {
  line: number;
  text: string;
  kind: Entry["kind"];
  level: Level;
  count: number;
  hover: string;
  /** The colour it is drawn in. */
  style: "log" | "info" | "warn" | "error";
}

export interface Api {
  port: number;
  token: string;
  hookPath: string;
  store: Store;
  /** Decorations last applied, by document URI string. */
  applied: Map<string, Applied[]>;
  readonly paused: boolean;
  /** True while the request log is paused (Pause Request Log). */
  readonly requestsPaused: boolean;
  /** What the status bar item says now. */
  readonly statusText: string;
  refresh(): void;
  open(entry: Entry): Promise<void>;
  mcp: McpHost;
  coverage: CoverageView;
  graph: GraphState;
  /** Sends the value graph webview a message, as its buttons would. */
  graphPost(m: unknown): void;
  logMap: LogMapProvider;
  values: ValueDocuments;
  /** Runtime errors in the Problems panel. */
  problems: vscode.DiagnosticCollection;
  viewer: ViewerProvider;
}

const cfg = () => vscode.workspace.getConfiguration(ID);

export async function activate(context: vscode.ExtensionContext): Promise<Api> {
  const store = new Store(process.platform === "win32" || process.platform === "darwin");
  const applied = new Map<string, Applied[]>();
  let paused = false;
  let requestsPaused = false;
  let refreshTimer: NodeJS.Timeout | undefined;
  const find = (id: string) => store.all.find((e) => e.id === id);

  const values = new ValueDocuments(find);
  const graph = new GraphPanel();
  const logMap = new LogMapProvider(store);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(VALUE_SCHEME, values),
    vscode.window.registerTreeDataProvider(`${ID}.map`, logMap),
    { dispose: () => graph.dispose() },
  );

  const viewer = new ViewerProvider(store, (e) => open(e), {
    diffPrevious: (e) => void diffPrevious(e),
    graph: (e) => showGraph(e),
    compare: (e) => void compareWith(e),
    copy: (e) => void copyValue(e),
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(`${ID}.viewer`, viewer, { webviewOptions: { retainContextWhenHidden: true } }));

  const receive = (entries: Entry[]) => {
    if (paused || !cfg().get<boolean>("enabled", true)) return;
    // The same entry can come twice (HTTP, the exit send, the spool file).
    let fresh = entries.filter((e) => !store.has(e.id));
    // Terminals opened before the request log was turned off still send requests.
    if (requestsPaused || !cfg().get<boolean>("requests", true)) fresh = fresh.filter((e) => e.kind !== "request");
    const newRun = noteRuns(fresh);
    // A page's notice that it loaded only starts a new run of that page: it is not shown.
    fresh = fresh.filter((e) => !e.pageLoad);
    if (!fresh.length) {
      if (newRun) scheduleProblems();
      return;
    }
    const changed = store.add(fresh);
    viewer.add(fresh);
    logMap.refresh();
    if (changed.size) scheduleRefresh();
    // The Problems panel only changes with a new error, or a new run that replaces old ones.
    if (newRun || fresh.some((e) => e.kind === "error")) scheduleProblems();
    updateStatus();
  };
  const version = String((context.extension?.packageJSON as { version?: string } | undefined)?.version ?? "0");
  const mcpRef: { host?: McpHost } = {};
  const server: LogServer = await startServer(receive, {
    token: () => mcpRef.host?.currentToken(),
    handle: (m) =>
      handleRpc(m, {
        entries: () => store.all,
        version,
        relative: (f) => vscode.workspace.asRelativePath(f),
      }),
  });
  context.subscriptions.push({ dispose: () => void server.close() });
  // One folder per window, so two windows never read each other's files.
  const spoolRoot = path.join(context.globalStorageUri.fsPath, "spool");
  cleanSpool(spoolRoot);
  const spool = startSpool(path.join(spoolRoot, server.token.slice(0, 16)), receive);
  context.subscriptions.push({
    dispose: () => {
      spool.close();
      fs.rmSync(spool.dir, { recursive: true, force: true });
    },
  });

  const hookPath = installHook(context);
  const mcp = (mcpRef.host = new McpHost(context, () => server.port, version));
  context.subscriptions.push(mcp);
  mcp.setEnabled(cfg().get<boolean>("mcp", false));

  // Coverage reports from this window's terminals only, never the hook itself.
  const ownHook = (f: string) => store.key(f) === store.key(hookPath) || store.key(f).endsWith("/dist/hook.cjs");
  const coverage = new CoverageView(context.extensionPath, path.join(context.globalStorageUri.fsPath, "coverage", server.token.slice(0, 16)), (f) => store.key(f), ownHook);
  context.subscriptions.push(coverage);
  coverage.setActive(cfg().get<boolean>("coverage", false));

  // ---- decorations ----
  const after = (color: string): vscode.ThemableDecorationAttachmentRenderOptions => ({ margin: "0 0 0 2em", color: new vscode.ThemeColor(color), fontStyle: "italic" });
  const types = {
    log: vscode.window.createTextEditorDecorationType({ after: after(`${ID}.foreground`), rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed }),
    warn: vscode.window.createTextEditorDecorationType({ after: after(`${ID}.warningForeground`), rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed }),
    info: vscode.window.createTextEditorDecorationType({ after: after(`${ID}.infoForeground`), rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed }),
    error: vscode.window.createTextEditorDecorationType({
      after: after(`${ID}.errorForeground`),
      backgroundColor: new vscode.ThemeColor(`${ID}.errorBackground`),
      isWholeLine: true,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    }),
  };
  context.subscriptions.push(types.log, types.warn, types.info, types.error);

  const scheduleRefresh = () => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      refresh();
    }, 30);
  };

  const refresh = () => {
    for (const editor of vscode.window.visibleTextEditors) decorate(editor);
  };

  const decorate = (editor: vscode.TextEditor) => {
    const doc = editor.document;
    if (doc.uri.scheme !== "file") return;
    const c = cfg();
    const enabled = c.get<boolean>("enabled", true);
    const levels = new Set(c.get<Level[]>("levels", ["log", "info", "warn", "error", "debug"]));
    const max = Math.max(10, c.get<number>("maxLength", 80));
    // Command links in hovers need VS Code to limit them to our commands (1.77+); without that, no links.
    const links = !versionBelow(vscode.version, 1, 77);
    const groups: Record<Applied["style"], vscode.DecorationOptions[]> = { log: [], info: [], warn: [], error: [] };
    const list: Applied[] = [];
    if (enabled) {
      for (const info of store.lines(doc.uri.fsPath)) {
        const e = info.latest;
        if (!levels.has(e.level)) continue;
        if (info.line < 1 || info.line > doc.lineCount) continue;
        const textLine = doc.lineAt(info.line - 1);
        // Logging libraries show their info level in its own colour.
        const group = e.kind === "error" || e.level === "error" ? "error" : e.level === "warn" ? "warn" : e.logger && e.level === "info" ? "info" : "log";
        const text = label(info, max);
        const hover = hoverFor(info, links);
        groups[group].push({
          range: new vscode.Range(info.line - 1, textLine.firstNonWhitespaceCharacterIndex, info.line - 1, textLine.range.end.character),
          hoverMessage: hover,
          renderOptions: { after: { contentText: text } },
        });
        list.push({ line: info.line, text, kind: e.kind, level: e.level, count: info.count, hover: hover.value, style: group });
      }
    }
    editor.setDecorations(types.log, groups.log);
    editor.setDecorations(types.warn, groups.warn);
    editor.setDecorations(types.info, groups.info);
    editor.setDecorations(types.error, groups.error);
    applied.set(doc.uri.toString(), list.sort((a, b) => a.line - b.line));
    coverage.decorate(editor);
  };

  // ---- edits move values ----
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((ev) => {
      if (ev.document.uri.scheme !== "file" || ev.contentChanges.length === 0) return;
      const changes: LineChange[] = ev.contentChanges.map((c) => ({
        startLine: c.range.start.line,
        startChar: c.range.start.character,
        endLine: c.range.end.line,
        endChar: c.range.end.character,
        newLines: (c.text.match(/\r\n|\r|\n/g) ?? []).length,
      }));
      if (store.shift(ev.document.uri.fsPath, changes)) {
        for (const editor of vscode.window.visibleTextEditors) if (editor.document === ev.document) decorate(editor);
        logMap.refresh();
        updateProblems();
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => refresh()),
  );

  // ---- runtime errors in the Problems panel ----
  // An error shows until its line is edited, or until a new run of the same
  // program (same folder and script, a new process) sends anything. In the
  // browser, a run is one load of a page: a reload replaces it.
  const problems = vscode.languages.createDiagnosticCollection(ID);
  context.subscriptions.push(problems);
  /** A process, or for the browser one load of a page. */
  const instance = (e: Entry) => (e.load !== undefined ? `${e.pid}/${e.load}` : String(e.pid));
  const newest = new Map<string, string>();
  const seen = new Set<string>();
  /** True when a process (or page load) not seen before started a run of a program (or page). By program too, as the system reuses process ids. */
  const noteRuns = (entries: readonly Entry[]) => {
    let fresh = false;
    for (const e of entries) {
      const i = instance(e);
      if (!e.run || seen.has(`${e.run}|${i}`)) continue;
      seen.add(`${e.run}|${i}`);
      newest.set(e.run, i);
      fresh = true;
    }
    return fresh;
  };
  let problemsTimer: NodeJS.Timeout | undefined;
  const scheduleProblems = () => {
    if (problemsTimer) return;
    problemsTimer = setTimeout(() => {
      problemsTimer = undefined;
      updateProblems();
    }, 50);
  };
  const updateProblems = () => {
    problems.clear();
    if (!cfg().get<boolean>("problems", true) || !cfg().get<boolean>("enabled", true)) return;
    for (const key of store.files()) {
      const list: vscode.Diagnostic[] = [];
      let uri: vscode.Uri | undefined;
      for (const info of store.lines(key)) {
        const e = info.latest;
        if (e.kind !== "error" || (e.run && newest.get(e.run) !== instance(e))) continue;
        uri ??= vscode.Uri.file(e.file);
        const line = Math.max(0, info.line - 1);
        const d = new vscode.Diagnostic(new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER), `${e.preview.split(/\r?\n/)[0]}${e.source === "browser" ? " (browser)" : ""}`, vscode.DiagnosticSeverity.Error);
        d.source = DISPLAY_NAME;
        list.push(d);
      }
      if (uri && list.length) problems.set(uri, list);
    }
  };

  // ---- status bar ----
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.name = DISPLAY_NAME;
  status.command = `${ID}.togglePause`;
  context.subscriptions.push(status);
  const updateStatus = () => {
    const on = cfg().get<boolean>("enabled", true);
    const n = store.size;
    if (!on) {
      status.text = "$(circle-slash) Logs off";
      status.tooltip = `${DISPLAY_NAME} is off. Turn it on with the ${ID}.enabled setting or the Turn On command.`;
      status.command = `${ID}.toggleEnabled`;
    } else if (paused) {
      status.text = `$(debug-pause) Paused ${n}`;
      status.tooltip = `${DISPLAY_NAME}: paused, ${n} entries. Click to resume.`;
      status.command = `${ID}.togglePause`;
    } else {
      status.text = `$(debug-console) ${n}`;
      status.tooltip = `${DISPLAY_NAME}: on, ${n} entries. Click to pause.`;
      status.command = `${ID}.togglePause`;
    }
    status.show();
    void vscode.commands.executeCommand("setContext", `${ID}.paused`, paused);
  };

  // ---- terminals ----
  /** The hook's options, as JSON, for this window's terminals and outside ones. */
  const hookOptions = () => {
    const c = cfg();
    return JSON.stringify({
      sourceMaps: c.get<boolean>("sourceMaps", true),
      includeNodeModules: c.get<boolean>("includeNodeModules", false),
      browser: c.get<boolean>("browser", true),
      requests: c.get<boolean>("requests", true),
      requestBodies: c.get<boolean>("requestBodies", true),
      coverage: c.get<boolean>("coverage", false),
    });
  };
  const applyEnv = () => {
    const env = context.environmentVariableCollection;
    env.clear();
    // Port and token are new every time VS Code starts, so do not restore them into old terminals.
    env.persistent = false;
    try {
      (env as unknown as { description?: string }).description = `${DISPLAY_NAME}: shows console output from Node, Bun and Deno apps next to your code.`;
    } catch {
      // older VS Code
    }
    if (!cfg().get<boolean>("enabled", true)) return;
    const c = cfg();
    env.append("NODE_OPTIONS", ` --require "${hookPath.replace(/\\/g, "/")}"`);
    // Bun reads BUN_OPTIONS, not NODE_OPTIONS. Only the "--preload=<file>"
    // form works there for every bun command (install, x, test, run), and
    // only quoting the whole argument keeps a path with spaces whole.
    env.append("BUN_OPTIONS", ` "--preload=${hookPath.replace(/\\/g, "/")}"`);
    env.replace(ENV_PORT, String(server.port));
    env.replace(ENV_TOKEN, server.token);
    env.replace(ENV_SPOOL, spool.dir);
    const withCoverage = c.get<boolean>("coverage", false);
    env.replace(ENV_OPTS, hookOptions());
    // Node's own coverage: every node process in the terminal writes what it ran here when it ends. Deno's too.
    if (withCoverage) {
      env.replace("NODE_V8_COVERAGE", coverage.dir);
      env.replace("DENO_COVERAGE_DIR", coverage.dir);
    }
  };
  applyEnv();

  // ---- commands ----
  const setPaused = (p: boolean) => {
    paused = p;
    updateStatus();
  };
  const open = async (e: Entry) => {
    const line = store.lines(e.file).find((i: LineInfo) => i.latest.line === e.line)?.line ?? e.line;
    const pos = new vscode.Position(Math.max(0, line - 1), Math.max(0, e.col - 1));
    await vscode.window.showTextDocument(vscode.Uri.file(e.file), { selection: new vscode.Range(pos, pos), preview: true });
  };
  const openLine = async (file: string, line: number) => {
    const pos = new vscode.Position(Math.max(0, line - 1), 0);
    await vscode.window.showTextDocument(vscode.Uri.file(file), { selection: new vscode.Range(pos, pos), preview: true });
  };
  // In a window with several folders the path starts with the folder's name.
  const where = (e: Entry) => `${vscode.workspace.asRelativePath(e.file)}:${e.line}`;

  /** The latest entry on a line as it is shown now (args from a hover link), or on the cursor's line. */
  const entryAt = (file?: unknown, line?: unknown): Entry | undefined => {
    let f = typeof file === "string" ? file : undefined;
    let l = typeof line === "number" ? line : undefined;
    const editor = vscode.window.activeTextEditor;
    if (!f && editor?.document.uri.scheme === "file") {
      f = editor.document.uri.fsPath;
      l = editor.selection.active.line + 1;
    }
    if (!f || !l) return undefined;
    return store.lines(f).find((i) => i.line === l)?.latest;
  };
  const byId = (arg: unknown) => (typeof arg === "string" ? find(arg) : undefined);

  const diffPrevious = async (e: Entry | undefined) => {
    if (!e) {
      void vscode.window.showInformationMessage(`${DISPLAY_NAME}: put the cursor on a line with a value first.`);
      return;
    }
    const prev = previousOf(store.all, e, (f) => store.key(f));
    if (!prev) {
      void vscode.window.showInformationMessage(`${DISPLAY_NAME}: ${where(e)} has only one value so far.`);
      return;
    }
    await showDiff(values, prev, e);
  };

  const pickEntry = async (title: string, except?: Entry) => {
    const items = [...store.all]
      .reverse()
      .filter((e) => e !== except)
      .slice(0, 1000)
      .map((e) => ({ label: e.preview.replace(/\r?\n/g, " ").slice(0, 200), description: where(e), detail: new Date(e.time).toLocaleTimeString(), entry: e }));
    return (await vscode.window.showQuickPick(items, { title, matchOnDescription: true }))?.entry;
  };
  let compareFirst: Entry | undefined;
  /** From the viewer: the first entry picked waits for the second. */
  const compareWith = async (e: Entry) => {
    if (!compareFirst || compareFirst === e) {
      compareFirst = e;
      vscode.window.setStatusBarMessage(`${DISPLAY_NAME}: ${where(e)} picked. Pick a second value to compare.`, 8_000);
      return;
    }
    const first = compareFirst;
    compareFirst = undefined;
    await showDiff(values, first, e);
  };

  const copyValue = async (e: Entry | undefined) => {
    if (!e) {
      void vscode.window.showInformationMessage(`${DISPLAY_NAME}: put the cursor on a line with a value first.`);
      return;
    }
    await vscode.env.clipboard.writeText(valueJson(e));
    vscode.window.setStatusBarMessage(`${DISPLAY_NAME}: copied the value from ${where(e)} as JSON`, 4_000);
  };

  const exportEntries = async (target?: unknown) => {
    let uri = target instanceof vscode.Uri ? target : typeof target === "string" ? vscode.Uri.file(target) : undefined;
    if (!uri) {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const name = `${EXPORT_FILE}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
      uri = await vscode.window.showSaveDialog({
        title: `${DISPLAY_NAME}: Export`,
        defaultUri: folder ? vscode.Uri.joinPath(folder, name) : undefined,
        filters: { JSON: ["json"], "Plain text": ["txt", "log"] },
      });
    }
    if (!uri) return;
    const rel = (f: string) => vscode.workspace.asRelativePath(f);
    const text = /\.json$/i.test(uri.path) ? exportJson(store.all, rel) : exportText(store.all, rel);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
    void vscode.window.showInformationMessage(`${DISPLAY_NAME}: exported ${store.size} ${store.size === 1 ? "entry" : "entries"} to ${vscode.workspace.asRelativePath(uri)}.`);
  };

  // The log commands carry TypeScript's parser, so it is loaded the first time one runs.
  let logEdit: typeof LogEdit | undefined;
  const loadLogEdit = (): typeof LogEdit => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    logEdit ??= require(path.join(context.extensionPath, "dist", "logedit.js")) as typeof LogEdit;
    return logEdit;
  };
  const logEditor = (): vscode.TextEditor | undefined => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || !loadLogEdit().supports(ed.document.languageId, ed.document.fileName)) {
      void vscode.window.showInformationMessage(`${DISPLAY_NAME}: open a JavaScript, TypeScript, Svelte, Vue or Astro file first.`);
      return undefined;
    }
    return ed;
  };
  const applyEdits = async (ed: vscode.TextEditor, edits: LogEdit.TextEdit[]) => {
    const doc = ed.document;
    return ed.edit((b) => {
      for (const x of edits) b.replace(new vscode.Range(doc.positionAt(x.start), doc.positionAt(x.end)), x.newText);
    });
  };
  const insertLog = async () => {
    const ed = logEditor();
    if (!ed) return;
    const le = loadLogEdit();
    const unit = ed.options.insertSpaces === false ? "\t" : " ".repeat(Number(ed.options.tabSize) || 2);
    // Top to bottom, one at a time, so each label has the line its log ends up on.
    const sels = [...ed.selections].sort((a, b) => a.start.compareTo(b.start));
    let added = 0;
    for (let i = 0; i < sels.length; i++) {
      const doc = ed.document;
      const start = doc.offsetAt(sels[i].start.translate(added));
      const end = doc.offsetAt(sels[i].end.translate(added));
      const r = le.insertLog(doc.getText(), doc.languageId, doc.fileName, { start, end, fileLabel: path.basename(doc.fileName), eol: doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n", indentUnit: unit });
      if ("error" in r) {
        void vscode.window.showInformationMessage(`${DISPLAY_NAME}: ${r.error}.`);
        continue;
      }
      await ed.edit((b) => b.insert(doc.positionAt(r.edit.start), r.edit.newText), { undoStopBefore: i === 0, undoStopAfter: i === sels.length - 1 });
      added++;
    }
  };
  const editLogs = async (what: "comment" | "uncomment" | "remove") => {
    const ed = logEditor();
    if (!ed) return;
    const le = loadLogEdit();
    const doc = ed.document;
    const r = what === "comment" ? le.commentOut(doc.getText(), doc.languageId, doc.fileName) : what === "uncomment" ? le.uncomment(doc.getText(), doc.languageId, doc.fileName) : le.removeAll(doc.getText(), doc.languageId, doc.fileName);
    if (r.edits.length) await applyEdits(ed, r.edits);
    const verb = what === "comment" ? "Commented out" : what === "uncomment" ? "Uncommented" : "Removed";
    const left = r.skipped ? ` ${r.skipped} left as ${r.skipped === 1 ? "it is" : "they are"}, as part of a larger expression.` : "";
    vscode.window.setStatusBarMessage(`${DISPLAY_NAME}: ${verb} ${r.done} console ${r.done === 1 ? "call" : "calls"}.${left}`, 6_000);
    return r;
  };

  const copyTerminalSetup = async (shellArg?: unknown) => {
    const shells: { label: string; description: string; shell: Shell }[] = [
      { label: "PowerShell", description: "Windows Terminal, a PowerShell window, pwsh", shell: "powershell" },
      { label: "Command Prompt", description: "cmd.exe", shell: "cmd" },
      { label: "bash or zsh", description: "macOS Terminal, iTerm, Linux terminals, Git Bash, WSL", shell: "posix" },
      { label: "fish", description: "fish shell", shell: "fish" },
    ];
    const shell = typeof shellArg === "string" && shells.some((s) => s.shell === shellArg) ? (shellArg as Shell) : (await vscode.window.showQuickPick(shells, { title: `${DISPLAY_NAME}: Copy Setup for an Outside Terminal`, placeHolder: "The shell of the terminal you start your app in" }))?.shell;
    if (!shell) return;
    if (!cfg().get<boolean>("enabled", true)) {
      void vscode.window.showInformationMessage(`${DISPLAY_NAME} is off. Turn it on first.`);
      return;
    }
    const c = cfg();
    const line = setupLine(shell, {
      hook: hookPath.replace(/\\/g, "/"),
      port: server.port,
      token: server.token,
      opts: hookOptions(),
      spool: spool.dir,
      coverage: c.get<boolean>("coverage", false) ? coverage.dir : undefined,
    });
    await vscode.env.clipboard.writeText(line);
    if (typeof shellArg !== "string") void vscode.window.showInformationMessage(`${DISPLAY_NAME}: copied. Paste it into the other terminal, then start your app there. It reports to this window while it is open, over 127.0.0.1 with this window's key.`);
    return line;
  };

  const showGraph = (e: Entry | undefined) => {
    if (!e) {
      void vscode.window.showInformationMessage(`${DISPLAY_NAME}: put the cursor on a line with a value first.`);
      return;
    }
    graph.show(e, where(e));
  };

  const searchUi = (initial?: string) => {
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { entry: Entry }>();
    qp.title = `${DISPLAY_NAME}: Search`;
    qp.placeholder = "Words to find. Narrow with kind:request, level:warn, file:api, status:404";
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    const update = () => {
      qp.items = search(store.all, qp.value, 300).map((e) => ({
        label: `$(${e.kind === "error" ? "error" : e.kind === "request" ? "globe" : e.level === "warn" ? "warning" : "debug-console"}) ${e.preview.replace(/\r?\n/g, " ").slice(0, 200)}`,
        description: where(e),
        detail: new Date(e.time).toLocaleTimeString(),
        alwaysShow: true,
        entry: e,
      }));
    };
    qp.onDidChangeValue(update);
    qp.onDidAccept(() => {
      const e = qp.selectedItems[0]?.entry;
      qp.hide();
      if (e) void open(e);
    });
    qp.onDidHide(() => qp.dispose());
    qp.value = initial ?? "";
    update();
    qp.show();
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(`${ID}.clear`, () => {
      store.clear();
      viewer.reset();
      logMap.refresh();
      refresh();
      updateProblems();
      updateStatus();
    }),
    vscode.commands.registerCommand(`${ID}.pause`, () => setPaused(true)),
    vscode.commands.registerCommand(`${ID}.resume`, () => setPaused(false)),
    vscode.commands.registerCommand(`${ID}.togglePause`, () => setPaused(!paused)),
    vscode.commands.registerCommand(`${ID}.toggleEnabled`, async () => {
      await cfg().update("enabled", !cfg().get<boolean>("enabled", true), vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand(`${ID}.showViewer`, async () => {
      await vscode.commands.executeCommand(`${ID}.viewer.focus`);
    }),
    vscode.commands.registerCommand(`${ID}.toggleRequests`, () => {
      requestsPaused = !requestsPaused;
      void vscode.commands.executeCommand("setContext", `${ID}.requestsPaused`, requestsPaused);
      vscode.window.setStatusBarMessage(`${DISPLAY_NAME}: request log ${requestsPaused ? "paused" : "resumed"}`, 4_000);
    }),
    vscode.commands.registerCommand(`${ID}.diffPrevious`, (file?: unknown, line?: unknown) => diffPrevious(byId(file) ?? entryAt(file, line))),
    vscode.commands.registerCommand(`${ID}.compareEntries`, async (a?: unknown, b?: unknown) => {
      const left = byId(a) ?? (await pickEntry("Compare: pick the first value"));
      if (!left) return;
      const right = byId(b) ?? (await pickEntry("Compare: pick the second value", left));
      if (right) await showDiff(values, left, right);
    }),
    vscode.commands.registerCommand(`${ID}.showGraph`, (file?: unknown, line?: unknown) => showGraph(byId(file) ?? entryAt(file, line))),
    vscode.commands.registerCommand(`${ID}.copyValue`, (file?: unknown, line?: unknown) => copyValue(byId(file) ?? entryAt(file, line))),
    vscode.commands.registerCommand(`${ID}.export`, (target?: unknown) => exportEntries(target)),
    vscode.commands.registerCommand(`${ID}.insertLog`, () => insertLog()),
    vscode.commands.registerCommand(`${ID}.commentLogs`, () => editLogs("comment")),
    vscode.commands.registerCommand(`${ID}.uncommentLogs`, () => editLogs("uncomment")),
    vscode.commands.registerCommand(`${ID}.removeLogs`, () => editLogs("remove")),
    vscode.commands.registerCommand(`${ID}.copyTerminalSetup`, (shell?: unknown) => copyTerminalSetup(shell)),
    vscode.commands.registerCommand(`${ID}.search`, (q?: unknown) => searchUi(typeof q === "string" ? q : undefined)),
    vscode.commands.registerCommand(`${ID}.filterMap`, async () => {
      const q = await vscode.window.showInputBox({ title: `${DISPLAY_NAME}: Filter Log Map`, value: logMap.query, prompt: "Words to find. Narrow with kind:request, level:warn, file:api, status:404" });
      if (q !== undefined) logMap.setQuery(q);
    }),
    vscode.commands.registerCommand(`${ID}.clearMapFilter`, () => logMap.setQuery("")),
    vscode.commands.registerCommand(`${ID}.openLine`, (file: string, line: number) => openLine(file, line)),
    vscode.commands.registerCommand(`${ID}.toggleCoverage`, async () => {
      await cfg().update("coverage", !cfg().get<boolean>("coverage", false), vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand(`${ID}.clearCoverage`, () => coverage.clear()),
    vscode.commands.registerCommand(`${ID}.copyMcpSetup`, async () => {
      if (!cfg().get<boolean>("mcp", false)) {
        const on = await vscode.window.showWarningMessage(`${DISPLAY_NAME}: MCP is off. AI tools that connect can read every logged value, request and error. Turn it on?`, "Turn On");
        if (on !== "Turn On") return;
        await cfg().update("mcp", true, vscode.ConfigurationTarget.Global);
      }
      const pick = await vscode.window.showQuickPick(
        [
          { label: "Claude Code", description: "A claude mcp add command", setup: "claude" as const },
          { label: "JSON config", description: "For tools with an mcpServers config file, like Cursor", setup: "json" as const },
        ],
        { title: `${DISPLAY_NAME}: Copy MCP Setup` },
      );
      if (!pick) return;
      await vscode.env.clipboard.writeText(mcp.setup(pick.setup));
      void vscode.window.showInformationMessage(`${DISPLAY_NAME}: copied. It connects to this VS Code window while it is open.`);
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => coverage.refresh()),
    vscode.workspace.onDidChangeConfiguration((ev) => {
      if (!ev.affectsConfiguration(ID)) return;
      if (["enabled", "sourceMaps", "includeNodeModules", "browser", "requests", "requestBodies", "coverage"].some((k) => ev.affectsConfiguration(`${ID}.${k}`))) applyEnv();
      if (ev.affectsConfiguration(`${ID}.mcp`)) mcp.setEnabled(cfg().get<boolean>("mcp", false));
      if (ev.affectsConfiguration(`${ID}.coverage`)) coverage.setActive(cfg().get<boolean>("coverage", false));
      if (ev.affectsConfiguration(`${ID}.problems`) || ev.affectsConfiguration(`${ID}.enabled`)) updateProblems();
      refresh();
      updateStatus();
    }),
  );

  updateStatus();
  refresh();

  return {
    port: server.port,
    token: server.token,
    hookPath,
    store,
    applied,
    get paused() {
      return paused;
    },
    get requestsPaused() {
      return requestsPaused;
    },
    get statusText() {
      return status.text;
    },
    refresh,
    open,
    mcp,
    coverage,
    graph: graph.state,
    graphPost: (m) => graph.post(m),
    logMap,
    values,
    problems,
    viewer,
  };
}

export function deactivate(): void {
  // subscriptions clean up
}

/** Between the calls of one line, when it has several (a request and the log in its callback). */
const SITE_GAP = "  ┊  ";

function label(info: LineInfo, max: number): string {
  // Each call on the line with its newest value, left to right. Calls that show the same are shown once.
  const parts = [...new Set((info.sites.length > 1 ? info.sites : [info.latest]).map((e) => e.preview.replace(/\r?\n/g, " ↵ ")))];
  const room = parts.length > 1 ? Math.max(10, Math.floor((max - SITE_GAP.length * (parts.length - 1)) / parts.length)) : max;
  const body = parts.map((one) => (one.length > room ? one.slice(0, room - 1) + "…" : one)).join(SITE_GAP);
  return info.count > 1 ? `${body}  ×${info.count}` : body;
}

const REQUEST_API = { fetch: "fetch", xhr: "XMLHttpRequest", http: "http request", websocket: "WebSocket", eventsource: "EventSource", beacon: "sendBeacon" } as const;

/** 14:03:07.120: the time of a run, to the millisecond. */
function clock(t: number): string {
  const d = new Date(t);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function hoverFor(info: LineInfo, links: boolean): vscode.MarkdownString {
  const e = info.latest;
  const what =
    e.kind === "error"
      ? "Uncaught error"
      : e.kind === "request"
        ? (REQUEST_API[e.request?.api ?? "fetch"] ?? "request")
        : e.logger
          ? `${e.logger} ${e.level}`
          : `console.${e.method && ALL_METHODS.includes(e.method) ? e.method : e.level}`;
  const when = new Date(e.time).toLocaleTimeString();
  const where = e.source === "browser" ? "browser" : `Node, pid ${e.pid}`;
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${what}** · ${info.count} ${info.count === 1 ? "hit" : "hits"} · last at ${when} · ${where}${e.group ? ` · in group ${e.group.replace(/[\\`*_[\]<>]/g, "\\$&")}` : ""}\n\n`);
  md.appendCodeblock(e.full.length > 20_000 ? e.full.slice(0, 20_000) + "…" : e.full, "text");
  // Several calls on the line: each one's newest value, as the end of the line shows them.
  if (info.sites.length > 1) {
    md.appendMarkdown(`\n**Calls on this line**, left to right\n`);
    md.appendCodeblock(info.sites.map((s) => `col ${s.col}  ${s.preview.replace(/\r?\n/g, " ").slice(0, 200)}`).join("\n"), "text");
  }
  // Each run of the line, newest first, with its time and value.
  if (info.count > 1) {
    const runs = [...info.recent].reverse();
    const rows = runs.map((r, i) => `#${info.count - i}  ${clock(r.time)}  ${r.preview.replace(/\r?\n/g, " ").slice(0, 120)}`);
    if (info.count > runs.length) rows.push(`… ${info.count - runs.length} earlier ${info.count - runs.length === 1 ? "run" : "runs"} in the log viewer`);
    md.appendMarkdown(`\n**Runs**, newest first\n`);
    md.appendCodeblock(rows.join("\n"), "text");
  }
  const actions: string[] = [];
  if (links && info.count > 1) actions.push(`[Compare with previous](command:${ID}.diffPrevious?${encodeURIComponent(JSON.stringify([e.id]))})`);
  if (links && e.json) actions.push(`[Show as graph](command:${ID}.showGraph?${encodeURIComponent(JSON.stringify([e.id]))})`);
  if (links) actions.push(`[Copy value](command:${ID}.copyValue?${encodeURIComponent(JSON.stringify([e.id]))})`);
  if (actions.length) {
    md.appendMarkdown(`\n\n${actions.join(" · ")}`);
    // Only these commands can run from a hover link, whatever the logged text holds.
    (md as unknown as { isTrusted: unknown }).isTrusted = { enabledCommands: [`${ID}.diffPrevious`, `${ID}.showGraph`, `${ID}.copyValue`] };
  }
  return md;
}

function versionBelow(v: string, major: number, minor: number): boolean {
  const [a, b] = v.split(".").map((x) => parseInt(x, 10));
  return a < major || (a === major && b < minor);
}

/** Spool folders of windows that closed without cleaning up (a crash): gone after a day. Folders of open windows are newer. */
function cleanSpool(root: string): void {
  try {
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      if (Date.now() - fs.statSync(dir).mtimeMs > 86_400_000) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // nothing there yet
  }
}

/**
 * NODE_OPTIONS points at a copy of the hook in this extension's global
 * storage, a path that stays the same across updates. A terminal opened
 * before an update would otherwise point at a version folder VS Code later
 * deletes, and every node command in it would fail to start.
 */
function installHook(context: vscode.ExtensionContext): string {
  const src = path.join(context.extensionPath, "dist", "hook.cjs");
  const dir = context.globalStorageUri.fsPath;
  const dest = path.join(dir, "hook.cjs");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const code = fs.readFileSync(src);
    let same = false;
    try {
      same = fs.readFileSync(dest).equals(code);
    } catch {
      // not there yet
    }
    if (!same) {
      const tmp = `${dest}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, code);
      fs.renameSync(tmp, dest);
    }
    return dest;
  } catch {
    return src;
  }
}
