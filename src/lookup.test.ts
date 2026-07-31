// Lookup columns — reading a value across a relation.
//
// The whole point is that this is FREE where the alternative is not: enriching a company once and
// reading it from two thousand contacts is one unit of spend instead of two thousand. So what these
// pin is that the value is right, that "no key" and "no match" stay distinguishable, that a pinned
// cell is never overwritten, and that the incremental path agrees with the full one — because it is
// the incremental path that runs after every change and the full one that people check by eye.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { addColumn, createSheet, insertRows } from "./store.ts";
import { createRelation, rekeyRows } from "./relations.ts";
import { LookupError, lookupConfig, noteRelationChange, readersOf, refreshLookupColumn } from "./lookup.ts";

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
  db.prepare("SELECT value_text, status, pinned, stale FROM cells WHERE row_id = ? AND column_id = ?")
    .get(rowId, Number(columnId)) as any;

/** Contacts → Companies, plus a Contacts column that reads the company's industry. */
function scenario(name: string) {
  const wb = workbook(name);
  const companies = sheetIn(wb, `${name}-companies`);
  const contacts = sheetIn(wb, `${name}-contacts`);

  const cDomain = addColumn(companies.id, { name: "Domain", kind: "static", valueType: "url" });
  const cIndustry = addColumn(companies.id, { name: "Industry", kind: "static", valueType: "text" });
  const kDomain = addColumn(contacts.id, { name: "Company Domain", kind: "static", valueType: "url" });
  const out = addColumn(contacts.id, { name: "Industry", kind: "lookup", valueType: "text" });

  insertRows(companies.id, [
    { values: { [String(cDomain.id)]: "https://www.Acme.com/", [String(cIndustry.id)]: "Fintech" } },
    { values: { [String(cDomain.id)]: "globex.com", [String(cIndustry.id)]: "Logistics" } },
  ], 0, [Number(cDomain.id), Number(cIndustry.id)]);

  insertRows(contacts.id, [
    { values: { [String(kDomain.id)]: "acme.com" } },
    { values: { [String(kDomain.id)]: "GLOBEX.com" } },
    { values: { [String(kDomain.id)]: "nowhere.example" } },
    { values: { [String(kDomain.id)]: "" } },
  ], 0, [Number(kDomain.id)]);

  const rel = createRelation({
    fromSheetId: contacts.id, fromColumnId: Number(kDomain.id),
    toSheetId: companies.id, toColumnId: Number(cDomain.id),
  });

  db.prepare("UPDATE columns SET relation_id = ?, lookup_column_id = ? WHERE id = ?")
    .run(rel.id, Number(cIndustry.id), Number(out.id));

  return { wb, companies, contacts, cDomain, cIndustry, kDomain, out, rel };
}

test("a contact reads its company's value, however the domain was written", () => {
  const s = scenario("read");
  const n = refreshLookupColumn(s.contacts.id, Number(s.out.id));
  assert.equal(n, 4, "every row is considered, matched or not");

  const ids = rowIdsOf(s.contacts.id);
  assert.equal(cell(ids[0]!, s.out.id).value_text, "Fintech", '"acme.com" reaches "https://www.Acme.com/"');
  assert.equal(cell(ids[1]!, s.out.id).value_text, "Logistics", '"GLOBEX.com" reaches "globex.com"');
});

test("no key and no match are different answers", () => {
  // Collapsing these into "blank" destroys the only diagnostic there is: 800 empty rows means
  // something completely different depending on which of the two it is.
  const s = scenario("states");
  refreshLookupColumn(s.contacts.id, Number(s.out.id));
  const ids = rowIdsOf(s.contacts.id);

  assert.equal(cell(ids[2]!, s.out.id).status, "not_found", "it had a domain; no company holds it");
  assert.equal(cell(ids[3]!, s.out.id).status, "empty", "it had no domain, so nothing was ever asked");
  assert.equal(cell(ids[0]!, s.out.id).status, "done");
});

