// What has been spent, and on what.
//
// The workspace could already say what a RUN cost. It could not say what a column costs, what a
// table costs, which model the money went to, or whether last month was more than this one — so the
// only way to answer "why is this expensive" was to remember. Every number needed for that was being
// computed and thrown away: the executor priced each cell from its token counts and kept the dollar
// figure, and `cells.tokens_in` / `cell_attempts.model` had existed since the first phase with
// nothing ever writing them.
//
// ── Why this is a rollup table and not a query ─────────────────────────────────────────────────
//
// The obvious version is `SELECT SUM(cost_usd) ... GROUP BY model` over `cell_attempts`. That is
// correct and it does not survive contact with the product: an AI column over the million-row table
// is a million attempts, and a workspace page that scans them on every view is a page that takes
// seconds and gets slower every week the workspace is used. Reporting is read far more often than it
// is written, so the work belongs on the write.
//
// So each attempt also increments one row of `usage_daily`, keyed by day, table, column and model.
// A workspace-wide answer then reads tens of rows rather than tens of millions, and stays that way
// however much is run.
//
// ── The day boundary ───────────────────────────────────────────────────────────────────────────
//
// Days are UTC, taken from the attempt's own timestamp rather than from "now". Bucketing by local
// time would make the same run report differently depending on where the machine is, and taking the
// date at aggregation time rather than at attempt time would file a backfill of last month's work
// under today.

import { db, getKv, setKv, tx } from "./db.ts";

export interface UsageTotals {
  attempts: number;
  errors: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheCreate: number;
  durationMs: number;
}

export interface UsageSlice extends UsageTotals {
  /** What this row is a total FOR — a model id, a lane, a column name, or a date. */
  key: string;
  label: string;
  /** Third-party units inside this group. */
  units: number;
  /**
   * What those units are called — and EMPTY when the group mixes more than one kind.
   *
   * A total of 1,500 that is really 1,000 credits plus 500 lookups is not a number, it is two
   * numbers added together. So a mixed group refuses to name a unit, the screen shows the count
   * without one, and `byUnit` is where a per-currency answer is read.
   */
  unit: string;
}

export interface UsageReport {
  scope: "workspace" | "workbook" | "table";
  /** Null for the whole workspace. */
  scopeId: string | null;
  scopeName: string;
  from: string | null;
  to: string | null;
  totals: UsageTotals;
  byModel: UsageSlice[];
  byLane: UsageSlice[];
  byColumn: UsageSlice[];
  byTable: UsageSlice[];
  byDay: UsageSlice[];
  /** One row per third-party currency spent — credits, enrichments, lookups. Empty when none. */
  byUnit: UsageSlice[];
}

const ZERO: UsageTotals = {
  attempts: 0, errors: 0, costUsd: 0, tokensIn: 0, tokensOut: 0,
  cacheRead: 0, cacheCreate: 0, durationMs: 0,
};

/**
 * Record one attempt against the daily rollup.
 *
 * Called from the same place the attempt row is written, so the two cannot disagree about what
 * happened. An upsert rather than an insert: the whole point is that a million attempts collapse
 * into a handful of rows.
 *
 * `model` is empty string rather than NULL for the lanes that have none — an HTTP column spends real
 * money and belongs in the totals, and NULL in a primary key would make every one of its attempts a
 * separate row. The report renders an empty model as its lane's name.
 */
