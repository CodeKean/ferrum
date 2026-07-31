// Restore points.
//
// The properties here are the ones whose failure is SILENT. A restore that puts back most of a cell,
// a restore that leaves the run's output sitting in every cell that was blank before, a restore that
// reaches into work done after the run it is reversing — none of those throw, and all three look like
// the feature working until somebody checks a value by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { addColumn, createSheet, getCell, insertRows } from "./store.ts";
import {
  columnsMatch, getSnapshot, listSnapshots, restoreSnapshot, snapshotFields, takeRunSnapshot,
} from "./snapshots.ts";

/** A sheet with one column and `n` rows, and a run id to hang a snapshot off. */
function fixture(n: number, values: Array<string | null>) {
  const sheet = createSheet(`ZZ snap ${Math.random().toString(36).slice(2)}`);
  const col = addColumn(sheet.id, { name: "Answer", kind: "ai", valueType: "text" });
  insertRows(sheet.id, Array.from({ length: n }, () => ({ values: {} })), 0, [Number(col.id)]);
  const rowIds = (db.prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY position").all(sheet.id) as any[])
    .map((r) => Number(r.id));

  rowIds.forEach((rowId, i) => {
    const v = values[i];
    if (v == null) return;
    db.prepare(
      `UPDATE cells SET status = 'done', value_text = ?, confidence = 'high', cost_usd = 0.01, run_id = 'older'
        WHERE row_id = ? AND column_id = ?`,
    ).run(v, rowId, Number(col.id));
  });

  const runId = `zz-run-${Math.random().toString(36).slice(2)}`;
  db.prepare("INSERT INTO runs (id, sheet_id, kind, total) VALUES (?, ?, 'sheet', 0)").run(runId, sheet.id);
  return {
    sheet, col, rowIds, runId,
    rowSql: "SELECT r.id FROM rows r WHERE r.sheet_id = ?",
    rowParams: [sheet.id] as Array<string | number>,
  };
}

/** What a run does to a cell: replaces the value and stamps its own id. */
function runWrites(runId: string, rowId: number, columnId: number, value: string): void {
  db.prepare(
    `UPDATE cells SET status = 'done', value_text = ?, value_json = NULL, confidence = 'low',
                      cost_usd = 0.05, run_id = ?, rev = rev + 1
      WHERE row_id = ? AND column_id = ?`,
  ).run(value, runId, rowId, columnId);
}

test("the snapshot table mirrors cells, so no field can be lost on the way back", () => {
  // The guard against the next migration. `cells` gains a column, restore silently stops putting it
  // back, and nothing anywhere reports it — which is exactly how undo.ts came to be restoring ten of
  // its table's twenty-three fields.
  const { cells, snapshot } = columnsMatch();
  assert.deepEqual(
    cells.filter((c) => !snapshot.includes(c)), [],
    "run_snapshot_cells has no home for these cells columns — add them to its DDL in db.ts",
  );
  assert.ok(snapshotFields().includes("confidence"), "the generated field list should carry every mirrored field");
  assert.ok(!snapshotFields().includes("rev"), "rev is bumped on restore, never restored");
});

test("only cells holding something are copied", () => {
  const f = fixture(4, ["a", null, "c", null]);
  const count = takeRunSnapshot(f.runId, f.sheet.id, "Run it", [Number(f.col.id)], f.rowSql, f.rowParams);
  assert.equal(count, 2, "the two empty cells have nothing to put back");
  assert.equal(getSnapshot(f.runId)?.cellCount, 2);
});

test("a run that would replace nothing gets no restore point at all", () => {
  const f = fixture(3, [null, null, null]);
  const count = takeRunSnapshot(f.runId, f.sheet.id, "First run", [Number(f.col.id)], f.rowSql, f.rowParams);
  assert.equal(count, 0);
  assert.equal(getSnapshot(f.runId), null, "an entry offering to restore emptiness is noise");
  assert.equal(listSnapshots(f.sheet.id).length, 0);
});

test("restore puts back every field, not just the value", () => {
  const f = fixture(2, ["kept", "also kept"]);
  takeRunSnapshot(f.runId, f.sheet.id, "Run it", [Number(f.col.id)], f.rowSql, f.rowParams);
  const before = getCell(f.rowIds[0]!, Number(f.col.id))!;

  runWrites(f.runId, f.rowIds[0]!, Number(f.col.id), "worse");
  runWrites(f.runId, f.rowIds[1]!, Number(f.col.id), "worse too");

  const res = restoreSnapshot(f.runId);
  assert.equal(res.restored, 2);

  const after = getCell(f.rowIds[0]!, Number(f.col.id))!;
  assert.equal(after.valueText, "kept");
  // The grade and the cost travel with the value. A cell restored to its old answer while still
  // showing the new run's confidence and price is a cell reporting a number for something else.
  assert.equal(after.confidence, before.confidence);
  assert.equal(after.costUsd, before.costUsd);
  assert.ok(after.rev > before.rev, "rev is bumped so an open grid treats the restored value as newer");
});

test("a cell the run FILLED goes back to empty, not to the run's output", () => {
  // The half-working restore. Without the second statement, "put back what was here" leaves the run's
  // value in every previously-blank cell — which on a first run is most of them.
  const f = fixture(3, ["had one", null, null]);
  takeRunSnapshot(f.runId, f.sheet.id, "Run it", [Number(f.col.id)], f.rowSql, f.rowParams);
  for (const rowId of f.rowIds) runWrites(f.runId, rowId, Number(f.col.id), "new");

  const res = restoreSnapshot(f.runId);
  assert.equal(res.restored, 1);
  assert.equal(res.cleared, 2);

  assert.equal(getCell(f.rowIds[0]!, Number(f.col.id))!.valueText, "had one");
  const cleared = getCell(f.rowIds[1]!, Number(f.col.id))!;
  assert.equal(cleared.status, "empty");
  assert.equal(cleared.valueText, null);
  assert.equal(cleared.costUsd, undefined, "a cleared cell must not keep a price for a value it no longer has");
});

test("a cell rewritten by a LATER run is left alone", () => {
  // Restoring over work done after the run being reversed would be a second destruction dressed up
  // as a repair. `run_id` is what distinguishes the two.
  const f = fixture(2, ["old", null]);
  takeRunSnapshot(f.runId, f.sheet.id, "Run it", [Number(f.col.id)], f.rowSql, f.rowParams);
  runWrites(f.runId, f.rowIds[0]!, Number(f.col.id), "new");
  runWrites("a-later-run", f.rowIds[1]!, Number(f.col.id), "written afterwards");

  const res = restoreSnapshot(f.runId);
  assert.equal(res.cleared, 0, "the later run's cell was never this run's to clear");
  assert.equal(getCell(f.rowIds[1]!, Number(f.col.id))!.valueText, "written afterwards");
});

test("a saved cell whose row has since been deleted is reported, not silently dropped", () => {
  const f = fixture(2, ["a", "b"]);
  takeRunSnapshot(f.runId, f.sheet.id, "Run it", [Number(f.col.id)], f.rowSql, f.rowParams);
  db.prepare("DELETE FROM rows WHERE id = ?").run(f.rowIds[1]!);

  const res = restoreSnapshot(f.runId);
  assert.equal(res.restored, 1);
  assert.equal(res.gone, 1, "the count has to say a saved value had nowhere to go back to");
});

test("only the last few restore points are kept, and their cells go with them", () => {
  const f = fixture(2, ["a", "b"]);
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const runId = `${f.runId}-${i}`;
    db.prepare("INSERT INTO runs (id, sheet_id, kind, total) VALUES (?, ?, 'sheet', 0)").run(runId, f.sheet.id);
    takeRunSnapshot(runId, f.sheet.id, `Run ${i}`, [Number(f.col.id)], f.rowSql, f.rowParams);
    ids.push(runId);
  }
  const kept = listSnapshots(f.sheet.id);
  assert.equal(kept.length, 3, "a restore point is a copy of every cell, so the depth is deliberately shallow");
  assert.deepEqual(kept.map((s) => s.label), ["Run 4", "Run 3", "Run 2"]);

  // The cells go through ON DELETE CASCADE. A metadata row deleted alone would leave the copies
  // orphaned with nothing pointing at them — invisible, and never reclaimed.
  const orphans = db
    .prepare(`SELECT COUNT(*) AS c FROM run_snapshot_cells WHERE snapshot_run_id = ?`)
    .get(ids[0]!) as any;
  assert.equal(Number(orphans.c), 0);
});

test("restoring a run with no saved copy says so rather than reporting success", () => {
  assert.throws(() => restoreSnapshot("no-such-run"), /no saved copy/i);
});
