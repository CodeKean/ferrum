// One paste, one pin state.
//
// A pin decides whether a run may overwrite a cell, and the two ways a value can arrive by hand used
// to answer differently: `setCellValue` pinned, `insertRows` did not. A paste that landed in rows the
// table already had was protected; the rows the same paste CREATED were not. Same action, same
// person, same block of text, two rules — and nothing on screen said which cells were which.
//
// The flag is explicit because the other caller wants the opposite answer. Pinning on import would
// make every imported cell immune to the column meant to fill it, which breaks import-then-run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { addColumn, createSheet, insertRows } from "./store.ts";

function fixture(name: string) {
  const sheet = createSheet(name);
  const a = Number(addColumn(sheet.id, { name: "Company" }).id);
  const b = Number(addColumn(sheet.id, { name: "Website" }).id);
  return { sheet, a, b };
}

const rowIds = (sheetId: string) =>
  (db.prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY position").all(sheetId) as any[])
    .map((r) => Number(r.id));

const cell = (rowId: number, columnId: number) =>
  db.prepare("SELECT value_text, status, pinned FROM cells WHERE row_id = ? AND column_id = ?")
    .get(rowId, columnId) as any;

test("rows created by a paste carry the same pin as a paste into an existing row", () => {
  const f = fixture("paste");
  insertRows(
    f.sheet.id,
    [
      { values: { [String(f.a)]: "Monzo", [String(f.b)]: "monzo.com" } },
      { values: { [String(f.a)]: "Tide", [String(f.b)]: "tide.co" } },
    ],
    0,
    [f.a, f.b],
    true,
  );
  for (const id of rowIds(f.sheet.id)) {
    assert.equal(Number(cell(id, f.a).pinned), 1, "a pasted value is a value somebody typed");
    assert.equal(Number(cell(id, f.b).pinned), 1);
  }
});

test("an import pins nothing, so the column meant to fill it still can", () => {
  const f = fixture("import");
  insertRows(f.sheet.id, [{ values: { [String(f.a)]: "Monzo" } }], 0, [f.a, f.b]);
  const id = rowIds(f.sheet.id)[0]!;
  assert.equal(Number(cell(id, f.a).pinned), 0, "import-then-run is the main flow and a pin would break it");
});

test("a blank is never pinned, even on a paste", () => {
  // A pin on an empty cell protects nothing and only stops the column that was going to fill it, so
  // a ragged pasted block would silently freeze its own gaps.
  const f = fixture("ragged");
  insertRows(f.sheet.id, [{ values: { [String(f.a)]: "Monzo" } }], 0, [f.a, f.b], true);
  const id = rowIds(f.sheet.id)[0]!;
  assert.equal(Number(cell(id, f.a).pinned), 1);
  assert.equal(cell(id, f.b).status, "empty");
  assert.equal(Number(cell(id, f.b).pinned), 0, "the gap stays fillable");
});
