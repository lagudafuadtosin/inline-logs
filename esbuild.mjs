import esbuild from "esbuild";

const production = process.argv.includes("--production");

// 1. The browser client, as one small script that gets inlined into the hook.
const client = await esbuild.build({
  entryPoints: ["src/client/index.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2019"],
  minify: true,
  write: false,
  legalComments: "none",
});
const clientJs = client.outputFiles[0].text.trim().replace(/<\/script/gi, "<\\/script");

// 2. The hook Node loads with --require. No dependencies, runs on Node 16+.
await esbuild.build({
  entryPoints: ["src/hook/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node16",
  minify: production,
  outfile: "dist/hook.cjs",
  define: { __CLIENT_JS__: JSON.stringify(clientJs) },
  legalComments: "none",
});

// 3. The value graph's webview script, inlined into the extension.
const graph = await esbuild.build({
  entryPoints: ["src/graph/view.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  write: false,
  legalComments: "none",
});
const graphJs = graph.outputFiles[0].text.trim().replace(/<\/script/gi, "<\\/script");

// 4. The stdio MCP bridge for command-line AI tools. No dependencies.
await esbuild.build({
  entryPoints: ["src/mcpbridge.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node16",
  minify: production,
  outfile: "dist/mcp.cjs",
  legalComments: "none",
});

// 5. The log commands (insert, comment out, uncomment, remove), with TypeScript's
//    parser in them. A file of its own, loaded the first time one runs.
await esbuild.build({
  entryPoints: ["src/logedit.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  minify: production,
  outfile: "dist/logedit.js",
  legalComments: "none",
});

// 6. The extension.
await esbuild.build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  external: ["vscode"],
  platform: "node",
  format: "cjs",
  target: "node18",
  minify: production,
  sourcemap: !production,
  outfile: "dist/extension.js",
  define: { __GRAPH_JS__: JSON.stringify(graphJs) },
});
console.log(`built dist/extension.js, dist/hook.cjs, dist/mcp.cjs and dist/logedit.js (browser client ${clientJs.length} bytes, graph view ${graphJs.length} bytes)`);
