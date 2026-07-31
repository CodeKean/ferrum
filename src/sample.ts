// Sample before you spend — a forecast, not a taste.
//
// `estimate.ts` already answers "what should this cost?" from arithmetic: token shapes, published
// prices, a measured record size. It is the right thing to show before a run and it is a MODEL of
// the run, not the run. A model is wrong in ways nobody can see from the model — a prompt that makes
// the agent search five times instead of once, a column whose answer is three paragraphs where 60
// tokens were assumed, a lookup that fails on 70% of rows.
//
// So: run a handful of rows for real, MEASURE what they cost and whether they worked, and project
// from the measurement. The difference from "look at three outputs and see if you like them" is that
// this is arithmetic on observed numbers, with the spread reported rather than hidden behind an
// average.
//
// Two rules, both learned from the ways this kind of screen usually lies:
//
//   1. The sample is SPREAD across the scope, never the first N rows. Imports arrive sorted — by
//      country, by import batch, by whatever the source exported first — so the head of a sheet is
//      systematically unrepresentative of it. The first ten rows of a million-row list are the
//      cheapest possible thing to sample and the least likely to predict the other 999,990.
//
//   2. The projection is built on the MEDIAN and reported as a RANGE. One runaway agent row that
//      searched sixteen times drags a mean of ten far above what the other nine will cost, and a
//      single number presented without a spread is a promise the run cannot keep.
//
// And one refusal: when most of the sample FAILED, no cost is projected at all. The useful finding
// there is "this column does not work", and printing a tidy dollar figure underneath a 70% failure
// rate invites someone to approve the spend and fix the column later.

import { db } from "./db.ts";
import { getColumn } from "./store.ts";
import { resolveScope, type RunScope } from "./scope.ts";
import { estimateRun } from "./estimate.ts";
import { isLocalModel } from "./providers/local.ts";
import type { Column } from "./types.ts";

/** Enough rows for a median to mean something, few enough that the sample itself is not the spend. */
export const DEFAULT_SAMPLE_ROWS = 10;

/**
 * The ceiling on a sample.
 *
 * A sample exists to be cheap. Past this, the honest advice is to stop sampling and run the job with
 * a budget cap, which is a different control that already exists.
 */
export const MAX_SAMPLE_ROWS = 100;

/**
 * Successful rows below which nothing is projected.
 *
 * A median of two is not a median. Refusing here is the whole point: the failure mode this feature
 * exists to prevent is a confident number derived from almost nothing.
 */
export const MIN_FOR_PROJECTION = 3;

/**
 * The share of failed rows past which the cost projection is withheld entirely.
 *
 * Not a cost judgement — a relevance one. At this failure rate the number that matters is the
 * failure rate, and a dollar figure beside it reads as permission.
 */
export const FAILURE_RATE_LIMIT = 0.4;

export interface SamplePick {
  rowIds: number[];
  /** How many rows the FULL scope matches — what the sample is a sample of. */
  ofRows: number;
  /** Every nth row was taken. 1 when the scope was small enough to sample densely. */
  stride: number;
}

/**
 * Pick rows spread evenly across the scope.
 *
 * One pass over the scope's ids, striding. `ORDER BY RANDOM()` would be the obvious way to get a
 * representative sample and is unusable here: it has to materialize and sort every candidate row, so
 * on the million-row sheet the act of choosing ten rows costs more than running them.
 *
 * Striding is not random — it is systematic sampling, and it has a known failure of its own: a scope
 * whose rows repeat on a cycle that matches the stride will sample the same phase every time. That
 * is a real limitation and an acceptable one here, because the alternative is a sort of a million
 * rows and the thing being defended against is a sheet sorted by ONE key, which a stride handles.
 */
