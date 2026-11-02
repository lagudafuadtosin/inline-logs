// The web package. Same file name as the api package, different lines.
let n = 0;

const timer = setInterval(() => {
  n++;
  console.log("web tick", { n, pkg: "web" }); // @expect web-tick
  if (n === 6) clearInterval(timer);
}, 150);
