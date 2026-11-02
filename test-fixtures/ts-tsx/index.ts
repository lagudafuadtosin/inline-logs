// TypeScript run through tsx (via npm start). Types are stripped, so without
// source maps the lines would not match.
interface Order {
  id: number;
  items: { sku: string; qty: number }[];
  note?: string;
}

type Total = { id: number; count: number };

function total(order: Order): Total {
  const count = order.items.reduce((n, i) => n + i.qty, 0);
  console.log("total for", order.id, "is", count); // @expect total
  return { id: order.id, count };
}

const orders: Order[] = [
  { id: 1, items: [{ sku: "a", qty: 2 }] },
  { id: 2, items: [{ sku: "b", qty: 1 }, { sku: "c", qty: 4 }], note: "gift" },
];

const totals: Total[] = orders.map(total);
console.info("all", totals); // @expect all
