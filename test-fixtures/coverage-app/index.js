// A plain CommonJS script for the coverage tests: run with "a" or "b" to
// take one branch. Lines marked "// @expect <name>" are checked.
function pick(kind) {
  if (kind === "a") {
    return "went a"; // @expect a-branch
  } else {
    return "went b"; // @expect b-branch
  }
}

function never() {
  return "never ran"; // @expect never
}

const kind = process.argv[2] || "a";
console.log(pick(kind)); // @expect top
module.exports = { never };
