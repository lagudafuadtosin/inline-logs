// Run with Deno. Deno reads NODE_OPTIONS --require too. The hook only works
// when the app was given the permissions it needs (-A here), and never asks.
const info = { runtime: typeof Deno !== "undefined" ? "deno" : "other", ok: true };
console.log("deno says", info); // @expect deno-log
await new Promise((r) => setTimeout(r, 10));
console.warn("deno later", [1, 2]); // @expect deno-later
