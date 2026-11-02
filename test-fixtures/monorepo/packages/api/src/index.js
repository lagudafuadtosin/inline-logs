// The api package. Its file has the same name as the web package's.
let n = 0;
const timer = setInterval(() => {
  n++;
  console.log("api tick", { n, pkg: "api" }); // @expect api-tick
  if (n === 6) clearInterval(timer);
}, 150);
