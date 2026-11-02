// An ES module imported by index.js. webpack rewrites imports and exports, so the served lines move.
export function area(shape) {
  const value = shape.w * shape.h;
  console.log("area of", shape); // @expect wp-module
  return value;
}
