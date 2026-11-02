// A ws socket to a port nothing listens on, with no "error" listener: ws
// throws its error and the app ends, the same with or without the hook.
const WebSocket = require("ws");

new WebSocket("ws://127.0.0.1:9/nothing");
