// Throws when the page is opened with ?boom, and not otherwise: a reload
// without it is a new load of the same page. Lines marked "@expect" are checked.
console.log("oops page", { boom: location.search.includes("boom") }); // @expect oops-log
if (location.search.includes("boom")) throw new Error("page boom"); // @expect oops-throw
