// Run with Bun. Bun reads BUN_OPTIONS, not NODE_OPTIONS.
const runtime = typeof Bun !== "undefined" ? "bun" : "other";
console.log("runtime", runtime, { ok: true }); // @expect bun-log
setTimeout(() => {
  const late = { later: 1 };
  console.warn("bun later", late); // @expect bun-later
}, 10);
