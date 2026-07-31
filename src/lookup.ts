// Lookup columns — reading a value from the row this row is linked to.
//
// The economics, which is the whole reason this lane exists: "Companies" has one row per company and
// "Contacts" has two thousand rows pointing at those companies. Enriching the industry ONCE on
// Companies and reading it from every contact is one unit of spend. Running the same prompt as a
// Contacts column is two thousand. So a lookup has to be free, and it has to be free at the scale
// where that difference matters.
//
// Which is why nothing here loads a row into JavaScript. The match, the read and the write are one
// SQL statement per batch, driven by the `relation_keys` index — the same shape dedupe had to move to
// when grouping a million values in a Map took 4.6 seconds on the engine's single thread and stopped
// the grid answering along with it.
//
// ── The three answers a lookup can give, and why they are three ────────────────────────────────
//
//   empty      — this row has nothing in its key column. There was never a question to answer.
//   not_found  — it has a key, and no row on the other side holds it. A real, informative answer.
//   done       — matched, and here is the value.
//
// Collapsing the first two into "blank" is the tempting simplification and it destroys the only
// diagnostic anyone has: "800 of my rows are empty" has completely different fixes depending on
// whether those rows lack a domain or lack a company. The filter operators already distinguish them.

import { db, tx, cellId } from "./db.ts";
import { emitColumnStats, markCellsDirty } from "./bus.ts";
import { markColumnDirty, refreshColumnStats } from "./columnStats.ts";
import { getRelation, rekeyRows, relationsKeyedOn, type Relation } from "./relations.ts";
import { listColumns } from "./store.ts";

/** Same batch size as the derived-column refresh, for the same reason: a bounded transaction. */
const BATCH = 5000;

export interface LookupConfig {
  relation: Relation;
  /** The column on the OTHER table whose value is copied in. */
  sourceColumnId: number;
  /**
   * Which direction this column reads.
   *
   * A relation is stored once and is useful from both ends: Contacts reads its company's industry
   * (`from` → `to`), and Companies could read something back off a contact. The side is a property
   * of the COLUMN, not of the link, so one link serves both without being defined twice.
   */
  side: "from" | "to";
}

export class LookupError extends Error {}

/**
 * What a lookup column is configured to do, or why it cannot run.
 *
 * Resolved up front and thrown as one error rather than degrading, because every degraded outcome
 * here writes plausible-looking values into cells. A lookup pointed at a deleted column that quietly
 * wrote blanks would read as "nothing matched" — the exact wrong diagnosis.
 */
export function lookupConfig(columnId: number): LookupConfig {
  const col = db
    .prepare("SELECT sheet_id, relation_id, lookup_column_id FROM columns WHERE id = ? AND deleted_at IS NULL")
    .get(Number(columnId)) as any;
  if (!col) throw new LookupError("That column no longer exists.");
  if (!col.relation_id) throw new LookupError("This column is not linked to another table yet.");
  if (!col.lookup_column_id) throw new LookupError("This column has no field chosen to read.");

  const relation = getRelation(Number(col.relation_id));
  if (!relation) throw new LookupError("The link this column used has been removed.");

  // The side is derived from where the column LIVES, so it cannot be set inconsistently with the
  // link. A column in the pointing table reads across to the other one, and vice versa.
  const sheetId = String(col.sheet_id);
  const side: "from" | "to" =
    sheetId === relation.fromSheetId ? "from"
    : sheetId === relation.toSheetId ? "to"
    : (() => { throw new LookupError("That link does not involve this table."); })();

  const otherSheet = side === "from" ? relation.toSheetId : relation.fromSheetId;
  const source = listColumns(otherSheet).find((c) => Number(c.id) === Number(col.lookup_column_id));
  if (!source) throw new LookupError("The field this column reads has been deleted from the other table.");

  return { relation, sourceColumnId: Number(source.id), side };
}

/**
 * Point a column at a link and a field, and refuse the combination if it cannot work.
 *
 * Validated by resolving it rather than by re-checking the same conditions here — one description of
 * what a valid lookup is, in `lookupConfig`, used both to save and to run. Two copies of that rule
 * would drift, and the way it would drift is a column that saves cleanly and then fails on every row.
 */
