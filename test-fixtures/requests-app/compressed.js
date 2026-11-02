// A server that sends gzip, deflate and br bodies, and a client that unpacks
// them itself with zlib, as apps do with node:http. Lines marked "@expect"
// are checked: the request log shows the unpacked text.
const http = require("node:http");
const zlib = require("node:zlib");

const body = JSON.stringify({ city: "Stirling", token: "zip-secret", n: 42 });
const pack = { gzip: zlib.gzipSync, deflate: zlib.deflateSync, br: zlib.brotliCompressSync };
const server = http.createServer((req, res) => {
  const enc = req.url.slice(1);
  res.setHeader("content-type", "application/json");
  res.setHeader("content-encoding", enc);
  res.end(pack[enc](body));
});

const get = (url) =>
  new Promise((resolve) => {
    http.get(url, (res) => { // @expect zip-get
      const unpack = { gzip: zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress }[res.headers["content-encoding"]]();
      let text = "";
      res.pipe(unpack).on("data", (c) => (text += c)).on("end", () => resolve(text));
    });
  });

server.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log("gzip", await get(`${base}/gzip`)); // @expect gzip
  console.log("deflate", await get(`${base}/deflate`)); // @expect deflate
  console.log("br", await get(`${base}/br`)); // @expect br
  server.close();
});
