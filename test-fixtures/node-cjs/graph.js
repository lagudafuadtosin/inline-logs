// A value with more boxes than the graph draws at first: 70 objects in a list.
console.log("big", { list: Array.from({ length: 70 }, (_, i) => ({ i })) }); // @expect big-graph
