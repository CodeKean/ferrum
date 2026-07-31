// The grid and a run must narrow to the SAME rows.
//
// This is the property the whole view/scope plumbing exists for. If they can disagree, a user filters
// to 400 rows, presses Run, and the engine spends on a million — so it is asserted rather than
// assumed, and asserted through both real code paths rather than by inspecting the shared helper.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { addColumn, createSheet, deleteRow, insertRows, readWindow } from "./store.ts";
import { resolveScope } from "./scope.ts";
import type { FilterGroup } from "./filter.ts";

function fixture(name: string, values: string[]) {
  const sheet = createSheet(name);
  const col = addColumn(sheet.id, { name: "Value" });
  const colId = Number(col.id);
  insertRows(sheet.id, values.map((v) => ({ values: { [String(colId)]: v } })), 0, [colId]);
  return { sheetId: sheet.id, colId };
}

test("a searched grid and a searched run cover the same rows", () => {
  const { sheetId } = fixture("agree-search", ["acme inc", "acme llc", "globex", "initech"]);

  const grid = readWindow(sheetId, 0, 100, { search: "acme" });
  const run = resolveScope(sheetId, { search: "acme" });

  assert.equal(grid.total, 2);
  assert.equal(run.rowCount, grid.total, "the run must not be wider than what the grid shows");
  assert.match(run.summary, /acme/, "and the confirm dialog must say so");
});

test("a status-filtered grid and a status-filtered run cover the same rows", () => {
  const { sheetId, colId } = fixture("agree-status", ["a", "b", "c"]);

  // Mark one cell failed.
  const rows = db.prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY position").all(sheetId) as any[];
  db.prepare("UPDATE cells SET status = 'error' WHERE row_id = ? AND column_id = ?").run(rows[1]!.id, colId);

  const filter: FilterGroup = {
    conj: "or",
    children: [{ columnId: colId, op: "status_is", value: ["error"] }],
  };

  const grid = readWindow(sheetId, 0, 100, { filter });
  const run = resolveScope(sheetId, { filter });

  assert.equal(grid.total, 1);
  assert.equal(run.rowCount, grid.total);
});

test("search and status compose the same way on both sides", () => {
  const { sheetId, colId } = fixture("agree-both", ["acme one", "acme two", "globex"]);
  const rows = db.prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY position").all(sheetId) as any[];
  // Fail one acme row and the globex row, so neither predicate alone gives the answer.
  for (const i of [1, 2]) {
    db.prepare("UPDATE cells SET status = 'error' WHERE row_id = ? AND column_id = ?").run(rows[i]!.id, colId);
  }

  const filter: FilterGroup = { conj: "or", children: [{ columnId: colId, op: "status_is", value: ["error"] }] };

  const grid = readWindow(sheetId, 0, 100, { filter, search: "acme" });
  const run = resolveScope(sheetId, { filter, search: "acme" });

  assert.equal(grid.total, 1, "only the failed acme row");
  assert.equal(run.rowCount, grid.total);
});

test("sorting changes the order but never the set a run would touch", () => {
  const { sheetId, colId } = fixture("sort-not-scope", ["c", "a", "b"]);

  const unsorted = readWindow(sheetId, 0, 100, {});
  const sorted = readWindow(sheetId, 0, 100, { sort: { columnId: colId, dir: "desc" } });
  const run = resolveScope(sheetId, {});

  assert.equal(sorted.total, unsorted.total);
  assert.equal(run.rowCount, sorted.total);
  // Same rows, different order — which is why sort is deliberately left out of the run scope.
  assert.deepEqual(
    new Set(sorted.rows.map((r) => r.id)),
    new Set(unsorted.rows.map((r) => r.id)),
  );
});

// ─────────────────────────────────────────────────────── run ranges

