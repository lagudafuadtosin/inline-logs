// Runs until it is killed, like a dev server. Its coverage still arrives,
// because the hook writes it out every few seconds.
let ticks = 0;
function tick() {
  ticks++; // @expect forever-tick
}
setInterval(tick, 100);
console.log("running");