export function sampleRowIds(sheetId: string, scope: RunScope, n: number): SamplePick {
  const want = Math.max(1, Math.min(Math.floor(n) || DEFAULT_SAMPLE_ROWS, MAX_SAMPLE_ROWS));
  const resolved = resolveScope(sheetId, scope);
  if (resolved.rowCount === 0) return { rowIds: [], ofRows: 0, stride: 1 };

  if (resolved.rowCount <= want) {
    const all = db.prepare(resolved.sql).all(...resolved.params) as Array<{ id: number }>;
    return { rowIds: all.map((r) => Number(r.id)), ofRows: resolved.rowCount, stride: 1 };
  }

  const stride = Math.floor(resolved.rowCount / want);
  // The row number is computed over the scope's own order, so the stride walks the scope rather than
  // the table. `LIMIT` on the outside cannot be pushed down past the window function, so this reads
  // the whole scope once — index-only, and once per sample rather than once per row.
  const picked = db
    .prepare(
      `SELECT id FROM (
         SELECT id, (ROW_NUMBER() OVER () - 1) AS rn FROM (${resolved.sql})
       ) WHERE rn % ? = 0 LIMIT ?`,
    )
    .all(...resolved.params, stride, want) as Array<{ id: number }>;

  return { rowIds: picked.map((r) => Number(r.id)), ofRows: resolved.rowCount, stride };
}

/** What the sample rows actually did, per cell. */
interface Measured {
  costs: number[];
  durations: number[];
  done: number;
  notFound: number;
  errored: number;
  skipped: number;
}

/**
 * Nearest-rank percentile over a sorted array.
 *
 * Deliberately the simple definition, with no interpolation. Over ten values, p90 IS "the
 * second-highest of the ten" — dressing that up with interpolation between neighbours would imply a
 * precision the sample size cannot support, and the UI says the sample size next to the figure for
 * the same reason.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

const median = (sorted: number[]): number => percentile(sorted, 50);

/**
 * Below this many rows, the top of the range is the MAX rather than the 90th percentile.
 *
 * Caught by a test, and it is not a rounding detail. Nearest-rank p90 over ten values is the ninth
 * of them, so the single most expensive row in a ten-row sample can never be inside p90 — the exact
 * row the top of the range exists to warn about is the one it structurally excludes. On a sample of
 * nine cheap rows and one that cost a hundred times more, `high` came back equal to `likely` and the
 * range said the spread was nil.
 *
 * Over a big enough sample p90 is the better bound, because there the max really is an outlier. Over
 * ten rows the max is not an outlier, it is the tail — it is one tenth of everything observed.
 */
const SMALL_SAMPLE = 20;

/** The pessimistic end of the range: what a budget cap should be set against. */
function tail(sorted: number[]): number {
  return sorted.length < SMALL_SAMPLE ? (sorted[sorted.length - 1] ?? 0) : percentile(sorted, 90);
}

export interface ForecastProjection {
  /** Rows in the original scope that the sample did NOT already run. */
  remainingRows: number;
  /** The optimistic end: the cheapest quarter of the sample, applied to everything. */
  low: number;
  /** The one to read — the median row, times the rows left. */
  likely: number;
  /** The pessimistic end, from the expensive tail — see `tail`. What a budget cap is set against. */
  high: number;
}

export interface Forecast {
  runId: string;
  sheetId: string;
  /** Cells measured — rows × columns, not rows. */
  cells: number;
  rowsSampled: number;
  /** Rows the full scope matched. */
  ofRows: number;
  done: number;
  notFound: number;
  errored: number;
  skipped: number;
  /** Failed share of the cells that finished, 0–1. */
  failureRate: number;
  /** What the sample itself cost. Already spent — this is not a projection. */
  spent: number;
  perRow: { min: number; median: number; p90: number; max: number };
  /** Median seconds per cell, and the sample's own wall clock. */
  medianMs: number;
  /**
   * Null when the sample cannot support a projection, with `whyNot` saying which rule refused.
   *
   * A null here is a RESULT, not a missing value — the sample worked and its answer is "do not
   * project from this".
   */
  projection: ForecastProjection | null;
  whyNot: string | null;
  /**
   * What the arithmetic estimate said one row would cost, for comparison.
   *
   * The comparison is the point. An estimate that turns out to be 5× under is a fact about every
   * other estimate this sheet will show, and worth surfacing once rather than leaving someone to
   * notice it on the bill.
   */
  estimatedPerRow: number | null;
  /** Measured ÷ estimated. Null when there is nothing to compare. */
  estimateRatio: number | null;
  /** True when every column in the run bills nothing — a local or script run really is free. */
  free: boolean;
}

