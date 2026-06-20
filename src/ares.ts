/**
 * Thin client for the public ARES REST API (Ministry of Finance of the Czech
 * Republic) plus a tolerant parser that turns a "veřejný rejstřík" (VR) record
 * into a relationship {@link GraphData graph}.
 *
 * Why a *tolerant* parser? The VR JSON is deeply nested and its exact shape
 * varies by legal form (s.r.o. vs a.s. vs spolek …) and changes over time. Rather
 * than hard-coding one schema and breaking on the next edge case, we walk the
 * record recursively and pick out anything that *looks like* a person
 * (`jmeno` + `prijmeni`) or a related company (`ico` + `obchodniJmeno`),
 * deriving the relationship label from the surrounding key path. This stays
 * correct across registry quirks and is the kind of defensive parsing real
 * registry tooling needs.
 *
 * Docs: https://ares.gov.cz/stranky/vyvojar-info
 * API limits: max 500 requests/min per the ARES terms of use.
 */

import type { CompanyHit, GraphData, GraphEdge, GraphNode } from "./types";

const BASE = "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest";

/** Hard cap on nodes added from a single record, to keep the graph readable. */
const MAX_RELATIONS_PER_RECORD = 80;

const REQUEST_TIMEOUT_MS = 12_000;

export class AresError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AresError";
  }
}

