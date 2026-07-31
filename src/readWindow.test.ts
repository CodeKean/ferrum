// The grid's read path: sorting, searching, and the window's cell fetch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { addColumn, createSheet, deleteRow, insertRows, readWindow } from "./store.ts";
import { db } from "./db.ts";

/** A sheet with one column, seeded in a deliberately unsorted order. */
function fixture(name: string, values: Array<string | null>) {
  const sheet = createSheet(name);
  const col = addColumn(sheet.id, { name: "Value" });
  const colId = Number(col.id);
  insertRows(sheet.id, values.map((v) => ({ values: { [String(colId)]: v ?? "" } })), 0, [colId]);
  return { sheetId: sheet.id, colId };
}

const valuesOf = (win: { rows: Array<{ cells: Record<string, any> }> }, colId: number) =>
  win.rows.map((r) => r.cells[String(colId)]?.v ?? null);

test("a descending sort still returns the window's cells", () => {
  const { sheetId, colId } = fixture("desc-cells", ["alpha", "bravo", "charlie", "delta"]);

  const win = readWindow(sheetId, 0, 4, { sort: { columnId: colId, dir: "desc" } });

  // The regression: a sorted window is no longer ordered by row id, so taking min/max from the first
  // and last row produced `BETWEEN <max> AND <min>` — which matches nothing. The negative span also
  // passed the "is this window dense?" test, so it took the contiguous path and every cell came back
  // empty. The rows were right and every value was blank.
  assert.deepEqual(valuesOf(win, colId), ["delta", "charlie", "bravo", "alpha"]);
  assert.ok(win.rows.every((r) => Object.keys(r.cells).length > 0), "no row may come back cell-less");
});

test("blank cells sort last in BOTH directions", () => {
  const { sheetId, colId } = fixture("blanks", ["pear", "", "apple", ""]);

  const asc = valuesOf(readWindow(sheetId, 0, 4, { sort: { columnId: colId, dir: "asc" } }), colId);
  const desc = valuesOf(readWindow(sheetId, 0, 4, { sort: { columnId: colId, dir: "desc" } }), colId);

  assert.deepEqual(asc.slice(0, 2), ["apple", "pear"]);
  // The point of the rule: a descending sort that leads with every blank row is showing you the rows
  // with no data, which is never what "sort by this column" was asking for.
  assert.deepEqual(desc.slice(0, 2), ["pear", "apple"]);
  // An empty cell reads back as null rather than "" — the column stores no text at all, so the
  // check is "is it blank", not "is it the empty string".
  const blank = (v: string | null) => v === null || v === "";
  assert.ok(asc.slice(2).every(blank), "blanks last ascending");
  assert.ok(desc.slice(2).every(blank), "blanks last descending");
});

test("a numeric column sorts numerically, not as text", () => {
  const sheet = createSheet("numeric-sort");
  const col = addColumn(sheet.id, { name: "N", valueType: "number" });
  const colId = Number(col.id);
  insertRows(sheet.id, ["9", "100", "20"].map((v) => ({ values: { [String(colId)]: v } })), 0, [colId]);

  const asc = valuesOf(readWindow(sheet.id, 0, 3, { sort: { columnId: colId, dir: "asc" } }), colId);
  // As text this would be 100, 20, 9.
  assert.deepEqual(asc, ["9", "20", "100"]);
});

test("search matches across columns and treats LIKE wildcards as literal text", () => {
  const { sheetId, colId } = fixture("search", ["100 percent", "1000 units", "half"]);

  assert.equal(readWindow(sheetId, 0, 10, { search: "100" }).total, 2);
  assert.equal(readWindow(sheetId, 0, 10, { search: "half" }).total, 1);

  // Unescaped, `%` and `_` are LIKE wildcards: "100%" would have meant "100 followed by anything"
  // and matched both rows, and "1_0" would have matched "100". A user searching for a literal
  // percentage got back the whole sheet.
  assert.equal(readWindow(sheetId, 0, 10, { search: "100%" }).total, 0);
  assert.equal(readWindow(sheetId, 0, 10, { search: "1_0" }).total, 0);
  assert.ok(colId);
});