test("a pinned cell is never overwritten by a lookup", () => {
  const s = scenario("pinned");
  const ids = rowIdsOf(s.contacts.id);
  // The cell has to EXIST before it can be pinned: a column added before its rows has no cells
  // until something creates them.
  db.prepare("INSERT OR IGNORE INTO cells (row_id, column_id, status) VALUES (?, ?, 'empty')")
    .run(ids[0]!, Number(s.out.id));
  db.prepare("UPDATE cells SET value_text = 'Typed by hand', pinned = 1, status = 'done' WHERE row_id = ? AND column_id = ?")
    .run(ids[0]!, Number(s.out.id));

  refreshLookupColumn(s.contacts.id, Number(s.out.id));
  assert.equal(cell(ids[0]!, s.out.id).value_text, "Typed by hand", "a run never overwrites a pinned cell");
  assert.equal(cell(ids[1]!, s.out.id).value_text, "Logistics", "and the rest still compute");
});

test("changing the company updates the contacts that read it, and only those", () => {
  const s = scenario("cascade");
  refreshLookupColumn(s.contacts.id, Number(s.out.id));
  const contactIds = rowIdsOf(s.contacts.id);
  const companyIds = rowIdsOf(s.companies.id);

  db.prepare("UPDATE cells SET value_text = 'Payments' WHERE row_id = ? AND column_id = ?")
    .run(companyIds[0]!, Number(s.cIndustry.id));

  // The cross-table half of the cascade: who reads the row that changed?
  const readers = readersOf(s.rel.id, "to", [companyIds[0]!]);
  assert.deepEqual(readers, [contactIds[0]!], "only the Acme contact reads the Acme company");

  refreshLookupColumn(s.contacts.id, Number(s.out.id), readers);
  assert.equal(cell(contactIds[0]!, s.out.id).value_text, "Payments");
  assert.equal(cell(contactIds[1]!, s.out.id).value_text, "Logistics", "the Globex contact was not touched");
});

test("the incremental path and the full refresh agree", () => {
  // Two ways to one answer, run at different times, on different triggers. The classic pair to drift.
  const s = scenario("agree");
  const ids = rowIdsOf(s.contacts.id);
  refreshLookupColumn(s.contacts.id, Number(s.out.id), ids);
  const incremental = ids.map((id) => JSON.stringify(cell(id, s.out.id)));

  refreshLookupColumn(s.contacts.id, Number(s.out.id));
  const full = ids.map((id) => JSON.stringify(cell(id, s.out.id)));
  assert.deepEqual(full, incremental);
});

test("a key that stops matching goes back to not_found rather than keeping the old value", () => {
  // The failure this pins is a stale value that looks current — worse than a blank, because nothing
  // about it says it is wrong.
  const s = scenario("stale");
  refreshLookupColumn(s.contacts.id, Number(s.out.id));
  const ids = rowIdsOf(s.contacts.id);
  assert.equal(cell(ids[0]!, s.out.id).value_text, "Fintech");

  db.prepare("UPDATE cells SET value_text = 'somewhere-else.com' WHERE row_id = ? AND column_id = ?")
    .run(ids[0]!, Number(s.kDomain.id));
  rekeyRows(s.rel.id, "from", [ids[0]!]);
  refreshLookupColumn(s.contacts.id, Number(s.out.id), [ids[0]!]);

  assert.equal(cell(ids[0]!, s.out.id).value_text, null);
  assert.equal(cell(ids[0]!, s.out.id).status, "not_found");
});

test("a freshly computed cell is not out of date", () => {
  const s = scenario("fresh");
  const ids = rowIdsOf(s.contacts.id);
  db.prepare("UPDATE cells SET stale = 1 WHERE column_id = ?").run(Number(s.out.id));
  refreshLookupColumn(s.contacts.id, Number(s.out.id));
  assert.equal(cell(ids[0]!, s.out.id).stale, 0, "it was just recomputed; it cannot also be stale");
});

test("a half-configured lookup says which half, instead of writing blanks", () => {
  // Every degraded outcome here writes plausible-looking values. "Nothing matched" is exactly the
  // wrong diagnosis for "you deleted the field I was reading".
  const s = scenario("guard");
  db.prepare("UPDATE columns SET lookup_column_id = NULL WHERE id = ?").run(Number(s.out.id));
  assert.throws(() => lookupConfig(Number(s.out.id)), LookupError);

  db.prepare("UPDATE columns SET lookup_column_id = ?, relation_id = NULL WHERE id = ?")
    .run(Number(s.cIndustry.id), Number(s.out.id));
  assert.throws(() => lookupConfig(Number(s.out.id)), LookupError);

  // And a field that has since been deleted from the other table.
  db.prepare("UPDATE columns SET relation_id = ? WHERE id = ?").run(s.rel.id, Number(s.out.id));
  db.prepare("UPDATE columns SET deleted_at = datetime('now') WHERE id = ?").run(Number(s.cIndustry.id));
  assert.throws(() => lookupConfig(Number(s.out.id)), LookupError);
});

