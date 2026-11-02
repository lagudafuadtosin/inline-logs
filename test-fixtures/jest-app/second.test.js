// A second test file, so Jest can run the files in worker processes.
test("second file", () => {
  const items = ["a", "b"];
  console.log("jest second", items); // @expect jest-second
  expect(items).toHaveLength(2);
});
