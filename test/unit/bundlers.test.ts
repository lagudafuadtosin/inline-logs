// Source maps and module URLs from bundlers: Turbopack index maps, webpack's
// eval devtools, external .map files, and which pages get the client. The
// webpack cases compile the real fixture with the real webpack.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { evalMaps, evalSources, externalMapUrl, inlineAnyMap, lineInSource, makeMapper, parseMap, type IndexMap, type RawMap } from "../../src/hook/sourcemap";
import { injectInto, isDevServerProcess, sourceToFile } from "../../src/hook/browser";
import { expectedLines } from "../expect";

const root = path.resolve(import.meta.dirname, "..", "..");
const fixtures = path.join(root, "test-fixtures");

test("an index map (sections) maps each part through its own map", () => {
  const index: IndexMap = {
    version: 3,
    sections: [
      { offset: { line: 0, column: 0 }, map: { version: 3, sources: ["a.js"], mappings: "AAAA;AACA" } },
      { offset: { line: 10, column: 0 }, map: { version: 3, sources: ["file:///p/b.js"], mappings: "AAAA;AAEA" } },
    ],
  };
  const m = makeMapper(index);
  assert.deepEqual(m.original(1, 1), { source: "a.js", line: 1, col: 1 });
  assert.deepEqual(m.original(2, 1), { source: "a.js", line: 2, col: 1 });
  assert.deepEqual(m.original(11, 1), { source: "file:///p/b.js", line: 1, col: 1 });
  assert.deepEqual(m.original(12, 1), { source: "file:///p/b.js", line: 3, col: 1 });
  const parsed = parseMap(JSON.stringify(index));
  assert.ok(parsed && "sections" in parsed);
});

test("external and inline map comments", () => {
  assert.equal(externalMapUrl("x()\n//# sourceMappingURL=chunk.js.map\n"), "chunk.js.map");
  assert.equal(externalMapUrl("x()\n//# sourceMappingURL=data:application/json;base64,e30=\n"), undefined);
  assert.equal(externalMapUrl("no map"), undefined);
  const idx = Buffer.from(JSON.stringify({ version: 3, sections: [] })).toString("base64");
  assert.ok(inlineAnyMap(`a\n//# sourceMappingURL=data:application/json;base64,${idx}`));
});

test("bundler module URLs and map sources to files", () => {
  const r = path.resolve("/proj");
  assert.equal(sourceToFile("webpack-internal:///(app-pages-browser)/./app/page.js", "", r), path.join(r, "app", "page.js"));
  assert.equal(sourceToFile("webpack://my-app/./src/a.js?", "", r), path.join(r, "src", "a.js"));
  assert.equal(sourceToFile("webpack:///./src/b.ts", "", r), path.join(r, "src", "b.ts"));
  assert.equal(sourceToFile("turbopack:///[project]/app/x.tsx", "", r), path.join(r, "app", "x.tsx"));
  assert.equal(sourceToFile("webpack://my-app/webpack/runtime/jsonp", "", r), undefined);
  assert.equal(sourceToFile("webpack://_N_E/webpack/bootstrap", "", r), undefined);
  assert.equal(sourceToFile("turbopack:///[turbopack]/browser/runtime.ts", "", r), undefined);
  assert.equal(sourceToFile("file:///C:/proj/app/page.js", "", r), path.normalize("C:/proj/app/page.js"));
  // Relative sources of a map file on disk resolve from the map's folder.
  assert.equal(sourceToFile("../src/x.ts", "", r, path.join(r, "dist")), path.join(r, "src", "x.ts"));
});

test("webpack's eval-source-map: the module's own map is found by its sourceURL", () => {
  const map = { version: 3, sources: ["C:\\proj\\app\\page.js"], mappings: ";;AAAA;AACA" };
  const b64 = Buffer.from(JSON.stringify(map)).toString("base64");
  const chunk = `eval(__webpack_require__.ts("x\\ny\\nconsole.log(1)\\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${b64}\\n//# sourceURL=webpack-internal:///(rsc)/./app/page.js\\n"));`;
  const maps = evalMaps(chunk);
  assert.deepEqual([...maps.keys()], ["webpack-internal:///(rsc)/./app/page.js"]);
  const raw = parseMap(Buffer.from(maps.get("webpack-internal:///(rsc)/./app/page.js")!, "base64").toString()) as RawMap;
  assert.deepEqual(makeMapper(raw).original(3, 1), { source: "C:\\proj\\app\\page.js", line: 1, col: 1 });
});

test("webpack's plain eval: lines are lined up with the source file", () => {
  const source = "// top\nimport { a } from './a.js';\n\nexport function f() {\n  console.log(a);\n}\n";
  const evald = "{__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(x);\n/* harmony import */ var _a = __webpack_require__(1);\n// top\n\n\nfunction f() {\n  console.log(_a.a);\n}\n\n//# sourceURL=webpack://app/./src/f.js?\n}";
  const chunk = `"./src/f.js": (() => { eval(${JSON.stringify(evald)}); })`;
  const codes = evalSources(chunk);
  assert.equal(codes.get("webpack://app/./src/f.js?"), evald);
  assert.equal(lineInSource(evald, source, 8), 5);
  assert.equal(lineInSource("nothing alike", source, 3), undefined);
});

