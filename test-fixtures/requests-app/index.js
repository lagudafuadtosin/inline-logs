// Makes requests to its own local server with fetch and node:http, and prints
// what it got back, so a run with the hook can be compared with one without.
// Lines marked "// @expect <name>" are checked by the tests.
const http = require("node:http");

const big = "x".repeat(40_000);
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/user") {
      res.setHeader("content-type", "application/json");
      res.setHeader("set-cookie", "sid=abc123");
      res.end(JSON.stringify({ name: "Ada", token: "t-123" }));
    } else if (req.url === "/echo") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ got: JSON.parse(body || "null"), auth: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null }));
    } else if (req.url === "/big") {
      res.setHeader("content-type", "text/plain");
      res.end(big);
    } else if (req.url === "/missing") {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain");
      res.end("nope");
    } else {
      res.setHeader("content-type", "application/octet-stream");
      res.end(Buffer.from([1, 2, 3]));
    }
  });
});

server.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const user = await fetch(`${base}/user`); // @expect fetch-get
  console.log("user", await user.json(), user.headers.get("set-cookie"));
  const echo = await fetch(`${base}/echo`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer secret-1" }, body: JSON.stringify({ q: 1, password: "hunter2" }) }); // @expect fetch-post
  console.log("echo", await echo.json());
  const bigRes = await fetch(`${base}/big`); // @expect fetch-big
  console.log("big length", (await bigRes.text()).length);
  const missing = await fetch(`${base}/missing`); // @expect fetch-404
  console.log("missing", missing.status, await missing.text());
  await fetch("http://127.0.0.1:9/").catch((e) => console.log("refused", e.name)); // @expect fetch-fail
  await new Promise((resolve) => http.get(`${base}/user`, (res) => { let b = ""; res.setEncoding("utf8"); res.on("data", (c) => (b += c)); res.on("end", () => { console.log("http.get", b); resolve(); }); })); // @expect http-get
  await new Promise((resolve) => { const req = http.request(`${base}/echo`, { method: "POST", headers: { "content-type": "application/json", cookie: "a=b" } }, (res) => { const parts = []; res.on("data", (c) => parts.push(c)); res.on("end", () => { console.log("http.request", Buffer.concat(parts).toString()); resolve(); }); }); req.write('{"n":'); req.end("2}"); }); // @expect http-post
  // Nobody reads this response: Node throws it away, the same with or without the hook.
  await new Promise((resolve) => http.get(`${base}/bin`).on("close", resolve)); // @expect http-unread
  server.close(() => console.log("done"));
});
