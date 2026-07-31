// Relations — the join between two tables.
//
// What these pin is mostly the QUIET failures, because a join that goes wrong does not throw. It
// fills a column with nothing, or with the wrong row's value, and both look like ordinary data. So:
// that normalization actually happens, that blank keys never match each other, that an ambiguous
// match is COUNTED rather than hidden, and that clearing a key removes it from the index instead of
// leaving it matching a value the row no longer holds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { addColumn, createSheet, insertRows } from "./store.ts";
import {
  RelationError, createRelation, deleteRelation, listRelations, matchedRow,
  rebuildRelationKeys, rekeyRows, relationHealth, relationKey, relationsKeyedOn, setMatchMode,
} from "./relations.ts";

/** A workbook, because a relation refuses two tables that are not in one. */
function workbook(name: string): string {
  const id = `wb-${name}-${db.prepare("SELECT COUNT(*) AS n FROM workbooks").get() as any ? Math.random().toString(36).slice(2) : ""}`;
  db.prepare("INSERT INTO workbooks (id, name) VALUES (?, ?)").run(id, name);
  return id;
}

function sheetIn(wb: string, name: string) {
  const s = createSheet(name);
  db.prepare("UPDATE sheets SET workbook_id = ? WHERE id = ?").run(wb, s.id);
  return s;
}

/** Append, never at position 0 — rows have a unique (sheet, position). */
const rowCount = (sheetId: string): number =>
  Number((db.prepare("SELECT COUNT(*) AS n FROM rows WHERE sheet_id = ?").get(sheetId) as any).n);

