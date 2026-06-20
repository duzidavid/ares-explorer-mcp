/**
 * Tests for the tolerant VR parser (buildGraph). Runs without network using a
 * representative fixture. Execute with: `npm test`.
 */

import assert from "node:assert/strict";
import { buildGraph } from "../src/ares";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// A trimmed but structurally realistic "veřejný rejstřík" record for an s.r.o.
// with one natural-person jednatel and one corporate společník (that itself is
// represented by a natural person — which must NOT leak as a separate node).
const ROOT_ICO = "24130222";
const subject = {
  ico: ROOT_ICO,
  obchodniJmeno: "Testovací s.r.o.",
  pravniForma: "Společnost s ručením omezeným",
  sidlo: { textovaAdresa: "Václavské náměstí 1, Praha" },
  datumVzniku: "2011-05-03",
};

const vr = {
  zaznamy: [
    {
      ico: ROOT_ICO,
      obchodniJmeno: [{ obchodniJmeno: "Testovací s.r.o.", primarniZaznam: true }],
      statutarniOrgany: [
        {
          typOrganu: "statutarniOrgan",
          clenoveOrganu: [
            {
              fyzickaOsoba: {
                jmeno: "Jan",
                prijmeni: "Novák",
                titulPredJmenem: "Ing.",
                datumNarozeni: "1979-02-14",
                adresa: { textovaAdresa: "Brno" },
              },
              funkce: { nazev: "jednatel" },
            },
          ],
        },
      ],
      spolecnici: [
        {
          spolecnik: [
            {
              pravnickaOsoba: {
                ico: "00006947", // Ministerstvo financí (as a stand-in corporate owner)
                obchodniJmeno: "Mateřská Holding a.s.",
                // a representing person nested inside the corporate member:
                fyzickaOsoba: { jmeno: "Petr", prijmeni: "Zástupce", datumNarozeni: "1965-01-01" },
              },
              podily: [{ vklad: { hodnota: 200000 } }],
            },
          ],
        },
      ],
    },
  ],
};

console.log("buildGraph");

test("root node carries subject metadata and is marked root", () => {
  const g = buildGraph(ROOT_ICO, subject, vr);
  const root = g.nodes.find((n) => n.id === g.rootId);
  assert.ok(root, "root node exists");
  assert.equal(root!.root, true);
  assert.equal(root!.ico, ROOT_ICO);
  assert.equal(root!.label, "Testovací s.r.o.");
  assert.equal(root!.meta?.["sídlo"], "Václavské náměstí 1, Praha");
});

test("extracts the jednatel as a person with precise role", () => {
  const g = buildGraph(ROOT_ICO, subject, vr);
  const person = g.nodes.find((n) => n.kind === "person" && n.label.includes("Novák"));
  assert.ok(person, "Jan Novák found");
  assert.equal(person!.label, "Ing. Jan Novák");
  assert.equal(person!.subtitle, "nar. 1979");
  const edge = g.edges.find((e) => e.target === person!.id);
  assert.equal(edge?.label, "jednatel");
});

test("extracts the corporate společník as an expandable company", () => {
  const g = buildGraph(ROOT_ICO, subject, vr);
  const company = g.nodes.find((n) => n.kind === "company" && n.ico === "00006947");
  assert.ok(company, "corporate owner found");
  assert.equal(company!.expandable, true);
  const edge = g.edges.find((e) => e.target === company!.id);
  assert.equal(edge?.label, "společník");
});

test("does NOT leak the representing person nested inside the corporate member", () => {
  const g = buildGraph(ROOT_ICO, subject, vr);
  const leaked = g.nodes.find((n) => n.label.includes("Zástupce"));
  assert.equal(leaked, undefined, "nested representative is pruned");
});

test("root is never added as its own relation", () => {
  const g = buildGraph(ROOT_ICO, subject, vr);
  const selfEdge = g.edges.find((e) => e.target === g.rootId);
  assert.equal(selfEdge, undefined);
});

test("handles a subject with no VR record (e.g. OSVČ) gracefully", () => {
  const g = buildGraph(ROOT_ICO, subject, null);
  assert.equal(g.nodes.length, 1);
  assert.equal(g.edges.length, 0);
});

console.log(`\n${passed} testů prošlo.`);
