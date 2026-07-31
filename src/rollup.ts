// Rollup columns — a number about ALL the rows on the other side of a link.
//
// The mirror of a lookup. A lookup answers "what is my company's industry"; a rollup answers "how
// many contacts does this company have", "what is the total pipeline on this account", "when did we
// last speak to anyone there". One row here, many rows over there, collapsed to one value.
//
// Free, for the same reason a lookup is: it is a GROUP BY over an index, not a model call. That
// matters more here than it looks, because the alternative people actually reach for is asking a
// model to count things, which is both expensive and — for counting — unreliable in a way that is
// very hard to notice.
//
// ── Two decisions worth stating ────────────────────────────────────────────────────────────────
//
// NON-NUMERIC VALUES ARE IGNORED, NOT COUNTED AS ZERO. SQLite's own `CAST('n/a' AS REAL)` is 0.0, so
// summing a column where a tenth of the rows say "unknown" would silently produce a total that is
// too low and an average that is far too low, with nothing anywhere saying so. `cc_rollup_num`
// returns NULL for anything that is not a number, and SQL aggregates skip NULLs — so those rows are
// left out of the calculation rather than quietly dragging it down.
//
// AN EMPTY GROUP IS NOT THE SAME ANSWER FOR EVERY FUNCTION. A company with no contacts genuinely HAS
// zero contacts, so `count` is 0 and that is a real answer. But the earliest date among no dates does
// not exist, and reporting 0 for it would be a fabricated fact. So count and sum answer 0; min, max,
// average and list answer `not_found`.

import { db, tx, cellId } from "./db.ts";
import { emitColumnStats, markCellsDirty } from "./bus.ts";
import { markColumnDirty, refreshColumnStats } from "./columnStats.ts";
import { getRelation, type Relation } from "./relations.ts";
import { listColumns } from "./store.ts";

const BATCH = 5000;

export type RollupFn = "count" | "sum" | "min" | "max" | "avg" | "list";

export const ROLLUP_FNS: RollupFn[] = ["count", "sum", "min", "max", "avg", "list"];

/** How each calculation is named on screen, so an error can use the words the user chose. */
const FN_LABEL: Record<RollupFn, string> = {
  count: "Counting rows",
  sum: "A total",
  min: "A smallest value",
  max: "A largest value",
  avg: "An average",
  list: "Joining the values",
};

/** `count` is the only one that needs no field — it is about the rows, not about a value in them. */
const NEEDS_FIELD = new Set<RollupFn>(["sum", "min", "max", "avg", "list"]);

/** The ones where "no matching rows" has a true numeric answer rather than no answer at all. */
const ZERO_ON_EMPTY = new Set<RollupFn>(["count", "sum"]);

const isFn = (v: unknown): v is RollupFn => ROLLUP_FNS.includes(v as RollupFn);

export class RollupError extends Error {}

export interface RollupConfig {
  relation: Relation;
  /** Which end this column sits on. It aggregates the OTHER end. */
  side: "from" | "to";
  fn: RollupFn;
  /** Null only for `count`. */
  sourceColumnId: number | null;
  /** For `list`. Comma-and-space, because the result is read by a person far more often than parsed. */
  separator: string;
}

/**
 * `Number()` as a SQL function, with non-numbers becoming NULL rather than zero.
 *
 * Registered rather than expressed in SQL because SQLite has no "is this a number" that is both
 * correct and readable, and the wrong answer here is invisible: a sum quietly missing a tenth of its
 * value looks exactly like a sum.
 */
let numFnReady = false;
function ensureNumFunction(): void {
  if (numFnReady) return;
  (db as unknown as { function: (n: string, o: object, f: (...a: any[]) => unknown) => void })
    .function("cc_rollup_num", { deterministic: true }, (v: string | null) => {
      if (v == null) return null;
      // Currency and thousands separators are how these values actually arrive from a CSV or a
      // model: "$1,200" is a number a person wrote, and refusing it would make sum useless on real
      // data. A bare "-" or "n/a" still becomes NULL.
      const cleaned = String(v).replace(/[^0-9.eE+-]/g, "");
      if (!cleaned || !/\d/.test(cleaned)) return null;
      const n = Number(cleaned);
      return Number.isFinite(n) ? n : null;
    });

  /**
   * A number written the way a person writes it.
   *
   * SQLite's `CAST(1300.0 AS TEXT)` is "1300.0", so a total of thirteen hundred pounds rendered as
   * "1300.0" and a count-like sum looked like a measurement. Worse, it lands in a cell that other
   * columns read and that gets exported — so the stray decimal travels. Whole numbers print whole;
   * fractions keep up to four places and lose trailing zeros, which is enough for money and for
   * averages without turning 1/3 into a wall of digits.
   */
  (db as unknown as { function: (n: string, o: object, f: (...a: any[]) => unknown) => void })
    .function("cc_rollup_fmt", { deterministic: true }, (v: number | null) => {
      if (v == null || !Number.isFinite(Number(v))) return null;
      const n = Number(v);
      if (Number.isInteger(n)) return String(n);
      return String(Number(n.toFixed(4)));
    });
  numFnReady = true;
}