test("a row range runs exactly the rows the gutter numbers say", () => {
  const sheet = createSheet("ranges");
  const col = addColumn(sheet.id, { name: "Value" });
  const colId = Number(col.id);
  insertRows(
    sheet.id,
    Array.from({ length: 100 }, (_, i) => ({ values: { [String(colId)]: `v${i + 1}` } })),
    0,
    [colId],
  );

  const rows = (s: Record<string, unknown>) => {
    const r = resolveScope(sheet.id, { columnIds: [colId], ...s } as never);
    return { count: r.rowCount, summary: r.summary };
  };

  // Range numbers are 1-BASED and INCLUSIVE, matching the numbers on the row gutter. Off by one in
  // either direction silently runs the wrong row, and on a paid lane that is a silently wrong charge.
  assert.equal(rows({ fromRow: 10, toRow: 20 }).count, 11, "10..20 inclusive is 11 rows");
  assert.equal(rows({ fromRow: 1, toRow: 1 }).count, 1);
  assert.equal(rows({ fromRow: 100, toRow: 100 }).count, 1);
  assert.equal(rows({ fromRow: 91 }).count, 10, "from 91 onwards is the last 10 of 100");
  assert.equal(rows({ fromRow: 50, limit: 5 }).count, 5);

  // Past the end is empty, not an error and not the whole sheet.
  assert.equal(rows({ fromRow: 500 }).count, 0);
  assert.equal(rows({ fromRow: 95, toRow: 5000 }).count, 6);
});

test("the tighter of a cap and a range wins, and the summary says the truth", () => {
  const sheet = createSheet("range-vs-limit");
  const col = addColumn(sheet.id, { name: "Value" });
  const colId = Number(col.id);
  insertRows(sheet.id, Array.from({ length: 100 }, (_, i) => ({ values: { [String(colId)]: String(i) } })), 0, [colId]);

  const r = resolveScope(sheet.id, { columnIds: [colId], fromRow: 50, toRow: 90, limit: 5 } as never);

  assert.equal(r.rowCount, 5, "the cap is tighter than the span, so the cap wins");
  // The summary is the sentence shown in the confirm dialog before money is approved. Describing
  // this run as "rows 50 to 90" while it touches five of them is the exact inaccuracy that makes a
  // confirmation worth less than no confirmation at all.
  assert.match(r.summary, /rows 50 to 54/);
  assert.doesNotMatch(r.summary, /90/);
});

test("a range that cannot be read is refused, never widened to the whole sheet", () => {
  const sheet = createSheet("range-garbage");
  const col = addColumn(sheet.id, { name: "Value" });
  const colId = Number(col.id);
  insertRows(
    sheet.id,
    Array.from({ length: 20 }, (_, i) => ({ values: { [String(colId)]: `v${i}` } })),
    0,
    [colId],
  );

  // Every bound in a scope makes a run SMALLER, so a bound that evaporates is a bill for the whole
  // sheet. One non-numeric `fromRow` produced exactly that: `Math.floor("abc")` is NaN, `NaN > 1` is
  // false, so no OFFSET and no LIMIT were emitted at all — 20 of 20 rows, under a confirm summary
  // reading "from row NaN onwards". With a valid `toRow` beside it the same input reached SQLite as
  // `LIMIT NaN` and failed the request outright. Refusing names the field instead.
  assert.throws(() => resolveScope(sheet.id, { fromRow: "abc" } as never), /fromRow/);
  assert.throws(() => resolveScope(sheet.id, { fromRow: "abc", toRow: 10 } as never), /fromRow/);
  assert.throws(() => resolveScope(sheet.id, { fromRow: Infinity } as never), /fromRow/);
  assert.throws(() => resolveScope(sheet.id, { toRow: "10 rows" } as never), /toRow/);
  assert.throws(() => resolveScope(sheet.id, { limit: {} } as never), /limit/);

  // The legitimate shapes are untouched, including "no range at all".
  assert.equal(resolveScope(sheet.id, { fromRow: 5, toRow: 9 } as never).rowCount, 5);
  assert.equal(resolveScope(sheet.id, { limit: 3 } as never).rowCount, 3);
  assert.equal(resolveScope(sheet.id, {}).rowCount, 20);
});

