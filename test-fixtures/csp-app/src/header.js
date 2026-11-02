// The page's CSP header allows scripts from 'self' only.
const policy = { from: "header", inline: false };
console.log("csp header page", policy); // @expect csp-header
