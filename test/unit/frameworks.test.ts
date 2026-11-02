// What the dev servers of SvelteKit, Astro, React Router and Nuxt need:
// their dev commands are known, SvelteKit's pages take the client, Nuxt's
// base path and Astro's <script> modules map back to the file, and tools'
// own "node -e" runs are not shown.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { astroScriptLine, injectInto, isDevServerProcess, urlPathToFile } from "../../src/hook/browser";
import { isInternal, pickFrame } from "../../src/shared/stack";
import { fixtures } from "../hooked";

test("dev commands of Vite and the frameworks on it are dev servers; builds and previews are not", () => {
  const is = (script: string, ...args: string[]) => isDevServerProcess(["node", script, ...args], {}, {});
  // Each call is a fresh check: the answer is kept once it is yes, so the no cases come first.
  assert.equal(is("/app/node_modules/vite/bin/vite.js", "build"), false);
  assert.equal(is("/app/node_modules/vite/bin/vite.js", "preview"), false);
  assert.equal(is("/app/node_modules/astro/astro.js", "build"), false);
  assert.equal(is("/app/node_modules/@react-router/dev/bin.js", "build"), false);
  assert.equal(is("/app/node_modules/vite/bin/vite.js", "dev", "--port", "5206"), true);
});

test("SvelteKit's dev page (no /@vite/client in it) takes the client", () => {
  const page = '<!doctype html><html><head></head><body><script>__sveltekit_dev = {}; import("./@fs/E:/app/.svelte-kit/generated/client/app.js")</script></body></html>';
  assert.ok(injectInto(page, "<script>X</script>").includes("<head><script>X</script>"));
  assert.equal(injectInto("<html><head></head></html>", "<script>X</script>"), "<html><head></head></html>", "other servers' pages are left alone");
});

test("Nuxt serves from /_nuxt/: the file is found below the base path", () => {
  const root = path.join(fixtures, "nuxt-app");
  assert.equal(urlPathToFile("/_nuxt/app.vue", root), path.join(root, "app.vue"));
  assert.equal(urlPathToFile("/_nuxt/@fs/E:/x/y.js", root), path.normalize("E:/x/y.js"));
  assert.equal(urlPathToFile("/src/main.js", path.join(fixtures, "vite-app")), path.join(fixtures, "vite-app", "src", "main.js"));
});

test("an Astro <script> maps to its line in the .astro file, by its text", () => {
  const file = path.join(fixtures, "astro-app", "src", "pages", "index.astro");
  assert.deepEqual(astroScriptLine(file, 0, 'console.log("astro script", seen);', 1), { file, line: 11, col: 7 });
  assert.equal(astroScriptLine(file, 0, "not in the file", 1)?.line, 9, "else the script's own tag");
  assert.equal(astroScriptLine(file, 3, "x", 1), undefined);
});

test("node -e code has no file: its frames are skipped", () => {
  assert.ok(isInternal({ file: "[eval]", line: 1, col: 1 }));
  assert.equal(pickFrame([{ file: "[eval]", line: 1, col: 9 }]), undefined);
});
