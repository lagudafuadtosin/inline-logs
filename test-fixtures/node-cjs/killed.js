// Logs, says it is ready, and waits. The test then kills it with no warning.
console.log("last words", { at: Date.now() > 0 }); // @expect killed
process.stdout.write("ready\n");
setInterval(() => {}, 1000);