test("the range counts the rows a run touches, not raw positions", () => {
  const sheet = createSheet("range-after-delete");
  const col = addColumn(sheet.id, { name: "Value" });
  const colId = Number(col.id);
  insertRows(sheet.id, Array.from({ length: 10 }, (_, i) => ({ values: { [String(colId)]: `v${i + 1}` } })), 0, [colId]);

  const ids = (db.prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY position").all(sheet.id) as any[]).map((r) => Number(r.id));
  deleteRow(ids[2]!); // positions now have a hole at 2

  // "Rows 1 to 3" must mean the first three rows STILL IN THE SHEET — the numbers the gutter shows —
  // not positions 1..3, which after a deletion are a different set with one of them missing.
  const r = resolveScope(sheet.id, { columnIds: [colId], fromRow: 1, toRow: 3 } as never);
  assert.equal(r.rowCount, 3);

  const got = (db.prepare(r.sql).all(...r.params) as any[]).map((x) => Number(x.id));
  assert.deepEqual(got, [ids[0], ids[1], ids[3]], "the deleted row is skipped, not counted");
});

// ─────────────────────────────────────────────────── the filter bar

test("an ad-hoc filter narrows the grid and a run to the same rows", () => {
  const sheet = createSheet("adhoc");
  const country = addColumn(sheet.id, { name: "Country" });
  const size = addColumn(sheet.id, { name: "Employees", valueType: "number" });
  const ids = [Number(country.id), Number(size.id)];

  insertRows(
    sheet.id,
    [
      { values: { [ids[0]!]: "US", [ids[1]!]: "600" } },
      { values: { [ids[0]!]: "US", [ids[1]!]: "10" } },
      { values: { [ids[0]!]: "UK", [ids[1]!]: "900" } },
      { values: { [ids[0]!]: "CA", [ids[1]!]: "700" } },
    ],
    0,
    ids,
  );

  const filter: FilterGroup = {
    conj: "and",
    children: [
      { columnId: ids[0]!, op: "eq", value: "US" },
      { columnId: ids[1]!, op: "gt", value: "500" },
    ],
  };

  const grid = readWindow(sheet.id, 0, 50, { filter });
  const run = resolveScope(sheet.id, { columnIds: [ids[0]!], filter } as never);

  // The property the whole view module exists to guarantee. If these could disagree, a user filters
  // to four rows, presses Run, and the engine spends on a million.
  assert.equal(grid.total, 1);
  assert.equal(run.rowCount, grid.total, "the grid and the run must cover the same rows");
  assert.match(run.summary, /Country is US and Employees is over 500/);
});

test("an OR filter is not silently ANDed", () => {
  const sheet = createSheet("adhoc-or");
  const col = addColumn(sheet.id, { name: "Country" });
  const id = Number(col.id);
  insertRows(sheet.id, ["US", "UK", "CA", "DE"].map((v) => ({ values: { [id]: v } })), 0, [id]);

  const filter: FilterGroup = {
    conj: "or",
    children: [
      { columnId: id, op: "eq", value: "US" },
      { columnId: id, op: "eq", value: "CA" },
    ],
  };

  // Two equality conditions on ONE column can only ever match under OR. Getting the conjunction
  // wrong here produces zero rows, which reads as "no data" rather than as a bug in the filter.
  assert.equal(readWindow(sheet.id, 0, 50, { filter }).total, 2);
  assert.equal(resolveScope(sheet.id, { columnIds: [id], filter } as never).rowCount, 2);
});

test("a numeric filter compares as a number, not as text", () => {
  const sheet = createSheet("adhoc-num");
  const col = addColumn(sheet.id, { name: "Employees", valueType: "number" });
  const id = Number(col.id);
  insertRows(sheet.id, ["9", "10", "100", "1000"].map((v) => ({ values: { [id]: v } })), 0, [id]);

  const filter: FilterGroup = { conj: "and", children: [{ columnId: id, op: "gt", value: "50" }] };

  // Lexically "9" > "50", so a text comparison would return three rows and quietly include 9.
  assert.equal(readWindow(sheet.id, 0, 50, { filter }).total, 2);
});

// ── a filter that cannot be compiled must never become "no filter" ────────────────────────────────
//
// The third instance of one bug in a day: something the engine did not understand meant NO
// narrowing, and no narrowing means every row. It was the run-scope body in the morning, the filter
// compiler here. Both are the same trade — a condition makes a result SMALLER, so a condition that
// vanishes makes it BIGGER — and on a paid lane that difference is the whole table's bill.

test("a condition using an unknown operator refuses the run rather than widening it", () => {
  const { sheetId, colId } = fixture("drop-op", ["US", "UK", "US", "DE"]);
  // Sanity first: with a real operator this narrows to two rows.
  const good: FilterGroup = { conj: "and", children: [{ columnId: colId, op: "eq", value: "US" }] };
  assert.equal(resolveScope(sheetId, { filter: good }).rowCount, 2);

  // Measured before the fix: this returned every row (4), summarised "every row" — the confirmation
  // dialog agreeing with itself while ignoring what was asked for.
  const bad = { conj: "and", children: [{ columnId: colId, op: "nonsense", value: "US" }] } as unknown as FilterGroup;
  assert.throws(
    () => resolveScope(sheetId, { filter: bad }),
    (e: unknown) => {
      assert.match((e as Error).message, /was not started/);
      // The message has to say what would have happened, or "fix the filter" reads as pedantry.
      assert.match((e as Error).message, /every row/);
      return true;
    },
  );
});

test("a condition on a column that is not in this table refuses too", () => {
  // The realistic route in: a saved view outlives the column it filtered on.
  const { sheetId } = fixture("drop-col", ["US", "UK"]);
  const orphan = { conj: "and", children: [{ columnId: 999_999, op: "eq", value: "US" }] } as unknown as FilterGroup;
  assert.throws(() => resolveScope(sheetId, { filter: orphan }), /was not started/);
});

test("a filter of the wrong shape is refused, not a crash", () => {
  // `{op, conditions}` is what someone would plausibly send, and it threw "node.children is not
  // iterable" — which reached the user as "Something went wrong inside Ferrum".
  const { sheetId } = fixture("drop-shape", ["US"]);
  const wrong = { op: "and", conditions: [] } as unknown as FilterGroup;
  assert.throws(() => resolveScope(sheetId, { filter: wrong }), /was not started/);
});

test("no filter at all is still every row, which is not the same thing", () => {
  // The distinction the fix rests on: ASKING for no narrowing is fine. Asking for narrowing and
  // silently getting none is not.
  const { sheetId } = fixture("no-filter", ["US", "UK", "DE"]);
  assert.equal(resolveScope(sheetId, {}).rowCount, 3);
  assert.equal(resolveScope(sheetId, { filter: { conj: "and", children: [] } }).rowCount, 3);
});

test("running a saved view that has been deleted refuses, rather than running the whole sheet", () => {
  // The realistic route in is two tabs, or two people: one deletes the view, the other presses Run
  // on it. Before the fix the missing view fell straight through to no filter at all — every row —
  // and the summary said "every row" without mentioning that the view had gone.
  const { sheetId } = fixture("view-gone", ["US", "UK", "DE"]);
  assert.throws(
    () => resolveScope(sheetId, { viewId: 999_999 }),
    (e: unknown) => {
      assert.match((e as Error).message, /no longer exists/);
      assert.match((e as Error).message, /every row/);
      return true;
    },
  );
});

test("a saved view whose stored filter is unreadable refuses too", () => {
  const { sheetId } = fixture("view-corrupt", ["US", "UK"]);
  const view = db
    .prepare("INSERT INTO views (sheet_id, name, filter_json) VALUES (?, 'Broken', ?) RETURNING id")
    .get(sheetId, "{not json at all") as { id: number };
  assert.throws(() => resolveScope(sheetId, { viewId: Number(view.id) }), /could not be read/);
});

test("a saved view that IS there still narrows normally", () => {
  // The guard must not have made views unusable — this is the case that has to keep working.
  const { sheetId, colId } = fixture("view-ok", ["US", "UK", "US"]);
  const filter: FilterGroup = { conj: "and", children: [{ columnId: colId, op: "eq", value: "US" }] };
  const view = db
    .prepare("INSERT INTO views (sheet_id, name, filter_json) VALUES (?, 'US only', ?) RETURNING id")
    .get(sheetId, JSON.stringify(filter)) as { id: number };
  const out = resolveScope(sheetId, { viewId: Number(view.id) });
  assert.equal(out.rowCount, 2);
  assert.match(out.summary, /US only/, "the confirmation names the view it narrowed by");
});
