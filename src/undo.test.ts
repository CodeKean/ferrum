// The two operations that were destructive and had no way back.
//
// Adding rows is one click and could not be taken back except by selecting them and deleting them by
// hand; renaming a table is one keystroke away from renaming the wrong one, and nothing else in the
// app answers "what was it called before?".

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { addColumn, countRows, createSheet, getSheet, insertRows, nextRowPosition, setCellValue } from "./store.ts";
import { record, redo, undo, undoState } from "./undo.ts";

function fixture(rows: number) {
  const sheet = createSheet(`ZZ undo ${Math.random().toString(36).slice(2)}`);
  const col = addColumn(sheet.id, { name: "Name", kind: "static", valueType: "text" });
  insertRows(sheet.id, Array.from({ length: rows }, () => ({ values: {} })), 0, [Number(col.id)]);
  const rowIds = (db.prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY position").all(sheet.id) as any[])
    .map((r) => Number(r.id));
  return { sheet, col, rowIds };
}

test("adding rows can be taken back", () => {
  const f = fixture(5);
  assert.equal(countRows(f.sheet.id), 5);
  record(f.sheet.id, "rows.add", "Add 5 rows", { sheetId: f.sheet.id, rowIds: f.rowIds });

  const out = undo(f.sheet.id);
  assert.equal(out.ok, true, out.error);
  assert.equal(countRows(f.sheet.id), 0);
});

test("a row that has since been filled in is kept, and the undo says so", () => {
  // The user is undoing the CREATION, not the work. Undoing "add 500 rows" an hour later, after
  // forty were enriched, must not throw away the forty — this is the one case where those differ.
  const f = fixture(4);
  setCellValue(f.rowIds[2]!, Number(f.col.id), "keep me");
  record(f.sheet.id, "rows.add", "Add 4 rows", { sheetId: f.sheet.id, rowIds: f.rowIds });

  assert.equal(undo(f.sheet.id).ok, true);
  assert.equal(countRows(f.sheet.id), 1, "the filled row survives, the three empty ones go");
  assert.ok(db.prepare("SELECT 1 FROM rows WHERE id = ?").get(f.rowIds[2]!));
});

test("undoing an add where every row has values refuses rather than destroying them", () => {
  const f = fixture(2);
  for (const id of f.rowIds) setCellValue(id, Number(f.col.id), "value");
  record(f.sheet.id, "rows.add", "Add 2 rows", { sheetId: f.sheet.id, rowIds: f.rowIds });

  const out = undo(f.sheet.id);
  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /values in them now/);
  assert.equal(countRows(f.sheet.id), 2, "nothing was removed");
});

test("redo puts back exactly what the undo removed, not what was originally added", () => {
  // A row kept because it had values was never removed, so re-adding it would duplicate it.
  const f = fixture(3);
  setCellValue(f.rowIds[0]!, Number(f.col.id), "kept");
  record(f.sheet.id, "rows.add", "Add 3 rows", { sheetId: f.sheet.id, rowIds: f.rowIds });

  assert.equal(undo(f.sheet.id).ok, true);
  assert.equal(countRows(f.sheet.id), 1);
  assert.equal(redo(f.sheet.id).ok, true);
  assert.equal(countRows(f.sheet.id), 3, "the two removed came back, and the kept one was not doubled");
});

test("a restored row keeps its id, so anything pointing at it still points at it", () => {
  const f = fixture(2);
  record(f.sheet.id, "rows.add", "Add 2 rows", { sheetId: f.sheet.id, rowIds: f.rowIds });
  assert.equal(undo(f.sheet.id).ok, true);
  assert.equal(redo(f.sheet.id).ok, true);
  const back = (db.prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY id").all(f.sheet.id) as any[])
    .map((r) => Number(r.id));
  assert.deepEqual(back, [...f.rowIds].sort((a, b) => a - b));
});

test("renaming a table can be taken back, and redone", () => {
  const sheet = createSheet("ZZ before");
  db.prepare("UPDATE sheets SET name = ? WHERE id = ?").run("ZZ after", sheet.id);
  record(sheet.id, "sheet.rename", "Rename", { sheetId: sheet.id, from: "ZZ before", to: "ZZ after" });

  assert.equal(undo(sheet.id).ok, true);
  assert.equal(getSheet(sheet.id)?.name, "ZZ before");
  assert.equal(redo(sheet.id).ok, true);
  assert.equal(getSheet(sheet.id)?.name, "ZZ after");
});

test("an entry naming no rows is refused rather than silently doing nothing", () => {
  // A no-op that reports success is worse than a failure: the button advances, the user believes it
  // worked, and the operation they wanted reversed is still there.
  const sheet = createSheet(`ZZ undo empty ${Math.random().toString(36).slice(2)}`);
  record(sheet.id, "rows.add", "Add rows", { sheetId: sheet.id, rowIds: [] });
  const out = undo(sheet.id);
  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /does not say which rows/);
});

test("the undo button says what it will undo", () => {
  const f = fixture(1);
  record(f.sheet.id, "rows.add", "Add a row", { sheetId: f.sheet.id, rowIds: f.rowIds });
  assert.equal(undoState(f.sheet.id).undo?.label, "Add a row");
});