test("a narrowed window is indexed from 0, not by the rows' positions in the sheet", () => {
  const { sheetId, colId } = fixture("view-positions", ["skip", "skip", "skip", "match one", "match two"]);

  const win = readWindow(sheetId, 0, 10, { search: "match" });

  // The grid renders by index within the view it is showing. Handing back the rows' sheet positions
  // (3 and 4) delivered them under keys the grid never asks for, so it sat on skeletons while
  // holding the data — a bug that only appears once something can actually narrow the grid.
  assert.deepEqual(win.rows.map((r) => r.position), [0, 1]);
  assert.deepEqual(valuesOf(win, colId), ["match one", "match two"]);

  // And the second page continues the view's own numbering.
  const page2 = readWindow(sheetId, 1, 10, { search: "match" });
  assert.deepEqual(page2.rows.map((r) => r.position), [1]);
});

test("search and sort compose, and paging through a sorted view does not repeat rows", () => {
  const { sheetId, colId } = fixture("compose", ["b2", "a1", "b1", "a2", "b3"]);

  const win = readWindow(sheetId, 0, 10, { search: "b", sort: { columnId: colId, dir: "asc" } });
  assert.deepEqual(valuesOf(win, colId), ["b1", "b2", "b3"]);

  // Two pages of the same view must partition the rows. Ties broken by position keep this stable —
  // without a tiebreak, equal values can land in a different order per page and a row shows twice.
  const p1 = readWindow(sheetId, 0, 2, { sort: { columnId: colId, dir: "asc" } });
  const p2 = readWindow(sheetId, 2, 3, { sort: { columnId: colId, dir: "asc" } });
  const ids = [...p1.rows, ...p2.rows].map((r) => r.id);
  assert.equal(new Set(ids).size, 5, "no row may appear in two pages of the same view");
});

test("a deleted row does not strand the rows after it", () => {
  const { sheetId, colId } = fixture("gap", ["alpha", "bravo", "charlie", "delta"]);

  const before = readWindow(sheetId, 0, 10);
  const second = Number(before.rows[1]!.id);
  assert.equal(deleteRow(second), sheetId);

  const after = readWindow(sheetId, 0, 10);

  // The bug this guards: the fast read path addresses rows by POSITION while reporting `total` as a
  // COUNT. Deleting row at position 1 leaves positions 0, 2, 3 with a count of 3 — so the grid sizes
  // itself for three rows, asks for positions 0..2, and "delta" at position 3 becomes unreachable.
  // It is in the sheet, it is in the count, and nothing will ever render it.
  assert.equal(after.total, 3);
  assert.deepEqual(valuesOf(after, colId), ["alpha", "charlie", "delta"]);
  assert.deepEqual(after.rows.map((r) => r.position), [0, 1, 2], "positions must stay addressable");

  // And every one of them must still be reachable one window at a time, which is how the virtualizer
  // actually asks for them.
  for (let i = 0; i < after.total; i++) {
    const win = readWindow(sheetId, i, 1);
    assert.equal(win.rows.length, 1, `position ${i} must return a row`);
  }
});

test("deleting a row takes its cells with it", () => {
  const { sheetId, colId } = fixture("cascade", ["alpha", "bravo"]);
  const rowId = Number(readWindow(sheetId, 0, 10).rows[0]!.id);

  deleteRow(rowId);

  // Orphaned cells would be invisible in the grid but still counted by column stats and still
  // matched by search, so the sheet would report values that no row owns.
  const orphans = db.prepare("SELECT COUNT(*) AS n FROM cells WHERE row_id = ?").get(rowId) as { n: number };
  assert.equal(Number(orphans.n), 0);
  assert.deepEqual(valuesOf(readWindow(sheetId, 0, 10), colId), ["bravo"]);
});

test("deleting a row the sheet does not have is not an error", () => {
  assert.equal(deleteRow(99_999_999), null);
});