export function recordUsage(input: {
  sheetId: string;
  columnId: number;
  lane: string;
  model?: string | null;
  status: string;
  costUsd?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  cacheRead?: number | null;
  cacheCreate?: number | null;
  durationMs?: number | null;
  /** Third-party units this attempt burned, and what they are called. */
  units?: number | null;
  unit?: string | null;
  /** The attempt's own timestamp. Defaults to now; passed explicitly by the backfill. */
  at?: string;
}): void {
  const day = (input.at ?? new Date().toISOString()).slice(0, 10);
  db.prepare(
    `INSERT INTO usage_daily
       (day, sheet_id, column_id, lane, model, attempts, errors, cost_usd,
        tokens_in, tokens_out, cache_read, cache_create, duration_ms, units, unit)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day, sheet_id, column_id, lane, model) DO UPDATE SET
       attempts     = attempts + 1,
       errors       = errors + excluded.errors,
       cost_usd     = cost_usd + excluded.cost_usd,
       tokens_in    = tokens_in + excluded.tokens_in,
       tokens_out   = tokens_out + excluded.tokens_out,
       cache_read   = cache_read + excluded.cache_read,
       cache_create = cache_create + excluded.cache_create,
       duration_ms  = duration_ms + excluded.duration_ms,
       units        = units + excluded.units,
       -- The LABEL is replaced, not accumulated, and only by a non-empty one. A column declares one
       -- unit at a time; if it is renamed mid-day the newest name wins for that day, which is the
       -- only answer that does not leave the total labelled with a word the user has stopped using.
       -- Guarded against empty so an attempt that burned nothing cannot blank a real label.
       unit         = CASE WHEN excluded.unit <> '' THEN excluded.unit ELSE unit END`,
  ).run(
    day, input.sheetId, Number(input.columnId), input.lane, input.model ?? "",
    input.status === "error" ? 1 : 0,
    input.costUsd ?? 0,
    input.tokensIn ?? 0, input.tokensOut ?? 0,
    input.cacheRead ?? 0, input.cacheCreate ?? 0,
    input.durationMs ?? 0,
    input.units ?? 0, (input.unit ?? "").trim(),
  );
}

/**
 * Fold the attempts that were recorded before this table existed into it.
 *
 * Guarded by a kv flag so it runs once. Without it the reporting screen would open on an empty
 * history for a workspace that has been used for weeks, which reads as the feature being broken
 * rather than as the data starting today.
 */
export function backfillUsage(): number {
  const KEY = "usage.backfill.v1";
  if (getKv(KEY)) return 0;

  let folded = 0;
  tx(() => {
    const rows = db
      .prepare(
        `SELECT a.started_at AS at, a.model AS model, a.status AS status,
                a.cost_usd AS cost, a.duration_ms AS ms,
                a.tokens_in AS ti, a.tokens_out AS to_, a.tokens_cache_read AS cr, a.tokens_cache_create AS cc,
                c.id AS column_id, c.sheet_id AS sheet_id, c.kind AS lane
           FROM cell_attempts a
           JOIN columns c ON c.id = a.column_id`,
      )
      .all() as any[];
    for (const r of rows) {
      recordUsage({
        sheetId: String(r.sheet_id), columnId: Number(r.column_id), lane: String(r.lane ?? ""),
        model: r.model, status: String(r.status ?? ""),
        costUsd: r.cost, tokensIn: r.ti, tokensOut: r.to_, cacheRead: r.cr, cacheCreate: r.cc,
        durationMs: r.ms, at: String(r.at ?? ""),
      });
      folded++;
    }
    setKv(KEY, "1");
  });
  return folded;
}

/** The sheets a scope covers. One statement, so a workbook and the workspace share a code path. */
function sheetsInScope(scope: UsageReport["scope"], id: string | null): string[] {
  if (scope === "table") return id ? [id] : [];
  if (scope === "workbook") {
    return (db.prepare("SELECT id FROM sheets WHERE workbook_id = ?").all(id) as any[]).map((r) => String(r.id));
  }
  return (db.prepare("SELECT id FROM sheets").all() as any[]).map((r) => String(r.id));
}

const SUMS = `
  SUM(attempts) AS attempts, SUM(errors) AS errors, SUM(cost_usd) AS cost_usd,
  SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
  SUM(cache_read) AS cache_read, SUM(cache_create) AS cache_create,
  SUM(duration_ms) AS duration_ms, SUM(units) AS units,
  MIN(NULLIF(unit, '')) AS unit_lo, MAX(NULLIF(unit, '')) AS unit_hi`;

/** The group's unit, or empty when it holds more than one kind. NULLIF above ignores the unpriced. */
const oneUnit = (r: any): string => (r?.unit_lo && r.unit_lo === r.unit_hi ? String(r.unit_lo) : "");

const toTotals = (r: any): UsageTotals => ({
  attempts: Number(r?.attempts ?? 0),
  errors: Number(r?.errors ?? 0),
  costUsd: Number(r?.cost_usd ?? 0),
  tokensIn: Number(r?.tokens_in ?? 0),
  tokensOut: Number(r?.tokens_out ?? 0),
  cacheRead: Number(r?.cache_read ?? 0),
  cacheCreate: Number(r?.cache_create ?? 0),
  durationMs: Number(r?.duration_ms ?? 0),
});

