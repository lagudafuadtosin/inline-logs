// The log viewer: a webview in the bottom panel listing every entry, with a
// search box and level toggles. Clicking an entry opens its line. Each row
// has buttons to compare it with the value before it on the same line, to
// pick it for comparing with another, to show it as a graph, and to copy it.
// The search box takes the same words as Search Logs (kind:, level:, file:,
// status:), matched here in the extension against the whole entry.
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { DISPLAY_NAME, ID } from "./names";
import type { Store } from "./store";
import type { Entry } from "./shared/types";
import { matches, parseQuery, search } from "./search";

interface Row {
  id: string;
  kind: Entry["kind"];
  level: Entry["level"];
  where: string;
  preview: string;
  full: string;
  time: number;
  source: Entry["source"];
  graph: boolean;
  /** Matches the search box's query (always true without one). */
  hit: boolean;
}

/** What the viewer shows now, as its page reports it (for tests). */
export interface ViewerState {
  query: string;
  shown: number;
  total: number;
  /** Ids of the rows shown, newest last, at most 200. */
  ids: string[];
}

export interface ViewerMessage {
  type: string;
  id?: string;
  q?: unknown;
  state?: ViewerState;
}

export interface ViewerActions {
  diffPrevious(e: Entry): void;
  graph(e: Entry): void;
  compare(e: Entry): void;
  copy(e: Entry): void;
}

export class ViewerProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private byId = new Map<string, Entry>();
  private query = "";
  /** The last state the page reported. */
  state: ViewerState | undefined;
  private readonly changed = new vscode.EventEmitter<ViewerState>();
  readonly onDidRender = this.changed.event;

  constructor(
    private readonly store: Store,
    private readonly openEntry: (e: Entry) => void | Promise<void>,
    private readonly actions?: ViewerActions,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = html(randomBytes(16).toString("base64"), view.webview.cspSource);
    view.webview.onDidReceiveMessage((m: ViewerMessage) => this.receive(m));
    view.onDidDispose(() => (this.view = undefined));
  }

  /** A message from the page: a row's button, the search box, or what it shows. */
  receive(m: ViewerMessage): void {
    const e = m.id ? (this.byId.get(m.id) ?? this.store.all.find((x) => x.id === m.id)) : undefined;
    if (m.type === "ready") this.reset();
    else if (m.type === "open" && e) void this.openEntry(e);
    else if (m.type === "diff" && e) this.actions?.diffPrevious(e);
    else if (m.type === "graph" && e) this.actions?.graph(e);
    else if (m.type === "compare" && e) this.actions?.compare(e);
    else if (m.type === "copy" && e) this.actions?.copy(e);
    else if (m.type === "clear") void vscode.commands.executeCommand(`${ID}.clear`);
    else if (m.type === "query" && typeof m.q === "string") this.search(m.q);
    else if (m.type === "shown" && m.state) {
      this.state = m.state;
      this.changed.fire(m.state);
    }
  }

  add(entries: readonly Entry[]): void {
    for (const e of entries) this.byId.set(e.id, e);
    if (this.byId.size > 20_000) this.byId = new Map(this.store.all.map((e) => [e.id, e]));
    const q = this.query ? parseQuery(this.query) : undefined;
    void this.view?.webview.postMessage({ type: "add", rows: entries.map((e) => row(e, !q || matches(e, q))) });
  }

  reset(): void {
    this.byId = new Map(this.store.all.map((e) => [e.id, e]));
    const hits = this.query ? new Set(search(this.store.all, this.query, Infinity).map((e) => e.id)) : undefined;
    void this.view?.webview.postMessage({ type: "reset", query: this.query, rows: this.store.all.map((e) => row(e, !hits || hits.has(e.id))) });
  }

  /** Types `q` into the search box, as a user would. */
  setQuery(q: string): void {
    void this.view?.webview.postMessage({ type: "setQuery", q });
  }

  private search(q: string): void {
    this.query = q.trim();
    this.reset();
  }
}

function row(e: Entry, hit: boolean): Row {
  // In a window with several folders the path starts with the folder's name.
  const rel = vscode.workspace.asRelativePath(e.file);
  return { id: e.id, kind: e.kind, level: e.level, where: `${rel}:${e.line}`, preview: e.preview.slice(0, 500), full: e.full.slice(0, 4000), time: e.time, source: e.source, graph: !!e.json, hit };
}