/** Normalise user input to a bare 8-digit IČO, or throw a friendly error. */
export function normalizeIco(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 0) throw new AresError("Nebylo zadáno žádné IČO.");
  // IČO is up to 8 digits; ARES expects it zero-padded to 8.
  if (digits.length > 8) throw new AresError(`„${raw}" není platné IČO (víc než 8 číslic).`);
  return digits.padStart(8, "0");
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "ares-explorer-mcp/0.1 (+https://github.com/)",
        ...init?.headers,
      },
    });
    if (res.status === 404) throw new AresError("Subjekt nebyl v ARES nalezen.", 404);
    if (!res.ok) throw new AresError(`ARES vrátil chybu ${res.status}.`, res.status);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof AresError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new AresError("Vypršel časový limit dotazu na ARES.");
    }
    throw new AresError(`Dotaz na ARES selhal: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Basic registration record (`/ekonomicke-subjekty/{ico}`). */
interface AresSubject {
  ico?: string;
  obchodniJmeno?: string;
  pravniForma?: string;
  sidlo?: { textovaAdresa?: string };
  datumVzniku?: string;
  datumZaniku?: string;
}

export async function getSubject(ico: string): Promise<AresSubject> {
  return fetchJson<AresSubject>(`${BASE}/ekonomicke-subjekty/${ico}`);
}

/** Full "veřejný rejstřík" record (`/ekonomicke-subjekty-vr/{ico}`) — holds the relationships. */
export async function getVrRecord(ico: string): Promise<unknown> {
  return fetchJson<unknown>(`${BASE}/ekonomicke-subjekty-vr/${ico}`);
}

/** Name search (`POST /ekonomicke-subjekty/vyhledat`). */
export async function searchByName(nazev: string, pocet = 10): Promise<CompanyHit[]> {
  interface SearchResponse {
    ekonomickeSubjekty?: AresSubject[];
  }
  const data = await fetchJson<SearchResponse>(`${BASE}/ekonomicke-subjekty/vyhledat`, {
    method: "POST",
    body: JSON.stringify({ obchodniJmeno: nazev, pocet: Math.min(Math.max(pocet, 1), 50) }),
  });
  return (data.ekonomickeSubjekty ?? [])
    .filter((s) => s.ico && s.obchodniJmeno)
    .map((s) => ({
      ico: s.ico as string,
      name: s.obchodniJmeno as string,
      address: s.sidlo?.textovaAdresa,
    }));
}

// ---------------------------------------------------------------------------
// Relationship extraction
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** A person object has both a given name and a surname. */
function asPerson(o: Record<string, unknown>): { label: string; birth?: string } | null {
  const jmeno = str(o.jmeno);
  const prijmeni = str(o.prijmeni);
  if (!jmeno || !prijmeni) return null;
  const titul = str(o.titulPredJmenem);
  const label = [titul, jmeno, prijmeni].filter(Boolean).join(" ");
  const birth = str(o.datumNarozeni);
  return { label, birth };
}

/** A related-company object exposes an IČO and a business name. */
function asCompany(o: Record<string, unknown>): { ico: string; name: string } | null {
  const ico = str(o.ico);
  const name = str(o.obchodniJmeno);
  if (!ico || !/^\d{6,8}$/.test(ico) || !name) return null;
  return { ico: ico.padStart(8, "0"), name };
}

/**
 * Map a key-path inside the VR record to a human relationship label. We scan the
 * whole path (joined + lowercased) for known role tokens; a precise `funkce.nazev`
 * found next to the member overrides this.
 */
function roleFromPath(path: string[]): string {
  const p = path.join("/").toLowerCase();
  if (p.includes("likvidator")) return "likvidátor";
  if (p.includes("prokur")) return "prokurista";
  if (p.includes("spolecnik") || p.includes("spolecnost")) return "společník";
  if (p.includes("dozorci")) return "dozorčí rada";
  if (p.includes("spravnirada") || p.includes("spravni")) return "správní rada";
  if (p.includes("predstavenstvo")) return "představenstvo";
  if (p.includes("statutarni")) return "statutární orgán";
  if (p.includes("akcionar")) return "akcionář";
  if (p.includes("zakladatel")) return "zakladatel";
  if (p.includes("clen")) return "člen orgánu";
  return "vazba";
}

/** Look for a `funkce` / `nazevAngazma` sibling to refine the role label. */
function preciseFunction(o: Record<string, unknown>): string | undefined {
  const funkce = o.funkce;
  if (isRecord(funkce)) {
    const nazev = str(funkce.nazev) ?? str((funkce as Record<string, unknown>).typ);
    if (nazev) return nazev.toLowerCase();
  }
  return str((o as Record<string, unknown>).nazevAngazma)?.toLowerCase();
}

interface Extracted {
  node: GraphNode;
  role: string;
}

/**
 * Recursively walk a VR record collecting people and related companies. When an
 * entity is identified we *stop descending* into it — this both avoids double
 * counting (e.g. a natural person representing a corporate board member) and
 * keeps the graph at the organisation level. The root company (its own IČO) is
 * never added as a relation but is still descended into.
 */
function walk(
  value: unknown,
  rootIco: string,
  path: string[],
  out: Map<string, Extracted>,
  roleHint?: string,
): void {
  if (out.size >= MAX_RELATIONS_PER_RECORD) return;

  if (Array.isArray(value)) {
    for (const item of value) walk(item, rootIco, path, out, roleHint);
    return;
  }
  if (!isRecord(value)) return;

  const localRole = preciseFunction(value) ?? roleHint;

  // Related company?
  const company = asCompany(value);
  if (company && company.ico !== rootIco) {
    const id = `ico:${company.ico}`;
    if (!out.has(id)) {
      out.set(id, {
        role: localRole ?? roleFromPath(path),
        node: {
          id,
          kind: "company",
          label: company.name,
          ico: company.ico,
          expandable: true,
          meta: { ico: company.ico },
        },
      });
    }
    return; // prune: don't descend into the related company's internals
  }

  // Natural person?
  const person = asPerson(value);
  if (person) {
    const birthKey = person.birth ?? "";
    const id = `person:${person.label.toLowerCase()}|${birthKey}`;
    if (!out.has(id)) {
      const year = person.birth?.slice(0, 4);
      out.set(id, {
        role: localRole ?? roleFromPath(path),
        node: {
          id,
          kind: "person",
          label: person.label,
          subtitle: year ? `nar. ${year}` : undefined,
          meta: person.birth ? { "datum narození": person.birth } : undefined,
        },
      });
    }
    return; // prune: don't descend into the person's address etc.
  }

  // Otherwise keep descending. A `funkce` found here (e.g. on a board-member
  // wrapper object) becomes the role hint for the person/company nested inside.
  for (const [key, child] of Object.entries(value)) {
    walk(child, rootIco, [...path, key], out, localRole);
  }
}

/**
 * Build a relationship graph centred on one company from its basic subject info
 * and (optionally) its VR record. Returns the root plus one edge to every
 * directly related person/company.
 */
export function buildGraph(
  ico: string,
  subject: AresSubject,
  vr: unknown,
): GraphData {
  const rootId = `ico:${ico}`;
  const rootMeta: Record<string, string> = { ico };
  if (subject.pravniForma) rootMeta["právní forma"] = subject.pravniForma;
  if (subject.sidlo?.textovaAdresa) rootMeta["sídlo"] = subject.sidlo.textovaAdresa;
  if (subject.datumVzniku) rootMeta["vznik"] = subject.datumVzniku;
  if (subject.datumZaniku) rootMeta["zánik"] = subject.datumZaniku;

  const root: GraphNode = {
    id: rootId,
    kind: "company",
    label: subject.obchodniJmeno ?? `IČO ${ico}`,
    ico,
    root: true,
    expandable: false, // already expanded
    subtitle: subject.pravniForma,
    meta: rootMeta,
  };

  const extracted = new Map<string, Extracted>();
  if (vr !== undefined && vr !== null) {
    walk(vr, ico, [], extracted);
  }

  const nodes: GraphNode[] = [root];
  const edges: GraphEdge[] = [];
  for (const { node, role } of extracted.values()) {
    nodes.push(node);
    edges.push({ source: rootId, target: node.id, label: role });
  }

  return {
    rootId,
    nodes,
    edges,
    generatedAt: new Date().toISOString(),
  };
}

/** Convenience: fetch everything needed and build the graph for one IČO. */
export async function graphForIco(rawIco: string): Promise<GraphData> {
  const ico = normalizeIco(rawIco);
  const [subject, vr] = await Promise.all([
    getSubject(ico),
    getVrRecord(ico).catch(() => null), // some subjects (e.g. OSVČ) have no VR record
  ]);
  return buildGraph(ico, subject, vr);
}
