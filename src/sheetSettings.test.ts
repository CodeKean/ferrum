// The three settings that live on the sheet row and name something else.
//
// All three were schema columns with no reader for the life of the product, and two of them point at
// another record — a column, a view. That pointer is the whole risk: the thing it names can go away
// and come back, because a column delete is soft and a view delete is undoable. So the property
// worth testing is not "does it save" but "what does it read as while the target is gone, and does
// it come back". A pointer that survives the round trip is the difference between a setting and a
// setting-shaped hole.
//
// The refusal tests matter for a reason that is easy to miss: the read path RESOLVES an unusable
// pointer to null. So if a bad write were allowed to land, it would read back as "not set" — exactly
// what a save that silently failed looks like. Refusing at the write is what makes those two states
// distinguishable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import {
  addColumn, createSheet, deleteColumn, getSheet,
  defaultPrimaryColumn, rowLabelColumn, setPrimaryColumn, setSheetKind,
} from "./store.ts";
import { createView, deleteView, setDefaultView } from "./views.ts";
import { SHEET_KINDS, isSheetKind } from "./types.ts";

/** Undo restores a soft-deleted column by clearing the tombstone. Done directly here. */
function undelete(columnId: string): void {
  db.prepare("UPDATE columns SET deleted_at = NULL WHERE id = ?").run(Number(columnId));
}

// ── isSheetKind ─────────────────────────────────────────────────────────────
//
// Import-free, so it is tested exhaustively rather than representatively.

test("every declared kind is accepted, and nothing else is", () => {
  for (const k of SHEET_KINDS) assert.equal(isSheetKind(k), true, `${k} must be accepted`);
  for (const junk of ["", "Person", "People", "person", "COMPANIES", " people", "generic ", null, undefined, 0, 1, {}, [], true]) {
    assert.equal(isSheetKind(junk), false, `${JSON.stringify(junk)} must be refused`);
  }
});

test("the kinds list is the only copy of those three strings", () => {
  // A second hand-written list is what let the workbook importer and the schema comment drift apart
  // from each other for the life of the feature.
  assert.deepEqual([...SHEET_KINDS], ["generic", "people", "companies"]);
});

// ── kind ────────────────────────────────────────────────────────────────────

test("a table is generic until somebody says otherwise", () => {
  const s = createSheet("Untitled sheet");
  assert.equal(getSheet(s.id)!.kind, "generic");
});

test("a kind given at creation is kept, and a junk one degrades instead of throwing", () => {
  const people = createSheet("Contacts", null, "people");
  assert.equal(getSheet(people.id)!.kind, "people");

  // Degrading rather than refusing is deliberate: what the rows are is a hint that improves
  // defaults, and it is never worth failing a table creation over.
  const junk = createSheet("Odd", null, "invoices" as any);
  assert.equal(getSheet(junk.id)!.kind, "generic");
});

test("setSheetKind refuses a value outside the list rather than storing it", () => {
  const s = createSheet("Accounts");
  assert.throws(() => setSheetKind(s.id, "invoices" as any), /people, companies, or generic/);
  assert.equal(getSheet(s.id)!.kind, "generic");
});

// ── the row label ───────────────────────────────────────────────────────────

test("a table with no columns has nothing to label a row with", () => {
  const s = createSheet("Empty");
  assert.equal(defaultPrimaryColumn(s.id), null);
  assert.equal(rowLabelColumn(s.id), null);
  assert.equal(getSheet(s.id)!.primaryColumnId, null);
});

test("the guess skips a column whose value would be a serialized object", () => {
  // A row labelled with a JSON blob is worse than a row labelled with its position, which is what
  // the caller falls back to when this returns null.
  const s = createSheet("Companies");
  const raw = addColumn(s.id, { name: "Payload", valueType: "json" });
  assert.equal(defaultPrimaryColumn(s.id), null, "a json column must not be guessed at");

  const name = addColumn(s.id, { name: "Company", valueType: "text" });
  assert.equal(defaultPrimaryColumn(s.id), name.id, "the text column is the guess");
  assert.ok(raw.id !== name.id);
});

test("an explicit choice beats the guess", () => {
  const s = createSheet("Companies");
  addColumn(s.id, { name: "Company", valueType: "text" });
  const domain = addColumn(s.id, { name: "Domain", valueType: "text" });

  assert.notEqual(rowLabelColumn(s.id), domain.id);
  setPrimaryColumn(s.id, domain.id);
  assert.equal(getSheet(s.id)!.primaryColumnId, domain.id);
  assert.equal(rowLabelColumn(s.id), domain.id);
});

