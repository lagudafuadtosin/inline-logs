// TypeScript run through ts-node (via npm start). Types are stripped, so without
// source maps the lines would not match.
interface Point {
  x: number;
  y: number;
}

type Pair = [Point, Point];

function distance([a, b]: Pair): number {
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  console.log("distance", d); // @expect ts-node-log
  return d;
}

const pairs: Pair[] = [[{ x: 0, y: 0 }, { x: 3, y: 4 }]];
console.info("pairs", pairs.map(distance)); // @expect ts-node-info
