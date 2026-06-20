/**
 * ARES Explorer — view logic.
 *
 * Renders a {@link GraphData} relationship graph with a D3 force layout and lets
 * the user grow it live: clicking a company node calls the server's `expand-node`
 * tool, and the returned subgraph is merged in. The view holds no ARES knowledge —
 * it only renders nodes/edges and asks the host to run tools.
 */

import * as d3 from "d3";
import { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { GraphData, GraphNode } from "./types";

// --- d3 datum types --------------------------------------------------------
type SimNode = GraphNode & d3.SimulationNodeDatum & { loading?: boolean };
interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  source: string | SimNode;
  target: string | SimNode;
  label: string;
}

// --- DOM handles -----------------------------------------------------------
const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;
const svg = d3.select<SVGSVGElement, unknown>("#graph");
const viewport = svg.append("g").attr("class", "viewport");
const linkLayer = viewport.append("g").attr("class", "links");
const labelLayer = viewport.append("g").attr("class", "link-labels");
const nodeLayer = viewport.append("g").attr("class", "nodes");

const inspectorEl = $<HTMLElement>("#inspector");
const loadingEl = $<HTMLElement>("#loading");
const errorEl = $<HTMLElement>("#error");
const toastEl = $<HTMLElement>("#toast");
const nodeCountEl = $<HTMLElement>("#node-count");
const generatedAtEl = $<HTMLElement>("#generated-at");

// --- graph state -----------------------------------------------------------
const nodes: SimNode[] = [];
const links: SimLink[] = [];
const nodeById = new Map<string, SimNode>();
const linkKeys = new Set<string>();
const expanded = new Set<string>(); // ICOs already expanded — avoids refetch
let globalRootId: string | null = null;
let selectedId: string | null = null;

// --- sizing ----------------------------------------------------------------
const SIZE = { root: 24, company: 17, person: 14 };
const sizeOf = (n: SimNode) => (n.root ? SIZE.root : n.kind === "company" ? SIZE.company : SIZE.person);

// --- simulation ------------------------------------------------------------
function dims() {
  const r = svg.node()!.getBoundingClientRect();
  return { w: r.width || 800, h: r.height || 600 };
}

const sim = d3
  .forceSimulation<SimNode>(nodes)
  .force("charge", d3.forceManyBody<SimNode>().strength((d) => (d.root ? -620 : -300)))
  .force(
    "link",
    d3
      .forceLink<SimNode, SimLink>(links)
      .id((d) => d.id)
      .distance((l) => ((l.source as SimNode).root || (l.target as SimNode).root ? 120 : 90))
      .strength(0.6),
  )
  .force("collide", d3.forceCollide<SimNode>().radius((d) => sizeOf(d) + 22))
  .force("x", d3.forceX(() => dims().w / 2).strength(0.04))
  .force("y", d3.forceY(() => dims().h / 2).strength(0.04))
  .on("tick", ticked);

// --- zoom & pan ------------------------------------------------------------
const zoom = d3
  .zoom<SVGSVGElement, unknown>()
  .scaleExtent([0.25, 3])
  .on("zoom", (e) => viewport.attr("transform", e.transform.toString()));
svg.call(zoom);

function recenter() {
  const { w, h } = dims();
  svg.transition().duration(450).call(zoom.transform, d3.zoomIdentity.translate(0, 0).scale(0.9).translate(w * 0.055, h * 0.055));
}

// ---------------------------------------------------------------------------
// Merge incoming graphs
// ---------------------------------------------------------------------------
function linkKey(l: { source: string; target: string; label: string }) {
  const [a, b] = [l.source, l.target].sort();
  return `${a}\u0000${b}\u0000${l.label}`;
}

