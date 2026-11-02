// The ws package's own WebSocket as a client, against its own server. Lines
// marked "@expect" are where the entries must land.
const WebSocket = require("ws");

const server = new WebSocket.Server({ port: 0, host: "127.0.0.1" }, () => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/feed?token=abc123`); // @expect wspkg-open
  ws.on("open", () => {
    ws.send(JSON.stringify({ hi: "pkg", secret: "s3cret" })); // @expect wspkg-send
  });
  ws.on("message", (data) => {
    console.log("pkg echo", String(data).length);
    ws.close(1000, "bye");
  });
  ws.on("close", () => server.close());
});
server.on("connection", (s) => s.on("message", (data, binary) => s.send(data, { binary })));
