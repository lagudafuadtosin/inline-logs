// EventSource, sendBeacon and fetch with a Request object in the browser.
// Lines marked "// @expect <name>" are checked by the tests.
const sse = new EventSource("/sse"); // @expect kinds-sse
let ticks = 0;
sse.addEventListener("message", () => {
  if (++ticks === 3) sse.close();
});
navigator.sendBeacon("/beacon", JSON.stringify({ left: true, token: "t-1" })); // @expect kinds-beacon
const req = new Request("/echo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ via: "Request", password: "pw" }) });
fetch(req).then((r) => r.text()); // @expect kinds-request