test("a column belonging to another table is refused, not stored", () => {
  const a = createSheet("A");
  const b = createSheet("B");
  const onB = addColumn(b.id, { name: "Name", valueType: "text" });

  assert.throws(() => setPrimaryColumn(a.id, onB.id), /not on this table/);
  assert.equal(getSheet(a.id)!.primaryColumnId, null);
});

test("the pointer reads as null while its column is deleted, and comes BACK when it returns", () => {
  // This is the whole justification for resolving the pointer on read instead of clearing it when
  // the column goes. A column delete is soft and undoable; clearing would turn an action the user is
  // allowed to take back into a silent, permanent loss of the setting.
  const s = createSheet("Companies");
  const name = addColumn(s.id, { name: "Company", valueType: "text" });
  setPrimaryColumn(s.id, name.id);
  assert.equal(getSheet(s.id)!.primaryColumnId, name.id);

  deleteColumn(name.id);
  assert.equal(getSheet(s.id)!.primaryColumnId, null, "a deleted column cannot label a row");

  undelete(name.id);
  assert.equal(getSheet(s.id)!.primaryColumnId, name.id, "undoing the delete must restore the label");
});

test("clearing the label is different from never setting one only in what it undoes", () => {
  const s = createSheet("Companies");
  const name = addColumn(s.id, { name: "Company", valueType: "text" });
  setPrimaryColumn(s.id, name.id);
  setPrimaryColumn(s.id, null);
  assert.equal(getSheet(s.id)!.primaryColumnId, null);
  // The guess still answers, so the record view is never left with nothing to show.
  assert.equal(rowLabelColumn(s.id), name.id);
});

// ── the default view ────────────────────────────────────────────────────────

test("a table opens on all rows until a default is set", () => {
  const s = createSheet("Companies");
  assert.equal(getSheet(s.id)!.defaultViewId, null);
});

test("a view belonging to another table is refused, not stored", () => {
  const a = createSheet("A");
  const b = createSheet("B");
  const onB = createView(b.id, "Hot");

  assert.throws(() => setDefaultView(a.id, Number(onB!.id)), /not on this table/);
  assert.equal(getSheet(a.id)!.defaultViewId, null);
});

test("the default view reads as null while its view is deleted, and comes BACK on undo", () => {
  // Same contract as the row label, for a different reason: a view delete is HARD, but undo
  // reinserts the row with its original id — so the pointer heals itself.
  const s = createSheet("Companies");
  const v = createView(s.id, "Hot leads");
  const viewId = Number(v!.id);

  setDefaultView(s.id, viewId);
  assert.equal(getSheet(s.id)!.defaultViewId, String(viewId));

  const saved = db.prepare("SELECT * FROM views WHERE id = ?").get(viewId) as any;
  deleteView(viewId);
  assert.equal(getSheet(s.id)!.defaultViewId, null, "a deleted view cannot be the landing view");

  db.prepare(
    `INSERT INTO views (id, sheet_id, name, position, filter_json, sorts_json, columns_json, group_by, row_height, search)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    saved.id, saved.sheet_id, saved.name, saved.position, saved.filter_json, saved.sorts_json,
    saved.columns_json, saved.group_by, saved.row_height, saved.search,
  );
  assert.equal(getSheet(s.id)!.defaultViewId, String(viewId), "restoring the view must restore the setting");
});

test("clearing the default view returns the table to all rows", () => {
  const s = createSheet("Companies");
  const v = createView(s.id, "Hot");
  setDefaultView(s.id, Number(v!.id));
  setDefaultView(s.id, null);
  assert.equal(getSheet(s.id)!.defaultViewId, null);
});

// ── the three together ──────────────────────────────────────────────────────

test("all three survive on the same sheet without touching each other", () => {
  const s = createSheet("Contacts", null, "people");
  const name = addColumn(s.id, { name: "Full name", valueType: "text" });
  const v = createView(s.id, "Unworked");

  setPrimaryColumn(s.id, name.id);
  setDefaultView(s.id, Number(v!.id));

  const read = getSheet(s.id)!;
  assert.equal(read.kind, "people");
  assert.equal(read.primaryColumnId, name.id);
  assert.equal(read.defaultViewId, String(v!.id));

  // Changing one leaves the others alone — they share a route and an undo kind, which is exactly
  // the arrangement where a careless write clobbers a neighbour.
  setSheetKind(s.id, "companies");
  const after = getSheet(s.id)!;
  assert.equal(after.kind, "companies");
  assert.equal(after.primaryColumnId, name.id);
  assert.equal(after.defaultViewId, String(v!.id));
});
