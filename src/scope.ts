// Run scoping — which rows a run actually touches.
//
// This is the most expensive decision in the product, so it is deliberately explicit and always
// resolved on the server. The rule: a scope is a DESCRIPTION ("the rows matching this view"), never
// a list of ids from the browser. A client that sends ids can only ever send the rows it has
// loaded — which on a million-row table is the ~2,000 it has scrolled past. Acting on those and
// calling it "all filtered rows" is the bug that quietly under-runs a job; the inverse, ignoring the
// filter and running everything, is the bug that empties a quota.
//
// Every scope compiles to the SAME predicate the grid uses, so what you see is what you spend on.

import { db } from "./db.ts";
import { compileFilter, describeFilter, escapeLike, type FilterGroup } from "./filter.ts";
import { SEARCH_PREDICATE } from "./store.ts";
import type { ValueType } from "./types.ts";

export interface RunScope {
  /** Columns to run. Empty means every runnable column in the table. */
  columnIds?: number[];
  /** Explicit rows — used by "run this row" and "run selected". */
  rowIds?: number[];
  /** Resolve through a saved view's filter. This is how "run only the visible rows" works. */
  viewId?: number;
  /** An ad-hoc filter (the unsaved state of the filter bar). */
  filter?: FilterGroup;
  /** The toolbar's free-text search. Present so a run over a searched grid covers what is on screen
   *  rather than the whole sheet — the grid narrowing and the run narrowing must agree. */
  search?: string;
  /** Only rows whose cell in the target column has one of these statuses. */
  statuses?: string[];
  /**
   * Only the rows a cheap first model did not settle.
   *
   * The complement of "answered and sure", among cells that have actually RUN. A never-run cell is
   * not unsure — it is unstarted, and sweeping those in would turn "check the doubtful ones" into
   * "run the whole column", which is the difference between a small deliberate spend and the bill
   * this whole feature exists to avoid.
   *
   * Paired with `useStrongModel` by the action that offers it, but kept separate: selecting rows and
   * choosing which model runs on them are two decisions, and one day someone will want to re-check
   * the doubtful rows on the cheap model after editing the prompt.
   */
  unsure?: boolean;
  /** Cap: "run the first N rows". Applied AFTER filtering, in position order. */
  limit?: number;
  /** 1-based, matching the number on the row gutter. Inclusive. */
  fromRow?: number;
  /** 1-based and inclusive. Combined with `fromRow` this is "rows X to Y". */
  toRow?: number;
  /** Ignore the input-hash skip and recompute even unchanged cells. */
  force?: boolean;
  /**
   * Skip the column's cheap first model and use the model it is configured with.
   *
   * The ONLY door to a paid model on a two-model column. It exists so that spending is something the
   * user asks for by starting this run, having been shown what it costs — never something the engine
   * decides on their behalf when a cheap answer looked shaky.
   */
  useStrongModel?: boolean;
}

// Numbers in the summary are formatted "en-US" explicitly rather than with the machine's locale.
// Node picks up the OS locale, and on this machine that made the confirm dialog read
// "10,00,000 rows" — Indian digit grouping — beside a grid that says "1,000,000". Two different
// renderings of the same number in the same dialog reads as a bug in the count itself.
export interface ResolvedScope {
  /** SQL selecting the target row ids, with `r` bound to `rows`. */
  sql: string;
  params: Array<string | number>;
  rowCount: number;
  columnIds: number[];
  /** Plain-English description for the confirm dialog — the user should never approve a spend they
   *  cannot read back. */
  summary: string;
}

/**
 * A row bound, or nothing — and never a silently discarded one.
 *
 * Every bound in a scope makes a run SMALLER, so a bound that fails to parse must not evaporate: it
 * evaporating is how "run rows 500 to 900" became a run over all 1,000,000. Reproduced three ways on
 * a scratch engine, all from a single non-numeric `fromRow`:
 *
 *   fromRow "abc"              → no OFFSET, no LIMIT: 20 of 20 rows, summarised "from row NaN onwards"
 *   fromRow "abc", toRow 10    → `LIMIT NaN`, which SQLite rejects as `no such column: NaN` (a 500)
 *   fromRow Infinity           → `OFFSET Infinity`, same failure
 *
 * The first is the expensive one: on a paid lane a vanished bound is a bill for the whole sheet. So
 * anything present and unusable is REFUSED here, where the message can name the field, rather than
 * widening the run or reaching SQL as a syntax error.
 */
