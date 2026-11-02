// Turns the MCP endpoint on and off, and tells AI tools where it is:
//  - VS Code's own MCP support (Copilot agent mode and other chat tools in
//    VS Code 1.101 and later) gets it from a server definition provider, as
//    an HTTP server on 127.0.0.1 with the token in a header;
//  - command-line tools (Claude Code, Cursor's and others' configs) start the
//    stdio bridge, which finds this window through a small file with the
//    port and token in the extension's own storage folder. The bridge runs on
//    VS Code's own program (its Electron, told to act as Node), so the
//    machine needs no Node of its own. On a remote machine (WSL, SSH, a dev
//    container), where the extension runs on VS Code's server, it runs on
//    `node` there: the server's own Node moves with each VS Code update.
// Off by default: logged values can hold personal data and secrets the app
// printed, and an AI tool may send what it reads to a model in the cloud.
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { DISPLAY_NAME, MCP_BRIDGE_FILE, MCP_INFO_DIR, MCP_LAUNCHER_CMD, MCP_LAUNCHER_SH, MCP_NAME, MCP_PATH, MCP_PROVIDER } from "./names";

/** The parts of the MCP API (VS Code 1.101+) used here, looked up at run time so older VS Code still loads the extension. */
interface McpApi {
  registerMcpServerDefinitionProvider(id: string, provider: { onDidChangeMcpServerDefinitions?: vscode.Event<void>; provideMcpServerDefinitions(): unknown[] }): vscode.Disposable;
}
type HttpDefinition = new (label: string, uri: vscode.Uri, headers?: Record<string, string>, version?: string) => unknown;

export class McpHost implements vscode.Disposable {
  private token: string | undefined;
  private infoFile: string | undefined;
  private changed = new vscode.EventEmitter<void>();
  private registration: vscode.Disposable | undefined;
  readonly bridgePath: string;
  /** The launcher next to the bridge, or undefined on a remote machine or when it could not be written. */
  readonly launcherPath: string | undefined;
  /** True when VS Code took the server definition provider. */
  readonly registered: boolean;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly port: () => number,
    private readonly version: string,
  ) {
    this.bridgePath = installBridge(context);
    this.launcherPath = installLauncher(this.bridgePath);
    const lm = (vscode as unknown as { lm?: Partial<McpApi> }).lm;
    let ok = false;
    if (typeof lm?.registerMcpServerDefinitionProvider === "function") {
      try {
        this.registration = lm.registerMcpServerDefinitionProvider(MCP_PROVIDER, {
          onDidChangeMcpServerDefinitions: this.changed.event,
          provideMcpServerDefinitions: () => this.definitions(),
        });
        ok = true;
      } catch {
        ok = false;
      }
    }
    this.registered = ok;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port()}${MCP_PATH}`;
  }

  /** The current token, or undefined while MCP is off. */
  currentToken(): string | undefined {
    return this.token;
  }

  /** What the provider hands VS Code: one HTTP server, or none while off. */
  definitions(): unknown[] {
    const Def = (vscode as unknown as { McpHttpServerDefinition?: HttpDefinition }).McpHttpServerDefinition;
    if (!this.token || typeof Def !== "function") return [];
    return [new Def(DISPLAY_NAME, vscode.Uri.parse(this.url), { Authorization: `Bearer ${this.token}` }, this.version)];
  }

  setEnabled(on: boolean): void {
    if (on === !!this.token) return;
    if (on) {
      // A new token every time it is turned on: one handed out before stops working.
      this.token = randomBytes(24).toString("hex");
      this.writeInfo();
    } else {
      this.token = undefined;
      this.removeInfo();
    }
    this.changed.fire();
  }

  private writeInfo(): void {
    try {
      const dir = path.join(this.context.globalStorageUri.fsPath, MCP_INFO_DIR);
      fs.mkdirSync(dir, { recursive: true });
      this.infoFile = path.join(dir, `${process.pid}-${randomBytes(4).toString("hex")}.json`);
      const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => f.uri.fsPath);
      fs.writeFileSync(this.infoFile, JSON.stringify({ port: this.port(), token: this.token, pid: process.pid, folders, time: Date.now() }), { mode: 0o600 });
    } catch {
      this.infoFile = undefined;
    }
  }

  private removeInfo(): void {
    if (this.infoFile) fs.rmSync(this.infoFile, { force: true });
    this.infoFile = undefined;
  }

  /** How a tool starts the bridge: the launcher, which runs it on VS Code's own program as Node, or `node` on a remote machine. */
  command(): { command: string; args: string[]; env: Record<string, string> } {
    const bridge = this.bridgePath.replace(/\\/g, "/");
    if (!process.versions.electron) return { command: "node", args: [bridge], env: {} };
    if (!this.launcherPath) return { command: process.execPath.replace(/\\/g, "/"), args: [bridge], env: { ELECTRON_RUN_AS_NODE: "1" } };
    // A .cmd file needs cmd to run it, and cmd wants the path with backslashes.
    if (process.platform === "win32") return { command: "cmd", args: ["/c", this.launcherPath], env: {} };
    return { command: this.launcherPath, args: [], env: {} };
  }

  /** The text a user pastes to connect a command-line tool. */
  setup(kind: "claude" | "json"): string {
    const c = this.command();
    if (kind === "claude") {
      // "-e" and "--" only when there is an env to pass: PowerShell drops "--" before the command sees it.
      const env = Object.entries(c.env).map(([k, v]) => ` -e ${k}=${v}`).join("");
      const quote = (s: string) => (/[\s"]/.test(s) ? `"${s}"` : s);
      return `claude mcp add ${MCP_NAME}${env}${env ? " --" : ""} ${[c.command, ...c.args].map(quote).join(" ")}`;
    }
    return JSON.stringify({ mcpServers: { [MCP_NAME]: c } }, null, 2);
  }

  dispose(): void {
    this.removeInfo();
    this.registration?.dispose();
    this.changed.dispose();
  }
}

/** The bridge goes next to the hook in global storage: a path that stays the same across updates, so a tool's config keeps working. */
function installBridge(context: vscode.ExtensionContext): string {
  const src = path.join(context.extensionPath, "dist", MCP_BRIDGE_FILE);
  const dest = path.join(context.globalStorageUri.fsPath, MCP_BRIDGE_FILE);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
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

/**
 * The launcher next to the bridge: a .cmd or .sh file that runs the bridge on VS Code's own
 * program as Node, so a tool needs no Node and no env flag. Written at every start, so it
 * follows VS Code's program when an update moves it, and a tool's config keeps working.
 */
function installLauncher(bridge: string): string | undefined {
  if (!process.versions.electron) return undefined;
  const win = process.platform === "win32";
  const dest = path.join(path.dirname(bridge), win ? MCP_LAUNCHER_CMD : MCP_LAUNCHER_SH);
  const text = win
    ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "%~dp0${MCP_BRIDGE_FILE}" %*\r\n`
    : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$(dirname "$0")/${MCP_BRIDGE_FILE}" "$@"\n`;
  try {
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o755 });
    fs.renameSync(tmp, dest);
    return dest;
  } catch {
    return undefined;
  }
}
