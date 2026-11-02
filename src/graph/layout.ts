// The value graph's model and layout: each object or array in a logged value
// is a box listing its keys, and a key whose value is another object or
// array points at that one's box. Laid out as a tree from left to right,
// each box centred on the boxes it points at. A big value is drawn in parts:
// up to MAX_NODES boxes and MAX_ROWS rows per box at first, and a cut row or
// a box's "more" row draws the next part when clicked. Used by the webview
// (bundled into its script) and unit tested on its own. No DOM, no VS Code.

export interface Row {
  key: string;
  /** Shown after the key for a plain value. */
  value?: string;
  /** Node id this row points at. */
  child?: string;
  /** An object or array not drawn yet (past MAX_NODES): drawn when the row is clicked. */
  later?: unknown;
}

export interface GNode {
  id: string;
  title: string;
  rows: Row[];
  /** Ids of child nodes, in row order. */
  children: string[];
  /** Rows not shown yet, past MAX_ROWS: the next ones are drawn when "more" is clicked. */
  hidden: number;
  /** The object or array, for the rows drawn later. */
  source?: unknown;
}

export interface Graph {
  nodes: Map<string, GNode>;
  root: string;
  /** True when MAX_NODES cut the graph short. */
  cut: boolean;
}

export const MAX_NODES = 600;
export const MAX_ROWS = 60;

const text = (v: unknown): string => (typeof v === "string" ? JSON.stringify(v.length > 120 ? v.slice(0, 120) + "…" : v) : v === null ? "null" : String(v));
const isBox = (v: unknown) => v !== null && typeof v === "object";
const entriesOf = (v: unknown): (readonly [string, unknown])[] =>
  Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>).filter(([k]) => k !== "$type");

/** Boxes left to draw in this part. */
interface Budget {
  left: number;
}

function add(g: Graph, v: unknown, title: string, budget: Budget): string {
  const id = `n${g.nodes.size}`;
  budget.left--;
  const node: GNode = { id, title, rows: [], children: [], hidden: 0 };
  g.nodes.set(id, node);
  if (!isBox(v)) {
    node.rows.push({ key: "value", value: text(v) });
    return id;
  }
  const o = v as Record<string, unknown>;
  if (!Array.isArray(v) && typeof o.$type === "string") node.title = `${title}: ${o.$type}`;
  else if (Array.isArray(v)) node.title = `${title}: Array(${v.length})`;
  node.source = v;
  fill(g, node, budget);
  return id;
}

/** Draws the next MAX_ROWS rows of a box. */
function fill(g: Graph, node: GNode, budget: Budget): void {
  const entries = entriesOf(node.source);
  const from = node.rows.length;
  const to = Math.min(entries.length, from + MAX_ROWS);
  for (let i = from; i < to; i++) {
    const [k, x] = entries[i];
    if (!isBox(x)) {
      node.rows.push({ key: k, value: text(x) });
    } else if (budget.left <= 0) {
      g.cut = true;
      node.rows.push({ key: k, value: Array.isArray(x) ? "[Array]" : "[Object]", later: x });
    } else {
      node.rows.push({ key: k, child: add(g, x, k, budget) });
    }
  }
  node.hidden = entries.length - to;
  node.children = node.rows.filter((r) => r.child).map((r) => r.child!);
}

export function buildGraph(value: unknown, rootTitle = "value", maxNodes = MAX_NODES): Graph {
  const g: Graph = { nodes: new Map(), root: "", cut: false };
  g.root = add(g, value, rootTitle, { left: maxNodes });
  return g;
}

/** A row cut at the box limit: its object or array is drawn now, with up to `maxNodes` more boxes. Returns its box's id. */
export function expandRow(g: Graph, nodeId: string, row: number, maxNodes = MAX_NODES): string | undefined {
  const n = g.nodes.get(nodeId);
  const r = n?.rows[row];
  if (!n || !r || r.later === undefined) return undefined;
  const child = add(g, r.later, r.key, { left: maxNodes });
  n.rows[row] = { key: r.key, child };
  n.children = n.rows.filter((x) => x.child).map((x) => x.child!);
  return child;
}

/** A box with rows not shown yet: the next MAX_ROWS of them are drawn, with up to `maxNodes` more boxes. */
export function moreRows(g: Graph, nodeId: string, maxNodes = MAX_NODES): boolean {
  const n = g.nodes.get(nodeId);
  if (!n || !n.hidden) return false;
  fill(g, n, { left: maxNodes });
  return true;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Sizes {
  rowHeight: number;
  headHeight: number;
  /** Width of a box from its longest text, in pixels. */
  width(node: GNode): number;
  gapX: number;
  gapY: number;
}

export const SIZES: Sizes = {
  rowHeight: 18,
  headHeight: 22,
  width: (n) => Math.min(420, Math.max(90, 7 * Math.max(n.title.length, ...n.rows.map((r) => r.key.length + (r.value?.length ?? 2) + 2)) + 16)),
  gapX: 60,
  gapY: 14,
};

export function height(n: GNode, s: Sizes = SIZES): number {
  return s.headHeight + (n.rows.length + (n.hidden ? 1 : 0)) * s.rowHeight + 4;
}

/**
 * Positions for every box shown: children of a collapsed node are left out.
 * Columns by depth (as wide as their widest box), each subtree stacked
 * under the one before, a parent centred on its children.
 */
export function layout(g: Graph, collapsed: ReadonlySet<string> = new Set(), s: Sizes = SIZES): Map<string, Box> {
  const out = new Map<string, Box>();
  const depthOf = new Map<string, number>();
  const colWidth: number[] = [];
  const visit = (id: string, d: number) => {
    const n = g.nodes.get(id)!;
    depthOf.set(id, d);
    colWidth[d] = Math.max(colWidth[d] ?? 0, s.width(n));
    if (!collapsed.has(id)) for (const c of n.children) visit(c, d + 1);
  };
  visit(g.root, 0);
  const colX: number[] = [];
  colWidth.forEach((w, i) => (colX[i] = i === 0 ? 0 : colX[i - 1] + colWidth[i - 1] + s.gapX));
  let cursor = 0;
  /** Places the subtree from the cursor down; returns the box's y. */
  const place = (id: string): number => {
    const n = g.nodes.get(id)!;
    const h = height(n, s);
    const d = depthOf.get(id)!;
    const kids = collapsed.has(id) ? [] : n.children;
    let y: number;
    if (!kids.length) {
      y = cursor;
      cursor += h + s.gapY;
    } else {
      const top = cursor;
      const ys = kids.map((c) => place(c));
      const first = ys[0];
      const lastBox = out.get(kids[kids.length - 1])!;
      const mid = (first + lastBox.y + lastBox.h) / 2;
      y = Math.max(top, mid - h / 2);
      // A tall parent with short children: keep the next subtree below it.
      cursor = Math.max(cursor, y + h + s.gapY);
    }
    out.set(id, { x: colX[d], y, w: s.width(n), h });
    return y;
  };
  place(g.root);
  return out;
}

/** The box that fits every box, for "fit to view". */
export function bounds(boxes: Map<string, Box>): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes.values()) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return boxes.size ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 };
}
