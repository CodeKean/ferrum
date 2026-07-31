// Broken references and reference loops, worked out in the browser before anything is saved.
//
// Both checks exist because of the same failure: a reference that resolves to nothing does not throw
// and does not show up in a cell. It runs, per row, against a literal — which on a paid column is a
// bill for a column of confidently wrong values. So the tests pin the two directions that matter:
// what must be REFUSED, and — just as important — what must still be allowed through.

import { test } from "node:test";
import assert from "node:assert/strict";
import { brokenRefs, cyclePathsFrom, type GraphColumn } from "./refGraph.ts";

const col = (id: string, name: string, extra: Partial<GraphColumn> = {}): GraphColumn =>
  ({ id, name, ...extra });

const COLUMNS: GraphColumn[] = [
  col("1", "Website"),
  col("2", "Country"),
  col("3", "Company"),
];

test("a reference to a live column is not broken", () => {
  assert.deepEqual(brokenRefs("Look up {{col:1}} in {{col:2}}", COLUMNS), []);
  // The name form resolves too — it is what a pasted prompt from elsewhere looks like.
  assert.deepEqual(brokenRefs("Look up {{Website}}", COLUMNS), []);
  // Optional markers are a different question entirely and must not read as broken.
  assert.deepEqual(brokenRefs("{{col:1?}}", COLUMNS), []);
  assert.deepEqual(brokenRefs("", COLUMNS), []);
});

test("a reference to a deleted column is reported, not silently dropped", () => {
  const broken = brokenRefs("Summarise {{col:99}}", COLUMNS);
  assert.equal(broken.length, 1);
  assert.equal(broken[0]!.label, "/deleted column 99");
  // No original name survives an id form, so there is nothing honest to suggest.
  assert.equal(broken[0]!.suggestion, null);
});

test("a misspelled name is reported WITH the column it probably meant", () => {
  const broken = brokenRefs("Look up {{Websit}}", COLUMNS);
  assert.deepEqual(broken, [{ label: "/Websit", suggestion: "Website" }]);
});

test("a name nothing resembles gets no suggestion rather than a wrong one", () => {
  const broken = brokenRefs("{{Annual recurring revenue}}", COLUMNS);
  assert.equal(broken.length, 1);
  assert.equal(broken[0]!.suggestion, null, "a wrong suggestion is worse than none");
});

test("the same broken reference twice is one complaint", () => {
  assert.equal(brokenRefs("{{col:99}} and {{col:99}}", COLUMNS).length, 1);
});

test("a column that already reads this one cannot be read back, and the loop is named", () => {
  // Domain reads Website. So Website may not read Domain.
  const columns: GraphColumn[] = [
    col("1", "Website"),
    col("2", "Domain", { prompt: "The root domain of {{col:1}}" }),
    col("3", "Country"),
  ];
  const paths = cyclePathsFrom("1", columns);
  assert.equal(paths.get("2"), "Website → Domain → Website");
  // Everything else is still offerable — a cycle check that disables the whole menu is useless.
  assert.equal(paths.get("3"), undefined);
  assert.equal(paths.get("1"), undefined, "self-reference is a different message, not a cycle");
});

test("a loop through a chain names every step of it", () => {
  const columns: GraphColumn[] = [
    col("1", "Price"),
    col("2", "Currency", { prompt: "Currency for {{col:1}}" }),
    col("3", "Total", { prompt: "{{col:2}} times quantity" }),
  ];
  assert.equal(cyclePathsFrom("1", columns).get("3"), "Price → Total → Currency → Price");
});

test("a request and a send configuration carry references too", () => {
  // Both were invisible to a scan that only read prompts, which is how a send column ended up with
  // depth 0 — sorting ahead of every column it reads.
  const viaHttp: GraphColumn[] = [
    col("1", "Website"),
    col("2", "Industry", { httpConfig: { url: "https://api.example.com/x?d={{col:1}}", query: [] } }),
  ];
  assert.equal(cyclePathsFrom("1", viaHttp).get("2"), "Website → Industry → Website");

  const viaSend: GraphColumn[] = [
    col("1", "Email"),
    col("2", "Send to CRM", { sendConfig: { mapping: { "7": { from: "row", columnId: 1 } } } }),
  ];
  assert.equal(cyclePathsFrom("1", viaSend).get("2"), "Email → Send to CRM → Email");
});

test("an unrelated table of columns produces no loops at all", () => {
  const columns: GraphColumn[] = [
    col("1", "Website"),
    col("2", "Country", { prompt: "Where is {{col:3}}" }),
    col("3", "Company"),
  ];
  // Website is read by nobody, so nothing it could reference closes a loop.
  assert.equal(cyclePathsFrom("1", columns).size, 0);
});