export function setLookup(columnId: number, relationId: number, sourceColumnId: number): LookupConfig {
  const before = db
    .prepare("SELECT relation_id, lookup_column_id FROM columns WHERE id = ?")
    .get(Number(columnId)) as any;
  if (!before) throw new LookupError("That column no longer exists.");

  db.prepare("UPDATE columns SET relation_id = ?, lookup_column_id = ?, updated_at = datetime('now') WHERE id = ?")
    .run(Number(relationId), Number(sourceColumnId), Number(columnId));
  try {
    return lookupConfig(Number(columnId));
  } catch (e) {
    // Put it back. A column left half-pointed at an invalid link is worse than one that never
    // changed: it runs, writes blanks, and reads as "nothing matched".
    db.prepare("UPDATE columns SET relation_id = ?, lookup_column_id = ? WHERE id = ?")
      .run(before.relation_id ?? null, before.lookup_column_id ?? null, Number(columnId));
    throw e;
  }
}

/**
 * Recompute a lookup column over a whole sheet, or over specific rows.
 *
 * Set-based and batched. `rowIds` is for the incremental path — when the other table changes, only
 * the rows that read the changed rows need redoing, and re-running a million of them because six
 * changed is the difference between a feature and a liability.
 */
export function refreshLookupColumn(sheetId: string, columnId: number, rowIds?: number[]): number {
  const cfg = lookupConfig(Number(columnId));
  const { relation, sourceColumnId, side } = cfg;
  const other: "from" | "to" = side === "from" ? "to" : "from";

  let processed = 0;

  const batches: number[][] = [];
  if (rowIds && rowIds.length > 0) {
    for (let i = 0; i < rowIds.length; i += BATCH) batches.push(rowIds.slice(i, i + BATCH));
  }

  const applyBatch = (rows: number[]): number => {
    if (rows.length === 0) return 0;

    const marks = rows.map(() => "?").join(",");
    const dirty: string[] = [];

    tx(() => {
      /**
       * Make sure there is a cell to write into.
       *
       * A cell row is not implied by a table row: `insertRows` only creates cells for the columns it
       * was handed, and `addColumn` backfills only the rows that existed when it ran. So any row that
       * arrived without this column in its list has no cell here, and an UPDATE would match nothing —
       * silently, leaving those rows blank while every count said the column had been run. Scoped to
       * the batch, and INSERT OR IGNORE, so it costs nothing where the cell already exists.
       */
      db.prepare(
        `INSERT OR IGNORE INTO cells (row_id, column_id, status)
         SELECT r.id, ?, 'empty' FROM rows r WHERE r.id IN (${marks})`,
      ).run(Number(columnId), ...rows);

      /**
       * One statement: match, read, write.
       *
       * The correlated subquery is an index seek on (relation_id, side, key) rather than a scan, so
       * this stays viable on the million-row table. `ORDER BY t.row_id LIMIT 1` makes the choice
       * DETERMINISTIC when a key hits several rows — the alternative is a value that changes between
       * two runs over unchanged data, which is indistinguishable from a bug. Which row it picks is
       * arbitrary; that it picks the same one every time is not. `relationHealth` counts these
       * separately so the ambiguity is reported rather than silently resolved.
       */
      db.prepare(
        `UPDATE cells
            SET value_text = (
                  SELECT tc.value_text
                    FROM relation_keys f
                    JOIN relation_keys t
                      ON t.relation_id = f.relation_id AND t.side = ? AND t.key = f.key
                    JOIN cells tc ON tc.row_id = t.row_id AND tc.column_id = ?
                   WHERE f.relation_id = ? AND f.side = ? AND f.row_id = cells.row_id
                   ORDER BY t.row_id LIMIT 1
                ),
                value_json = NULL,
                status = CASE
                  -- No key at all: there was never a question. Distinct from "asked and not found".
                  WHEN NOT EXISTS (
                    SELECT 1 FROM relation_keys f
                     WHERE f.relation_id = ? AND f.side = ? AND f.row_id = cells.row_id
                  ) THEN 'empty'
                  WHEN (
                    SELECT tc.value_text
                      FROM relation_keys f
                      JOIN relation_keys t
                        ON t.relation_id = f.relation_id AND t.side = ? AND t.key = f.key
                      JOIN cells tc ON tc.row_id = t.row_id AND tc.column_id = ?
                     WHERE f.relation_id = ? AND f.side = ? AND f.row_id = cells.row_id
                     ORDER BY t.row_id LIMIT 1
                  ) IS NULL THEN 'not_found'
                  ELSE 'done'
                END,
                -- Freshly computed by definition, so it cannot still be out of date.
                stale = 0,
                error_type = NULL,
                error_msg = NULL,
                rev = rev + 1,
                updated_at = datetime('now')
          WHERE column_id = ?
            AND pinned = 0
            AND row_id IN (${marks})`,
      ).run(
        other, sourceColumnId, relation.id, side,
        relation.id, side,
        other, sourceColumnId, relation.id, side,
        Number(columnId), ...rows,
      );
      for (const id of rows) dirty.push(cellId(id, Number(columnId)));
    });

    markColumnDirty(Number(columnId));
    markCellsDirty(dirty);
    return rows.length;
  };

  if (batches.length > 0) {
    for (const b of batches) processed += applyBatch(b);
    return processed;
  }

  let lastId = 0;
  for (;;) {
    const rows = (db
      .prepare("SELECT id FROM rows WHERE sheet_id = ? AND id > ? ORDER BY id LIMIT ?")
      .all(sheetId, lastId, BATCH) as any[]).map((r) => Number(r.id));
    if (rows.length === 0) break;
    processed += applyBatch(rows);
    lastId = rows[rows.length - 1]!;
  }
  return processed;
}

