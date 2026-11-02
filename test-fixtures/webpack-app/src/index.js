// The entry webpack bundles for the browser.
import { area } from "./shapes.js";

const settings = { theme: "dark", sizes: [1, 2, 3] };
console.log("settings", settings); // @expect wp-settings
console.warn("area is", area({ w: 3, h: 4 })); // @expect wp-area

setTimeout(() => {
  undefined.crash(); // @expect wp-error
}, 50);
