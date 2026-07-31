// Sampling and forecasting.
//
// A forecast is read once, believed, and acted on with money. So most of these tests are about the
// forecast REFUSING — proving that a sample too small, too broken, or too lucky does not come back
// as a confident number.
//
// Nothing here calls a model. Attempts are written directly, which is also the only way to test the
// arithmetic on a known distribution rather than on whatever a run happened to cost.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { addColumn, createSheet, insertRows } from "./store.ts";
import {
  forecast, sampleRowIds, DEFAULT_SAMPLE_ROWS, FAILURE_RATE_LIMIT, MAX_SAMPLE_ROWS, MIN_FOR_PROJECTION,
} from "./sample.ts";

/** A sheet with `n` rows and one AI column. */
function sheetWith(n: number, name: string) {
  const sheet = createSheet(name);
  const col = addColumn(sheet.id, { name: "Industry", kind: "ai" });
  insertRows(sheet.id, Array.from({ length: n }, () => ({ values: {} })), 0, [Number(col.id)]);
  const rowIds = (db.prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY position").all(sheet.id) as any[])
    .map((r) => Number(r.id));
  return { sheet, col, rowIds };
}

/** A finished sample run with attempts of exactly the given costs. */
function runWith(
  sheetId: string,
  columnId: number,
  rowIds: number[],
  attempts: Array<{ rowId: number; status: string; cost: number; ms?: number }>,
  sampleOfRows: number,
): string {
  const runId = `run-${Math.abs(sheetId.split("").reduce((a, c) => a * 31 + c.charCodeAt(0), 7))}-${attempts.length}-${sampleOfRows}`;
  db.prepare(
    `INSERT INTO runs (id, sheet_id, kind, scope_json, status, total, started_at)
     VALUES (?, ?, 'sample', ?, 'done', ?, datetime('now'))`,
  ).run(
    runId, sheetId,
    JSON.stringify({ rowIds, resolvedColumnIds: [columnId], sampleOfRows, summary: "" }),
    attempts.length,
  );
  let i = 0;
  for (const a of attempts) {
    db.prepare(
      `INSERT INTO cell_attempts (row_id, column_id, run_id, attempt, status, cost_usd, duration_ms, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(a.rowId, columnId, runId, ++i, a.status, a.cost, a.ms ?? 1000);
  }
  // The cell carries the OUTCOME, which is what the forecast counts — the last attempt per row wins,
  // exactly as the engine leaves it.
  const last = new Map<number, { status: string; cost: number }>();
  for (const a of attempts) last.set(a.rowId, { status: a.status, cost: a.cost });
  for (const [rowId, v] of last) {
    db.prepare("UPDATE cells SET status = ?, cost_usd = ?, run_id = ? WHERE row_id = ? AND column_id = ?")
      .run(v.status, v.cost, runId, rowId, columnId);
  }
  return runId;
}

/** A run whose cells finished but that recorded no attempt rows at all — the script lane. */
function runWithoutAttempts(
  sheetId: string, columnId: number, rowIds: number[], statuses: string[],
): string {
  const runId = `run-noattempt-${sheetId.slice(0, 8)}-${rowIds.length}`;
  db.prepare(
    `INSERT INTO runs (id, sheet_id, kind, scope_json, status, total, started_at)
     VALUES (?, ?, 'sample', ?, 'done', ?, datetime('now'))`,
  ).run(runId, sheetId, JSON.stringify({ rowIds, resolvedColumnIds: [columnId], sampleOfRows: 500 }), rowIds.length);
  rowIds.forEach((rowId, i) => {
    db.prepare("UPDATE cells SET status = ?, run_id = ?, duration_ms = ? WHERE row_id = ? AND column_id = ?")
      .run(statuses[i] ?? "done", runId, 4, rowId, columnId);
  });
  return runId;
}

// ── picking the rows ────────────────────────────────────────────────────────

test("a sample is spread across the scope, not taken off the top", () => {
  // The whole reason this is not `LIMIT 10`. Imports arrive sorted, so the first ten rows of a sheet
  // are its least representative ten — and on a paid column they are what the projection for the
  // other 990 would be built from.
  const { sheet, rowIds } = sheetWith(1_000, "ZZ sample spread");
  const pick = sampleRowIds(sheet.id, {}, 10);

  assert.equal(pick.rowIds.length, 10);
  assert.equal(pick.ofRows, 1_000);
  assert.equal(pick.stride, 100);

  const positions = pick.rowIds.map((id) => rowIds.indexOf(id));
  assert.ok(Math.max(...positions) > 800, "the sample reaches the far end of the sheet");
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), "and walks it in order");
});

test("a scope smaller than the sample returns all of it, rather than nothing", () => {
  // Integer division by a stride of zero is how "sample 10 of 4 rows" becomes an empty sample and a
  // forecast with nothing in it.
  const { sheet } = sheetWith(4, "ZZ sample small");
  const pick = sampleRowIds(sheet.id, {}, 10);
  assert.equal(pick.rowIds.length, 4);
  assert.equal(pick.ofRows, 4);
});

test("the sample obeys the scope it was given, not the whole sheet", () => {
  const { sheet, rowIds } = sheetWith(100, "ZZ sample scoped");
  const wanted = rowIds.slice(10, 20);
  const pick = sampleRowIds(sheet.id, { rowIds: wanted }, 5);
  assert.equal(pick.ofRows, 10);
  for (const id of pick.rowIds) assert.ok(wanted.includes(id), "no row from outside the scope");
});

test("a sample size is clamped rather than believed", () => {
  const { sheet } = sheetWith(500, "ZZ sample clamp");
  assert.equal(sampleRowIds(sheet.id, {}, 10_000).rowIds.length, MAX_SAMPLE_ROWS);
  assert.equal(sampleRowIds(sheet.id, {}, 0).rowIds.length, DEFAULT_SAMPLE_ROWS);
  assert.equal(sampleRowIds(sheet.id, {}, -5).rowIds.length, 1);
});

// ── the projection ──────────────────────────────────────────────────────────

test("the projection is built on the median, so one runaway row cannot set the price", () => {
  // Nine rows at a cent and one at a dollar. The mean is 10.9 cents — an eleven-fold overstatement
  // of what the next row will cost, and the number a naive average would put in front of someone
  // deciding whether to spend.
  const { sheet, col, rowIds } = sheetWith(20, "ZZ forecast median");
  const attempts = rowIds.slice(0, 10).map((rowId, i) => ({
    rowId, status: "done", cost: i === 9 ? 1.0 : 0.01,
  }));
  const runId = runWith(sheet.id, Number(col.id), rowIds.slice(0, 10), attempts, 1_000);

  const f = forecast(runId)!;
  assert.equal(f.rowsSampled, 10);
  assert.equal(f.perRow.median, 0.01);
  assert.equal(f.perRow.max, 1.0);
  assert.equal(f.projection!.remainingRows, 990);
  assert.ok(Math.abs(f.projection!.likely - 9.9) < 1e-9, "990 rows at the median cent");
});

test("over a small sample the top of the range includes the priciest row, not the ninth of ten", () => {
  // The flaw a test caught before this shipped. Nearest-rank p90 over ten values is the NINTH of
  // them, so the single most expensive row in a ten-row sample is structurally excluded from p90 —
  // the exact row the top of the range exists to warn about. `high` came back equal to `likely` and
  // the range reported the spread as nil.
  const { sheet, col, rowIds } = sheetWith(20, "ZZ forecast tail");
  const runId = runWith(
    sheet.id, Number(col.id), rowIds.slice(0, 10),
    rowIds.slice(0, 10).map((rowId, i) => ({ rowId, status: "done", cost: i === 9 ? 1.0 : 0.01 })),
    1_010,
  );
  const f = forecast(runId)!;
  assert.equal(f.perRow.p90, 1.0, "the tail of a ten-row sample is its top row");
  assert.ok(f.projection!.high > f.projection!.likely * 50, "so the range actually shows the spread");
});

test("the range is ordered low ≤ likely ≤ high, whatever the spread", () => {
  const { sheet, col, rowIds } = sheetWith(30, "ZZ forecast range");
  const costs = [0.001, 0.002, 0.002, 0.003, 0.004, 0.004, 0.009, 0.02, 0.05, 0.4];
  const runId = runWith(
    sheet.id, Number(col.id), rowIds.slice(0, 10),
    costs.map((cost, i) => ({ rowId: rowIds[i]!, status: "done", cost })),
    500,
  );
  const p = forecast(runId)!.projection!;
  assert.ok(p.low <= p.likely && p.likely <= p.high);
});

test("what a row costs is the SUM of its attempts, not one of them", () => {
  // A retried row cost three calls. Forecasting from the surviving attempt under-projects by exactly
  // the retry rate — which is highest on the columns that most need forecasting.
  const { sheet, col, rowIds } = sheetWith(20, "ZZ forecast retries");
  const runId = runWith(
    sheet.id, Number(col.id), rowIds.slice(0, 4),
    [
      { rowId: rowIds[0]!, status: "error", cost: 0.01 },
      { rowId: rowIds[0]!, status: "error", cost: 0.01 },
      { rowId: rowIds[0]!, status: "done", cost: 0.01 },
      { rowId: rowIds[1]!, status: "done", cost: 0.03 },
      { rowId: rowIds[2]!, status: "done", cost: 0.03 },
      { rowId: rowIds[3]!, status: "done", cost: 0.03 },
    ],
    100,
  );
  const f = forecast(runId)!;
  assert.equal(f.rowsSampled, 4, "four rows, six attempts");
  assert.equal(f.perRow.median, 0.03, "the retried row cost the same three cents as the rest");
  assert.ok(Math.abs(f.spent - 0.12) < 1e-9);
});

// ── the refusals ────────────────────────────────────────────────────────────

test("too few answers means no projection, and says which rule refused", () => {
  const { sheet, col, rowIds } = sheetWith(20, "ZZ forecast too few");
  const runId = runWith(
    sheet.id, Number(col.id), rowIds.slice(0, 5),
    [
      { rowId: rowIds[0]!, status: "done", cost: 0.01 },
      { rowId: rowIds[1]!, status: "done", cost: 0.01 },
      { rowId: rowIds[2]!, status: "skipped", cost: 0 },
      { rowId: rowIds[3]!, status: "skipped", cost: 0 },
      { rowId: rowIds[4]!, status: "skipped", cost: 0 },
    ],
    1_000,
  );
  const f = forecast(runId)!;
  assert.equal(f.projection, null);
  assert.match(String(f.whyNot), /too few/i);
  assert.ok(MIN_FOR_PROJECTION > 2, "a median of two is not a median");
});

test("a sample still running says so, rather than passing a verdict on it", () => {
  // Seen on screen three seconds into a live sample: "Only 0 of 10 rows produced an answer. Fix
  // what is failing." Nothing was failing — it had not finished. A verdict shown before the
  // evidence is in is worse than no verdict, because it names a fault that does not exist.
  const { sheet, col, rowIds } = sheetWith(20, "ZZ forecast in-flight");
  const runId = runWith(
    sheet.id, Number(col.id), rowIds.slice(0, 2),
    [{ rowId: rowIds[0]!, status: "done", cost: 0.01 }],
    1_000,
  );
  db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);

  const f = forecast(runId)!;
  assert.equal(f.projection, null);
  assert.match(String(f.whyNot), /still running/i);
  assert.doesNotMatch(String(f.whyNot), /fix what is failing/i);
});

test("a mostly-failing column gets no cost projected, because that is not the finding", () => {
  // A tidy dollar figure under a 70% failure rate reads as permission. The number worth acting on is
  // the failure rate.
  const { sheet, col, rowIds } = sheetWith(20, "ZZ forecast failing");
  const attempts = rowIds.slice(0, 10).map((rowId, i) => ({
    rowId, status: i < 7 ? "error" : "done", cost: i < 7 ? 0 : 0.01,
  }));
  const runId = runWith(sheet.id, Number(col.id), rowIds.slice(0, 10), attempts, 1_000);

  const f = forecast(runId)!;
  assert.ok(f.failureRate > FAILURE_RATE_LIMIT);
  assert.equal(f.projection, null);
  assert.match(String(f.whyNot), /errored/i);
  assert.equal(f.errored, 7, "and the count itself is still reported");
});

test("an answer that does not exist is not a failure", () => {
  // `not_found` is the column working: it asked, there was no answer for that row, and it cost money
  // finding out — which it will do again on the rows after. Counting it as broken would suppress the
  // projection on exactly the columns whose cost is worth knowing.
  const { sheet, col, rowIds } = sheetWith(20, "ZZ forecast not-found");
  const attempts = rowIds.slice(0, 10).map((rowId, i) => ({
    rowId, status: i < 8 ? "not_found" : "done", cost: 0.01,
  }));
  const runId = runWith(sheet.id, Number(col.id), rowIds.slice(0, 10), attempts, 1_000);

  const f = forecast(runId)!;
  assert.equal(f.failureRate, 0);
  assert.ok(f.projection, "and a projection is offered");
  assert.equal(f.notFound, 8, "while still saying plainly that most rows had no answer");
});

test("a sample that covered everything projects nothing, rather than doubling the bill", () => {
  const { sheet, col, rowIds } = sheetWith(8, "ZZ forecast complete");
  const runId = runWith(
    sheet.id, Number(col.id), rowIds,
    rowIds.map((rowId) => ({ rowId, status: "done", cost: 0.01 })),
    8,
  );
  const f = forecast(runId)!;
  assert.equal(f.projection, null);
  assert.match(String(f.whyNot), /every row/i);
  assert.ok(Math.abs(f.spent - 0.08) < 1e-9, "the money already spent is still reported");
});

test("a lane that records no successful attempt is still counted", () => {
  // Caught live, not by a test. The script lane deliberately writes an attempt row only on FAILURE —
  // a script column is one pass over a whole table, and a million provenance rows per pass is the
  // cost that design avoids. Reading attempts alone, the first version of this reported a
  // ten-for-ten successful script sample as "0 of 0 rows produced an answer".
  //
  // The dangerous half is the mixed case below: with only failures recorded, a column that answered
  // eight of ten rows reported as 100% failed, which suppresses the projection on a column that
  // works.
  const { sheet, col, rowIds } = sheetWith(20, "ZZ forecast no-attempts");
  const runId = runWithoutAttempts(
    sheet.id, Number(col.id), rowIds.slice(0, 10),
    ["done", "done", "done", "done", "done", "done", "done", "done", "error", "error"],
  );

  const f = forecast(runId)!;
  assert.equal(f.rowsSampled, 10, "all ten rows are seen, not just the two that failed");
  assert.equal(f.done, 8);
  assert.equal(f.errored, 2);
  assert.ok(f.projection, "and a column that mostly works gets a projection");
});

test("a run that does not exist forecasts nothing rather than zero", () => {
  assert.equal(forecast("no-such-run"), null);
});