function rowBound(value: unknown, field: string): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    // The received value is echoed as text rather than through JSON.stringify, which renders both
    // NaN and Infinity as the literal "null" and would describe two different mistakes identically.
    throw new Error(`"${field}" has to be a whole number of rows, not ${JSON.stringify(String(value)).slice(0, 60)}.`);
  }
  // Clamped so the number can only ever render as digits. Past 1e21 `String()` switches to
  // exponential form, and `LIMIT 1e+21` is not something to discover from SQLite at run time.
  return Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER);
}

function columnTypes(sheetId: string): Map<number, ValueType> {
  const m = new Map<number, ValueType>();
  for (const r of db.prepare("SELECT id, value_type FROM columns WHERE sheet_id = ? AND deleted_at IS NULL").all(sheetId) as any[]) {
    m.set(Number(r.id), r.value_type as ValueType);
  }
  return m;
}

function columnNames(sheetId: string): Map<number, string> {
  const m = new Map<number, string>();
  for (const r of db.prepare("SELECT id, name FROM columns WHERE sheet_id = ? AND deleted_at IS NULL").all(sheetId) as any[]) {
    m.set(Number(r.id), r.name);
  }
  return m;
}

/** Columns that actually execute. A static column has nothing to run. */
export function runnableColumns(sheetId: string): number[] {
  return (
    db
      .prepare("SELECT id FROM columns WHERE sheet_id = ? AND kind <> 'static' AND deleted_at IS NULL ORDER BY position")
      .all(sheetId) as any[]
  ).map((r) => Number(r.id));
}

