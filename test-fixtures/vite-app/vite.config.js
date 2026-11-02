// Three small endpoints for the browser request tests: /sse sends three
// events and ends, /beacon takes a beacon, /echo answers with what it got.
// Every page is served as Vite serves it.
export default {
  plugins: [
    {
      name: "fixture-endpoints",
      configureServer(server) {
        server.middlewares.use("/sse", (req, res) => {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          let n = 0;
          const timer = setInterval(() => {
            res.write(`data: tick ${++n}\n\n`);
            if (n === 3) {
              clearInterval(timer);
              res.end();
            }
          }, 50);
        });
        server.middlewares.use("/beacon", (req, res) => {
          req.resume();
          req.on("end", () => {
            res.statusCode = 204;
            res.end();
          });
        });
        server.middlewares.use("/echo", (req, res) => {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            res.setHeader("content-type", "application/json");
            res.end(body);
          });
        });
      },
    },
  ],
};
