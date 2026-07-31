// Rollups — one number about all the rows on the other side of a link.
//
// A rollup produces a NUMBER, and a wrong number is the worst possible output: it is not blank, it
// is not an error, and nothing about it invites checking. So most of these pin the two ways a
// rollup can be quietly wrong — treating text as zero, and inventing an answer for an empty group.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { addColumn, createSheet, insertRows } from "./store.ts";
import { createRelation, rebuildRelationKeys } from "./relations.ts";
import { noteRelationChange } from "./lookup.ts";
import { RollupError, refreshRollupColumn, rollupConfig, setRollup, type RollupFn } from "./rollup.ts";

function workbook(name: string): string {
  const id = `wb-${name}-${Math.random().toString(36).slice(2)}`;
  db.prepare("INSERT INTO workbooks (id, name) VALUES (?, ?)").run(id, name);
  return id;
}
function sheetIn(wb: string, name: string) {
  const s = createSheet(name);
  db.prepare("UPDATE sheets SET workbook_id = ? WHERE id = ?").run(wb, s.id);
  return s;
}
const rowIdsOf = (sheetId: string): number[] =>
  (db.prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY position").all(sheetId) as any[]).map((r) => Number(r.id));
const cell = (rowId: number, columnId: string | number) =>
  db.prepare("SELECT value_text, status FROM cells WHERE row_id = ? AND column_id = ?")
    .get(rowId, Number(columnId)) as any;

/**
 * Companies, and Contacts pointing at them. Acme has three contacts, Globex one, Initech none —
 * so every interesting case (several, one, zero) is present in one fixture.
 */
function scenario(name: string) {
  const wb = workbook(name);
  const companies = sheetIn(wb, `${name}-companies`);
  const contacts = sheetIn(wb, `${name}-contacts`);

  const cDomain = addColumn(companies.id, { name: "Domain", kind: "static", valueType: "url" });
  const out = addColumn(companies.id, { name: "Rollup", kind: "rollup", valueType: "number" });
  const kDomain = addColumn(contacts.id, { name: "Company Domain", kind: "static", valueType: "url" });
  const deal = addColumn(contacts.id, { name: "Deal", kind: "static", valueType: "number" });
  const person = addColumn(contacts.id, { name: "Name", kind: "static", valueType: "text" });

  insertRows(companies.id, [
    { values: { [String(cDomain.id)]: "acme.com" } },
    { values: { [String(cDomain.id)]: "globex.com" } },
    { values: { [String(cDomain.id)]: "initech.com" } },
  ], 0, [Number(cDomain.id)]);

  insertRows(contacts.id, [
    { values: { [String(kDomain.id)]: "acme.com", [String(deal.id)]: "100",     [String(person.id)]: "Ada" } },
    { values: { [String(kDomain.id)]: "acme.com", [String(deal.id)]: "$1,200",  [String(person.id)]: "Brue" } },
    // The row that breaks a naive sum: SQLite's own CAST('unknown' AS REAL) is 0.0.
    { values: { [String(kDomain.id)]: "acme.com", [String(deal.id)]: "unknown", [String(person.id)]: "Cy" } },
    { values: { [String(kDomain.id)]: "globex.com", [String(deal.id)]: "50",    [String(person.id)]: "Dot" } },
  ], 0, [Number(kDomain.id), Number(deal.id), Number(person.id)]);

  const rel = createRelation({
    fromSheetId: contacts.id, fromColumnId: Number(kDomain.id),
    toSheetId: companies.id, toColumnId: Number(cDomain.id),
  });

  const use = (fn: RollupFn, sourceColumnId: number | null, separator?: string) =>
    setRollup(Number(out.id), rel.id, fn, sourceColumnId, separator);

  return { companies, contacts, cDomain, out, kDomain, deal, person, rel, use };
}

test("count answers how many rows point here, including zero", () => {
  const s = scenario("count");
  s.use("count", null);
  refreshRollupColumn(s.companies.id, Number(s.out.id));
  const ids = rowIdsOf(s.companies.id);

  assert.equal(cell(ids[0]!, s.out.id).value_text, "3", "Acme has three contacts");
  assert.equal(cell(ids[1]!, s.out.id).value_text, "1");
  // The distinction that matters: a company with no contacts HAS zero contacts. That is an answer,
  // not an absence, so it is `done` rather than `not_found`.
  assert.equal(cell(ids[2]!, s.out.id).value_text, "0", "Initech has none, and zero is the answer");
  assert.equal(cell(ids[2]!, s.out.id).status, "done");
});

test("sum ignores text rather than counting it as zero", () => {
  // This is the defect the whole numeric path exists to prevent. CAST('unknown' AS REAL) is 0.0 in
  // SQLite, so the naive version returns the right total here by luck — but AVG does not, which is
  // the assertion below.
  const s = scenario("sum");
  s.use("sum", Number(s.deal.id));
  refreshRollupColumn(s.companies.id, Number(s.out.id));
  const ids = rowIdsOf(s.companies.id);

  // 100 + 1,200, with "unknown" left out entirely. The currency formatting is read, not rejected:
  // "$1,200" is how a number actually arrives from a CSV or a model.
  assert.equal(cell(ids[0]!, s.out.id).value_text, "1300");
  assert.equal(cell(ids[1]!, s.out.id).value_text, "50");
  assert.equal(cell(ids[2]!, s.out.id).value_text, "0", "nothing to add up is zero, which is a real total");
});

test("average is taken over the values that ARE numbers", () => {
  // The one where treating text as zero is unmistakably wrong: 1300/3 = 433.33 is a fabricated
  // average of a value nobody recorded, where 1300/2 = 650 is the average of what is known.
  const s = scenario("avg");
  s.use("avg", Number(s.deal.id));
  refreshRollupColumn(s.companies.id, Number(s.out.id));
  const ids = rowIdsOf(s.companies.id);
  assert.equal(cell(ids[0]!, s.out.id).value_text, "650");
});

test("min and max compare as numbers, not as text", () => {
  // Lexically "1,200" sorts before "50", so a text comparison reports the wrong extreme — and it
  // looks entirely plausible.
  const s = scenario("minmax");
  s.use("max", Number(s.deal.id));
  refreshRollupColumn(s.companies.id, Number(s.out.id));
  const ids = rowIdsOf(s.companies.id);
  assert.equal(cell(ids[0]!, s.out.id).value_text, "1200");

  s.use("min", Number(s.deal.id));
  refreshRollupColumn(s.companies.id, Number(s.out.id));
  assert.equal(cell(ids[0]!, s.out.id).value_text, "100");
});

test("an empty group has no minimum, and says so instead of reporting zero", () => {
  // Zero would be a fabricated fact: the smallest deal among no deals does not exist.
  const s = scenario("empty-min");
  s.use("min", Number(s.deal.id));
  refreshRollupColumn(s.companies.id, Number(s.out.id));
  const ids = rowIdsOf(s.companies.id);
  assert.equal(cell(ids[2]!, s.out.id).status, "not_found");
  assert.equal(cell(ids[2]!, s.out.id).value_text, null);
});

test("list joins the values on the other side", () => {
  const s = scenario("list");
  s.use("list", Number(s.person.id), " | ");
  refreshRollupColumn(s.companies.id, Number(s.out.id));
  const ids = rowIdsOf(s.companies.id);
  const got = String(cell(ids[0]!, s.out.id).value_text).split(" | ").sort();
  assert.deepEqual(got, ["Ada", "Brue", "Cy"]);
  assert.equal(cell(ids[2]!, s.out.id).status, "not_found", "no names is not an empty list, it is no answer");
});

test("a row with nothing to match on was never asked the question", () => {
  const s = scenario("nokey");
  // A company with no domain has no key, so it joins to nothing — but that is a different state
  // from "matched nothing", and collapsing them loses the only clue about which it is.
  const ids = rowIdsOf(s.companies.id);
  db.prepare("UPDATE cells SET value_text = '' WHERE row_id = ? AND column_id = ?").run(ids[2]!, Number(s.cDomain.id));
  rebuildRelationKeys(s.rel.id);

  s.use("count", null);
  refreshRollupColumn(s.companies.id, Number(s.out.id));
  assert.equal(cell(ids[2]!, s.out.id).status, "empty");
  assert.equal(cell(ids[2]!, s.out.id).value_text, null);
});

test("a pinned cell is never overwritten", () => {
  const s = scenario("pinned");
  const ids = rowIdsOf(s.companies.id);
  db.prepare("INSERT OR IGNORE INTO cells (row_id, column_id, status) VALUES (?, ?, 'empty')")
    .run(ids[0]!, Number(s.out.id));
  db.prepare("UPDATE cells SET value_text = '99', pinned = 1, status = 'done' WHERE row_id = ? AND column_id = ?")
    .run(ids[0]!, Number(s.out.id));

  s.use("count", null);
  refreshRollupColumn(s.companies.id, Number(s.out.id));
  assert.equal(cell(ids[0]!, s.out.id).value_text, "99");
  assert.equal(cell(ids[1]!, s.out.id).value_text, "1", "and the rest still compute");
});

test("the incremental path and the full refresh agree", () => {
  const s = scenario("agree");
  s.use("sum", Number(s.deal.id));
  const ids = rowIdsOf(s.companies.id);

  refreshRollupColumn(s.companies.id, Number(s.out.id), ids);
  const incremental = ids.map((id) => JSON.stringify(cell(id, s.out.id)));
  refreshRollupColumn(s.companies.id, Number(s.out.id));
  assert.deepEqual(ids.map((id) => JSON.stringify(cell(id, s.out.id))), incremental);
});

test("a calculation that could not run is refused at save time, not at row time", () => {
  const s = scenario("guard");
  // Everything except count needs a field to work on.
  assert.throws(() => s.use("sum", null), RollupError);
  // And the column is left as it was rather than half-pointed at an impossible calculation.
  s.use("count", null);
  assert.equal(rollupConfig(Number(s.out.id)).fn, "count");
  assert.throws(() => s.use("avg", null), RollupError);
  assert.equal(rollupConfig(Number(s.out.id)).fn, "count", "the failed change was rolled back");
});

// ── The cascade a rollup needs and a lookup does not ────────────────────────────────────────────
//
// A lookup goes stale when the row it READS changes. A rollup goes stale when the SET of rows
// changes — which includes a row leaving. That asymmetry is the whole reason this is tested apart:
// when a contact moves from Acme to Globex, Acme's count is now too high, and nothing about Acme
// itself changed to hint at it.

test("a row moving between groups marks BOTH the group it left and the one it joined", () => {
  const s = scenario("move");
  s.use("count", null);
  refreshRollupColumn(s.companies.id, Number(s.out.id));
  const co = rowIdsOf(s.companies.id);
  const ct = rowIdsOf(s.contacts.id);
  assert.equal(cell(co[0]!, s.out.id).value_text, "3");
  assert.equal(cell(co[1]!, s.out.id).value_text, "1");
  assert.equal(cell(co[0]!, s.out.id).stale, undefined);

  // One Acme contact moves to Globex.
  db.prepare("UPDATE cells SET value_text = 'globex.com' WHERE row_id = ? AND column_id = ?")
    .run(ct[0]!, Number(s.kDomain.id));
  noteRelationChange(s.contacts.id, Number(s.kDomain.id), [ct[0]!]);

  const stale = (rowId: number) =>
    Number((db.prepare("SELECT stale FROM cells WHERE row_id = ? AND column_id = ?")
      .get(rowId, Number(s.out.id)) as any).stale);

  assert.equal(stale(co[0]!), 1, "Acme lost a contact — captured before the re-key, or unreachable after");
  assert.equal(stale(co[1]!), 1, "Globex gained one");
  assert.equal(stale(co[2]!), 0, "Initech was not involved and is left alone");

  // And re-running produces the corrected counts.
  refreshRollupColumn(s.companies.id, Number(s.out.id));
  assert.equal(cell(co[0]!, s.out.id).value_text, "2");
  assert.equal(cell(co[1]!, s.out.id).value_text, "2");
});

test("changing a value a rollup adds up marks the group holding it", () => {
  const s = scenario("value-change");
  s.use("sum", Number(s.deal.id));
  refreshRollupColumn(s.companies.id, Number(s.out.id));
  const co = rowIdsOf(s.companies.id);
  const ct = rowIdsOf(s.contacts.id);
  assert.equal(cell(co[0]!, s.out.id).value_text, "1300");

  db.prepare("UPDATE cells SET value_text = '900' WHERE row_id = ? AND column_id = ?")
    .run(ct[0]!, Number(s.deal.id));
  noteRelationChange(s.contacts.id, Number(s.deal.id), [ct[0]!]);

  const stale = (rowId: number) =>
    Number((db.prepare("SELECT stale FROM cells WHERE row_id = ? AND column_id = ?")
      .get(rowId, Number(s.out.id)) as any).stale);
  assert.equal(stale(co[0]!), 1);
  assert.equal(stale(co[1]!), 0, "Globex holds none of the changed rows");

  refreshRollupColumn(s.companies.id, Number(s.out.id));
  assert.equal(cell(co[0]!, s.out.id).value_text, "2100", "900 + 1,200, still ignoring 'unknown'");
});
