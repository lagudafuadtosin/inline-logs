// Node's global WebSocket talking to a small echo server (the ws package),
// and one socket to a port nothing listens on. Lines marked "@expect" are
// where the entries must land.
const { WebSocketServer } = require("ws");

const server = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () => {
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live?token=abc123&room=7`); // @expect ws-open
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "hello", password: "hunter2" })); // @expect ws-send
    ws.send(new Uint8Array([1, 2, 3, 4]));
  });
  let got = 0;
  ws.addEventListener("message", (ev) => {
    got++;
    if (got === 2) ws.close(1000, "done");
    console.log("echo", typeof ev.data === "string" ? ev.data.length : "binary");
  });
  ws.addEventListener("close", () => {
    server.close();
    const dead = new WebSocket("ws://127.0.0.1:9/nothing"); // @expect ws-dead
    dead.onerror = () => console.log("dead socket failed as expected");
  });
});
server.on("connection", (s) => s.on("message", (data, binary) => s.send(data, { binary })));
