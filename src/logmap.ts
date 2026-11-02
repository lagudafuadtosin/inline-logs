// The Log Map: a tree in the bottom panel with every file that logged, threw
// or made a request, and under each file its lines with their latest value.
// Clicking a line opens it. A filter (the same query as Search) narrows it.
import * as vscode from "vscode";
import * as path from "node:path";
import { ID } from "./names";
import { matches, parseQuery } from "./search";
import type { Store } from "./store";
import type { Entry } from "./shared/types";

export type MapNode = { type: "file"; key: string; file: string; count: number } | { type: "line"; file: string; line: number; latest: Entry; count: number };

export class LogMapProvider implements vscode.TreeDataProvider<MapNode> {
  private changed = new vscode.EventEmitter<MapNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private timer: NodeJS.Timeout | undefined;
  query = "";

  constructor(private readonly store: Store) {}

  /** Redraws soon (many entries can arrive at once). */
  refresh(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.changed.fire(undefined);
    }, 150);
  }

  setQuery(q: string): void {
    this.query = q.trim();
    void vscode.commands.executeCommand("setContext", `${ID}.mapFiltered`, !!this.query);
    this.changed.fire(undefined);
  }

  /** Per file key: line now shown -> the entries on it that match the filter. */
  private grouped(): Map<string, { file: string; lines: Map<number, Entry[]> }> {
    const q = parseQuery(this.query);
    const out = new Map<string, { file: string; lines: Map<number, Entry[]> }>();
    // Entries are kept at the line they were logged on; the store knows where that line is now.
    const nowByFile = new Map<string, Map<number, number>>();
    for (const e of this.store.all) {
      if (!matches(e, q)) continue;
      const k = this.store.key(e.file);
      let now = nowByFile.get(k);
      if (!now) nowByFile.set(k, (now = new Map(this.store.lines(k).map((i) => [i.latest.line, i.line] as const))));
      const at = now.get(e.line);
      if (at === undefined) continue;
      let f = out.get(k);
      if (!f) out.set(k, (f = { file: e.file, lines: new Map() }));
      let list = f.lines.get(at);
      if (!list) f.lines.set(at, (list = []));
      list.push(e);
    }
    return out;
  }

  getChildren(node?: MapNode): MapNode[] {
    const groups = this.grouped();
    if (!node) {
      return [...groups.entries()]
        .map(([key, g]) => ({ type: "file" as const, key, file: g.file, count: [...g.lines.values()].reduce((n, l) => n + l.length, 0) }))
        .sort((a, b) => vscode.workspace.asRelativePath(a.file).localeCompare(vscode.workspace.asRelativePath(b.file)));
    }
    if (node.type !== "file") return [];
    const g = groups.get(node.key);
    if (!g) return [];
    return [...g.lines.entries()].sort((a, b) => a[0] - b[0]).map(([line, list]) => ({ type: "line" as const, file: g.file, line, latest: latestOf(list), count: list.length }));
  }

  getTreeItem(node: MapNode): vscode.TreeItem {
    if (node.type === "file") {
      const item = new vscode.TreeItem(path.basename(node.file), vscode.TreeItemCollapsibleState.Expanded);
      item.resourceUri = vscode.Uri.file(node.file);
      item.description = `${vscode.workspace.asRelativePath(path.dirname(node.file))} · ${node.count}`;
      item.iconPath = vscode.ThemeIcon.File;
      item.id = `file:${node.key}`;
      return item;
    }
    const e = node.latest;
    const item = new vscode.TreeItem(`${node.line}`, vscode.TreeItemCollapsibleState.None);
    item.description = `${e.preview.replace(/\r?\n/g, " ").slice(0, 200)}${node.count > 1 ? `  ×${node.count}` : ""}`;
    item.tooltip = e.full.slice(0, 4_000);
    item.iconPath = new vscode.ThemeIcon(e.kind === "error" ? "error" : e.kind === "request" ? "globe" : e.level === "warn" ? "warning" : e.level === "error" ? "error" : "debug-console");
    item.command = { command: `${ID}.openLine`, title: "Open", arguments: [node.file, node.line] };
    item.contextValue = e.kind;
    item.id = `line:${this.store.key(node.file)}:${node.line}`;
    return item;
  }
}

/** Errors stay in front of later logs, as on the line itself. */
function latestOf(list: Entry[]): Entry {
  let out = list[0];
  for (const e of list) if (!(out.kind === "error" && e.kind !== "error")) out = e;
  return out;
}