/** Merge a {@link GraphData} payload into the live graph (dedup by id / link key). */
function merge(graph: GraphData, anchorId?: string): number {
  const { w, h } = dims();
  const anchor = anchorId ? nodeById.get(anchorId) : undefined;
  let added = 0;

  for (const incoming of graph.nodes) {
    const isGlobalRoot = incoming.id === globalRootId;
    const existing = nodeById.get(incoming.id);
    if (existing) {
      // An incoming "root" node means we just expanded it → mark fully expanded.
      if (incoming.root) existing.expandable = false;
      if (!existing.subtitle && incoming.subtitle) existing.subtitle = incoming.subtitle;
      if (incoming.meta) existing.meta = { ...incoming.meta, ...existing.meta };
      continue;
    }
    const node: SimNode = {
      ...incoming,
      root: isGlobalRoot ? true : false, // only the very first root stays root
      x: (anchor?.x ?? w / 2) + (Math.random() - 0.5) * 80,
      y: (anchor?.y ?? h / 2) + (Math.random() - 0.5) * 80,
    };
    nodes.push(node);
    nodeById.set(node.id, node);
    added++;
  }

  for (const edge of graph.edges) {
    const key = linkKey(edge);
    if (linkKeys.has(key)) continue;
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
    linkKeys.add(key);
    links.push({ source: edge.source, target: edge.target, label: edge.label });
  }
  return added;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function neighbors(id: string): Set<string> {
  const set = new Set<string>([id]);
  for (const l of links) {
    const s = (l.source as SimNode).id ?? (l.source as string);
    const t = (l.target as SimNode).id ?? (l.target as string);
    if (s === id) set.add(t);
    if (t === id) set.add(s);
  }
  return set;
}

function render() {
  // ---- links ----
  linkLayer
    .selectAll<SVGLineElement, SimLink>("line")
    .data(links, (l) => linkKey({ source: (l.source as SimNode).id ?? (l.source as string), target: (l.target as SimNode).id ?? (l.target as string), label: l.label }))
    .join("line")
    .attr("class", "link");

  labelLayer
    .selectAll<SVGTextElement, SimLink>("text")
    .data(links, (l) => linkKey({ source: (l.source as SimNode).id ?? (l.source as string), target: (l.target as SimNode).id ?? (l.target as string), label: l.label }))
    .join("text")
    .attr("class", "link-label")
    .attr("text-anchor", "middle")
    .text((l) => l.label);

  // ---- nodes ----
  const nodeSel = nodeLayer
    .selectAll<SVGGElement, SimNode>("g.node")
    .data(nodes, (d) => d.id)
    .join((enter) => {
      const g = enter.append("g").attr("class", "node");
      g.each(function (d) {
        const sel = d3.select(this);
        const s = sizeOf(d);
        if (d.kind === "person") {
          sel.append("circle").attr("class", "shape").attr("r", s);
        } else {
          sel
            .append("rect")
            .attr("class", "shape")
            .attr("width", s * 2)
            .attr("height", s * 2)
            .attr("x", -s)
            .attr("y", -s)
            .attr("rx", 6);
        }
        sel.append("text").attr("class", "node-label").attr("text-anchor", "middle");
        sel.append("text").attr("class", "node-sub").attr("text-anchor", "middle");
        sel.append("text").attr("class", "expand-badge").attr("text-anchor", "middle");
      });
      g.call(dragBehavior());
      g.on("click", (_e, d) => onNodeClick(d));
      g.on("mouseenter", (_e, d) => setHover(d.id));
      g.on("mouseleave", () => setHover(null));
      return g;
    });

  // ---- per-node visuals (enter + update) ----
  nodeSel.each(function (d) {
    const sel = d3.select(this);
    const s = sizeOf(d);
    const fill = d.kind === "company" ? "var(--company)" : "var(--person)";
    sel
      .select<SVGGraphicsElement>(".shape")
      .attr("fill", fill)
      .attr("fill-opacity", d.root ? 1 : 0.16)
      .attr("stroke", fill)
      .attr("stroke-width", d.root ? 3 : 1.6);

    sel
      .select<SVGTextElement>(".node-label")
      .attr("y", s + 14)
      .text(truncate(d.label, 26));

    sel
      .select<SVGTextElement>(".node-sub")
      .attr("y", s + 26)
      .text(d.subtitle ?? (d.ico ? `IČO ${d.ico}` : ""));

    // "+" affordance on companies that can still be expanded
    sel
      .select<SVGTextElement>(".expand-badge")
      .attr("y", -s - 6)
      .text(d.loading ? "⋯" : d.kind === "company" && d.expandable && !d.root ? "+" : "");
  });

  nodeCountEl.textContent = `${nodes.length} uzlů · ${links.length} vazeb`;
  sim.nodes(nodes);
  (sim.force("link") as d3.ForceLink<SimNode, SimLink>).links(links);
  sim.alpha(0.7).restart();
  updateHighlight();
}

function ticked() {
  linkLayer
    .selectAll<SVGLineElement, SimLink>("line")
    .attr("x1", (l) => (l.source as SimNode).x ?? 0)
    .attr("y1", (l) => (l.source as SimNode).y ?? 0)
    .attr("x2", (l) => (l.target as SimNode).x ?? 0)
    .attr("y2", (l) => (l.target as SimNode).y ?? 0);

  labelLayer
    .selectAll<SVGTextElement, SimLink>("text")
    .attr("x", (l) => (((l.source as SimNode).x ?? 0) + ((l.target as SimNode).x ?? 0)) / 2)
    .attr("y", (l) => (((l.source as SimNode).y ?? 0) + ((l.target as SimNode).y ?? 0)) / 2 - 3);

  nodeLayer.selectAll<SVGGElement, SimNode>("g.node").attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
}

function dragBehavior() {
  return d3
    .drag<SVGGElement, SimNode>()
    .on("start", (e, d) => {
      if (!e.active) sim.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    })
    .on("drag", (e, d) => {
      d.fx = e.x;
      d.fy = e.y;
    })
    .on("end", (e, d) => {
      if (!e.active) sim.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    });
}

// --- highlighting ----------------------------------------------------------
let hoverId: string | null = null;
function setHover(id: string | null) {
  hoverId = id;
  updateHighlight();
}

function updateHighlight() {
  const focus = selectedId ?? hoverId;
  const near = focus ? neighbors(focus) : null;

  nodeLayer
    .selectAll<SVGGElement, SimNode>("g.node")
    .classed("dim", (d) => !!near && !near.has(d.id));

  labelLayer
    .selectAll<SVGTextElement, SimLink>("text")
    .style("opacity", (l) => {
      if (!focus) return 0;
      const s = (l.source as SimNode).id;
      const t = (l.target as SimNode).id;
      return s === focus || t === focus ? 1 : 0;
    });

  linkLayer
    .selectAll<SVGLineElement, SimLink>("line")
    .attr("stroke", (l) => {
      if (!focus) return "var(--edge)";
      const s = (l.source as SimNode).id;
      const t = (l.target as SimNode).id;
      return s === focus || t === focus ? "var(--faint)" : "var(--edge)";
    });
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------
async function onNodeClick(d: SimNode) {
  selectedId = d.id;
  openInspector(d);
  updateHighlight();

  if (d.kind === "company" && d.ico && d.expandable && !d.root && !expanded.has(d.ico)) {
    await expandCompany(d);
  }
}

async function expandCompany(d: SimNode) {
  if (!d.ico) return;
  expanded.add(d.ico);
  d.loading = true;
  render();
  try {
    const result = await app.callServerTool({ name: "expand-node", arguments: { ico: d.ico } });
    const graph = graphFrom(result);
    if (!graph) throw new Error("Server nevrátil data grafu.");
    d.loading = false;
    d.expandable = false;
    const added = merge(graph, d.id);
    render();
    toast(added > 0 ? `+${added} vazeb · ${d.label}` : `Žádné nové vazby · ${d.label}`);
    // Let the model know what the user is exploring.
    void app
      .updateModelContext({
        content: [{ type: "text", text: `Uživatel v grafu rozbalil firmu „${d.label}" (IČO ${d.ico}), přidáno ${added} vazeb.` }],
      })
      .catch(() => {});
  } catch (err) {
    d.loading = false;
    expanded.delete(d.ico);
    render();
    toast(`Nepodařilo se načíst ${d.ico}: ${(err as Error).message}`, true);
  }
}

function openInspector(d: SimNode) {
  const edges = links.filter((l) => (l.source as SimNode).id === d.id || (l.target as SimNode).id === d.id);
  const relations = edges
    .map((l) => {
      const otherId = (l.source as SimNode).id === d.id ? (l.target as SimNode).id : (l.source as SimNode).id;
      const other = nodeById.get(otherId);
      return `<li><span class="role">${escapeHtml(l.label)}</span> — ${escapeHtml(other?.label ?? otherId)}</li>`;
    })
    .join("");

  const metaRows = Object.entries(d.meta ?? {})
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd class="${k === "ico" ? "mono" : ""}">${escapeHtml(v)}</dd>`)
    .join("");

  const aresLink = d.ico
    ? `<button class="link" data-ares="${d.ico}">Otevřít v ARES ↗</button>`
    : "";
  const expandBtn =
    d.kind === "company" && d.ico && d.expandable && !expanded.has(d.ico)
      ? `<button class="link" data-expand="${d.ico}">Rozbalit vazby</button>`
      : "";

  inspectorEl.innerHTML = `
    <button class="close" aria-label="Zavřít">×</button>
    <span class="kind-tag ${d.kind}">${d.kind === "company" ? "firma" : "osoba"}${d.root ? " · kořen" : ""}</span>
    <h2>${escapeHtml(d.label)}</h2>
    <div class="ico">${d.ico ? `IČO ${d.ico}` : d.subtitle ?? ""}</div>
    ${metaRows ? `<dl>${metaRows}</dl>` : ""}
    ${relations ? `<dl><dt style="grid-column:1/-1;margin-top:8px">vazby (${edges.length})</dt></dl><ul class="rel-list">${relations}</ul>` : ""}
    <div class="actions">${expandBtn}${aresLink}</div>
  `;
  inspectorEl.classList.add("open");

  inspectorEl.querySelector(".close")?.addEventListener("click", closeInspector);
  inspectorEl.querySelector("[data-ares]")?.addEventListener("click", () => {
    void app.openLink({ url: `https://ares.gov.cz/ekonomicke-subjekty?ico=${d.ico}` }).catch(() => {});
  });
  inspectorEl.querySelector("[data-expand]")?.addEventListener("click", () => {
    const n = nodeById.get(d.id);
    if (n) void expandCompany(n);
  });
}

