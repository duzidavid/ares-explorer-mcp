/**
 * ARES Explorer — MCP App as a Vercel serverless function.
 *
 * The same three tools and ui:// resource that previously ran under a long-lived
 * Express process (see git history for server.ts), now served statelessly via
 * `mcp-handler`'s Streamable HTTP transport at POST /api/mcp:
 *   • ares-search   — find companies by name (plain tool, no UI)
 *   • company-graph — open the interactive relationship graph for a company (UI app)
 *   • expand-node   — fetch one company's relationships; called by the running app
 *                     when the user clicks a node, and reused to graft new clusters
 *
 * The graph rendering lives entirely in the sandboxed view (src/mcp-app.ts, built
 * by vite into a single HTML file). In serverless there is no dependable runtime
 * filesystem for that artifact, so the build inlines it as ARES_EXPLORER_HTML
 * (scripts/inline-html.mjs) and the ui:// resource serves that string directly.
 */

import { createMcpHandler } from "mcp-handler";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

import {
  AresError,
  graphForIco,
  normalizeIco,
  searchByName,
} from "../../../src/ares";
import type { GraphData } from "../../../src/types";
import { ARES_EXPLORER_HTML } from "./ares-explorer-html";

export const runtime = "nodejs";
export const maxDuration = 60;

const RESOURCE_URI = "ui://ares-explorer/graph.html";

/** Short text rendition of a graph so the model has context alongside the UI. */
function summarize(graph: GraphData): string {
  const root = graph.nodes.find((n) => n.id === graph.rootId);
  const others = graph.nodes.filter((n) => n.id !== graph.rootId);
  const people = others.filter((n) => n.kind === "person").length;
  const companies = others.filter((n) => n.kind === "company").length;
  return (
    `Graf vazeb pro „${root?.label ?? graph.rootId}" (IČO ${root?.ico ?? "?"}): ` +
    `${others.length} přímých vazeb — ${people} osob, ${companies} firem. ` +
    `Kliknutím na firmu v appce se její vazby donačtou.`
  );
}

/** GraphData is a named interface; cast to a record so it satisfies structuredContent. */
const structured = (graph: GraphData) => graph as unknown as { [k: string]: unknown };

/** Turn errors into a user-facing tool error rather than crashing the transport. */
function toolError(err: unknown) {
  const message =
    err instanceof AresError ? err.message : `Neočekávaná chyba: ${(err as Error).message}`;
  return { content: [{ type: "text" as const, text: `⚠️ ${message}` }], isError: true };
}

const handler = createMcpHandler(
  (server) => {
    // --- ares-search (plain tool, no UI) -----------------------------------
    server.registerTool(
      "ares-search",
      {
        title: "Hledat firmu v ARES",
        description:
          "Vyhledá ekonomické subjekty v českém registru ARES podle názvu a vrátí jejich IČO. " +
          "Použij, když uživatel zná jméno firmy, ale ne IČO; výsledné IČO pak předej toolu company-graph.",
        inputSchema: {
          nazev: z.string().min(2).describe("Název firmy nebo jeho část"),
          pocet: z.number().int().min(1).max(50).optional().describe("Max. počet výsledků (default 10)"),
        },
      },
      async ({ nazev, pocet }) => {
        try {
          const hits = await searchByName(nazev, pocet ?? 10);
          if (hits.length === 0) {
            return { content: [{ type: "text", text: `Pro „${nazev}" nebyly nalezeny žádné subjekty.` }] };
          }
          const lines = hits.map((h) => `• ${h.name} — IČO ${h.ico}${h.address ? ` (${h.address})` : ""}`);
          return {
            content: [{ type: "text", text: `Nalezené subjekty:\n${lines.join("\n")}` }],
            structuredContent: { hits } as { [k: string]: unknown },
          };
        } catch (err) {
          return toolError(err);
        }
      },
    );

    // --- company-graph (UI app) --------------------------------------------
    registerAppTool(
      server,
      "company-graph",
      {
        title: "Graf vazeb firmy",
        description:
          "Otevře interaktivní graf personálních a vlastnických vazeb firmy z českého registru ARES " +
          "(statutární orgán, společníci, propojené firmy). Zadej IČO, nebo název firmy. " +
          "Uzly firem lze v appce rozklikávat a graf se živě rozrůstá.",
        inputSchema: {
          ico: z.string().optional().describe("IČO firmy (8 číslic)"),
          nazev: z.string().optional().describe("Název firmy — použije se, pokud není zadáno IČO"),
        },
        _meta: { ui: { resourceUri: RESOURCE_URI } },
      },
      async ({ ico, nazev }) => {
        try {
          let resolvedIco = ico ? normalizeIco(ico) : undefined;
          let note = "";
          if (!resolvedIco) {
            if (!nazev) throw new AresError("Zadej prosím IČO nebo název firmy.");
            const hits = await searchByName(nazev, 5);
            if (hits.length === 0) throw new AresError(`Pro „${nazev}" nebyl nalezen žádný subjekt.`);
            resolvedIco = hits[0].ico;
            if (hits.length > 1) {
              note =
                `\nVybral jsem „${hits[0].name}" (IČO ${resolvedIco}). Další shody: ` +
                hits.slice(1).map((h) => `${h.name} (${h.ico})`).join(", ") + ".";
            }
          }
          const graph = await graphForIco(resolvedIco);
          return {
            content: [{ type: "text", text: summarize(graph) + note }],
            structuredContent: structured(graph),
          };
        } catch (err) {
          return toolError(err);
        }
      },
    );

    // --- expand-node (plain tool; called by the running app) ---------------
    server.registerTool(
      "expand-node",
      {
        title: "Donačíst vazby firmy",
        description:
          "Vrátí vazby jedné firmy podle IČO jako podgraf. Volá ji běžící appka při rozkliknutí uzlu; " +
          "lze použít i pro připojení nové firmy do existujícího grafu.",
        inputSchema: {
          ico: z.string().describe("IČO firmy k rozbalení (8 číslic)"),
        },
      },
      async ({ ico }) => {
        try {
          const graph = await graphForIco(ico);
          return {
            content: [{ type: "text", text: summarize(graph) }],
            structuredContent: structured(graph),
          };
        } catch (err) {
          return toolError(err);
        }
      },
    );

    // --- UI resource -------------------------------------------------------
    registerAppResource(
      server,
      "ARES Explorer Graph",
      RESOURCE_URI,
      {
        _meta: {
          ui: {
            // The bundled view reaches ARES directly for live node expansion; declare
            // the connect origin so the host CSP allows it. Drawing is inline SVG/CSS.
            csp: {
              connectDomains: ["https://ares.gov.cz"],
            },
            prefersBorder: false,
          },
        },
      },
      async () => ({
        contents: [
          { uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: ARES_EXPLORER_HTML },
        ],
      }),
    );
  },
  {
    serverInfo: { name: "ARES Explorer", version: "0.1.0" },
  },
  {
    // The route lives at app/api/mcp/route.ts, so the transport is mounted under /api.
    basePath: "/api",
    maxDuration: 60,
    // redisUrl is only needed for SSE resumability; this server is stateless
    // Streamable HTTP (JSON responses), so it is intentionally omitted.
  },
);

export { handler as GET, handler as POST, handler as DELETE };
