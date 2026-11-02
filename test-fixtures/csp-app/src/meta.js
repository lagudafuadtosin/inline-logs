// This page adds a <meta> policy that does not allow posts to its own origin.
const policy = { from: "meta", connect: "ws only" };
console.log("csp meta page", policy); // @expect csp-meta