function closeInspector() {
  inspectorEl.classList.remove("open");
  selectedId = null;
  updateHighlight();
}

// background click clears selection
svg.on("click", (e) => {
  if (e.target === svg.node()) closeInspector();
});

// --- toolbar ---------------------------------------------------------------
$<HTMLButtonElement>("#reset-btn").addEventListener("click", recenter);

async function addByIco() {
  const input = $<HTMLInputElement>("#ico-input");
  const raw = input.value.trim();
  if (!raw) return;
  input.value = "";
  showLoading(`Načítám IČO ${raw}…`);
  try {
    const result = await app.callServerTool({ name: "expand-node", arguments: { ico: raw } });
    const graph = graphFrom(result);
    if (!graph) throw new Error("Server nevrátil data grafu.");
    if (!globalRootId) globalRootId = graph.rootId;
    const added = merge(graph);
    render();
    recenter();
    toast(`Přidáno ${added} uzlů`);
  } catch (err) {
    toast(`Chyba: ${(err as Error).message}`, true);
  } finally {
    hideLoading();
  }
}
$<HTMLButtonElement>("#add-btn").addEventListener("click", addByIco);
$<HTMLInputElement>("#ico-input").addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key === "Enter") void addByIco();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function graphFrom(result: CallToolResult): GraphData | null {
  if (result.isError) {
    const text = result.content?.find((c) => c.type === "text");
    throw new Error(text && "text" in text ? (text.text as string) : "Chyba toolu");
  }
  const sc = result.structuredContent as unknown;
  if (sc && typeof sc === "object" && "nodes" in sc && "edges" in sc) return sc as GraphData;
  return null;
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string, isError = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle("err", isError);
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
}