export function resolveScope(sheetId: string, scope: RunScope): ResolvedScope {
  const types = columnTypes(sheetId);
  const names = columnNames(sheetId);

  // Validate requested columns against the table, so a stale or hostile id cannot widen a run.
  const requested = scope.columnIds?.map(Number).filter((id) => names.has(id)) ?? [];
  const columnIds = requested.length > 0 ? requested : runnableColumns(sheetId);

  const where: string[] = ["r.sheet_id = ?"];
  const params: Array<string | number> = [sheetId];
  const summaryParts: string[] = [];

  // 1. Explicit rows win: "run this row" / "run selected rows".
  if (scope.rowIds && scope.rowIds.length > 0) {
    const ids = scope.rowIds.map(Number).filter(Number.isInteger);
    where.push(`r.id IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
    summaryParts.push(ids.length === 1 ? "1 selected row" : `${ids.length.toLocaleString("en-US")} selected rows`);
  } else {
    // 2. Otherwise a filter — from a saved view, or the unsaved filter bar.
    let filter: FilterGroup | null = scope.filter ?? null;
    let viewName: string | null = null;

    if (scope.viewId != null) {
      const v = db.prepare("SELECT name, filter_json FROM views WHERE id = ? AND sheet_id = ?")
        .get(Number(scope.viewId), sheetId) as any;

      // A view that is not there is REFUSED rather than fallen through. `v` undefined leaves
      // `filter` null, which is no narrowing, which is every row, and the summary then says "every
      // row" with no mention of the view at all. So "run this saved view" on a view someone had
      // since deleted ran the entire sheet, and the confirmation gave no hint that the thing being
      // asked for had gone missing. The realistic route in is two tabs, or two people.
      if (!v) {
        throw new Error(
          "This run was not started, because that saved view no longer exists. Running it anyway " +
            "would have covered every row rather than the view's. Pick a view that is still there.",
        );
      }

      viewName = v.name;
      try {
        filter = JSON.parse(v.filter_json) as FilterGroup;
      } catch {
        // Same trade again: unreadable stored filter → no filter → the whole table. On a paid lane
        // the difference between a view's 400 rows and a sheet's million is the entire bill.
        throw new Error(
          `This run was not started, because the saved filter on "${String(v.name)}" could not be ` +
            "read. Running it anyway would have covered every row rather than the view's. Open the " +
            "view, set its filter again, and save it.",
        );
      }
    }

    const compiled = compileFilter(filter, types);

    // A filter the engine could not fully understand is REFUSED, never quietly ignored.
    //
    // Same shape of bug as a vanished row bound, and the same reasoning: every condition makes a run
    // SMALLER, so a condition that disappears makes it BIGGER — and all of them disappearing leaves
    // no WHERE clause at all, which means every row. Measured on a 30-row sheet with one condition
    // the compiler did not recognise: 10 rows became 30, summarised as "every row", so the
    // confirmation dialog was internally consistent and had nothing to do with what was asked for.
    // On a paid lane that is the whole table billed.
    //
    // The grid does NOT do this — there, dropping a condition on a since-deleted column and showing
    // more rows is the better failure. The difference is that the grid does not spend money.
    if (compiled.dropped.length > 0) {
      throw new Error(
        `This run was not started, because part of the filter could not be applied: ` +
          `${compiled.dropped.join("; ")}. Running it anyway would have covered every row rather ` +
          `than the ones you filtered to. Fix or clear the filter and try again.`,
      );
    }

    if (compiled.sql) {
      where.push(`(${compiled.sql})`);
      params.push(...compiled.params);
      summaryParts.push(
        viewName
          ? `rows in "${viewName}" (${describeFilter(filter, names)})`
          : `rows where ${describeFilter(filter, names)}`,
      );
    } else {
      summaryParts.push("every row");
    }
  }

  // 2b. Free-text search, matched against every column exactly as the grid matches it — the SAME
  // predicate, imported rather than restated, because a copy that drifts is a run that spends on
  // rows the grid never showed. (It already had: the grid's copy and this one both matched cells of
  // soft-deleted columns, so a search returned rows with no visible match.)
  const search = (scope.search ?? "").trim();
  if (search) {
    where.push(SEARCH_PREDICATE);
    params.push(`%${escapeLike(search)}%`);
    summaryParts.push(`matching "${search}"`);
  }

  // 3. Status narrowing — "run empty cells only", "retry errors only".
  if (scope.statuses && scope.statuses.length > 0) {
    const holes = scope.statuses.map(() => "?").join(",");
    const colHoles = columnIds.map(() => "?").join(",");
    where.push(
      `EXISTS (SELECT 1 FROM cells c WHERE c.row_id = r.id AND c.column_id IN (${colHoles}) AND c.status IN (${holes}))`,
    );
    params.push(...columnIds, ...scope.statuses);
    summaryParts.push(`where the cell is ${scope.statuses.join(" or ")}`);
  }

  // 3b. The rows a cheap first model did not settle: it ran, and it did not come back a confident
  // answer. `status IN (...)` is what keeps never-run rows out — see RunScope.unsure.
  if (scope.unsure) {
    const colHoles = columnIds.map(() => "?").join(",");
    where.push(
      `EXISTS (SELECT 1 FROM cells c
                WHERE c.row_id = r.id AND c.column_id IN (${colHoles})
                  AND c.status IN ('done','not_found','error')
                  -- COALESCE, not a bare comparison. Comparing a NULL confidence yields NULL, and
                  -- NOT NULL is NULL, so SQLite drops the row — which meant the cells where the
                  -- model answered off-schema and said nothing about how sure it was, the single
                  -- most doubtful state there is, were the ones being silently left out.
                  AND NOT (c.status = 'done' AND COALESCE(c.confidence, '') = 'high'))`,
    );
    params.push(...columnIds);
    summaryParts.push("where the cheap model was not sure");
  }

  let sql = `SELECT r.id FROM rows r WHERE ${where.join(" AND ")} ORDER BY r.position`;

  // 4. A row RANGE — "start at row 500", "rows 500 to 900", "200 rows from row 500".
  //
  // Expressed in the numbers on the row gutter, which are 1-based, and translated to a 0-based
  // OFFSET here. Off-by-one in either direction silently runs the wrong row, and on a paid lane a
  // silently-wrong row is a silently-wrong charge.
  //
  // OFFSET is acceptable here where it is not on the grid's read path: this runs ONCE per run, not
  // on every scroll, and the alternative — filtering on r.position — is wrong after any row has been
  // deleted, because position is no longer the same as the number the user is reading off the
  // gutter.
  const hasRange = scope.fromRow != null || scope.toRow != null;
  const fromRow = rowBound(scope.fromRow, "fromRow");
  const toRow = rowBound(scope.toRow, "toRow");
  const askedLimit = rowBound(scope.limit, "limit");

  const from = Math.max(1, fromRow ?? 1);
  const to = toRow != null && toRow > 0 ? toRow : null;

  // A limit and an explicit end row both bound the run; the tighter one wins, so asking for
  // "rows 500 to 900" and separately capping at 50 gets 50 rather than the two quietly contradicting
  // each other.
  const asked = askedLimit != null && askedLimit > 0 ? askedLimit : null;
  const span = to != null ? Math.max(0, to - from + 1) : null;
  const limit =
    asked != null && span != null ? Math.min(asked, span)
    : asked ?? span;

  if (limit != null) {
    sql += ` LIMIT ${limit}`;
  } else if (from > 1) {
    // SQLite requires a LIMIT before OFFSET; -1 is the documented way to write an offset with none.
    sql += ` LIMIT -1`;
  }
  if (from > 1) sql += ` OFFSET ${from - 1}`;

  // The summary is derived from the EFFECTIVE bounds, not from what was asked for.
  //
  // These two disagree whenever a cap is tighter than a range, and the summary is the sentence the
  // user reads in the confirm dialog before approving a spend. Saying "rows 500 to 900" over a run
  // that will touch 50 of them is exactly the kind of quiet inaccuracy that makes the dialog worth
  // less than no dialog.
  const end = limit != null ? from + limit - 1 : null;
  if (hasRange && end != null && end > from) {
    summaryParts.push(`rows ${from.toLocaleString("en-US")} to ${end.toLocaleString("en-US")}`);
  } else if (hasRange && end != null) {
    summaryParts.push(`row ${from.toLocaleString("en-US")} only`);
  } else if (hasRange) {
    summaryParts.push(`from row ${from.toLocaleString("en-US")} onwards`);
  } else if (limit != null) {
    summaryParts.push(`capped at the first ${limit.toLocaleString("en-US")}`);
  }

  // Count through the identical predicate. Deriving the count any other way is how a confirm dialog
  // ends up disagreeing with what the run actually does.
  const countSql = `SELECT COUNT(*) AS c FROM (${sql})`;
  const rowCount = Number((db.prepare(countSql).get(...params) as any).c);

  const colLabel =
    columnIds.length === 1
      ? `"${names.get(columnIds[0]!) ?? "column"}"`
      : `${columnIds.length} columns`;

  return {
    sql,
    params,
    rowCount,
    columnIds,
    summary: `Run ${colLabel} on ${rowCount.toLocaleString("en-US")} ${rowCount === 1 ? "row" : "rows"} — ${summaryParts.join(", ")}.`,
  };
}

/**
 * Stream the scope's row ids in batches.
 *
 * Enqueuing a million-row run must not build a million-element array in memory first, so jobs are
 * inserted in chunks as the ids arrive.
 *
 * `iterate`, not `all` — which is what this said it did and did not do. `all()` materializes the
 * entire result set before the first batch is handed over, so the one property this function exists
 * for was the one it did not have.
 */
export function forEachScopedRow(
  resolved: ResolvedScope,
  batchSize: number,
  fn: (rowIds: number[]) => void,
): void {
  const rows = db.prepare(resolved.sql).iterate(...resolved.params) as Iterable<{ id: number }>;
  let batch: number[] = [];
  for (const r of rows) {
    batch.push(Number(r.id));
    if (batch.length >= batchSize) { fn(batch); batch = []; }
  }
  if (batch.length > 0) fn(batch);
}
