// Runs in the value graph webview. Draws the graph as SVG, with zoom (wheel,
// buttons), pan (drag), fit, collapse (click a box's title), and the next
// part of a big value (click a cut [Object] row or a box's "more" row). Text
// goes in with textContent only, never as markup. Tells the extension what
// it drew, so the tests can check it.
import { bounds, buildGraph, expandRow, layout, moreRows, SIZES, type Box, type Graph } from "./layout";

interface VsCodeApi {
  postMessage(m: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

(function start() {
  const vscode = acquireVsCodeApi();
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.getElementById("graph") as unknown as SVGSVGElement;
  const stage = document.createElementNS(NS, "g");
  svg.append(stage);
  const title = document.getElementById("title")!;
  const note = document.getElementById("note")!;
  let graph: Graph | undefined;
  let boxes = new Map<string, Box>();
  const collapsed = new Set<string>();
  let view = { x: 0, y: 0, k: 1 };

  const el = <K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>, parent: Element) => {
    const e = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    parent.append(e);
    return e;
  };

  const apply = () => stage.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.k})`);

  const report = () => {
    let edges = 0;
    for (const id of boxes.keys()) if (!collapsed.has(id)) edges += graph!.nodes.get(id)!.children.length;
    vscode.postMessage({ type: "rendered", nodes: boxes.size, edges, total: graph?.nodes.size ?? 0, collapsed: collapsed.size, zoom: Math.round(view.k * 1000) / 1000 });
  };

  const draw = () => {
    if (!graph) return;
    boxes = layout(graph, collapsed);
    stage.replaceChildren();
    const edgeLayer = el("g", { class: "edges" }, stage);
    for (const [id, b] of boxes) {
      const n = graph.nodes.get(id)!;
      const g = el("g", { class: "node", "data-id": id }, stage);
      el("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: 4, class: "box" }, g);
      el("rect", { x: b.x, y: b.y, width: b.w, height: SIZES.headHeight, rx: 4, class: "head" }, g);
      const t = el("text", { x: b.x + 8, y: b.y + 15, class: "title" }, g);
      t.textContent = `${n.children.length ? (collapsed.has(id) ? "▸ " : "▾ ") : ""}${n.title}`;
      n.rows.forEach((r, i) => {
        const y = b.y + SIZES.headHeight + i * SIZES.rowHeight + 13;
        const row = el("text", { x: b.x + 8, y, class: r.later !== undefined ? "row later" : "row", "data-row": i }, g);
        const k = el("tspan", { class: "key" }, row);
        k.textContent = r.key + (r.child ? "" : ": ");
        if (r.value !== undefined) {
          const v = el("tspan", { class: "val" }, row);
          v.textContent = r.value;
        }
        if (r.child && !collapsed.has(id)) {
          const c = boxes.get(r.child);
          if (c) {
            const x0 = b.x + b.w;
            const y0 = y - 4;
            const x1 = c.x;
            const y1 = c.y + SIZES.headHeight / 2;
            const mx = (x0 + x1) / 2;
            el("path", { d: `M${x0} ${y0} C${mx} ${y0} ${mx} ${y1} ${x1} ${y1}`, class: "edge" }, edgeLayer);
            el("circle", { cx: x0, cy: y0, r: 2.5, class: "dot" }, g);
          }
        }
      });
      if (n.hidden) {
        const more = el("text", { x: b.x + 8, y: b.y + SIZES.headHeight + n.rows.length * SIZES.rowHeight + 13, class: "more" }, g);
        more.textContent = `… ${n.hidden} more, click to show`;
      }
    }
    apply();
    report();
  };

  const fit = () => {
    const b = bounds(boxes);
    const w = svg.clientWidth || 800;
    const h = svg.clientHeight || 600;
    const k = Math.min(2, Math.max(0.05, Math.min((w - 40) / Math.max(1, b.w), (h - 40) / Math.max(1, b.h))));
    view = { k, x: (w - b.w * k) / 2 - b.x * k, y: (h - b.h * k) / 2 - b.y * k };
    apply();
    report();
  };

  const zoomAt = (factor: number, cx: number, cy: number) => {
    const k = Math.min(8, Math.max(0.05, view.k * factor));
    view = { k, x: cx - ((cx - view.x) * k) / view.k, y: cy - ((cy - view.y) * k) / view.k };
    apply();
    report();
  };

  const noteCut = () => {
    note.textContent = graph?.cut ? "Click [Object], [Array] or … more to draw the rest." : "";
  };
  /** The next part of a big value: a cut row's object, or a box's next rows. */
  const grow = (id: string, row?: number) => {
    if (!graph) return;
    if (!(row === undefined ? moreRows(graph, id) : expandRow(graph, id, row))) return;
    noteCut();
    draw();
  };

  const toggle = (id: string) => {
    if (!graph?.nodes.get(id)?.children.length) return;
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    draw();
  };

  svg.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const r = svg.getBoundingClientRect();
    zoomAt(ev.deltaY < 0 ? 1.15 : 1 / 1.15, ev.clientX - r.left, ev.clientY - r.top);
  }, { passive: false });
  let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | undefined;
  svg.addEventListener("pointerdown", (ev) => {
    drag = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y, moved: false };
    svg.setPointerCapture(ev.pointerId);
  });
  svg.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    view = { ...view, x: drag.vx + dx, y: drag.vy + dy };
    apply();
  });
  svg.addEventListener("pointerup", (ev) => {
    const was = drag;
    drag = undefined;
    if (!was || was.moved) return;
    const node = (ev.target as Element).closest?.(".node");
    const target = ev.target as Element;
    if (node && target.closest(".title, .head")) toggle(node.getAttribute("data-id")!);
    else if (node && target.closest(".later")) grow(node.getAttribute("data-id")!, Number(target.closest(".later")!.getAttribute("data-row")));
    else if (node && target.closest(".more")) grow(node.getAttribute("data-id")!);
  });
  const button = (id: string, f: () => void) => document.getElementById(id)!.addEventListener("click", f);
  button("fit", fit);
  button("in", () => zoomAt(1.25, (svg.clientWidth || 800) / 2, (svg.clientHeight || 600) / 2));
  button("out", () => zoomAt(1 / 1.25, (svg.clientWidth || 800) / 2, (svg.clientHeight || 600) / 2));
  button("expand", () => {
    collapsed.clear();
    draw();
    fit();
  });
  button("collapse", () => {
    for (const [id, n] of graph?.nodes ?? []) if (n.children.length && id !== graph!.root) collapsed.add(id);
    draw();
    fit();
  });

  window.addEventListener("message", (ev) => {
    const m = ev.data as { type: string; value?: unknown; title?: string; label?: string; id?: string; factor?: number; row?: number };
    if (m.type === "show") {
      graph = buildGraph(m.value, m.label ?? "value");
      collapsed.clear();
      title.textContent = m.title ?? "";
      noteCut();
      draw();
      fit();
    } else if (m.type === "toggle") {
      toggle(m.id ?? graph?.root ?? "");
    } else if (m.type === "grow") {
      grow(m.id ?? graph?.root ?? "", m.row);
    } else if (m.type === "fit") {
      fit();
    } else if (m.type === "zoom") {
      zoomAt(m.factor ?? 1.25, (svg.clientWidth || 800) / 2, (svg.clientHeight || 600) / 2);
    }
  });
  vscode.postMessage({ type: "ready" });
})();
