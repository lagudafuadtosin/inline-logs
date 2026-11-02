// Run with `bun test`. Bun's test runner ends without exit events, so these
// come through the spool file. Lines marked "@expect" are checked.
import { expect, test } from "bun:test";

test("adds", () => {
  const sum = { result: 2 + 3 };
  console.log("bun test result", sum); // @expect bun-test-log
  expect(sum.result).toBe(5);
});
