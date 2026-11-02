// Jest runs this file with its own console. Logs inside tests show on their lines.
function add(a, b) {
  return a + b;
}

test("adds", () => {
  const result = add(2, 3);
  console.log("jest result", { result }); // @expect jest-log
  expect(result).toBe(5);
});

test("tables", () => {
  const rows = [{ a: 1, b: "x" }, { a: 2, b: "y" }];
  console.table(rows); // @expect jest-table
  console.warn("jest warn", rows.length); // @expect jest-warn
});