/** Every lookup column, in any table, that reads through this relation. */
export function lookupColumnsFor(relationId: number): Array<{ id: number; sheetId: string }> {
  // Filtered by kind. Rollups also carry `relation_id`, and handing one to `refreshLookupColumn`
  // would throw on a column that is perfectly well configured — as a rollup.
  return (
    db
      .prepare("SELECT id, sheet_id FROM columns WHERE relation_id = ? AND kind = 'lookup' AND deleted_at IS NULL")
      .all(Number(relationId)) as any[]
  ).map((r) => ({ id: Number(r.id), sheetId: String(r.sheet_id) }));
}

/** Both kinds that read through a link, since both go stale for the same reasons. */
function readersThrough(relationId: number): Array<{ id: number; sheetId: string }> {
  return (
    db
      .prepare(
        `SELECT id, sheet_id FROM columns
          WHERE relation_id = ? AND kind IN ('lookup','rollup') AND deleted_at IS NULL`,
      )
      .all(Number(relationId)) as any[]
  ).map((r) => ({ id: Number(r.id), sheetId: String(r.sheet_id) }));
}

/**
 * Keep every relation honest after a write, and flag what now reads an old answer.
 *
 * Called from the same place — and inside the same transaction — as the ordinary stale cascade, so a
 * lookup can never be briefly readable as fresh against a value that has already changed.
 *
 * Two entirely different things can have happened, and both have to be handled or a relation rots
 * quietly:
 *
 *   THE KEY COLUMN CHANGED. A contact's domain was corrected, so the index now points at the wrong
 *   company for that row. Re-key it, then mark that row's lookups out of date — they were computed
 *   against the old key. Without this the match is simply wrong from then on, and nothing says so.
 *
 *   THE VALUE BEING READ CHANGED. A company's industry was re-run, so every contact pointing at that
 *   company is holding last week's answer. Those readers are found through the key index rather than
 *   by scanning the other table, which is the whole reason the index is materialized.
 *
 * Marked stale rather than recomputed. Recomputing here would do unbounded work inside somebody
 * else's transaction — one company can have a hundred thousand contacts — and "out of date" is
 * already a first-class state the grid shows, the filters target and a re-run clears.
 */
export function noteRelationChange(sheetId: string, columnId: number, rowIds: number[]): void {
  if (rowIds.length === 0) return;

  // (a) This column is one side's key.
  for (const { relation, side } of relationsKeyedOn(Number(columnId))) {
    /**
     * The rows on the OTHER side this row belonged to BEFORE the key moved.
     *
     * A contact moving from Acme to Globex changes two answers over there, not one: Acme's count is
     * now too high and Globex's too low. After `rekeyRows` the old key is gone and Acme is
     * unreachable — so this is the only moment it can be recorded. Without it, a row LEAVING a group
     * leaves that group's total wrong, which is the hardest kind of wrong to spot, because nothing
     * about the number visibly changed.
     */
    const readersBefore = readersOf(relation.id, side, rowIds);

    rekeyRows(relation.id, side, rowIds);

    // The rows whose key moved now hold a value computed against the key they used to have.
    for (const col of readersThrough(relation.id)) {
      if (col.sheetId === sheetId) markLookupStale(col.id, col.sheetId, rowIds);
    }

    // …and on the other side, both the group it left and the group it joined.
    const touched = [...new Set([...readersBefore, ...readersOf(relation.id, side, rowIds)])];
    for (const col of readersThrough(relation.id)) {
      if (col.sheetId !== sheetId) markLookupStale(col.id, col.sheetId, touched);
    }
  }

  // (b) This column is the value a lookup reads, or the one a rollup adds up.
  for (const r of db
    .prepare(
      `SELECT id, sheet_id, relation_id FROM columns
        WHERE lookup_column_id = ? AND relation_id IS NOT NULL
          AND kind IN ('lookup','rollup') AND deleted_at IS NULL`,
    )
    .all(Number(columnId)) as any[]) {
    const relation = getRelation(Number(r.relation_id));
    if (!relation) continue;
    // Which end the READER sits on decides which end just changed.
    const readerSide: "from" | "to" = String(r.sheet_id) === relation.fromSheetId ? "from" : "to";
    const changedSide: "from" | "to" = readerSide === "from" ? "to" : "from";
    markLookupStale(Number(r.id), String(r.sheet_id), readersOf(relation.id, changedSide, rowIds));
  }
}