const rowIdsOf = (sheetId: string): number[] =>
  (db.prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY position").all(sheetId) as any[]).map((r) => Number(r.id));

/**
 * Companies keyed by domain, Contacts keyed by the company's domain — the shape the feature exists
 * for. The two sides deliberately hold the SAME domains written differently.
 */
function pair(name: string) {
  const wb = workbook(name);
  const companies = sheetIn(wb, `${name}-companies`);
  const contacts = sheetIn(wb, `${name}-contacts`);

  const cDomain = addColumn(companies.id, { name: "Domain", kind: "static", valueType: "url" });
  const cIndustry = addColumn(companies.id, { name: "Industry", kind: "static", valueType: "text" });
  const kDomain = addColumn(contacts.id, { name: "Company Domain", kind: "static", valueType: "url" });

  insertRows(companies.id, [
    { values: { [String(cDomain.id)]: "https://www.Acme.com/", [String(cIndustry.id)]: "Fintech" } },
    { values: { [String(cDomain.id)]: "globex.com", [String(cIndustry.id)]: "Logistics" } },
  ], 0, [Number(cDomain.id), Number(cIndustry.id)]);

  insertRows(contacts.id, [
    { values: { [String(kDomain.id)]: "acme.com" } },        // same company, written plainly
    { values: { [String(kDomain.id)]: "GLOBEX.com" } },      // same company, different case
    { values: { [String(kDomain.id)]: "nowhere.example" } }, // no company for this one
    { values: { [String(kDomain.id)]: "" } },                // nothing to match with at all
  ], 0, [Number(kDomain.id)]);

  return { wb, companies, contacts, cDomain, cIndustry, kDomain };
}

test("the same company written three ways is one company", () => {
  const p = pair("norm");
  const rel = createRelation({
    fromSheetId: p.contacts.id, fromColumnId: Number(p.kDomain.id),
    toSheetId: p.companies.id, toColumnId: Number(p.cDomain.id),
  });

  const h = relationHealth(rel.id);
  // "https://www.Acme.com/" on one side and "acme.com" on the other are the SAME key. A relation
  // that compared raw strings would match neither of the first two rows and would say nothing.
  assert.equal(h.matched, 2, `expected both real companies to match, got ${JSON.stringify(h)}`);
  assert.equal(h.unmatched, 1, "nowhere.example has a key and no company");
  assert.equal(h.blank, 1, "the empty cell is blank, not unmatched — a different problem with a different fix");
  assert.equal(h.ambiguous, 0);
  assert.equal(h.targetKeys, 2);
});

test("a blank key never matches another blank key", () => {
  // The single most destructive thing a join can do quietly: treat "no value" as a value, and match
  // every empty row on one side to every empty row on the other.
  const p = pair("blank");
  const blankCompany = addColumn(p.companies.id, { name: "Spare", kind: "static", valueType: "text" });
  insertRows(p.companies.id, [{ values: { [String(blankCompany.id)]: "x" } }], rowCount(p.companies.id), [Number(blankCompany.id)]);

  const rel = createRelation({
    fromSheetId: p.contacts.id, fromColumnId: Number(p.kDomain.id),
    toSheetId: p.companies.id, toColumnId: Number(p.cDomain.id),
  });
  const blankRow = rowIdsOf(p.contacts.id)[3]!;
  assert.equal(matchedRow(rel.id, blankRow), null, "a row with no key matches nothing");

  const keys = db.prepare("SELECT COUNT(*) AS n FROM relation_keys WHERE relation_id = ? AND key = ''").get(rel.id) as any;
  assert.equal(Number(keys.n), 0, "an empty key is never indexed at all");
});

test("two target rows for one key is reported, not hidden", () => {
  // A lookup still fills in when this happens — it just silently picks one. That is the failure that
  // looks like success, so the count has to exist.
  const p = pair("ambig");
  insertRows(p.companies.id, [
    { values: { [String(p.cDomain.id)]: "acme.com", [String(p.cIndustry.id)]: "Something else" } },
  ], rowCount(p.companies.id), [Number(p.cDomain.id), Number(p.cIndustry.id)]);

  const rel = createRelation({
    fromSheetId: p.contacts.id, fromColumnId: Number(p.kDomain.id),
    toSheetId: p.companies.id, toColumnId: Number(p.cDomain.id),
  });
  const h = relationHealth(rel.id);
  assert.equal(h.ambiguous, 1, `one contact now hits two Acme rows: ${JSON.stringify(h)}`);
  assert.equal(h.matched, 2, "it is still matched — ambiguous is a warning about which one, not a failure to match");
});

test("clearing a key removes it from the index rather than leaving it matching", () => {
  const p = pair("rekey");
  const rel = createRelation({
    fromSheetId: p.contacts.id, fromColumnId: Number(p.kDomain.id),
    toSheetId: p.companies.id, toColumnId: Number(p.cDomain.id),
  });
  const first = rowIdsOf(p.contacts.id)[0]!;
  assert.notEqual(matchedRow(rel.id, first), null, "matched to begin with");

  // The row's key is emptied, the way a re-run that returned nothing would empty it.
  db.prepare("UPDATE cells SET value_text = '' WHERE row_id = ? AND column_id = ?").run(first, Number(p.kDomain.id));
  rekeyRows(rel.id, "from", [first]);

  assert.equal(matchedRow(rel.id, first), null, "an insert-only re-key would have left the old key matching forever");
});

test("re-keying one row does not disturb the others", () => {
  const p = pair("scoped");
  const rel = createRelation({
    fromSheetId: p.contacts.id, fromColumnId: Number(p.kDomain.id),
    toSheetId: p.companies.id, toColumnId: Number(p.cDomain.id),
  });
  const ids = rowIdsOf(p.contacts.id);
  rekeyRows(rel.id, "from", [ids[0]!]);
  assert.notEqual(matchedRow(rel.id, ids[1]!), null, "the untouched row keeps its match");
  assert.equal(relationHealth(rel.id).matched, 2);
});

test("a full rebuild and an incremental re-key agree", () => {
  // They are two paths to one answer, so they are the classic pair to drift apart.
  const p = pair("agree");
  const rel = createRelation({
    fromSheetId: p.contacts.id, fromColumnId: Number(p.kDomain.id),
    toSheetId: p.companies.id, toColumnId: Number(p.cDomain.id),
  });
  const snapshot = () =>
    JSON.stringify(db.prepare("SELECT side, row_id, key FROM relation_keys WHERE relation_id = ? ORDER BY side, row_id").all(rel.id));

  const afterCreate = snapshot();
  rekeyRows(rel.id, "from", rowIdsOf(p.contacts.id));
  rekeyRows(rel.id, "to", rowIdsOf(p.companies.id));
  assert.equal(snapshot(), afterCreate, "incremental re-keying every row must reproduce the full rebuild");

  rebuildRelationKeys(rel.id);
  assert.equal(snapshot(), afterCreate, "and a rebuild must reproduce it again");
});

test("a link refuses the pairs that would silently match nothing", () => {
  const p = pair("guard");
  assert.throws(
    () => createRelation({
      fromSheetId: p.contacts.id, fromColumnId: Number(p.kDomain.id),
      toSheetId: p.contacts.id, toColumnId: Number(p.kDomain.id),
    }),
    RelationError,
    "a table linked to itself is a rollup, not a relation",
  );

  // A column that is not in the table it is claimed to be in builds no keys and matches nothing —
  // an empty column, which reads as bad data rather than as a bad link.
  assert.throws(
    () => createRelation({
      fromSheetId: p.contacts.id, fromColumnId: Number(p.cIndustry.id),
      toSheetId: p.companies.id, toColumnId: Number(p.cDomain.id),
    }),
    RelationError,
  );

  createRelation({
    fromSheetId: p.contacts.id, fromColumnId: Number(p.kDomain.id),
    toSheetId: p.companies.id, toColumnId: Number(p.cDomain.id),
  });
  assert.throws(
    () => createRelation({
      fromSheetId: p.contacts.id, fromColumnId: Number(p.kDomain.id),
      toSheetId: p.companies.id, toColumnId: Number(p.cDomain.id),
    }),
    RelationError,
    "the same pair twice would build two indexes over the same rows",
  );
});

test("two tables in different workbooks cannot be linked", () => {
  const a = sheetIn(workbook("wbA"), "A");
  const b = sheetIn(workbook("wbB"), "B");
  const ca = addColumn(a.id, { name: "Key", kind: "static", valueType: "text" });
  const cb = addColumn(b.id, { name: "Key", kind: "static", valueType: "text" });
  assert.throws(
    () => createRelation({ fromSheetId: a.id, fromColumnId: Number(ca.id), toSheetId: b.id, toColumnId: Number(cb.id) }),
    RelationError,
  );
});

test("a link is findable from either side, and deleting it takes its index with it", () => {
  const p = pair("list");
  const rel = createRelation({
    fromSheetId: p.contacts.id, fromColumnId: Number(p.kDomain.id),
    toSheetId: p.companies.id, toColumnId: Number(p.cDomain.id),
  });
  assert.equal(listRelations(p.contacts.id).length, 1, "visible from the pointing table");
  assert.equal(listRelations(p.companies.id).length, 1, "and from the table being pointed at");

  // Both sides' key columns have to announce themselves, or a run that fills one of them has no way
  // to know the index needs updating.
  assert.deepEqual(relationsKeyedOn(Number(p.kDomain.id)).map((x) => x.side), ["from"]);
  assert.deepEqual(relationsKeyedOn(Number(p.cDomain.id)).map((x) => x.side), ["to"]);

  deleteRelation(rel.id);
  const left = db.prepare("SELECT COUNT(*) AS n FROM relation_keys WHERE relation_id = ?").get(rel.id) as any;
  assert.equal(Number(left.n), 0, "an orphaned key index would match rows against a link nobody can see");
});

// ── Match modes ────────────────────────────────────────────────────────────────────────────────
//
// Three positions on one question: how much difference between two values still means "the same
// thing". Each is pinned by what it MISSES as well as what it catches, because a matching mode is
// only useful if you can predict its mistakes — and the expensive mistake is the invisible one,
// where a join quietly matches two businesses that are not the same.

test("exact means exact, including case", () => {
  // Its whole purpose is identifiers whose case is meaningful — a CRM id, a SKU, a token. Folding
  // case would make it `normalized` under a name that promises otherwise.
  assert.equal(relationKey("Acme-123", "text", "exact"), "Acme-123");
  assert.notEqual(relationKey("acme-123", "text", "exact"), relationKey("Acme-123", "text", "exact"));
  // Surrounding whitespace is still not data.
  assert.equal(relationKey("  Acme-123  ", "text", "exact"), "Acme-123");
  assert.equal(relationKey("   ", "text", "exact"), null, "blank is never a key in any mode");
});

test("normalized ignores case and the shape of a web address", () => {
  const k = (v: string) => relationKey(v, "url", "normalized");
  assert.equal(k("https://www.Acme.com/"), k("acme.com"));
  assert.equal(k("GLOBEX.com"), k("globex.com"));
  // …and stops there. "Acme Inc." and "Acme" are different values, and normalized does not guess.
  const t = (v: string) => relationKey(v, "text", "normalized");
  assert.notEqual(t("Acme Inc."), t("Acme"));
});

test("fuzzy ignores punctuation, company-type words, and word order", () => {
  const f = (v: string) => relationKey(v, "text", "fuzzy");
  assert.equal(f("Acme Inc."), f("Acme"), "a legal suffix is not part of which company this is");
  assert.equal(f("Acme Inc."), f("ACME, Incorporated"));
  assert.equal(f("Acme Software Ltd"), f("Software Acme"), "word order stops mattering");
  assert.equal(f("The Acme Group GmbH"), f("Acme"));
});

test("fuzzy still refuses to match two genuinely different names", () => {
  // The over-match is the failure that costs money, so this is the assertion that matters most.
  const f = (v: string) => relationKey(v, "text", "fuzzy");
  assert.notEqual(f("Acme"), f("Beta"));
  assert.notEqual(f("Acme Software"), f("Acme Hardware"));
  assert.notEqual(f("Northwind"), f("Northwind Traders"), "an extra real word is a different name");
});

test("a name made ONLY of company words does not collapse to nothing", () => {
  // "The Group Ltd" strips to empty. An empty key would match every other stripped-to-empty row —
  // exactly the blank-matches-blank disaster, arriving by a different door.
  const f = (v: string) => relationKey(v, "text", "fuzzy");
  assert.ok(f("The Group Ltd"), "it falls back to the normalized form rather than becoming blank");
  assert.notEqual(f("The Group Ltd"), f("The Holdings Company"));
});

test("the mode decides what a link matches, end to end", () => {
  const p = pair("modes");
  // A second company written the way a human would, not the way a machine would.
  insertRows(p.companies.id, [
    { values: { [String(p.cDomain.id)]: "Initech Ltd", [String(p.cIndustry.id)]: "Software" } },
  ], rowCount(p.companies.id), [Number(p.cDomain.id), Number(p.cIndustry.id)]);
  insertRows(p.contacts.id, [
    { values: { [String(p.kDomain.id)]: "initech" } },
  ], rowCount(p.contacts.id), [Number(p.kDomain.id)]);

  const rel = createRelation({
    fromSheetId: p.contacts.id, fromColumnId: Number(p.kDomain.id),
    toSheetId: p.companies.id, toColumnId: Number(p.cDomain.id),
    matchMode: "exact",
  });
  assert.equal(relationHealth(rel.id).matched, 0, "exact catches none of these — every pair differs");

  setMatchMode(rel.id, "normalized");
  assert.equal(relationHealth(rel.id).matched, 2, "normalized catches the two domain spellings");

  setMatchMode(rel.id, "fuzzy");
  assert.equal(relationHealth(rel.id).matched, 3, "fuzzy also reaches 'initech' -> 'Initech Ltd'");
});

test("changing the mode rebuilds the index rather than leaving the old keys", () => {
  // The symptom this prevents: a match rate that does not move when you change the setting whose
  // entire job is to move it.
  const p = pair("rebuild-on-mode");
  const rel = createRelation({
    fromSheetId: p.contacts.id, fromColumnId: Number(p.kDomain.id),
    toSheetId: p.companies.id, toColumnId: Number(p.cDomain.id),
    matchMode: "exact",
  });
  const keysUnderExact = db.prepare("SELECT key FROM relation_keys WHERE relation_id = ? AND side = 'from' ORDER BY key")
    .all(rel.id).map((r: any) => r.key).join("|");

  setMatchMode(rel.id, "normalized");
  const keysUnderNormalized = db.prepare("SELECT key FROM relation_keys WHERE relation_id = ? AND side = 'from' ORDER BY key")
    .all(rel.id).map((r: any) => r.key).join("|");

  assert.notEqual(keysUnderNormalized, keysUnderExact, "the stored keys follow the mode");
  assert.ok(keysUnderNormalized.includes("acme.com"));
});
