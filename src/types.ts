/**
 * Shared data contract between the MCP server and the browser-side App.
 *
 * The server builds a {@link GraphData} object from ARES responses and ships it
 * to the view as `structuredContent`. The view never talks to ARES directly —
 * it only renders graphs and asks the server to expand nodes. Keeping the wire
 * format in one file means both sides stay in sync.
 */

/** A graph node is either a registered company or a natural person. */
export type NodeKind = "company" | "person";

export interface GraphNode {
  /** Stable, deduplicating identity, e.g. `ico:24130222` or `person:jan|novak|1979`. */
  id: string;
  kind: NodeKind;
  /** Human-readable display name. */
  label: string;
  /** IČO (8 digits) — present for companies, enables expansion. */
  ico?: string;
  /** Secondary line: legal form for companies, birth year for people. */
  subtitle?: string;
  /** True for the entity the graph was opened on. */
  root?: boolean;
  /** True when this company can be expanded (has an IČO we can look up). */
  expandable?: boolean;
  /** Free-form key/value details shown in the inspector panel. */
  meta?: Record<string, string>;
}

export interface GraphEdge {
  /** Source node id. */
  source: string;
  /** Target node id. */
  target: string;
  /** Relationship label, e.g. `jednatel`, `společník`, `člen představenstva`. */
  label: string;
}

export interface GraphData {
  /** Id of the node this graph is centred on. */
  rootId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** ISO timestamp; handy for cache/debug and shown in the footer. */
  generatedAt: string;
}

/** One hit from a name search, used by the `ares-search` tool. */
export interface CompanyHit {
  ico: string;
  name: string;
  address?: string;
}