/**
 * What a rollup column is configured to do, or why it cannot run.
 *
 * Resolved as one object and thrown as one error, for the same reason as the lookup: every degraded
 * outcome writes a plausible number into a cell, and a wrong number is worse than a blank because
 * nothing about it invites checking.
 */
export function rollupConfig(columnId: number): RollupConfig {
  const col = db
    .prepare("SELECT sheet_id, relation_id, lookup_column_id, rollup FROM columns WHERE id = ? AND deleted_at IS NULL")
    .get(Number(columnId)) as any;
  if (!col) throw new RollupError("That column no longer exists.");
  if (!col.relation_id) throw new RollupError("This column is not linked to another table yet.");

  let parsed: any = {};
  try { parsed = col.rollup ? JSON.parse(String(col.rollup)) : {}; } catch { parsed = {}; }
  const fn: RollupFn | null = isFn(parsed.fn) ? parsed.fn : null;
  if (!fn) throw new RollupError("This column has no calculation chosen yet.");

  const relation = getRelation(Number(col.relation_id));
  if (!relation) throw new RollupError("The link this column used has been removed.");

  const sheetId = String(col.sheet_id);
  const side: "from" | "to" =
    sheetId === relation.fromSheetId ? "from"
    : sheetId === relation.toSheetId ? "to"
    : (() => { throw new RollupError("That link does not involve this table."); })();

  let sourceColumnId: number | null = null;
  if (NEEDS_FIELD.has(fn)) {
    // Named the way the screen names it, not the way the code does. "A avg needs a field" is both
    // ungrammatical and a word the user never chose — they picked "Average".
    if (!col.lookup_column_id) {
      throw new RollupError(`${FN_LABEL[fn]} needs a field on the other table to work on.`);
    }
    const otherSheet = side === "from" ? relation.toSheetId : relation.fromSheetId;
    const source = listColumns(otherSheet).find((c) => Number(c.id) === Number(col.lookup_column_id));
    if (!source) throw new RollupError("The field this column adds up has been deleted from the other table.");
    sourceColumnId = Number(source.id);
  }

  return {
    relation,
    side,
    fn,
    sourceColumnId,
    separator: typeof parsed.separator === "string" && parsed.separator ? parsed.separator : ", ",
  };
}

/** Save a rollup's calculation, refusing a combination that could not run. */
export function setRollup(
  columnId: number,
  relationId: number,
  fn: RollupFn,
  sourceColumnId: number | null,
  separator?: string,
): RollupConfig {
  const before = db
    .prepare("SELECT relation_id, lookup_column_id, rollup FROM columns WHERE id = ?")
    .get(Number(columnId)) as any;
  if (!before) throw new RollupError("That column no longer exists.");

  db.prepare("UPDATE columns SET relation_id = ?, lookup_column_id = ?, rollup = ?, updated_at = datetime('now') WHERE id = ?")
    .run(
      Number(relationId),
      sourceColumnId == null ? null : Number(sourceColumnId),
      JSON.stringify({ fn, separator: separator ?? ", " }),
      Number(columnId),
    );
  try {
    return rollupConfig(Number(columnId));
  } catch (e) {
    // Rolled back rather than left half-applied: a column pointed at an impossible calculation still
    // runs, and writes numbers.
    db.prepare("UPDATE columns SET relation_id = ?, lookup_column_id = ?, rollup = ? WHERE id = ?")
      .run(before.relation_id ?? null, before.lookup_column_id ?? null, before.rollup ?? null, Number(columnId));
    throw e;
  }
}

/**
 * The aggregate expression, and what "no matching rows" means for it.
 *
 * `list` uses GROUP_CONCAT over the raw text; the others go through `cc_rollup_num` so a stray
 * "unknown" is skipped rather than counted as zero. `min`/`max` are numeric here deliberately —
 * lexical ordering would put "9" after "10", which is the kind of wrong that survives a glance.
 */
function aggregateSql(fn: RollupFn): string {
  switch (fn) {
    case "count": return "COUNT(*)";
    case "sum":   return "SUM(cc_rollup_num(tc.value_text))";
    case "min":   return "MIN(cc_rollup_num(tc.value_text))";
    case "max":   return "MAX(cc_rollup_num(tc.value_text))";
    case "avg":   return "AVG(cc_rollup_num(tc.value_text))";
    case "list":  return "GROUP_CONCAT(tc.value_text, ?)";
  }
}

/**
 * Recompute a rollup column over a whole sheet, or over specific rows.
 *
 * Set-based and batched, exactly like the lookup: one statement per batch, driven by the
 * `relation_keys` index, so nothing is loaded into JavaScript and this stays viable on a table with
 * a million rows on either side.
 */
