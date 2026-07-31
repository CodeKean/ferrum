// Which words find which lane.
//
// The mode picker's titles are plain English on purpose — the person choosing usually does not know
// what an HTTP request is. The cost of that is a screen where the word "HTTP" appears nowhere, so
// someone arriving from Clay searches for the thing they already know they want, finds nothing, and
// concludes the feature is missing. It is not missing; it is called something else.
//
// So these are not tests of a filter function. They are the list of words a real person types, and
// the lane each one has to land on. A term that stops matching is a feature that has become
// invisible, which is indistinguishable from a feature that was never built.

import { test } from "node:test";
import assert from "node:assert/strict";
import { filterModes } from "./modes.ts";

/** The card ids a query finds, in list order. */
const ids = (q: string) => filterModes(q).map((m) => m.id);

test("an empty search shows every lane", () => {
  assert.equal(filterModes("").length, 12);
  assert.equal(filterModes("   ").length, 12);
});

test("the words someone arriving from Clay types each find the right lane", () => {
  // The one the user named explicitly.
  assert.ok(ids("http api").includes("http-get"));
  assert.ok(ids("HTTP API").includes("http-get"), "search is case-insensitive");

  const cases: Array<[string, string]> = [
    ["webhook", "http-send"],
    ["zapier", "http-send"],
    ["n8n", "http-send"],
    ["rest", "http-get"],
    ["endpoint", "http-get"],
    ["bearer token", "http-get"],
    ["prospeo", "http-get"],
    ["vlookup", "lookup"],
    ["join", "lookup"],
    ["relation", "lookup"],
    ["rollup", "rollup"],
    ["aggregate", "rollup"],
    ["sum", "rollup"],
    ["count", "rollup"],
    ["regex", "script"],
    ["javascript", "script"],
    ["formula", "script"],
    ["normalize", "script"],
    ["normalise", "script"],
    ["gpt", "ai"],
    ["claude", "ai"],
    ["classify", "ai"],
    ["categorize", "ai"],
    ["categorise", "ai"],
    ["scrape", "agent"],
    ["web search", "agent"],
    ["research", "agent"],
    ["crm", "send"],
    ["upsert", "send"],
    ["fan out", "send"],
    ["csv", "static"],
    ["import", "static"],
  ];
  for (const [q, id] of cases) {
    assert.ok(ids(q).includes(id), `searching "${q}" must find ${id}, got [${ids(q).join(", ")}]`);
  }
});

test("both spellings of the words that have two are covered", () => {
  // A British speller and an American speller are the same user with the same need, and one of them
  // silently finding nothing is the failure this whole file exists to catch.
  for (const pair of [["normalise", "normalize"], ["categorise", "categorize"], ["summarise", "summarize"]]) {
    const [a, b] = pair as [string, string];
    assert.deepEqual(ids(a), ids(b), `"${a}" and "${b}" must find the same lanes`);
    assert.ok(ids(a).length > 0);
  }
});

test("every word is required, so a second word narrows rather than widens", () => {
  const wide = ids("table");
  const narrow = ids("table count");
  assert.ok(narrow.length < wide.length, "adding a word must not return MORE lanes");
  assert.ok(narrow.every((id) => wide.includes(id)));
});

test("a phrase whose words are spread across different fields still matches", () => {
  // "api" is in the tag, "row" is in the test sentence — a whole-phrase match would find nothing.
  assert.ok(ids("api row").length > 0);
});

test("a word that genuinely means nothing here finds nothing", () => {
  // The empty state has to be reachable, and it must not be reachable by accident: a filter that
  // matched everything would make the search look broken in the other direction.
  assert.deepEqual(ids("banana"), []);
});

test("every lane is reachable by its own industry name", () => {
  // The guarantee in one line: whatever a lane is called on its card, typing that finds it.
  for (const m of filterModes("")) {
    assert.ok(ids(m.tag).includes(m.id), `"${m.tag}" must find its own card`);
  }
});

test("no two lanes share a tag, so a tag search is unambiguous about what it named", () => {
  const tags = filterModes("").map((m) => m.tag.toLowerCase());
  assert.equal(new Set(tags).size, tags.length);
});

test("the words someone wants a waterfall for find the waterfall", () => {
  // The lane exists because running four providers on every row and running them until one works are
  // wildly different bills. Someone who knows they want that arrives typing the vendor they already
  // pay for, or the word Clay uses — and landing on nothing is what sends them back to Clay.
  for (const q of [
    "waterfall", "fallback", "cascade", "email finder", "phone finder",
    "hunter", "dropcontact", "findymail", "coverage", "backup provider",
  ]) {
    assert.ok(ids(q).includes("waterfall"), `"${q}" should find the waterfall lane`);
  }
});

test("a vendor name finds BOTH the waterfall and the single API call", () => {
  // Deliberate, not a collision to fix. Someone typing "prospeo" has two honest answers — one call,
  // or one call inside an ordered list of them — and hiding either is deciding for them.
  for (const q of ["prospeo", "betterenrich", "clay"]) {
    const found = ids(q);
    assert.ok(found.includes("waterfall"), `"${q}" should offer the waterfall`);
    assert.ok(found.includes("http-get"), `"${q}" should still offer a single call`);
  }
});
