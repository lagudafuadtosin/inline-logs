// Started from a terminal outside VS Code, with the one-line setup pasted first.
const where = { from: "outside", pid: typeof process.pid };
console.log("outside terminal", where); // @expect outside
console.warn("outside warning"); // @expect outside-warn