function showLoading(text: string) {
  $<HTMLElement>("#loading-text").textContent = text;
  loadingEl.style.display = "flex";
}
function hideLoading() {
  loadingEl.style.display = "none";
}
function showError(text: string) {
  errorEl.textContent = `⚠️ ${text}`;
  errorEl.style.display = "flex";
}

// ---------------------------------------------------------------------------
// Boot: connect to host and ingest the first graph
// ---------------------------------------------------------------------------
const app = new App({ name: "ARES Explorer", version: "0.1.0" });

function ingestInitial(result: CallToolResult) {
  hideLoading();
  let graph: GraphData | null = null;
  try {
    graph = graphFrom(result);
  } catch (err) {
    showError((err as Error).message);
    return;
  }
  if (!graph) {
    showError("Nepřišla žádná data grafu.");
    return;
  }
  globalRootId = graph.rootId;
  merge(graph);
  render();
  recenter();
  if (generatedAtEl) generatedAtEl.textContent = new Date(graph.generatedAt).toLocaleString("cs-CZ");
  const root = nodeById.get(graph.rootId);
  if (root) {
    selectedId = root.id;
    openInspector(root);
  }
}

app.ontoolresult = (params) => ingestInitial(params as CallToolResult);

showLoading("Načítám data z ARES…");
app
  .connect()
  .then(() => {
    // If the host already delivered a result before we attached the handler,
    // ontoolresult still fires; otherwise we simply wait for it.
  })
  .catch((err) => showError(`Připojení k hostiteli selhalo: ${err.message}`));

// keep layout centred on resize
window.addEventListener("resize", () => sim.alpha(0.3).restart());
