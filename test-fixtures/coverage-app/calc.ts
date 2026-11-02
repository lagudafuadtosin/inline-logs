// TypeScript run through tsx: coverage lands on these lines through the
// source map tsx gives Node. Lines marked "// @expect <name>" are checked.
interface Box {
  w: number;
  h: number;
}

export function area(b: Box): number {
  if (b.w < 0) {
    throw new Error("negative"); // @expect ts-miss
  }
  return b.w * b.h; // @expect ts-hit
}

console.log("area", area({ w: 2, h: 3 })); // @expect ts-top
