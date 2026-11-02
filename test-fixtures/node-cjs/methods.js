// console.table, console.dir and console.trace.
const people = [
  { name: "Ada", born: 1815 },
  { name: "Grace", born: 1906 },
];
console.table(people); // @expect table
console.dir({ deep: { deeper: { deepest: { bottom: true } } } }, { depth: 0 }); // @expect dir
function where() {
  console.trace("traced", people.length); // @expect trace
}
where();