export function refreshRollupColumn(sheetId: string, columnId: number, rowIds?: number[]): number {
  const cfg = rollupConfig(Number(columnId));
  const { relation, side, fn, sourceColumnId, separator } = cfg;
  const other: "from" | "to" = side === "from" ? "to" : "from";
  ensureNumFunction();

  // `count` needs no cell join at all — it is counting matched ROWS, and joining cells would
  // silently drop any row that has no cell for the column being counted.
  const join = fn === "count"
    ? ""
    : `JOIN cells tc ON tc.row_id = t.row_id AND tc.column_id = ${Number(sourceColumnId)}`;

  const agg = aggregateSql(fn);
  const value = `(
    SELECT ${agg}
      FROM relation_keys f
      JOIN relation_keys t
        ON t.relation_id = f.relation_id AND t.side = ? AND t.key = f.key
      ${join}
     WHERE f.relation_id = ? AND f.side = ? AND f.row_id = cells.row_id
  )`;
  const hasKey = `EXISTS (SELECT 1 FROM relation_keys f WHERE f.relation_id = ? AND f.side = ? AND f.row_id = cells.row_id)`;

  /** Bindings for one copy of `value`, in order. GROUP_CONCAT takes its separator first. */
  const valueParams = (): Array<string | number> =>
    fn === "list" ? [separator, other, relation.id, side] : [other, relation.id, side];

  let processed = 0;
  const applyBatch = (rows: number[]): number => {
    if (rows.length === 0) return 0;
    const marks = rows.map(() => "?").join(",");
    const dirty: string[] = [];

    tx(() => {
      db.prepare(
        `INSERT OR IGNORE INTO cells (row_id, column_id, status)
         SELECT r.id, ?, 'empty' FROM rows r WHERE r.id IN (${marks})`,
      ).run(Number(columnId), ...rows);

      /**
       * One statement: group, calculate, write.
       *
       * The status arm is the interesting half. A row with no key was never asked the question, so
       * it is `empty`. A row WITH a key and no matching rows is `done` with 0 for a count or a sum —
       * a company with no contacts has zero contacts — and `not_found` for min/max/average/list,
       * where zero would be a fabricated fact rather than an answer.
       */
      const zeroOnEmpty = ZERO_ON_EMPTY.has(fn);
      db.prepare(
        `UPDATE cells
            SET value_text = CASE
                  WHEN NOT ${hasKey} THEN NULL
                  WHEN ${value} IS NULL THEN ${zeroOnEmpty ? "'0'" : "NULL"}
                  ELSE ${fn === "count" || fn === "list" ? `CAST(${value} AS TEXT)` : `cc_rollup_fmt(${value})`}
                END,
                value_json = NULL,
                status = CASE
                  WHEN NOT ${hasKey} THEN 'empty'
                  WHEN ${value} IS NULL THEN ${zeroOnEmpty ? "'done'" : "'not_found'"}
                  ELSE 'done'
                END,
                stale = 0,
                error_type = NULL,
                error_msg = NULL,
                rev = rev + 1,
                updated_at = datetime('now')
          WHERE column_id = ?
            AND pinned = 0
            AND row_id IN (${marks})`,
      ).run(
        // CASE arms are bound in source order: hasKey, value, value, then hasKey, value, value.
        relation.id, side,
        ...valueParams(),
        ...valueParams(),
        relation.id, side,
        ...valueParams(),
        Number(columnId), ...rows,
      );
      for (const id of rows) dirty.push(cellId(id, Number(columnId)));
    });

    markColumnDirty(Number(columnId));
    markCellsDirty(dirty);
    return rows.length;
  };

  if (rowIds && rowIds.length > 0) {
    for (let i = 0; i < rowIds.length; i += BATCH) processed += applyBatch(rowIds.slice(i, i + BATCH));
  } else {
    let lastId = 0;
    for (;;) {
      const rows = (db
        .prepare("SELECT id FROM rows WHERE sheet_id = ? AND id > ? ORDER BY id LIMIT ?")
        .all(sheetId, lastId, BATCH) as any[]).map((r) => Number(r.id));
      if (rows.length === 0) break;
      processed += applyBatch(rows);
      lastId = rows[rows.length - 1]!;
    }
  }

  try {
    emitColumnStats(refreshColumnStats([Number(columnId)], sheetId));
  } catch { /* a stats refresh must never break the write that triggered it */ }
  return processed;
}

/** Every rollup column, in any table, that aggregates through this relation. */
export function rollupColumnsFor(relationId: number): Array<{ id: number; sheetId: string }> {
  return (
    db
      .prepare("SELECT id, sheet_id FROM columns WHERE relation_id = ? AND kind = 'rollup' AND deleted_at IS NULL")
      .all(Number(relationId)) as any[]
  ).map((r) => ({ id: Number(r.id), sheetId: String(r.sheet_id) }));
}
