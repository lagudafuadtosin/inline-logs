// console.count, time, group and assert in the browser, and a WebSocket to the
// test's echo server. Lines marked "// @expect <name>" are checked by the tests.
for (let i = 0; i < 2; i++) console.count("clicks"); // @expect web-count
console.time("paint");
console.timeEnd("paint"); // @expect web-time-end
console.group("Cart"); // @expect web-group
console.log("item", { sku: "A1" }); // @expect web-in-group
console.groupEnd();
console.assert(false, "web assert"); // @expect web-assert

const ws = new WebSocket("ws://127.0.0.1:5210/echo?token=page-token"); // @expect web-ws-open
ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ hello: "page", secret: "s3cret" })); // @expect web-ws-send
});
ws.addEventListener("message", () => ws.close(1000, "bye"));
