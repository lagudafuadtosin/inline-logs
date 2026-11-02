// The value graph panel: one webview that shows the logged value it was
// last opened for. Its script is bundled into the extension (no files, no
// network) and only runs with this page's nonce.
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { DISPLAY_NAME, GRAPH_VIEW } from "../names";
import type { Entry } from "../shared/types";

declare const __GRAPH_JS__: string;

/** What the webview last said it drew; read by the tests. */
export interface GraphState {
  entryId?: string;
  html?: string;
  rendered?: { nodes: number; edges: number; total: number; collapsed: number; zoom: number };
}

export class GraphPanel {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private pending: unknown;
  readonly state: GraphState = {};

  show(e: Entry, where: string): void {
    let value: unknown = e.full;
    if (e.json) {
      try {
        value = JSON.parse(e.json) as unknown;
      } catch {
        value = e.full;
      }
    }
    const label = e.kind === "request" ? "request" : e.json && /^\[/.test(e.json) ? "arguments" : "value";
    const message = { type: "show", value, label, title: `${where} · ${new Date(e.time).toLocaleTimeString()}` };
    this.state.entryId = e.id;
    this.state.rendered = undefined;
    if (!this.panel) {
      this.ready = false;
      this.panel = vscode.window.createWebviewPanel(GRAPH_VIEW, `Value Graph`, vscode.ViewColumn.Beside, { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
      const nonce = randomBytes(16).toString("base64");
      this.panel.webview.html = this.state.html = html(nonce);
      this.panel.webview.onDidReceiveMessage((m: { type: string } & GraphState["rendered"]) => {
        if (m.type === "ready") {
          this.ready = true;
          if (this.pending) void this.panel?.webview.postMessage(this.pending);
          this.pending = undefined;
        } else if (m.type === "rendered") {
          const { nodes, edges, total, collapsed, zoom } = m as NonNullable<GraphState["rendered"]>;
          this.state.rendered = { nodes, edges, total, collapsed, zoom };
        }
      });
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.ready = false;
      });
    } else {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
    }
    this.panel.title = `Value Graph: ${where}`;
    if (this.ready) void this.panel.webview.postMessage(message);
    else this.pending = message;
  }

  /** For the tests: the same messages the buttons and clicks make. */
  post(m: unknown): void {
    void this.panel?.webview.postMessage(m);
  }

  get open(): boolean {
    return !!this.panel;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

function html(nonce: string): string {
  const js = typeof __GRAPH_JS__ === "string" ? __GRAPH_JS__ : "";
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>${DISPLAY_NAME} Value Graph</title>
<style nonce="${nonce}">
html,body{height:100%;margin:0;padding:0;overflow:hidden;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background)}
.bar{position:absolute;top:0;left:0;right:0;display:flex;gap:6px;align-items:center;padding:4px 8px;background:var(--vscode-editorWidget-background);border-bottom:1px solid var(--vscode-panel-border);z-index:1}
.bar span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85}
button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;padding:2px 8px;cursor:pointer}
button:hover{background:var(--vscode-button-secondaryHoverBackground)}
#note{opacity:.7;flex:none}
svg{position:absolute;top:30px;left:0;width:100%;height:calc(100% - 30px);cursor:grab;user-select:none}
svg:active{cursor:grabbing}
text{font-family:var(--vscode-editor-font-family);font-size:12px;fill:var(--vscode-editor-foreground)}
.box{fill:var(--vscode-editorWidget-background);stroke:var(--vscode-editorWidget-border,var(--vscode-panel-border));stroke-width:1}
.head{fill:var(--vscode-badge-background);opacity:.35;cursor:pointer}
.title{font-weight:bold;cursor:pointer}
.key{fill:var(--vscode-symbolIcon-propertyForeground,var(--vscode-textLink-foreground))}
.val{fill:var(--vscode-debugTokenExpression-string,var(--vscode-editor-foreground))}
.more,.later{cursor:pointer}
.more{opacity:.6;font-style:italic}
.edge{fill:none;stroke:var(--vscode-textLink-foreground);stroke-width:1.2;opacity:.7}
.dot{fill:var(--vscode-textLink-foreground)}
</style></head><body>
<div class="bar"><span id="title"></span><span id="note"></span>
<button id="in" title="Zoom in">+</button><button id="out" title="Zoom out">−</button><button id="fit">Fit</button>
<button id="expand">Expand all</button><button id="collapse">Collapse all</button></div>
<svg id="graph" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Value graph"></svg>
<script nonce="${nonce}">${js}</script>
</body></html>`;
}
