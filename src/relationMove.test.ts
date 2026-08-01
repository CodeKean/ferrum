// Moving a linked table out of its workbook.
//
// `createRelation` refuses a pair whose tables sit in different workbooks. Nothing enforced that
// rule ever again, so moving one end afterwards produced exactly the state the product declines to
// build — and produced it through a supported one-drag gesture in the file browser.
//
// The reason it went unnoticed for so long is that it has NO SYMPTOM. The link goes on matching:
// `lookupConfig` resolves from sheet ids and never re-checks the workbook, so lookups keep writing
// correct values. What breaks is everything downstream — a copy drops the link, an export dropped it
// silently, and `relations.workbook_id` is what authorizes access to it, so the link ends up checked
// against a workbook one of its tables has left.
//
// These tests are about the two halves of the fix: the move is refused, and the links already
// spanning in somebody's database are reported rather than dropped in silence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { addColumn, createSheet } from "./store.ts";
import { createRelation, relationsSpanning } from "./relations.ts";
import { droppedRelationsIn } from "./workbookCopy.ts";

/** Companies and Contacts in one workbook, linked on domain. */
function linkedPair() {
  const companies = createSheet("Companies");
  const wb = companies.workbookId!;
  const contacts = createSheet("Contacts", wb);

  const cDomain = addColumn(companies.id, { name: "Domain", valueType: "text" });
  const kDomain = addColumn(contacts.id, { name: "Company domain", valueType: "text" });

  const rel = createRelation({
    fromSheetId: contacts.id,
    fromColumnId: Number(kDomain.id),
    toSheetId: companies.id,
    toColumnId: Number(cDomain.id),
  });

  const other = createSheet("Elsewhere");
  return { companies, contacts, wb, rel, otherWorkbook: other.workbookId! };
}

/** The move, exactly as the route performs it. */
function move(sheetId: string, toWorkbook: string): void {
  db.prepare("UPDATE sheets SET workbook_id = ? WHERE id = ?").run(toWorkbook, sheetId);
}

test("the rule this protects is real: the same pair cannot be linked across two workbooks", () => {
  const companies = createSheet("Companies");
  const elsewhere = createSheet("Contacts");
  const a = addColumn(companies.id, { name: "Domain", valueType: "text" });
  const b = addColumn(elsewhere.id, { name: "Domain", valueType: "text" });

  assert.throws(
    () => createRelation({
      fromSheetId: elsewhere.id, fromColumnId: Number(b.id),
      toSheetId: companies.id, toColumnId: Number(a.id),
    }),
    /same workbook/,
  );
});

test("a move that would split a link is reported, naming both tables", () => {
  const { contacts, otherWorkbook } = linkedPair();
  const spanning = relationsSpanning(contacts.id, otherWorkbook);
  assert.equal(spanning.length, 1, "the link must be found before the move happens");
  assert.deepEqual(
    [spanning[0]?.fromTable, spanning[0]?.toTable].sort(),
    ["Companies", "Contacts"],
    "the refusal has to name what is in the way, or it is an error the user cannot act on",
  );
});

test("moving the OTHER end is caught too", () => {
  // The relation stores a `from` and a `to`, and the bug does not care which one moves.
  const { companies, otherWorkbook } = linkedPair();
  assert.equal(relationsSpanning(companies.id, otherWorkbook).length, 1);
});

test("moving a table WITHIN its own workbook is not a split", () => {
  const { contacts, wb } = linkedPair();
  assert.deepEqual(relationsSpanning(contacts.id, wb), [], "a move that changes nothing must not be refused");
});

test("an unlinked table moves freely", () => {
  const loose = createSheet("Notes");
  const dest = createSheet("Somewhere else");
  assert.deepEqual(relationsSpanning(loose.id, dest.workbookId!), []);
});

test("a link to a TRASHED table does not block a move", () => {
  // A trashed table is not somewhere the user can go, so refusing a move because of one would be an
  // error about something invisible.
  const { companies, contacts, otherWorkbook } = linkedPair();
  db.prepare("UPDATE sheets SET deleted_at = datetime('now') WHERE id = ?").run(companies.id);
  assert.deepEqual(relationsSpanning(contacts.id, otherWorkbook), []);
});

// ── the links already spanning, in databases from before the refusal ────────

test("a link left spanning by an older version is reported, not dropped in silence", () => {
  const { companies, contacts, wb, otherWorkbook } = linkedPair();
  move(companies.id, otherWorkbook);

  const dropped = droppedRelationsIn(wb);
  assert.equal(dropped.length, 1, "the export must say the link cannot travel");
  assert.equal(dropped[0]?.table, "Contacts", "the end still inside this workbook");
  assert.equal(dropped[0]?.otherTable, "Companies", "and the one that left");
  void contacts;
});

test("a workbook whose links are all internal reports nothing", () => {
  const { wb } = linkedPair();
  assert.deepEqual(droppedRelationsIn(wb), [], "a healthy workbook must not raise a warning");
});
