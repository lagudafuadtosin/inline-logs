// Editors built on VS Code that install from Open VSX (Cursor, Windsurf and
// others): the extension asks for VS Code 1.75, is type checked against the
// 1.75 API (npm run typecheck), and every newer API it uses is looked up and
// checked for before it is used, so an editor without it simply goes without.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { root } from "../hooked";

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { engines: { vscode: string }; devDependencies: Record<string, string>; contributes: Record<string, unknown> };
const src = (f: string) => readFileSync(path.join(root, "src", f), "utf8");

test("needs VS Code 1.75, and the types it is checked against are 1.75's", () => {
  assert.equal(pkg.engines.vscode, "^1.75.0");
  assert.match(pkg.devDependencies["@types/vscode"], /^~1\.75\./);
  const types = JSON.parse(readFileSync(path.join(root, "node_modules", "@types", "vscode", "package.json"), "utf8")) as { version: string };
  assert.match(types.version, /^1\.75\./);
});

test("each API newer than 1.75 is checked for before use", () => {
  const ext = src("extension.ts");
  const mcp = src("mcphost.ts");
  // The MCP list for VS Code's own chat (1.101): only when the editor has it.
  assert.match(mcp, /const lm = \(vscode as unknown as \{ lm\?: Partial<McpApi> \}\)\.lm;\s+[\s\S]{0,40}if \(typeof lm\?\.registerMcpServerDefinitionProvider === "function"\)/);
  assert.match(mcp, /const Def = \(vscode as unknown as \{ McpHttpServerDefinition\?: HttpDefinition \}\)\.McpHttpServerDefinition;\s+if \(!this\.token \|\| typeof Def !== "function"\) return \[\];/);
  // Command links in hovers limited to our commands (1.77): only on 1.77 or later.
  assert.match(ext, /const links = !versionBelow\(vscode\.version, 1, 77\);/);
  assert.match(ext, /if \(actions\.length\) \{[\s\S]{0,200}isTrusted = \{ enabledCommands/);
  assert.match(ext, /if \(links && info\.count > 1\)[\s\S]*if \(links\) actions\.push/);
  // The terminal variables' description (1.76): set inside a try.
  assert.match(ext, /try \{\s+\(env as unknown as \{ description\?: string \}\)\.description/);
  // Nothing else reaches past the 1.75 types.
  const casts = [...["extension.ts", "mcphost.ts", "viewer.ts", "logmap.ts", "diff.ts", "coverageview.ts", "graph/panel.ts"].flatMap((f) => src(f).match(/\(vscode as unknown as|\((md|env) as unknown as/g) ?? [])];
  assert.equal(casts.length, 4);
});

test("contributions an older editor does not know are only extra", () => {
  // mcpServerDefinitionProviders is ignored where there is no MCP list; the rest is from 1.75.
  assert.ok(Array.isArray(pkg.contributes.mcpServerDefinitionProviders));
  const keys = Object.keys(pkg.contributes).sort();
  assert.deepEqual(keys, ["colors", "commands", "configuration", "keybindings", "mcpServerDefinitionProviders", "menus", "views", "viewsContainers"]);
});
