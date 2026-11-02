// fetch and XMLHttpRequest calls in the browser, for the request log tests.
// Lines marked "// @expect <name>" are checked by the tests.
const data = await fetch("/data.json", { headers: { authorization: "Bearer page-secret" } }); // @expect web-fetch
document.querySelector("#app").textContent = (await data.json()).name;
// Asking for JSON only: Vite answers its index page to requests that accept HTML.
await fetch("/missing-file.json", { headers: { accept: "application/json" } }); // @expect web-404

const xhr = new XMLHttpRequest();
xhr.open("GET", "/data.json");
xhr.setRequestHeader("x-api-key", "page-key");
xhr.send(); // @expect web-xhr