/**
 * How many stale cells are worth streaming individually.
 *
 * The same reasoning and the same number as the ordinary cascade: past this, the column-level
 * counter is the useful signal and per-cell deltas are just traffic.
 */
const BROADCAST_LIMIT = 2000;

/** Flag specific cells of one lookup column as out of date. Same rules as the ordinary cascade. */
function markLookupStale(columnId: number, sheetId: string, rowIds: number[]): void {
  if (rowIds.length === 0) return;
  for (let i = 0; i < rowIds.length; i += 500) {
    const chunk = rowIds.slice(i, i + 500);
    db.prepare(
      // Only a cell that HOLDS an answer can be out of date, and a pinned one is never refreshed —
      // flagging it would promise an update that is not coming. Identical to markDownstreamStale.
      `UPDATE cells SET stale = 1
        WHERE column_id = ? AND pinned = 0 AND stale = 0
          AND status IN ('done','not_found')
          AND row_id IN (${chunk.map(() => "?").join(",")})`,
    ).run(Number(columnId), ...chunk);
  }
  markColumnDirty(Number(columnId));

  /**
   * Push the change, do not just invalidate it.
   *
   * `markColumnDirty` only tells the CACHE its numbers are old; something has to recompute them for
   * the client to hear about it, and a run of the column is what normally does. This cascade fires
   * from an edit in a DIFFERENT table, so no run of this column is coming — nothing was ever going
   * to emit.
   *
   * Measured before the fix: the flag was correct in the database and the API reported `stale: 1`,
   * while the open grid held a snapshot reading `stale: 0, computing: true` and went on saying "Up
   * to date" — through a reload. A correct flag nobody is shown is the same as no flag.
   *
   * `refreshColumnStats` only COMPUTES — it does not push. The `onStatsComputed` hook is wired to the
   * background warmer, not to this path, which is why the run loop pairs the two by hand as
   * `emitColumnStats(refreshColumnStats(...))`. Computing without emitting looks like it works and
   * changes nothing on screen; that was the first version of this fix. The count rides the partial
   * `stale = 1` index, so it stays cheap on a large column.
   */
  if (rowIds.length <= BROADCAST_LIMIT) {
    markCellsDirty(rowIds.map((r) => cellId(r, Number(columnId))));
  }
  try {
    emitColumnStats(refreshColumnStats([Number(columnId)], sheetId));
  } catch { /* a stats refresh must never break the write that triggered it */ }
}

/**
 * Which rows of a lookup column read a given set of rows on the other side.
 *
 * This is the cross-table half of the stale cascade, and it is why the key index is materialized
 * rather than computed. Without it the question "who reads row 412 of Companies?" is a full scan of
 * Contacts per changed row; with it, it is a seek on a shared key.
 */
export function readersOf(relationId: number, changedSide: "from" | "to", changedRowIds: number[]): number[] {
  if (changedRowIds.length === 0) return [];
  const readerSide = changedSide === "from" ? "to" : "from";
  const out = new Set<number>();
  for (let i = 0; i < changedRowIds.length; i += 500) {
    const chunk = changedRowIds.slice(i, i + 500);
    const marks = chunk.map(() => "?").join(",");
    for (const r of db
      .prepare(
        `SELECT DISTINCT r.row_id AS id
           FROM relation_keys c
           JOIN relation_keys r
             ON r.relation_id = c.relation_id AND r.side = ? AND r.key = c.key
          WHERE c.relation_id = ? AND c.side = ? AND c.row_id IN (${marks})`,
      )
      .all(readerSide, Number(relationId), changedSide, ...chunk) as any[]) {
      out.add(Number(r.id));
    }
  }
  return [...out];
}