// The real thing: the webpack fixture compiled three ways, and every marked line found from the bundle.
const req = createRequire(path.join(fixtures, "webpack-app", "package.json"));
for (const devtool of ["eval", "eval-source-map", "source-map"]) {
  test(`real webpack output (devtool ${devtool}) maps back to the marked lines`, async () => {
    const webpack = req("webpack") as (c: object) => { outputFileSystem: unknown; run(cb: (err: Error | null, stats?: { hasErrors(): boolean; toString(): string }) => void): void; close(cb: () => void): void };
    const mfs = new Map<string, Buffer>();
    const compiler = webpack({
      mode: "development",
      devtool,
      context: path.join(fixtures, "webpack-app"),
      entry: "./src/index.js",
      output: { path: "/out", filename: "main.js" },
      infrastructureLogging: { level: "none" },
    });
    // Output into memory: nothing is written to the fixture.
    compiler.outputFileSystem = memoryFs(mfs);
    const errors = await new Promise<string | undefined>((resolve) => compiler.run((err, stats) => compiler.close(() => resolve(err ? String(err) : stats?.hasErrors() ? stats.toString() : undefined))));
    assert.equal(errors, undefined);
    const code = mfs.get(path.normalize("/out/main.js"))!.toString("utf8");
    const files = { index: path.join(fixtures, "webpack-app", "src", "index.js"), shapes: path.join(fixtures, "webpack-app", "src", "shapes.js") };
    const want = [
      [files.index, "wp-settings"],
      [files.index, "wp-area"],
      [files.shapes, "wp-module"],
    ] as const;
    const genLines = code.split("\n");
    for (const [file, marker] of want) {
      const srcLine = expectedLines(file).get(marker)!;
      const srcText = readFileSync(file, "utf8").split(/\r?\n/)[srcLine - 1].trim();
      const name = `./src/${path.basename(file)}`;
      let got: number | undefined;
      if (devtool === "source-map") {
        const map = parseMap(mfs.get(path.normalize("/out/main.js.map"))!.toString("utf8"))!;
        const genLine = genLines.findIndex((l) => l.includes(srcText.slice(0, 20))) + 1;
        const o = makeMapper(map).original(genLine, genLines[genLine - 1].indexOf("console") + 1);
        assert.equal(sourceToFile(o!.source, "", path.join(fixtures, "webpack-app")), file);
        got = o?.line;
      } else {
        // Inside the eval string the module's own lines are what the browser reports.
        const evalUrl = [...(devtool === "eval" ? evalSources(code).keys() : evalMaps(code).keys())].find((u) => u.includes(name))!;
        assert.ok(evalUrl, `module ${name} in the bundle`);
        if (devtool === "eval") {
          const evald = evalSources(code).get(evalUrl)!;
          const at = evald.split("\n").findIndex((l) => l.includes(srcText.slice(0, 20))) + 1;
          got = lineInSource(evald, readFileSync(file, "utf8"), at);
        } else {
          const map = parseMap(Buffer.from(evalMaps(code).get(evalUrl)!, "base64").toString("utf8"))!;
          // The eval'd module code, where the browser's line numbers count from.
          const literal = new RegExp(`eval\\(("(?:[^"\\\\]|\\\\.)*sourceURL=${evalUrl.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?:\\\\n)*\\}?")\\)`).exec(code)![1];
          const evald = (JSON.parse(literal) as string).split("\n");
          const at = evald.findIndex((l) => l.includes(srcText.slice(0, 20)));
          got = makeMapper(map).original(at + 1, evald[at].indexOf("console") + 1)?.line;
        }
      }
      assert.equal(got, srcLine, `${marker} (${devtool})`);
    }
  });
}

test("which pages get the client", () => {
  const script = "<script>__INLINE_LOGS__</script>";
  const next = '<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/>';
  assert.equal(injectInto(next, script, false), next, "not a dev server process: left alone");
  assert.ok(injectInto(next, script, true).startsWith(`<!DOCTYPE html><html lang="en"><head>${script}<meta`));
  assert.equal(injectInto("<p>a fragment</p>", script, true), "<p>a fragment</p>", "fragments are left alone");
  assert.equal(injectInto(injectInto(next, script, true), script, true), injectInto(next, script, true), "once");
});

test("dev server processes are known by command, variable or loaded modules", () => {
  // Each check is fresh: a "true" is remembered for the process, so test the false ones first.
  assert.equal(isDevServerProcess(["node", "/p/app.js"], {}, {}), false);
  assert.equal(isDevServerProcess(["node", "/p/node_modules/webpack/bin/webpack.js", "build"], {}, {}), false);
  assert.equal(isDevServerProcess(["node", "/p/node_modules/webpack/bin/webpack.js", "serve"], {}, {}), true);
});

function memoryFs(files: Map<string, Buffer>) {
  const norm = (p: string) => path.normalize(p);
  return {
    mkdir: (_p: string, _o: unknown, cb: (e?: Error) => void) => (typeof _o === "function" ? (_o as (e?: Error) => void)() : cb()),
    writeFile: (p: string, data: Buffer | string, cb: (e?: Error) => void) => {
      files.set(norm(p), Buffer.from(data));
      cb();
    },
    stat: (p: string, cb: (e: Error | null, s?: object) => void) => (files.has(norm(p)) ? cb(null, { isFile: () => true, isDirectory: () => false }) : cb(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))),
    readFile: (p: string, cb: (e: Error | null, d?: Buffer) => void) => (files.has(norm(p)) ? cb(null, files.get(norm(p))) : cb(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))),
    join: path.join,
    relative: path.relative,
    dirname: path.dirname,
  };
}
