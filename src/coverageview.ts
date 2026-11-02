// Shows code coverage in the editor gutter: a green bar on lines that ran, a
// red one on code that never ran. Node writes its reports to a folder in
// this window's storage (NODE_V8_COVERAGE, set in new terminals while the
// setting is on), read here every second and then removed.
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { CoverageStore, readReports } from "./coverage";

export class CoverageView implements vscode.Disposable {
  readonly store: CoverageStore;
  /** Lines last decorated per document URI string, for the tests. */
  readonly applied = new Map<string, { hit: number[]; missed: number[] }>();
  private timer: NodeJS.Timeout | undefined;
  private hit: vscode.TextEditorDecorationType;
  private missed: vscode.TextEditorDecorationType;

  constructor(
    extensionPath: string,
    readonly dir: string,
    key: (file: string) => string,
    private readonly skip: (file: string) => boolean,
  ) {
    this.store = new CoverageStore(key);
    this.hit = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.file(path.join(extensionPath, "images", "coverage-hit.svg")),
      gutterIconSize: "contain",
      overviewRulerColor: "#3fb95080",
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.missed = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.file(path.join(extensionPath, "images", "coverage-miss.svg")),
      gutterIconSize: "contain",
      overviewRulerColor: "#f8514980",
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
  }

  /** Starts or stops reading reports. Reports already written are still read once when it stops. */
  setActive(on: boolean): void {
    if (on && !this.timer) {
      fs.mkdirSync(this.dir, { recursive: true });
      this.timer = setInterval(() => this.read(), 1_000);
    } else if (!on && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.read();
    }
  }

  read(): void {
    let changed = false;
    readReports(
      this.dir,
      (hits) => {
        if (this.store.add(hits).size) changed = true;
      },
      this.skip,
    );
    if (changed) this.refresh();
  }

  refresh(): void {
    for (const editor of vscode.window.visibleTextEditors) this.decorate(editor);
  }

  decorate(editor: vscode.TextEditor): void {
    const doc = editor.document;
    if (doc.uri.scheme !== "file") return;
    const hit: vscode.Range[] = [];
    const missed: vscode.Range[] = [];
    for (const [line, count] of this.store.lines(doc.uri.fsPath)) {
      if (line < 1 || line > doc.lineCount) continue;
      (count > 0 ? hit : missed).push(new vscode.Range(line - 1, 0, line - 1, 0));
    }
    editor.setDecorations(this.hit, hit);
    editor.setDecorations(this.missed, missed);
    if (hit.length || missed.length || this.applied.has(doc.uri.toString())) {
      this.applied.set(doc.uri.toString(), { hit: hit.map((r) => r.start.line + 1), missed: missed.map((r) => r.start.line + 1) });
    }
  }

  clear(): void {
    this.store.clear();
    this.refresh();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.hit.dispose();
    this.missed.dispose();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
