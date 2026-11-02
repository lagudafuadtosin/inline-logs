// Starts a real VS Code with the extension loaded and runs test/host/suite.ts
// inside it, then a second window on a workspace with two folders for
// test/host/multiroot-suite.ts. VS Code is downloaded once into .vscode-test
// (git-ignored). IL_SUITE=features5-suite (or features4-suite, features-suite, multiroot-suite) runs just those checks.
import * as path from "node:path";
import { mkdirSync, mkdtempSync } from "node:fs";
import { runTests } from "@vscode/test-electron";

async function main() {
  // Bundled into .test-build, so the repo is one folder up.
  const root = path.resolve(__dirname, "..");
  mkdirSync(path.join(root, ".test-build"), { recursive: true });
  const only = process.env.IL_SUITE;
  const launch = async (suite: string, open: string) => {
    const dir = mkdtempSync(path.join(root, ".test-build", "run-"));
    await runTests({
      version: process.env.VSCODE_VERSION || "1.142.0",
      cachePath: path.join(root, ".vscode-test"),
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(root, ".test-build", suite),
      extensionTestsEnv: { IL_TEST_TMP: dir, IL_TEST_ROOT: root, IL_SCREENSHOT: process.env.IL_SCREENSHOT ?? "" },
      launchArgs: [
        open,
        "--disable-extensions",
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
        `--user-data-dir=${path.join(root, ".vscode-test", "user-data")}`,
        `--extensions-dir=${path.join(root, ".vscode-test", "extensions")}`,
      ],
    });
  };
  try {
    if (!only) await launch("host-suite.cjs", path.join(root, "test-fixtures"));
    else if (only !== "multiroot-suite") await launch(`host-${only}.cjs`, path.join(root, "test-fixtures"));
    if (!only || only === "multiroot-suite") await launch("host-multiroot-suite.cjs", path.join(root, "test-fixtures", "multi-root.code-workspace"));
  } catch (err) {
    console.error("host tests failed", err);
    process.exit(1);
  }
}

void main();
