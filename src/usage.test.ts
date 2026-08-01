// What has been spent, and on what.
//
// A cost report is believed. Nobody re-derives it, so the failures worth pinning are the ones that
// produce a plausible number: a scope that quietly widens to the whole workspace, a breakdown that
// stops adding up to its own total, and spend attributed to the wrong day or the wrong model.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { addColumn, createSheet } from "./store.ts";
import { backfillUsage, recordUsage, usageReport } from "./usage.ts";

function workbook(name: string): string {
  const id = `wb-${name}-${Math.random().toString(36).slice(2)}`;
  db.prepare("INSERT INTO workbooks (id, name) VALUES (?, ?)").run(id, name);
  return id;
}
function sheetIn(wb: string, name: string) {
  const s = createSheet(name);
  db.prepare("UPDATE sheets SET workbook_id = ? WHERE id = ?").run(wb, s.id);
  return s;
}

/** Two workbooks, so "did this scope leak" is answerable rather than assumed. */
function world(name: string) {
  const wbA = workbook(`${name}-A`);
  const wbB = workbook(`${name}-B`);
  const leads = sheetIn(wbA, `${name}-leads`);
  const accounts = sheetIn(wbA, `${name}-accounts`);
  const other = sheetIn(wbB, `${name}-elsewhere`);

  const enrich = addColumn(leads.id, { name: "Enrich", kind: "ai", valueType: "text" });
  const score = addColumn(accounts.id, { name: "Score", kind: "agent", valueType: "text" });
  const far = addColumn(other.id, { name: "Far", kind: "ai", valueType: "text" });

  const spend = (sheetId: string, columnId: number, lane: string, model: string, cost: number, at: string, status = "done") =>
    recordUsage({
      sheetId, columnId, lane, model, status,
      costUsd: cost, tokensIn: 1000, tokensOut: 200, durationMs: 500, at,
    });

  spend(leads.id, Number(enrich.id), "ai", "openai/gpt-oss-20b", 1, "2026-07-01T10:00:00Z");
  spend(leads.id, Number(enrich.id), "ai", "openai/gpt-oss-20b", 2, "2026-07-01T11:00:00Z");
  spend(leads.id, Number(enrich.id), "ai", "anthropic/claude", 4, "2026-07-02T10:00:00Z");
  spend(accounts.id, Number(score.id), "agent", "anthropic/claude", 8, "2026-07-02T12:00:00Z", "error");
  // A different workbook entirely — the money that must never appear in workbook A's total.
  spend(other.id, Number(far.id), "ai", "openai/gpt-oss-20b", 16, "2026-07-02T13:00:00Z");

  return { wbA, wbB, leads, accounts, other, enrich, score, far };
}

test("a table's total is that table's spend and nothing else", () => {
  const w = world("table");
  const r = usageReport("table", w.leads.id);
  assert.equal(r.totals.costUsd, 7, "1 + 2 + 4");
  assert.equal(r.totals.attempts, 3);
});

test("a workbook adds up its tables and stops there", () => {
  const w = world("workbook");
  const r = usageReport("workbook", w.wbA);
  assert.equal(r.totals.costUsd, 15, "7 on leads plus 8 on accounts — the other workbook is not ours");
  assert.deepEqual(r.byTable.map((t) => t.costUsd).sort((a, b) => a - b), [7, 8]);
});

test("the workspace is everything", () => {
  const w = world("workspace");
  const r = usageReport("workspace", null);
  assert.ok(r.totals.costUsd >= 31, "15 in one workbook and 16 in the other, plus anything else present");
});

test("an empty scope reports nothing, not everything", () => {
  // THE failure this file exists for. An empty sheet list becoming "no filter" would report the whole
  // workspace's spend under one new workbook's name — the same shape as an unparseable filter meaning
  // "every row", which this codebase has produced four separate times.
  world("empty");
  const fresh = workbook("brand-new");
  const r = usageReport("workbook", fresh);
  assert.equal(r.totals.costUsd, 0);
  assert.equal(r.totals.attempts, 0);
  assert.deepEqual(r.byModel, []);
});

test("every breakdown adds up to the total it sits under", () => {
  // A breakdown that does not reconcile is worse than no breakdown: it invites the reader to trust
  // whichever half suits them.
  const w = world("reconcile");
  const r = usageReport("workbook", w.wbA);
  const sum = (xs: Array<{ costUsd: number }>) => xs.reduce((a, b) => a + b.costUsd, 0);

  assert.equal(sum(r.byModel), r.totals.costUsd);
  assert.equal(sum(r.byLane), r.totals.costUsd);
  assert.equal(sum(r.byColumn), r.totals.costUsd);
  assert.equal(sum(r.byTable), r.totals.costUsd);
  assert.equal(sum(r.byDay), r.totals.costUsd);
});

test("spend is attributed to the model that answered", () => {
  const w = world("models");
  const r = usageReport("workbook", w.wbA);
  const byModel = Object.fromEntries(r.byModel.map((m) => [m.key, m.costUsd]));
  assert.equal(byModel["openai/gpt-oss-20b"], 3);
  assert.equal(byModel["anthropic/claude"], 12, "4 on leads and 8 on accounts");
});

