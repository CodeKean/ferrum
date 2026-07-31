// Column stats tests.
//
// These exist because the header's numbers come from a CACHE, and a cache has two failure modes that
// both look like a working feature: it can serve a number that is quietly wrong, and it can decline
// to serve any number at all. Both happened. Both are covered here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { addColumn, createSheet, insertRows } from "./store.ts";
import {
  clearStatsCache, getColumnStats, getSheetColumnStats, markColumnDirty, warmSheetStats,
} from "./columnStats.ts";

/** A sheet whose cells are forced into the exact statuses a test needs. */
function fixture(name: string, statuses: string[]) {
  const sheet = createSheet(name);
  const col = addColumn(sheet.id, { name: "Result" });
  const colId = Number(col.id);
  insertRows(sheet.id, statuses.map(() => ({ values: {} })), 0, [colId]);

  const rows = db.prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY position").all(sheet.id) as any[];
  const set = db.prepare("UPDATE cells SET status = ? WHERE row_id = ? AND column_id = ?");
  rows.forEach((r, i) => set.run(statuses[i]!, r.id, colId));

  clearStatsCache();
  return { sheetId: sheet.id, colId };
}

/** Drive the background warmer to completion — it yields between columns, so this yields with it. */
async function settle(sheetId: string, tries = 60): Promise<ReturnType<typeof getSheetColumnStats>> {
  for (let i = 0; i < tries; i++) {
    const stats = getSheetColumnStats(sheetId, 0);
    if (!stats.some((s) => s.computing)) return stats;
    warmSheetStats(sheetId);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("column stats never finished computing");
}

test("a failed cell is completed — the bar fills, the breakdown says why", () => {
  const { sheetId, colId } = fixture("stats-terminal", ["done", "done", "error"]);
  const stats = getColumnStats(colId, sheetId);

  // The point of the distinction: 100% of the work is over, and a third of it failed. Counting a
  // failure as incomplete would leave the bar stuck below full with nothing left to run.
  assert.equal(stats.completed, 3);
  assert.equal(stats.pct, 100);
  assert.equal(stats.byStatus.error, 1);
  assert.equal(stats.byStatus.done, 2);
});

test("a column with fewer cells than rows is not 100% done", () => {
  const sheet = createSheet("stats-backfill");
  const a = addColumn(sheet.id, { name: "A" });
  insertRows(sheet.id, [{ values: {} }, { values: {} }], 0, [Number(a.id)]);
  // A column added after the rows exist has no cells yet.
  const b = addColumn(sheet.id, { name: "B" });
  db.prepare("DELETE FROM cells WHERE column_id = ?").run(Number(b.id));
  clearStatsCache();

  const stats = getColumnStats(Number(b.id), sheet.id);
  assert.equal(stats.total, 2, "total comes from the row count, not from the cells that exist");
  assert.equal(stats.completed, 0);
  assert.equal(stats.byStatus.empty, 2, "the missing cells are reported as never run");
});

test("an invalidated column is recomputed, not re-served from its own snapshot", async () => {
  const { sheetId, colId } = fixture("stats-warm", ["done", "error"]);

  // Compute and persist once, so the column has a snapshot on disk.
  assert.equal(getColumnStats(colId, sheetId).byStatus.error, 1);

  // Now change the data and invalidate — the shape of a real re-run fixing a failure.
  db.prepare("UPDATE cells SET status = 'done' WHERE column_id = ?").run(colId);
  markColumnDirty(colId);

  const first = getSheetColumnStats(sheetId, 0);
  assert.equal(first[0]!.computing, true, "a zero budget must not compute anything inline");

  // Two ways this can go wrong, and the assertion below catches both: the warmer treated any
  // column present on disk as already warm and skipped it (so `computing` never cleared), and its
  // hydrate-from-disk step overwrote the dirty flag, so the next request served the pre-change
  // snapshot as if it were current — a header still reporting a failure that had been fixed.
  const settled = await settle(sheetId);
  assert.equal(settled[0]!.computing, undefined);
  assert.equal(settled[0]!.byStatus.error, undefined, "the fixed failure must be gone from the breakdown");
  assert.equal(settled[0]!.byStatus.done, 2);
});

test("an invalidation reaches the snapshot on disk, not only the one in memory", async () => {
  const { sheetId, colId } = fixture("stats-restart", ["error", "error"]);

  // Warm the cache and persist a snapshot — which is all that reading the header does.
  assert.equal(getColumnStats(colId, sheetId).byStatus.error, 2);

  // Fix the failures and invalidate: the shape of a re-run that succeeded.
  db.prepare("UPDATE cells SET status = 'done' WHERE column_id = ?").run(colId);
  markColumnDirty(colId);

  // `markColumnDirty` returned early on a cache hit, which is the COMMON case — reading the header
  // caches the column, and the run then writes to it. So the flag was set in memory while the copy
  // on disk, which outlives the process the memory does not, kept the pre-write numbers. hydrate()
  // serves whatever it finds there as FRESH, so after a restart the header reported two failures
  // that no longer existed, as fact, for the whole ten-minute TTL.
  const persisted = db.prepare("SELECT stats_json FROM columns WHERE id = ?").get(colId) as any;
  assert.equal(persisted.stats_json, null, "the persisted snapshot is invalidated too");

  clearStatsCache(); // the restart: memory gone, disk is all that is left
  const settled = await settle(sheetId);
  assert.equal(settled[0]!.byStatus.error, undefined, "the fixed failures must not survive the restart");
  assert.equal(settled[0]!.byStatus.done, 2);
});

test("a persisted snapshot from an older definition is discarded, not served", () => {
  const { sheetId, colId } = fixture("stats-version", ["done", "done", "error"]);
  getColumnStats(colId, sheetId);

  // Simulate a snapshot written before `completed` meant "terminal": right shape, wrong meaning,
  // and — critically — no version stamp. Serving it would show 67% for a column that is finished.
  db.prepare("UPDATE columns SET stats_json = ? WHERE id = ?").run(
    JSON.stringify({ columnId: colId, total: 3, byStatus: { done: 2, error: 1 }, stale: 0, completed: 2, pct: 67, computedAt: Date.now() }),
    colId,
  );
  clearStatsCache();

  const [stats] = getSheetColumnStats(sheetId, 0);
  assert.equal(stats!.computedAt, 0, "an unversioned snapshot must read as unknown, not as fact");
  assert.notEqual(stats!.pct, 67);
});
