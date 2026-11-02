// Runs only the 0.4.0 feature checks (features4.ts), for quicker runs while
// working on them: bundle this file in place of suite.ts.
import * as vscode from "vscode";
import * as path from "node:path";
import type { Api } from "../../src/extension";
import { runFeatures4 } from "./features4";

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
  try {
    await runFeatures4(api, check);
  } catch (err) {
    console.error(err);
    failed++;
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) throw new Error(`${failed} host checks failed`);
}