test("a date range narrows, and narrows honestly", () => {
  const w = world("dates");
  const all = usageReport("workbook", w.wbA);
  const firstDay = usageReport("workbook", w.wbA, { from: "2026-07-01", to: "2026-07-01" });
  assert.equal(firstDay.totals.costUsd, 3, "only the two attempts on the 1st");
  assert.ok(all.totals.costUsd > firstDay.totals.costUsd);
  assert.deepEqual(firstDay.byDay.map((d) => d.key), ["2026-07-01"]);
});

test("a day is taken from when it happened, not from when it was counted", () => {
  // Bucketing by "now" would file a backfill of last month's work under today, which makes a
  // month-on-month comparison say the opposite of the truth.
  const w = world("daybound");
  const r = usageReport("workbook", w.wbA);
  assert.deepEqual(r.byDay.map((d) => d.key), ["2026-07-01", "2026-07-02"]);
});

test("failures are counted, and their spend is kept", () => {
  // The most valuable spend to find is the kind that produced nothing. Leaving errors out of the
  // totals would hide exactly the waste worth looking for.
  const w = world("errors");
  const r = usageReport("workbook", w.wbA);
  assert.equal(r.totals.errors, 1);
  const agent = r.byLane.find((l) => l.key === "agent");
  assert.equal(agent?.costUsd, 8, "it failed and it still cost eight dollars");
});

test("a lane with no model is labelled rather than left blank", () => {
  // An HTTP column spends real money at a third party. A blank row in a cost table reads as a bug.
  const wb = workbook("nomodel");
  const s = sheetIn(wb, "requests");
  const col = addColumn(s.id, { name: "Call", kind: "http", valueType: "text" });
  recordUsage({
    sheetId: s.id, columnId: Number(col.id), lane: "http", model: null, status: "done",
    costUsd: 5, at: "2026-07-03T10:00:00Z",
  });
  const r = usageReport("workbook", wb);
  assert.equal(r.byModel.length, 1);
  assert.equal(r.byModel[0]!.key, "");
  assert.ok(r.byModel[0]!.label.length > 0, "it says what it is instead of showing an empty cell");
  assert.equal(r.byModel[0]!.costUsd, 5);
});

test("a deleted column keeps its spend, so the breakdown still reconciles", () => {
  const wb = workbook("deleted");
  const s = sheetIn(wb, "t");
  const col = addColumn(s.id, { name: "Gone", kind: "ai", valueType: "text" });
  recordUsage({
    sheetId: s.id, columnId: Number(col.id), lane: "ai", model: "m", status: "done",
    costUsd: 9, at: "2026-07-04T10:00:00Z",
  });
  db.prepare("DELETE FROM columns WHERE id = ?").run(Number(col.id));

  const r = usageReport("workbook", wb);
  assert.equal(r.totals.costUsd, 9, "the money was spent whether or not the column still exists");
  assert.equal(r.byColumn.length, 1);
  assert.ok(/deleted/i.test(r.byColumn[0]!.label), "and it says the column is gone rather than showing an id");
});

test("many attempts collapse into few rows", () => {
  // The reason this is a rollup at all: a million attempts must not become a million rows to scan.
  const wb = workbook("collapse");
  const s = sheetIn(wb, "t");
  const col = addColumn(s.id, { name: "C", kind: "ai", valueType: "text" });
  for (let i = 0; i < 500; i++) {
    recordUsage({
      sheetId: s.id, columnId: Number(col.id), lane: "ai", model: "m", status: "done",
      costUsd: 0.01, at: "2026-07-05T10:00:00Z",
    });
  }
  const stored = db.prepare("SELECT COUNT(*) AS n FROM usage_daily WHERE sheet_id = ?").get(s.id) as any;
  assert.equal(Number(stored.n), 1, "one day, one column, one model — one row");
  const r = usageReport("workbook", wb);
  assert.equal(r.totals.attempts, 500);
  assert.ok(Math.abs(r.totals.costUsd - 5) < 1e-9);
});

// ── Third-party units ─────────────────────────────────────────────────────────────────────────
//
// Credits are a second currency, and the failure that matters is adding two of them together: 1,000
// credits plus 500 lookups is not 1,500 of anything.

test("declared units are counted alongside the money", () => {
  const s = createSheet("ZZ usage units");
  const c = addColumn(s.id, { name: "Enrich", kind: "http", valueType: "text" });
  recordUsage({ sheetId: s.id, columnId: Number(c.id), lane: "http", status: "done", costUsd: 0.098, units: 2, unit: "credits", at: "2026-07-05T10:00:00Z" });
  recordUsage({ sheetId: s.id, columnId: Number(c.id), lane: "http", status: "done", costUsd: 0.098, units: 2, unit: "credits", at: "2026-07-05T11:00:00Z" });

  const r = usageReport("table", s.id);
  assert.equal(r.byUnit.length, 1);
  assert.equal(r.byUnit[0]!.key, "credits");
  assert.equal(r.byUnit[0]!.units, 4);
  assert.ok(Math.abs(r.totals.costUsd - 0.196) < 1e-9);
});

