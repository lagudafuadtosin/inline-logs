# Changelog

## 0.5.1

- Licensed under the GNU General Public License, version 3 or any later version. TypeScript, bundled for the log commands, is listed with its Apache 2.0 licence in THIRD-PARTY-NOTICES.md.

## 0.5.0

- The Copy MCP Setup line for Claude Code points at a launcher next to the bridge, with no `--` and no `-e`, so it pastes into PowerShell as well as bash, and it keeps working after a VS Code update moves VS Code's program.
- VS Code's own command line (`code --install-extension` and friends) and programs compiled with `bun build --compile`, such as Claude Code, are left alone by the hook.
- Remote windows: WSL, SSH, dev containers and Codespaces. The extension runs on the remote side, next to your app, and values, hovers, the Problems panel and the Log Map work on the remote files. Checked with WSL.
- React Router 7 on Vite 7: loaders and actions land on their own line, through the source map Vite puts in the code it runs from memory.
- Next.js routes in the Edge runtime, with Turbopack or webpack.
- `bun test`: logs inside tests land on their lines.
- Bun and Deno record `http` and `https` calls and the built-in `WebSocket`, as Node does.
- The `ws` package's `WebSocket`, `EventSource` (in the browser, Deno and Node) and `navigator.sendBeacon` in the request log.
- `http` bodies sent compressed (gzip, deflate, br, zstd) are unpacked from a copy. The body of a `Request` object passed to `fetch` is shown, read from a clone. The hover says when a response body ended, as well as when its headers came.
- A custom webpack dev server script gets the browser script whether it loads webpack-dev-server with `require` or `import`.
- Jest: the values are the values the test logged, so they compare and draw as a graph. With `--silent` they still show.
- tslog's JSON output shows on the calling line when tslog records where each call was made.
- Astro: two identical lines in one `<script>` each land on their own line.
- A line with several calls, such as a request and the log in its callback, shows each call's newest value side by side.
- In the browser, a page's errors leave the Problems panel when the page loads again.
- Values from a process that ends with no warning arrive at once: the extension watches the folder of the small files each process writes.
- Code coverage for Deno apps, from Deno's own coverage files.
- The value graph draws a big value in parts: click an `[Object]` or `[Array]` row, or a box's `… more` row, to draw the rest.
- The MCP setup for command-line AI tools runs the bridge with VS Code's own program, so no Node is needed.
- New keys for the log commands, Ctrl+K then L, Shift+C, Shift+U or Shift+D (Cmd+K on Mac). They are none of VS Code's own keys on Windows, Linux or Mac, and with no Alt, keyboards that type letters with AltGr keep them.
- An `http` request error your app does not handle prints exactly the trace Node prints without the extension.
- A new run's errors show in the Problems panel also when the system gives its process the id an earlier process had.
- Browser entries reach VS Code in the order the page logged them, across all of its posts.

## 0.4.0

- Insert Log for Selection (Ctrl+Alt+L, Cmd+Alt+L on Mac) adds a `console.log` with the file and line for the selection or the name under the cursor, in the file's indentation, quotes and semicolons. Comment Out, Uncomment and Remove Console Calls in This File (Ctrl+Shift+Alt+C, U and D) work on real calls only, found with TypeScript's parser, in JavaScript, TypeScript, JSX, Svelte, Vue, HTML and Astro files.
- A line that ran several times shows `×N`, and its hover lists the last ten runs with their time and value.
- `console.count`, `countReset`, `time`, `timeLog`, `timeEnd`, `group`, `groupCollapsed` and a failing `console.assert` show on their lines, in Node and in the browser. A log inside a group names the group in its hover. What the terminal prints is unchanged.
- Pause or Resume is one command, and the status bar says Paused. Export Entries to a File saves everything as JSON or plain text.
- Svelte 5's `$inspect` values show on the `$inspect` line.
- Copy Value as JSON, from the command, a link in the hover, and **copy** in the log viewer.
- The log viewer has a search box with the same words as Search Logs.
- pino, winston, consola and tslog calls show on the line that called them, in their level's colour, with their output unchanged. New theme colour `inlineLogs.infoForeground`.
- WebSockets in the request log: the browser's and Node's built-in `WebSocket`. Opening, messages both ways, close and errors, with messages redacted like bodies.
- Uncaught errors in the Problems panel, so Error Lens and others show them. They go when the line is edited or the program runs again. New setting `inlineLogs.problems`.
- Copy Setup for an Outside Terminal copies one line for PowerShell, Command Prompt, bash, zsh or fish, so apps started in a terminal outside VS Code report to the window.
- Monorepos and windows with several folders: packages running at once each land on their own files, and paths name their folder.
- SvelteKit, Nuxt, Astro and React Router 7 dev servers, on the server and in the browser. Astro `<script>` logs land on their line in the `.astro` file.
- Output from `node -e` code, which tools run in the background, is left out, as it has no file to show on.

