import { test } from "node:test";
import assert from "node:assert/strict";
import { fileUrlToPath, parseStack, pickFrame } from "../../src/shared/stack";
import { isToolProcess } from "../../src/hook/tools";

test("V8 frames: paths, file URLs, internals, anonymous and async", () => {
  const stack = [
    "Error",
    "    at __inlineLogs_log (E:\\x\\hook.cjs:10:5)",
    "    at Object.<anonymous> (C:\\proj\\src\\app.js:12:9)",
    "    at async load (file:///home/me/my%20app/index.mjs:4:3)",
    "    at C:\\proj\\src\\top.js:1:1",
    "    at Module._compile (node:internal/modules/cjs/loader:1554:14)",
    "    at new Foo (/srv/app/foo.js:7:11)",
    "    at eval (eval at run (/srv/app/run.js:3:1), <anonymous>:1:1)",
    "    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
  ].join("\n");
  const frames = parseStack(stack);
  assert.deepEqual(
    frames.map((f) => [f.fn, f.file, f.line, f.col]),
    [
      ["__inlineLogs_log", "E:\\x\\hook.cjs", 10, 5],
      ["Object.<anonymous>", "C:\\proj\\src\\app.js", 12, 9],
      ["load", "file:///home/me/my%20app/index.mjs", 4, 3],
      [undefined, "C:\\proj\\src\\top.js", 1, 1],
      ["Module._compile", "node:internal/modules/cjs/loader", 1554, 14],
      ["new Foo", "/srv/app/foo.js", 7, 11],
      ["process.processTicksAndRejections", "node:internal/process/task_queues", 105, 5],
    ],
  );
});

test("browser frames: Chrome and Firefox/Safari", () => {
  const chrome = parseStack("Error\n    at http://localhost:5173/src/main.js?t=1700:6:9\n    at onClick (http://localhost:5173/src/ui.ts:3:1)");
  assert.deepEqual(chrome.map((f) => [f.file, f.line, f.col]), [
    ["http://localhost:5173/src/main.js?t=1700", 6, 9],
    ["http://localhost:5173/src/ui.ts", 3, 1],
  ]);
  const ff = parseStack("__inlineLogs_log@http://localhost:5173/:2:100\nonClick@http://localhost:5173/src/ui.ts:3:1\n@http://localhost:5173/src/main.js:6:9\n");
  assert.deepEqual(ff.map((f) => [f.fn, f.file, f.line]), [
    ["__inlineLogs_log", "http://localhost:5173/", 2],
    ["onClick", "http://localhost:5173/src/ui.ts", 3],
    [undefined, "http://localhost:5173/src/main.js", 6],
  ]);
  assert.equal(pickFrame(ff)?.frame.file, "http://localhost:5173/src/ui.ts");
});

test("the caller is the first app frame after our wrapper", () => {
  const frames = parseStack(
    [
      "Error",
      "    at __inlineLogs_log (/x/hook.cjs:1:1)",
      "    at Logger.info (/app/node_modules/tiny-logger/index.js:20:13)",
      "    at handler (/app/src/server.js:42:7)",
      "    at node:internal/main:1:1",
    ].join("\n"),
  );
  const picked = pickFrame(frames);
  assert.equal(picked?.frame.file, "/app/src/server.js");
  assert.equal(picked?.frame.line, 42);
  assert.equal(picked?.lib, false);
});

test("a stack that is all library code is marked lib", () => {
  const frames = parseStack("Error\n    at log (/app/node_modules/vite/dist/node/cli.js:9:3)\n    at node:internal/x:1:1");
  const picked = pickFrame(frames);
  assert.equal(picked?.lib, true);
  assert.equal(picked?.frame.line, 9);
  assert.equal(pickFrame(parseStack("Error\n    at node:internal/x:1:1")), undefined);
});

test("Vite's own client and pre-bundled deps are not the caller", () => {
  const frames = parseStack(
    [
      "Error",
      "    at http://localhost:5173/@vite/client:800:5",
      "    at http://localhost:5173/node_modules/.vite/deps/lodash.js?v=1:10:1",
      "    at http://localhost:5173/src/main.ts:4:2",
    ].join("\n"),
  );
  assert.equal(pickFrame(frames)?.frame.file, "http://localhost:5173/src/main.ts");
});

test("skip callback drops the hook's own file", () => {
  const frames = parseStack("Error\n    at x (/ext/hook.cjs:5:5)\n    at /app/a.js:2:2");
  assert.equal(pickFrame(frames, (f) => f === "/ext/hook.cjs")?.frame.file, "/app/a.js");
});

test("file URLs to paths", () => {
  assert.equal(fileUrlToPath("file:///C:/Users/A%20B/app.mjs"), "C:/Users/A B/app.mjs");
  assert.equal(fileUrlToPath("file:///home/me/app.mjs"), "/home/me/app.mjs");
  assert.equal(fileUrlToPath("file:///home/me/app.mjs?v=2"), "/home/me/app.mjs");
  assert.equal(fileUrlToPath("C:\\a\\b.js"), "C:\\a\\b.js");
});

test("package managers and runners are tools, the app is not", () => {
  for (const tool of [
    "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    "/usr/lib/node_modules/npm/bin/npx-cli.js",
    "/home/me/.local/share/pnpm/pnpm.cjs",
    "/usr/lib/node_modules/corepack/dist/pnpm.js",
    "/app/node_modules/nodemon/bin/nodemon.js",
    "/app/node_modules/.bin/nodemon",
    "/app/node_modules/tsx/dist/cli.mjs",
    "/app/node_modules/concurrently/dist/bin/concurrently.js",
    "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\resources\\app\\out\\cli.js",
    "B:/~BUN/root/claude.exe",
    "/$bunfs/root/claude",
  ])
    assert.equal(isToolProcess(tool), true, tool);
  for (const app of ["/app/index.js", "/app/node_modules/vite/bin/vite.js", "/app/node_modules/ts-node/dist/bin.js", "C:\\proj\\server.mjs", undefined])
    assert.equal(isToolProcess(app), false, String(app));
});

test("Bun: a top-level frame has no column", () => {
  const frames = parseStack("Error\n    at E:\\app\\index.js:3\n    at named (E:\\app\\index.js:6:31)");
  assert.deepEqual(frames.map((f) => [f.fn, f.file, f.line, f.col]), [
    [undefined, "E:\\app\\index.js", 3, 1],
    ["named", "E:\\app\\index.js", 6, 31],
  ]);
});

test("bundled frames are mapped before the app frame is picked", () => {
  const frames = parseStack(
    [
      "Error",
      "    at __inlineLogs_log (/x/hook.cjs:1:1)",
      "    at /app/.next/server/chunks/a.js:40:3",
      "    at /app/.next/server/chunks/a.js:90:9",
      "    at webpack://app/webpack/runtime/x:1:1",
    ].join("\n"),
  );
  // Line 40 of the chunk is React (node_modules), line 90 is the page.
  const map = (f: { file: string; line: number; col: number }) =>
    f.line === 40 ? { ...f, file: "/app/node_modules/react/x.js" } : f.line === 90 ? { ...f, file: "/app/app/page.js", line: 8 } : f;
  const picked = pickFrame(frames, undefined, map);
  assert.deepEqual([picked?.frame.file, picked?.frame.line, picked?.lib], ["/app/app/page.js", 8, false]);
  // A frame the map drops (bundler runtime) is skipped.
  assert.equal(pickFrame(parseStack("Error\n    at /app/b.js:1:1"), undefined, () => undefined), undefined);
});
