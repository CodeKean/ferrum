// What the palette must put first.
//
// Ordering is the whole product in a command palette, and it is the part no screenshot shows. These
// pin the cases that make one feel broken: an acronym that does not find its command, a keyword
// match outranking the thing whose name you actually typed, and an empty query reshuffling the list.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rank, score } from "./commandMatch.ts";

const CMDS = [
  { label: "Add column", kw: "field new" },
  { label: "Add row", kw: "record new" },
  { label: "Export as CSV", kw: "download csv save" },
  { label: "Run every runnable column", kw: "start execute" },
  { label: "Deduplication…", kw: "duplicate merge" },
];
const ranked = (q: string) => rank(CMDS, q, (c) => c.label, (c) => c.kw).map((r) => r.item.label);

test("an acronym finds its command", () => {
  // "adcol" is a subsequence of "Add column", not a substring — `includes` would find nothing.
  assert.equal(ranked("adcol")[0], "Add column");
});

test("a space in the query is a separator, not a character to find", () => {
  assert.equal(ranked("add col")[0], "Add column");
});

test("the label beats a keyword", () => {
  // "csv" is in the label of Export and in nobody else's; but the point is that a command matching
  // on its LABEL must outrank one matching only on a hidden keyword.
  const r = rank(
    [{ label: "Deduplication…", kw: "export" }, { label: "Export as CSV", kw: "" }],
    "export",
    (c) => c.label,
    (c) => c.kw,
  );
  assert.equal(r[0]!.item.label, "Export as CSV");
});

test("a hidden keyword still finds a command whose name does not contain the word", () => {
  assert.ok(ranked("download").includes("Export as CSV"));
});

test("a query that matches nothing returns nothing, rather than everything", () => {
  assert.deepEqual(ranked("zzzz"), []);
});

test("an empty query keeps the list in the order it was given", () => {
  // Every item scores the same here, so this is really asserting the sort is stable — an unstable
  // one reshuffles the whole palette the moment you clear the box.
  assert.deepEqual(ranked(""), CMDS.map((c) => c.label));
});

test("an adjacent run outranks the same letters scattered", () => {
  const together = score("column", "col")!.score;
  const apart = score("cancel of lists", "col")!.score;
  assert.ok(together > apart, `expected an adjacent match to win: ${together} vs ${apart}`);
});

test("the matched positions come back, so the UI can mark them", () => {
  assert.deepEqual(score("Add column", "ac")!.hits, [0, 4]);
});
