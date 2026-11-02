import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { decodeMappings, inlineMap, originalFor } from "../../src/hook/sourcemap";
import { injectInto, sourceToFile, urlPathToFile } from "../../src/hook/browser";

test("decodes VLQ mappings and maps generated positions back", () => {
  // Line 1: col 0 -> src 0 line 0 col 0; col 4 -> line 2 col 2.
  // Line 2: col 0 -> line 5 col 0.
  const map = { version: 3, sources: ["a.ts"], mappings: "AAAA,IAEE;AAGF" };
  const d = decodeMappings(map.mappings);
  assert.deepEqual(d[0], [
    [0, 0, 0, 0],
    [4, 0, 2, 2],
  ]);
  assert.deepEqual(d[1], [[0, 0, 5, 0]]);
  assert.deepEqual(originalFor(map, d, 1, 1), { source: "a.ts", line: 1, col: 1 });
  assert.deepEqual(originalFor(map, d, 1, 9), { source: "a.ts", line: 3, col: 3 });
  assert.deepEqual(originalFor(map, d, 2, 3), { source: "a.ts", line: 6, col: 1 });
  assert.equal(originalFor(map, d, 3, 1), undefined);
});

test("reads an inline base64 source map", () => {
  const json = JSON.stringify({ version: 3, sources: ["x.ts"], mappings: "AAAA" });
  const code = `console.log(1)\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(json).toString("base64")}\n`;
  assert.deepEqual(inlineMap(code)?.sources, ["x.ts"]);
  assert.equal(inlineMap("no map here"), undefined);
});

test("served URLs and map sources to files", () => {
  const root = path.resolve("/proj");
  assert.equal(urlPathToFile("/src/main.js", root), path.join(root, "src", "main.js"));
  assert.equal(urlPathToFile("/@fs/C:/other/x.js", root), path.normalize("C:/other/x.js"));
  assert.equal(sourceToFile("describe.ts", "/src/describe.ts", root), path.join(root, "src", "describe.ts"));
  assert.equal(sourceToFile("../lib/u.ts", "/src/a/b.ts", root), path.join(root, "src", "lib", "u.ts"));
  assert.equal(sourceToFile("C:\\abs\\file.ts", "/src/x.ts", root), path.normalize("C:\\abs\\file.ts"));
});

test("HTML injection only for Vite dev pages, once, inside <head>", () => {
  const vite = '<!doctype html><html><head lang="x"><script type="module" src="/@vite/client"></script></head><body></body></html>';
  const out = injectInto(vite, "<script>window.__INLINE_LOGS__={}</script>");
  assert.ok(out.startsWith('<!doctype html><html><head lang="x"><script>window.__INLINE_LOGS__'));
  assert.equal(injectInto(out, "<script>window.__INLINE_LOGS__={}</script>"), out);
  const plain = "<html><head></head><body>not vite</body></html>";
  assert.equal(injectInto(plain, "<script></script>"), plain);
  const headless = '<script type="module" src="/@vite/client"></script><p>hi</p>';
  assert.ok(injectInto(headless, "<script>__INLINE_LOGS__</script>").startsWith("<script>__INLINE_LOGS__</script><script type=\"module\""));
});
