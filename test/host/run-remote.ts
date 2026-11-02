// Starts the test VS Code as a remote window on WSL: the folder, the
// extension under development and the checks (remote-suite.ts) are all
// vscode-remote://wsl+<distro>/ paths, so the extension runs on the WSL side
// and the editor shows remote files, as for a user who opens a WSL folder.
// The Remote - WSL extension is installed into a folder of its own next to
// the test VS Code. Files go to ~/il-remote-test in WSL. Run on Windows with
// WSL and Node in it: node .test-build/host-run-remote.cjs [distro]
import * as path from "node:path";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

function main(): number {
  const root = path.resolve(__dirname, "..");
  const distro = process.argv[2] || "Ubuntu";
  const home = spawnSync("wsl.exe", ["-d", distro, "--", "sh", "-c", "echo $HOME"], { encoding: "utf8" }).stdout.trim();
  if (!home.startsWith("/")) throw new Error(`no home folder in WSL ${distro}`);
  const base = `${home}/il-remote-test`;
  const unc = (p: string) => `\\\\wsl.localhost\\${distro}${p.replace(/\//g, "\\")}`;

  // The extension as it ships (package.json, dist, images) with the checks next to it, and the app to run.
  const ext = unc(`${base}/ext`);
  const app = unc(`${base}/app`);
  rmSync(ext, { recursive: true, force: true });
  rmSync(app, { recursive: true, force: true });
  mkdirSync(path.join(ext, "dist"), { recursive: true });
  mkdirSync(app, { recursive: true });
  for (const f of ["package.json", "LICENSE"]) cpSync(path.join(root, f), path.join(ext, f));
  cpSync(path.join(root, "images"), path.join(ext, "images"), { recursive: true });
  for (const f of readdirSync(path.join(root, "dist"))) if (!f.endsWith(".map")) cpSync(path.join(root, "dist", f), path.join(ext, "dist", f));
  cpSync(path.join(root, ".test-build", "host-remote-suite.cjs"), path.join(ext, "remote-suite.cjs"));
  for (const f of ["index.js", "crash.js"]) cpSync(path.join(root, "test-fixtures", "node-cjs", f), path.join(app, f));

  const vscodeDir = path.join(root, ".vscode-test", readdirSync(path.join(root, ".vscode-test")).find((d) => d.startsWith("vscode-win32"))!);
  const extDir = path.join(root, ".vscode-test", "extensions-remote");
  const userDir = path.join(root, ".vscode-test", "user-data-remote");
  mkdirSync(extDir, { recursive: true });
  if (!readdirSync(extDir).some((d) => d.startsWith("ms-vscode-remote.remote-wsl"))) {
    const r = spawnSync(path.join(vscodeDir, "bin", "code.cmd"), ["--extensions-dir", extDir, "--user-data-dir", userDir, "--install-extension", "ms-vscode-remote.remote-wsl"], { encoding: "utf8", shell: true });
    console.log(r.stdout, r.stderr);
  }

  const remote = (p: string) => `vscode-remote://wsl+${distro}${p}`;
  const r = spawnSync(
    path.join(vscodeDir, "Code.exe"),
    [
      `--folder-uri=${remote(`${base}/app`)}`,
      `--extensionDevelopmentPath=${remote(`${base}/ext`)}`,
      `--extensionTestsPath=${remote(`${base}/ext/remote-suite.cjs`)}`,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      `--user-data-dir=${userDir}`,
      `--extensions-dir=${extDir}`,
    ],
    { stdio: "inherit", timeout: 600_000 },
  );
  const result = path.join(app, "remote-result.json");
  if (!existsSync(result)) {
    console.error(`no result from the remote window (VS Code ended with ${r.status})`);
    return 1;
  }
  const checks = JSON.parse(readFileSync(result, "utf8")) as { ok: boolean; what: string; detail?: unknown }[];
  for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.what}${c.ok ? "" : `  [${JSON.stringify(c.detail)}]`}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\nremote (WSL ${distro}): ${checks.length - failed} passed, ${failed} failed`);
  return failed || r.status ? 1 : 0;
}

process.exit(main());
