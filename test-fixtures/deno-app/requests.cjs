// node:http, fetch with a Request object and the global WebSocket, for Bun
// and Deno (deno run -A requests.cjs <ws port>, bun requests.cjs <ws port>).
// A WebSocket echo server listens on the port given (sockets-app/echo.js).
// Lines marked "@expect" are where the entries must land.
const http = require("node:http");

const port = Number(process.argv[2]);
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ path: req.url, got: body }));
  });
});
server.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => http.get(`${base}/get`, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { console.log("rt get", b); resolve(); }); })); // @expect rt-http-get
  await new Promise((resolve) => {
    const req = http.request(`${base}/post`, { method: "POST", headers: { "content-type": "application/json" } }, (res) => { res.resume(); res.on("end", resolve); }); // @expect rt-http-post
    req.end(JSON.stringify({ n: 1, password: "pw" }));
  });
  const r = await fetch(new Request(`${base}/req`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ via: "Request", token: "t" }) })); // @expect rt-fetch-request
  console.log("rt fetch", await r.text());
  const ws = new WebSocket(`ws://127.0.0.1:${port}/rt`); // @expect rt-ws
  ws.addEventListener("open", () => ws.send("rt ping")); // @expect rt-ws-send
  ws.addEventListener("message", () => {
    ws.close(1000);
    server.close();
  });
});
