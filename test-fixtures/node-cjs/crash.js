// Throws after one log. The error should show on the throwing line.
console.log("before crash"); // @expect before

function parse(input) {
  if (typeof input !== "string") throw new TypeError("bad input"); // @expect throw
  return input;
}

parse(42);
