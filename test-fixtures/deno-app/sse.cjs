// EventSource where the runtime has one (Deno, Node with --experimental-eventsource),
// against a small server of its own that sends three events.
// Lines marked "@expect" are where the entries must land.
const http = require("node:http");

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  let n = 0;
  const timer = setInterval(() => {
    res.write(`data: tick ${++n}\n\n`);
    if (n === 3) clearInterval(timer);
  }, 20);
});
server.listen(0, "127.0.0.1", () => {
  const es = new EventSource(`http://127.0.0.1:${server.address().port}/feed`); // @expect sse
  let got = 0;
  es.addEventListener("message", (ev) => {
    console.log("sse", ev.data);
    if (++got === 3) {
      es.close();
      server.closeAllConnections?.();
      server.close();
    }
  });
});
