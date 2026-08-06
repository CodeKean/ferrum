import test from "node:test";
import assert from "node:assert/strict";
import { parseRefNodes, serializeRefNodes, uniqueRefs, type RefColumnLite } from "./refNodes.ts";

// The reference format sits behind every prompt, rule, request and destination field in the app, and
// had no test at all. What matters most is the ROUND TRIP: the editor parses a stored template into
// nodes, draws them, reads them back and serializes. If that is not lossless, editing one word of a
// prompt silently rewrites the references in it.

const columns: RefColumnLite[] = [
  { id: 33, name: "Company" },
  { id: 34, name: "Website" },
  { id: 35, name: "Country" },
];

const trip = (s: string) => serializeRefNodes(parseRefNodes(s, columns));

test("plain text survives untouched", () => {
  assert.equal(trip("What industry is this?"), "What industry is this?");
  assert.equal(trip(""), "");
});

test("an id reference round trips", () => {
  assert.equal(trip("What industry is {{col:33}} in?"), "What industry is {{col:33}} in?");
});

test("optional is preserved, not dropped", () => {
  // This mark decides whether a row with a blank is paid for, so losing it costs money.
  assert.equal(trip("{{col:33?}}"), "{{col:33?}}");
  const [ref] = parseRefNodes("{{col:33?}}", columns);
  assert.equal(ref && ref.type === "ref" && ref.optional, true);
});

test("a JSON path is preserved", () => {
  assert.equal(trip("{{col:34.industry}}"), "{{col:34.industry}}");
  assert.equal(trip("{{col:34.a.b}}"), "{{col:34.a.b}}");
  assert.equal(trip("{{col:34[0]}}"), "{{col:34[0]}}");
});

test("a path and an optional mark together", () => {
  assert.equal(trip("{{col:34.industry?}}"), "{{col:34.industry?}}");
});

test("a name reference resolves to its column's id", () => {
  const [ref] = parseRefNodes("{{Website}}", columns);
  assert.equal(ref && ref.type === "ref" && ref.columnId, "34");
  // Once resolved it is stored by id, so renaming the column later cannot break it.
  assert.equal(trip("{{Website}}"), "{{col:34}}");
});

test("a name reference matches case-insensitively and ignores surrounding spaces", () => {
  assert.equal(trip("{{ website }}"), "{{col:34}}");
  assert.equal(trip("{{WEBSITE}}"), "{{col:34}}");
});

test("a name that matches nothing is written back by name, not emptied", () => {
  // A template pasted from another table must survive this editor rather than being quietly gutted.
  assert.equal(trip("{{Revenue}}"), "{{Revenue}}");
  assert.equal(trip("{{Revenue?}}"), "{{Revenue?}}");
});

test("a reference to a deleted column keeps its id and says so", () => {
  const [ref] = parseRefNodes("{{col:999}}", columns);
  assert.equal(ref && ref.type === "ref" && ref.name, "deleted column 999");
  // The id survives the trip, so the template still means what it meant.
  assert.equal(trip("{{col:999}}"), "{{col:999}}");
});

test("a slash is just a slash — no escape syntax", () => {
  assert.equal(trip("https://acme.com/about"), "https://acme.com/about");
});

test("several references and the text between them keep their order", () => {
  const s = "Is {{col:33}} in {{col:35?}} a {{col:34.kind}} company?";
  assert.equal(trip(s), s);
  const nodes = parseRefNodes(s, columns);
  assert.deepEqual(nodes.map((n) => n.type), ["text", "ref", "text", "ref", "text", "ref", "text"]);
});

test("uniqueRefs gives one entry per column, keeping the first", () => {
  const nodes = parseRefNodes("{{col:33}} {{col:34}} {{col:33?}}", columns);
  const refs = uniqueRefs(nodes);
  assert.deepEqual(refs.map((r) => r.columnId), ["33", "34"]);
  // The first occurrence wins, so a duplicate cannot flip the decision made by the first.
  assert.equal(refs[0]!.optional, false);
});

test("an unresolved name and an id are counted apart by uniqueRefs", () => {
  const refs = uniqueRefs(parseRefNodes("{{col:33}} {{Revenue}}", columns));
  assert.equal(refs.length, 2);
});