## 0.3.0

- Requests. `fetch`, `XMLHttpRequest` and Node `http` and `https` calls show on the line that made them, with method, status, time and URL. The hover has headers and text or JSON bodies up to 16,000 characters. Secret headers, and JSON and form fields named like passwords, tokens or keys, are redacted inside the app. Bodies are read from a copy, so the app's own request and response are untouched. New settings `inlineLogs.requests` and `inlineLogs.requestBodies`, and a Pause or Resume Request Log command.
- An MCP server for AI tools, off by default (`inlineLogs.mcp`). Read-only tools list recent logs, errors and requests, search them, and give one entry in full. VS Code's own chat finds it by itself from VS Code 1.101. Command-line tools such as Claude Code connect through a small script, set up with Copy MCP Setup for an AI Tool. It listens on 127.0.0.1 with its own key.
- Compare values in VS Code's diff editor: a value with the one before it from the same line, or any two values. Objects show as pretty JSON.
- Search Logs, across every log, error and request, with `kind:`, `level:`, `file:` and `status:` filters. The Log Map, a tree of files and lines in the bottom panel.
- Value graph. Objects and arrays drawn as boxes, with zoom, pan, fit and fold, from the hover, the viewer or a command.
- Code coverage for Node apps in the gutter, off by default (`inlineLogs.coverage`). Mapped through source maps, added up across runs, with a Clear Coverage command.
- The log viewer has buttons on each row to compare and to draw a value, and a switch to hide requests.

## 0.2.0

- Next.js dev servers, with Turbopack or webpack. Logs from server components, route handlers and `getServerSideProps` land on your source lines, and so do logs from client components in the browser. App router and pages router.
- Browser logs for webpack-dev-server (`webpack serve`), with webpack's default `eval` setting, `eval-source-map` or `source-map`.
- Jest and Vitest. Logs inside tests land on the test's lines, also from worker processes. Jest prints exactly what it prints without the extension.
- ts-node.
- Bun, through `BUN_OPTIONS`, in a form every bun command accepts. Deno, through `NODE_OPTIONS`, when the script has the permissions it needs. Without them the hook stays off and asks nothing.
- `console.table`, `console.dir` and `console.trace`. The line shows the table's size and columns, the object, or the trace message. The hover shows the drawn table, the whole object, or the call stack.
- Logs right before Ctrl+C or a killed process arrive. Each value is also written at once to a small file in the extension's storage, read when a process ends with no chance to send.
- Pages with a Content-Security-Policy. The client script reuses the page's nonce, or its own hash is added to the policy.
- Pages streamed in pieces and pages a dev server would compress get the client script too.

## 0.1.0

First release. Console output and uncaught errors from Node apps started in the VS Code terminal show at the end of the line that made them, for CommonJS, ES modules and TypeScript through tsx. Browser console output and errors for Vite dev servers, with no config. Hover for the full value and hit count, a log viewer with filters, Clear, Pause and Resume, and values that move with their lines as you edit.