/**
 * What a scope has spent, broken down every way worth asking.
 *
 * All five breakdowns come back together rather than behind five requests: they are read off the
 * same tiny table, and a screen that has to ask again for each one is a screen where the totals and
 * the breakdown can disagree while you look at them.
 */
export function usageReport(
  scope: UsageReport["scope"],
  scopeId: string | null,
  range: { from?: string | null; to?: string | null } = {},
): UsageReport {
  const sheets = sheetsInScope(scope, scopeId);
  const from = range.from ?? null;
  const to = range.to ?? null;

  const scopeName =
    scope === "workspace" ? "This workspace"
    : scope === "workbook"
      ? String((db.prepare("SELECT name FROM workbooks WHERE id = ?").get(scopeId) as any)?.name ?? "a deleted workbook")
      : String((db.prepare("SELECT name FROM sheets WHERE id = ?").get(scopeId) as any)?.name ?? "a deleted table");

  // An empty scope is a real state — a brand new workbook — and must not become "no filter", which
  // would report the whole workspace's spend under one table's name. This is the same failure as an
  // unparseable filter meaning "every row", and it has happened four times in this codebase.
  if (sheets.length === 0) {
    return { scope, scopeId, scopeName, from, to, totals: { ...ZERO }, byModel: [], byLane: [], byColumn: [], byTable: [], byDay: [], byUnit: [] };
  }

  const marks = sheets.map(() => "?").join(",");
  const where: string[] = [`sheet_id IN (${marks})`];
  const params: Array<string | number> = [...sheets];
  if (from) { where.push("day >= ?"); params.push(from); }
  if (to) { where.push("day <= ?"); params.push(to); }
  const W = where.join(" AND ");

  const totals = toTotals(db.prepare(`SELECT ${SUMS} FROM usage_daily WHERE ${W}`).get(...params));

  const slice = (groupBy: string, labelFor: (key: string) => string): UsageSlice[] =>
    (db
      .prepare(`SELECT ${groupBy} AS k, ${SUMS} FROM usage_daily WHERE ${W} GROUP BY k ORDER BY cost_usd DESC, attempts DESC`)
      .all(...params) as any[])
      .map((r) => ({
        key: String(r.k ?? ""), label: labelFor(String(r.k ?? "")),
        ...toTotals(r), units: Number(r.units ?? 0), unit: oneUnit(r),
      }));

  const columnNames = new Map<string, string>();
  for (const r of db.prepare("SELECT id, name FROM columns").all() as any[]) columnNames.set(String(r.id), String(r.name));
  const sheetNames = new Map<string, string>();
  for (const r of db.prepare("SELECT id, name FROM sheets").all() as any[]) sheetNames.set(String(r.id), String(r.name));

  return {
    scope, scopeId, scopeName, from, to, totals,
    // A lane with no model is labelled by its lane, not left blank — an HTTP column spends real money
    // and a blank row in a cost table reads as a bug.
    byModel: slice("model", (k) => k || "A request or a rule"),
    byLane: slice("lane", (k) => k || "unknown"),
    // Deleted columns keep their spend and say so. Dropping them would make the breakdown stop
    // adding up to the total, which is worse than naming something that is gone.
    byColumn: slice("column_id", (k) => columnNames.get(k) ?? `a deleted column (${k})`),
    byTable: slice("sheet_id", (k) => sheetNames.get(k) ?? "a deleted table"),
    byDay: (db
      .prepare(`SELECT day AS k, ${SUMS} FROM usage_daily WHERE ${W} GROUP BY k ORDER BY k`)
      .all(...params) as any[])
      .map((r) => ({
        key: String(r.k), label: String(r.k),
        ...toTotals(r), units: Number(r.units ?? 0), unit: oneUnit(r),
      })),
    // Rows with no declared unit are excluded rather than bucketed as "unknown": every model attempt
    // has none, so including them would make one enormous nameless row that answers nothing.
    byUnit: (db
      .prepare(
        `SELECT unit AS k, ${SUMS} FROM usage_daily WHERE ${W} AND unit <> '' GROUP BY k ORDER BY units DESC`,
      )
      .all(...params) as any[])
      .map((r) => ({
        key: String(r.k), label: String(r.k),
        ...toTotals(r), units: Number(r.units ?? 0), unit: String(r.k),
      })),
  };
}
