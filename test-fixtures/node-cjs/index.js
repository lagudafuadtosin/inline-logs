// A plain CommonJS app. Lines marked "// @expect <name>" are checked by the tests.
const circular = { name: "loop" };
circular.self = circular;
const user = { name: "Ada", born: 1815, tags: ["math", "code"] };

console.log("user", user); // @expect user
console.info(new Map([["a", 1]]), new Set([1, 2])); // @expect map
console.warn(10n, circular); // @expect warn
console.error(new Error("boom")); // @expect error-log
for (let i = 0; i < 3; i++) console.log("i =", i); // @expect loop
class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
}
console.debug(new Point(1, 2)); // @expect class
console.log("%s has %d tags", user.name, user.tags.length); // @expect printf
setTimeout(() => {
  console.log("later", { done: true }); // @expect later
}, 10);
