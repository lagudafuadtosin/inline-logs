// Vitest runs this file in a worker with its own console.
import { expect, test } from "vitest";

function mul(a, b) {
  return a * b;
}

test("multiplies", () => {
  const result = mul(3, 4);
  console.log("vitest result", { result }); // @expect vitest-log
  expect(result).toBe(12);
});

test("dirs", () => {
  console.dir({ deep: { er: { est: 1 } } }); // @expect vitest-dir
  console.info("vitest info", [1, 2]); // @expect vitest-info
});

test("traces", () => {
  console.trace("vitest trace"); // @expect vitest-trace
});