test("which row an ambiguous key picks is arbitrary but never changes between runs", () => {
  // A value that moves between two runs over unchanged data is indistinguishable from a bug.
  const s = scenario("determinism");
  insertRows(s.companies.id, [
    { values: { [String(s.cDomain.id)]: "acme.com", [String(s.cIndustry.id)]: "A different answer" } },
  ], 2, [Number(s.cDomain.id), Number(s.cIndustry.id)]);
  rekeyRows(s.rel.id, "to", rowIdsOf(s.companies.id));

  const ids = rowIdsOf(s.contacts.id);
  refreshLookupColumn(s.contacts.id, Number(s.out.id));
  const first = cell(ids[0]!, s.out.id).value_text;
  refreshLookupColumn(s.contacts.id, Number(s.out.id));
  refreshLookupColumn(s.contacts.id, Number(s.out.id), [ids[0]!]);
  assert.equal(cell(ids[0]!, s.out.id).value_text, first, "same answer every time, by both paths");
});

// ── The cascade: what happens automatically when either side changes ────────────────────────────
//
// Relations are a SECOND dependency graph — cross-table, matched by key rather than declared by a
// reference, and completely invisible to `column_deps`. So the ordinary stale cascade cannot see any
// of this, and without `noteRelationChange` a lookup goes on showing an answer that was correct last
// week with nothing anywhere saying so.

test("changing the value being read marks its readers out of date", () => {
  const s = scenario("cascade-value");
  refreshLookupColumn(s.contacts.id, Number(s.out.id));
  const contactIds = rowIdsOf(s.contacts.id);
  const companyIds = rowIdsOf(s.companies.id);
  assert.equal(cell(contactIds[0]!, s.out.id).stale, 0);

  db.prepare("UPDATE cells SET value_text = 'Payments' WHERE row_id = ? AND column_id = ?")
    .run(companyIds[0]!, Number(s.cIndustry.id));
  noteRelationChange(s.companies.id, Number(s.cIndustry.id), [companyIds[0]!]);

  assert.equal(cell(contactIds[0]!, s.out.id).stale, 1, "the Acme contact reads a value that has moved");
  assert.equal(cell(contactIds[1]!, s.out.id).stale, 0, "the Globex contact reads a value that has not");
});

test("changing a key re-indexes it AND flags the row that used it", () => {
  // Two failures in one: the index still pointing at the old company, and a cell holding the answer
  // computed against the old key while looking perfectly current.
  const s = scenario("cascade-key");
  refreshLookupColumn(s.contacts.id, Number(s.out.id));
  const ids = rowIdsOf(s.contacts.id);
  assert.equal(cell(ids[0]!, s.out.id).value_text, "Fintech");

  db.prepare("UPDATE cells SET value_text = 'globex.com' WHERE row_id = ? AND column_id = ?")
    .run(ids[0]!, Number(s.kDomain.id));
  noteRelationChange(s.contacts.id, Number(s.kDomain.id), [ids[0]!]);

  assert.equal(cell(ids[0]!, s.out.id).stale, 1, "its answer was computed against the domain it used to have");
  // And the index moved with it, so a re-run gives the NEW company rather than the old one.
  refreshLookupColumn(s.contacts.id, Number(s.out.id), [ids[0]!]);
  assert.equal(cell(ids[0]!, s.out.id).value_text, "Logistics");
  assert.equal(cell(ids[0]!, s.out.id).stale, 0, "and re-running clears the flag");
});

test("a column no relation uses cascades to nothing", () => {
  // The cheap-path guard: every cell write in the product calls this, so an unrelated column must
  // not pay for relations it has nothing to do with.
  const s = scenario("cascade-none");
  refreshLookupColumn(s.contacts.id, Number(s.out.id));
  const ids = rowIdsOf(s.contacts.id);
  const spare = addColumn(s.contacts.id, { name: "Notes", kind: "static", valueType: "text" });

  noteRelationChange(s.contacts.id, Number(spare.id), ids);
  assert.equal(cell(ids[0]!, s.out.id).stale, 0, "nothing reads Notes, so nothing goes out of date");
});