/**
 * Turn a sample run into a forecast.
 *
 * Two tables, because neither one alone is the truth:
 *
 *   `cells` is where the OUTCOME lives, and it is the only source that covers every lane. The script
 *   lane deliberately writes an attempt row only on failure — a script column is one pass over a
 *   whole table and a million provenance rows per pass is the cost that design avoids — so a
 *   forecast built on attempts alone sees a successful script column as zero rows run, and a partly
 *   failing one as 100% failed. Both were true of the first version of this, and the second is the
 *   dangerous one: a working column reported as entirely broken.
 *
 *   `cell_attempts` is where the MONEY lives, because a cell keeps only its last attempt while the
 *   run paid for all of them. A row that failed twice and succeeded on the third try cost three
 *   calls, and reading the survivor's cost would under-project by exactly the retry rate — which is
 *   highest on the columns that most need forecasting.
 *
 * So: status and coverage from cells, cost and duration from attempts, and cells' own figure as the
 * fallback for the lanes that record no successful attempt.
 */
export function forecast(runId: string): Forecast | null {
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as any;
  if (!run) return null;

  let scopeJson: any = {};
  try { scopeJson = JSON.parse(run.scope_json ?? "{}"); } catch { scopeJson = {}; }

  const cells = db
    .prepare(
      `SELECT row_id, status, COALESCE(cost_usd, 0) AS cost_usd, COALESCE(duration_ms, 0) AS duration_ms
         FROM cells WHERE run_id = ?`,
    )
    .all(runId) as Array<{ row_id: number; status: string; cost_usd: number; duration_ms: number }>;

  // Every attempt this run made, folded to one figure per row. Includes the attempts a cell no
  // longer remembers.
  const attemptCost = new Map<number, number>();
  const attemptMs = new Map<number, number>();
  for (const a of db
    .prepare(
      `SELECT row_id, COALESCE(cost_usd, 0) AS cost_usd, COALESCE(duration_ms, 0) AS duration_ms
         FROM cell_attempts WHERE run_id = ?`,
    )
    .all(runId) as Array<{ row_id: number; cost_usd: number; duration_ms: number }>) {
    attemptCost.set(a.row_id, (attemptCost.get(a.row_id) ?? 0) + Number(a.cost_usd));
    attemptMs.set(a.row_id, (attemptMs.get(a.row_id) ?? 0) + Number(a.duration_ms));
  }

  const m: Measured = { costs: [], durations: [], done: 0, notFound: 0, errored: 0, skipped: 0 };
  // Summed PER ROW before the median is taken. The median of a list of cells answers "what does a
  // cell cost", and the question is what a ROW costs — which on a multi-column run is the sum across
  // its columns.
  const perRow = new Map<number, number>();
  const perRowMs = new Map<number, number>();
  for (const c of cells) {
    if (c.status === "done") m.done++;
    else if (c.status === "not_found") m.notFound++;
    else if (c.status === "error") m.errored++;
    else m.skipped++;
    if (!perRow.has(c.row_id)) {
      // Attempts first, and the cell's own figure only where this run recorded none — never both,
      // which on a retried paid cell would count the final attempt twice.
      perRow.set(c.row_id, attemptCost.get(c.row_id) ?? Number(c.cost_usd));
      perRowMs.set(c.row_id, attemptMs.get(c.row_id) ?? Number(c.duration_ms));
    }
  }
  m.costs = [...perRow.values()];
  m.durations = [...perRowMs.values()].filter((ms) => ms > 0);

  // The run's own running total, not a re-derivation of it. `runs.cost_usd` is what the budget check
  // reads before every cell, so a "spent" figure on this screen that disagreed with it would be two
  // answers to a question with one.
  const spent = Number(run.cost_usd ?? 0) || m.costs.reduce((a, b) => a + b, 0);
  const sortedCosts = [...m.costs].sort((a, b) => a - b);
  const sortedMs = [...m.durations].sort((a, b) => a - b);

  const finished = m.done + m.notFound + m.errored;
  const failureRate = finished > 0 ? m.errored / finished : 0;

  // `not_found` is NOT a failure here. A column asking a question with no answer for that row did its
  // job, cost money doing it, and will do the same on the rows that come after — counting it as
  // broken would suppress the projection on exactly the columns whose cost is worth knowing.
  const usable = m.done + m.notFound;

  const columns = (scopeJson.resolvedColumnIds ?? [])
    .map((id: number) => getColumn(String(id)))
    .filter((c: Column | null): c is Column => !!c);
  const free =
    columns.length > 0 &&
    columns.every(
      (c: Column) =>
        (c.kind !== "ai" && c.kind !== "agent" && c.kind !== "http" && c.kind !== "mcp") ||
        ((c.kind === "ai" || c.kind === "agent") && isLocalModel(c.model ?? "")),
    );

  const rowsSampled = perRow.size;
  const ofRows = Number(scopeJson.sampleOfRows ?? rowsSampled);
  const remainingRows = Math.max(0, ofRows - rowsSampled);

  let projection: ForecastProjection | null = null;
  let whyNot: string | null = null;

  // Still going. Said before every other refusal, because the others are VERDICTS — "too few
  // answers" and "fix what is failing" are both false of a run that simply has not finished, and
  // they were being shown three seconds in, when nothing had failed and nothing was wrong.
  const stillRunning = run.status === "running" || run.status === "pending";

  if (stillRunning && usable < MIN_FOR_PROJECTION) {
    whyNot = "Still running. The figures fill in as rows finish.";
  } else if (usable < MIN_FOR_PROJECTION) {
    whyNot =
      `Only ${usable} of ${rowsSampled} sampled ${rowsSampled === 1 ? "row" : "rows"} produced an ` +
      `answer, which is too few to project from. Fix what is failing, then sample again.`;
  } else if (failureRate > FAILURE_RATE_LIMIT) {
    whyNot =
      `${Math.round(failureRate * 100)}% of the sample errored. The number worth acting on is that ` +
      "one, not a cost — so no total is projected until the column works.";
  } else if (remainingRows === 0) {
    whyNot = "The sample covered every row in the selection, so there is nothing left to project.";
  } else {
    projection = {
      remainingRows,
      low: percentile(sortedCosts, 25) * remainingRows,
      likely: median(sortedCosts) * remainingRows,
      high: tail(sortedCosts) * remainingRows,
    };
  }

  return {
    runId,
    sheetId: String(run.sheet_id),
    cells: cells.length,
    rowsSampled,
    ofRows,
    done: m.done,
    notFound: m.notFound,
    errored: m.errored,
    skipped: m.skipped,
    failureRate,
    spent,
    perRow: {
      min: sortedCosts[0] ?? 0,
      median: median(sortedCosts),
      p90: tail(sortedCosts),
      max: sortedCosts[sortedCosts.length - 1] ?? 0,
    },
    medianMs: median(sortedMs),
    projection,
    whyNot,
    estimatedPerRow: null,
    estimateRatio: null,
    free,
  };
}

/**
 * The forecast, with the arithmetic estimate attached for comparison.
 *
 * Separate and async because pricing a column can reach the catalogue over the network, and the
 * measured half of this must stay a pure synchronous read — it is the half that is true.
 */
export async function forecastWithEstimate(runId: string): Promise<Forecast | null> {
  const f = forecast(runId);
  if (!f) return null;

  const run = db.prepare("SELECT scope_json FROM runs WHERE id = ?").get(runId) as any;
  let ids: number[] = [];
  try { ids = JSON.parse(run?.scope_json ?? "{}").resolvedColumnIds ?? []; } catch { ids = []; }
  const columns = ids.map((id) => getColumn(String(id))).filter((c): c is Column => !!c);
  if (columns.length === 0) return f;

  try {
    const est = await estimateRun(columns, 1);
    if (!est.incomplete) {
      f.estimatedPerRow = est.total;
      // Guarded against dividing by an estimate of zero, which is what a free lane legitimately
      // estimates at — and where a ratio would be Infinity rather than a fact.
      f.estimateRatio = est.total > 0 ? f.perRow.median / est.total : null;
    }
  } catch {
    // A price sheet that could not be read leaves the comparison off. The measured numbers do not
    // depend on it and are the ones being reported.
  }
  return f;
}