test("a group holding two different currencies refuses to name one", () => {
  const s = createSheet("ZZ usage mixed");
  const a = addColumn(s.id, { name: "Credits col", kind: "http", valueType: "text" });
  const b = addColumn(s.id, { name: "Lookups col", kind: "http", valueType: "text" });
  recordUsage({ sheetId: s.id, columnId: Number(a.id), lane: "http", status: "done", units: 1000, unit: "credits", at: "2026-07-05T10:00:00Z" });
  recordUsage({ sheetId: s.id, columnId: Number(b.id), lane: "http", status: "done", units: 500, unit: "lookups", at: "2026-07-05T10:00:00Z" });

  const r = usageReport("table", s.id);
  const lane = r.byLane.find((l) => l.key === "http")!;
  assert.equal(lane.units, 1500, "the count is still the sum");
  assert.equal(lane.unit, "", "but it must not be labelled, because 1500 credits-or-lookups is not a thing");

  // Per column, each of which has one currency, the label survives.
  assert.equal(r.byColumn.find((x) => x.label === "Credits col")!.unit, "credits");
  assert.equal(r.byColumn.find((x) => x.label === "Lookups col")!.unit, "lookups");
  // And the per-currency breakdown is where a real answer is read.
  assert.deepEqual(r.byUnit.map((u) => [u.key, u.units]), [["credits", 1000], ["lookups", 500]]);
});

test("model attempts do not create a nameless unit row", () => {
  const s = createSheet("ZZ usage nounits");
  const c = addColumn(s.id, { name: "Ask", kind: "ai", valueType: "text" });
  recordUsage({ sheetId: s.id, columnId: Number(c.id), lane: "ai", model: "m", status: "done", costUsd: 1, at: "2026-07-05T10:00:00Z" });
  assert.deepEqual(usageReport("table", s.id).byUnit, []);
});

test("renaming a unit relabels the day rather than leaving a word nobody uses", () => {
  const s = createSheet("ZZ usage rename");
  const c = addColumn(s.id, { name: "Enrich", kind: "http", valueType: "text" });
  recordUsage({ sheetId: s.id, columnId: Number(c.id), lane: "http", status: "done", units: 1, unit: "credits", at: "2026-07-06T10:00:00Z" });
  recordUsage({ sheetId: s.id, columnId: Number(c.id), lane: "http", status: "done", units: 1, unit: "enrichments", at: "2026-07-06T11:00:00Z" });
  const r = usageReport("table", s.id);
  assert.equal(r.byUnit.length, 1, "one row, because it is one column-day");
  assert.equal(r.byUnit[0]!.key, "enrichments", "the newest name wins");
  assert.equal(r.byUnit[0]!.units, 2);
});

test("an attempt that burned nothing cannot blank a real label", () => {
  const s = createSheet("ZZ usage blank");
  const c = addColumn(s.id, { name: "Enrich", kind: "http", valueType: "text" });
  recordUsage({ sheetId: s.id, columnId: Number(c.id), lane: "http", status: "done", units: 3, unit: "credits", at: "2026-07-07T10:00:00Z" });
  // A skip, or a call made before the price was filled in.
  recordUsage({ sheetId: s.id, columnId: Number(c.id), lane: "http", status: "done", at: "2026-07-07T11:00:00Z" });
  const r = usageReport("table", s.id);
  assert.equal(r.byUnit[0]?.key, "credits");
  assert.equal(r.byUnit[0]?.units, 3);
});

test("the backfill folds old attempts into the daily rollup, and only once", () => {
  const s = createSheet("ZZ usage backfill");
  const c = addColumn(s.id, { name: "Ask", kind: "ai", valueType: "text" });
  const col = Number(c.id);

  // Attempts as they were written before usage_daily existed: no rollup row accompanies them.
  const attempt = (at: string, status: string, cost: number) =>
    db
      .prepare(
        `INSERT INTO cell_attempts (row_id, column_id, attempt, started_at, status, model, cost_usd,
                                    tokens_in, tokens_out, duration_ms)
         VALUES (1, ?, 1, ?, ?, 'm', ?, 100, 20, 250)`,
      )
      .run(col, at, status, cost);
  attempt("2026-06-01T10:00:00Z", "done", 0.5);
  attempt("2026-06-01T11:00:00Z", "error", 0.25);
  attempt("2026-06-02T10:00:00Z", "done", 1);

  assert.equal(usageReport("table", s.id).totals.attempts, 0, "nothing is rolled up yet");

  // Two days of attempts collapse into two rows regardless of how many attempts there were, which is
  // the property the SQL GROUP BY has to preserve now that it is not one upsert per attempt.
  assert.equal(backfillUsage(), 3, "returns how many attempts it folded");
  const r = usageReport("table", s.id);
  assert.equal(r.totals.attempts, 3);
  assert.equal(r.totals.errors, 1);
  assert.equal(r.totals.costUsd, 1.75);
  assert.equal(r.byDay.length, 2);

  // Guarded by a kv flag: a second boot must not double every historical number.
  assert.equal(backfillUsage(), 0);
  assert.equal(usageReport("table", s.id).totals.attempts, 3);
});
