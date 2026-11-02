// The one-line setup for a terminal outside VS Code (Windows Terminal, a
// PowerShell window, iTerm): the same variables VS Code gives its own
// terminals, so an app started there reports to this window. The values
// connect to 127.0.0.1 only and carry this window's key. No VS Code
// imports, so it is unit tested on its own.
import { ENV_OPTS, ENV_PORT, ENV_SPOOL, ENV_TOKEN } from "./names";

export type Shell = "powershell" | "cmd" | "posix" | "fish";

export interface SetupVars {
  /** The hook's path, with forward slashes. */
  hook: string;
  port: number;
  token: string;
  /** The hook's options as JSON. */
  opts: string;
  spool: string;
  /** NODE_V8_COVERAGE and DENO_COVERAGE_DIR, when coverage is on. */
  coverage?: string;
}

/** The variables and their values, NODE_OPTIONS and BUN_OPTIONS as the part to add. */
export function setupVars(v: SetupVars): [string, string][] {
  const out: [string, string][] = [
    [ENV_PORT, String(v.port)],
    [ENV_TOKEN, v.token],
    [ENV_OPTS, v.opts],
    [ENV_SPOOL, v.spool],
  ];
  if (v.coverage) out.push(["NODE_V8_COVERAGE", v.coverage], ["DENO_COVERAGE_DIR", v.coverage]);
  return out;
}

const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const fish = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** One line to paste into that shell. Running it twice does no harm: the hook installs itself once per process. */
export function setupLine(shell: Shell, v: SetupVars): string {
  const require = `--require "${v.hook}"`;
  const preload = `"--preload=${v.hook}"`;
  const vars = setupVars(v);
  switch (shell) {
    case "powershell":
      return [`$env:NODE_OPTIONS = ("$env:NODE_OPTIONS " + ${ps(require)}).Trim()`, `$env:BUN_OPTIONS = ("$env:BUN_OPTIONS " + ${ps(preload)}).Trim()`, ...vars.map(([k, x]) => `$env:${k} = ${ps(x)}`)].join("; ");
    case "cmd":
      // cmd has no way to add to a variable that may not be set, so NODE_OPTIONS and BUN_OPTIONS are set, not added to.
      return [`set "NODE_OPTIONS=${require}"`, `set "BUN_OPTIONS=${preload}"`, ...vars.map(([k, x]) => `set "${k}=${x}"`)].join(" & ");
    case "fish":
      return [`set -gx NODE_OPTIONS (string trim -- "$NODE_OPTIONS "${fish(require)})`, `set -gx BUN_OPTIONS (string trim -- "$BUN_OPTIONS "${fish(preload)})`, ...vars.map(([k, x]) => `set -gx ${k} ${fish(x)}`)].join("; ");
    default:
      return `export NODE_OPTIONS="\${NODE_OPTIONS:+$NODE_OPTIONS }"${sh(require)} BUN_OPTIONS="\${BUN_OPTIONS:+$BUN_OPTIONS }"${sh(preload)} ${vars.map(([k, x]) => `${k}=${sh(x)}`).join(" ")}`;
  }
}
