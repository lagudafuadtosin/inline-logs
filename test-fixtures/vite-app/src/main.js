// A vanilla Vite app. Runs in the browser.
import { describe } from "./describe.ts";

const state = { clicks: 0, user: { name: "Grace" } };
document.querySelector("#app").textContent = "Hello from Vite";
console.log("state", state); // @expect state
console.warn(describe(state.user)); // @expect describe

setTimeout(() => {
  null.boom(); // @expect browser-error
}, 50);
