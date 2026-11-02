// console.count, countReset, time, timeLog, timeEnd, group, groupCollapsed,
// groupEnd and assert. Lines marked "// @expect <name>" are checked by the tests.
for (let i = 0; i < 3; i++) console.count("loop"); // @expect count
console.countReset("loop"); // @expect count-reset
console.time("load"); // @expect time
console.timeLog("load", "halfway", { step: 1 }); // @expect time-log
console.timeEnd("load"); // @expect time-end
console.group("Outer"); // @expect group
console.log("inside the group"); // @expect in-group
console.groupCollapsed("Inner"); // @expect group-collapsed
console.groupEnd();
console.groupEnd(); // @expect group-end
console.assert(1 + 1 === 2, "never shown"); // @expect assert-ok
console.assert(1 + 1 === 3, "math is broken: %d", 3); // @expect assert-fail
