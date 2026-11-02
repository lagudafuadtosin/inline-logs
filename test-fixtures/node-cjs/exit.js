// Logs and calls process.exit() at once: nothing gets a chance to run after.
console.log("about to exit", { code: 3 }); // @expect exit
process.exit(3);
