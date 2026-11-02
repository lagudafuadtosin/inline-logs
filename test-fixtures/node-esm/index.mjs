// An ES module app with top-level await.
import { setTimeout as sleep } from "node:timers/promises";

const config = { mode: "esm", port: 3000, nested: { deep: { deeper: { deepest: [1, 2, 3] } } } };
console.log("config", config); // @expect config

await sleep(5);
console.warn("waited", 5, "ms"); // @expect waited

export function area(r) {
  return Math.PI * r * r;
}
console.log(area(2).toFixed(2)); // @expect area
