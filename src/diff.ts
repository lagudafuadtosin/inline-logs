// Compares logged values in VS Code's own diff editor. Each value is a
// read-only virtual document (pretty JSON when the value is an object, the
// printed text otherwise), so nothing is written to disk.
import * as vscode from "vscode";
import * as path from "node:path";
import { VALUE_SCHEME } from "./names";
import { valueText } from "./search";
import type { Entry } from "./shared/types";

export class ValueDocuments implements vscode.TextDocumentContentProvider {
  constructor(private readonly find: (id: string) => Entry | undefined) {}

  /** inline-logs-value:/<file>-<line>.json?<id> */
  uri(e: Entry): vscode.Uri {
    const v = valueText(e);
    const name = `${path.basename(e.file)}-${e.line}-${new Date(e.time).toISOString().slice(11, 23).replace(/[:.]/g, "")}.${v.json ? "json" : "txt"}`;
    return vscode.Uri.from({ scheme: VALUE_SCHEME, path: `/${name}`, query: encodeURIComponent(e.id) });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const e = this.find(decodeURIComponent(uri.query));
    return e ? valueText(e).text : "This value was cleared.\n";
  }
}

export async function showDiff(docs: ValueDocuments, left: Entry, right: Entry): Promise<void> {
  const where = (e: Entry) => `${path.basename(e.file)}:${e.line} ${new Date(e.time).toLocaleTimeString()}`;
  await vscode.commands.executeCommand("vscode.diff", docs.uri(left), docs.uri(right), `${where(left)} ↔ ${where(right)}`, { preview: true });
}