function html(nonce: string, csp: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>${DISPLAY_NAME}</title>
<style nonce="${nonce}">
body{padding:0;margin:0;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground)}
.bar{position:sticky;top:0;display:flex;gap:6px;align-items:center;padding:4px 8px;background:var(--vscode-panel-background);border-bottom:1px solid var(--vscode-panel-border);flex-wrap:wrap}
input[type=text]{flex:1;min-width:120px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:2px 6px}
label{display:flex;gap:3px;align-items:center;opacity:.9}
button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;padding:2px 8px;cursor:pointer}
ul{list-style:none;margin:0;padding:0;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size)}
li{display:flex;gap:8px;padding:1px 8px;cursor:pointer;white-space:nowrap;border-bottom:1px solid transparent}
li:hover{background:var(--vscode-list-hoverBackground)}
.t{opacity:.6}.w{color:var(--vscode-textLink-foreground);flex:none}
.p{overflow:hidden;text-overflow:ellipsis;flex:1}
.warn .p{color:var(--vscode-editorWarning-foreground)}
.error .p{color:var(--vscode-editorError-foreground)}
.empty{padding:8px;opacity:.7}
.request .p{color:var(--vscode-textLink-activeForeground,var(--vscode-foreground))}
.a{display:none;gap:2px;flex:none}
li:hover .a{display:flex}
.a button{padding:0 5px;font-size:11px}
</style></head><body>
<div class="bar"><input id="q" type="text" placeholder="Search: words, kind:request, level:warn, file:api, status:404" aria-label="Search"><span id="n" class="t"></span>
<label><input type="checkbox" data-l="log" checked>log</label><label><input type="checkbox" data-l="info" checked>info</label>
<label><input type="checkbox" data-l="warn" checked>warn</label><label><input type="checkbox" data-l="error" checked>error</label>
<label><input type="checkbox" data-l="debug" checked>debug</label><label><input type="checkbox" id="req" checked>requests</label><button id="clear">Clear</button></div>
<ul id="list"></ul><div id="empty" class="empty">Run an app, a dev server or your tests from a VS Code terminal. Its console output shows here and next to your code.</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let rows = [];
const list = document.getElementById("list"), q = document.getElementById("q"), empty = document.getElementById("empty"), n = document.getElementById("n");
const levels = () => new Set([...document.querySelectorAll("input[data-l]")].filter(c => c.checked).map(c => c.dataset.l));
const fmt = t => new Date(t).toLocaleTimeString();
const req = document.getElementById("req");
// The search itself runs in the extension (the same as Search Logs); each row comes with hit set.
function matches(r, lv) { return r.hit && lv.has(r.level) && (r.kind !== "request" || req.checked); }
function act(label, type, title) { const b = document.createElement("button"); b.textContent = label; b.title = title; b.dataset.act = type; return b; }
function item(r) {
  const li = document.createElement("li");
  li.className = r.kind === "error" ? "error" : r.kind === "request" ? "request " + r.level : r.level;
  li.title = r.full;
  li.dataset.id = r.id;
  const t = document.createElement("span"); t.className = "t"; t.textContent = fmt(r.time) + (r.source === "browser" ? " web" : "");
  const p = document.createElement("span"); p.className = "p"; p.textContent = r.preview;
  const w = document.createElement("span"); w.className = "w"; w.textContent = r.where;
  const a = document.createElement("span"); a.className = "a";
  a.append(act("prev", "diff", "Compare with the value before it on this line"), act("compare", "compare", "Pick for comparing, then pick a second value"));
  if (r.graph) a.append(act("graph", "graph", "Show as a graph"));
  a.append(act("copy", "copy", "Copy the value as JSON"));
  li.append(t, p, a, w);
  return li;
}
function report() {
  const ids = [...list.children].map(li => li.dataset.id);
  n.textContent = q.value.trim() ? ids.length + " of " + rows.length : "";
  vscode.postMessage({ type: "shown", state: { query: q.value.trim(), shown: ids.length, total: rows.length, ids: ids.slice(-200) } });
}
function render() {
  const lv = levels();
  const shown = rows.filter(r => matches(r, lv)).slice(-2000);
  list.replaceChildren(...shown.map(item));
  empty.style.display = rows.length ? "none" : "block";
  report();
}
window.addEventListener("message", ev => {
  const m = ev.data;
  if (m.type === "reset") { rows = m.rows; render(); }
  else if (m.type === "setQuery") { q.value = m.q; sendQuery(); }
  else if (m.type === "add") {
    rows.push(...m.rows); if (rows.length > 10000) rows = rows.slice(-10000);
    const lv = levels();
    const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 4;
    for (const r of m.rows) if (matches(r, lv)) list.append(item(r));
    while (list.children.length > 2000) list.firstChild.remove();
    empty.style.display = rows.length ? "none" : "block";
    if (atBottom) window.scrollTo(0, document.body.scrollHeight);
    report();
  }
});
list.addEventListener("click", ev => { const li = ev.target.closest("li"); if (!li) return; const b = ev.target.closest("button[data-act]"); vscode.postMessage({ type: b ? b.dataset.act : "open", id: li.dataset.id }); });
let timer;
function sendQuery() { clearTimeout(timer); vscode.postMessage({ type: "query", q: q.value }); }
q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(sendQuery, 120); });
req.addEventListener("change", render);
document.querySelectorAll("input[data-l]").forEach(c => c.addEventListener("change", render));
document.getElementById("clear").addEventListener("click", () => vscode.postMessage({ type: "clear" }));
vscode.postMessage({ type: "ready" });
</script></body></html>`;
}
