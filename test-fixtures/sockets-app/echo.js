// A WebSocket echo server for the browser test: node echo.js <port>
const { WebSocketServer } = require("ws");

const server = new WebSocketServer({ port: Number(process.argv[2] || 5210), host: "127.0.0.1" });
server.on("connection", (s) => s.on("message", (data, binary) => s.send(data, { binary })));
