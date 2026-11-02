// Logs, then keeps the event loop busy until Ctrl+C: the log never gets a
// turn of the loop to be sent, so only the spool file can deliver it.
console.log("waiting", { pid: process.pid }); // @expect waiting
const end = Date.now() + 120_000;
while (Date.now() < end) {
  // busy
}
