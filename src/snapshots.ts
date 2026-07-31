// Restore points — putting back what a run replaced.
//
// The one remaining way to destroy something valuable in this app with a single click is a large run
// over a column that already held good answers: a prompt edited badly, a model swapped for a worse
// one, a re-run started with the wrong scope. Every other bulk destruction is already covered — a
// deleted column is soft-deleted, a deleted row is snapshotted, a hand edit is in the undo log — and
// a run is the only one that writes over a hundred thousand cells with no way back.
//
// WHY IT IS NOT THE UNDO LOG. undo.ts excludes runs on purpose, and its reason still holds: a run
// that spent $40 cannot be un-spent, so an "Undo" over one would imply a refund that is not coming.
// So this is a separate thing with a separate name and a sentence that says exactly what it does and
// does not do — the values come back, the charge stands.
//
// WHAT IT COSTS. One `INSERT ... SELECT` off the run's own resolved row set, taken inside the same
// transaction that creates the run, so nothing can be written before it lands. That means a run over
// a million filled cells pays for a million-row copy before it starts — a few seconds against a job
// that is about to make a million paid calls, and proportional to the run, so "run this one row"
// stays instant. Cells with nothing in them are not copied, so the common case of a first run over an
// empty column snapshots nothing and creates no restore point at all.

import { db, tx } from "./db.ts";
import { markCellsDirty } from "./bus.ts";
import { markColumnDirty, markSheetDirty } from "./columnStats.ts";
import { bumpDataVersion } from "./store.ts";
import { invalidateRedo } from "./undo.ts";

/**
 * How many restore points a table keeps.
 *
 * Deliberately shallow, and shallower than undo's 50. An undo entry is a few hundred bytes; a restore
 * point is a copy of every cell the run was about to replace, so depth here is measured in gigabytes
 * rather than kilobytes. The value also decays fast — a run that produced worse answers is noticed
 * within minutes, not five runs later — so paying to keep the sixth-oldest copy of a million-cell
 * column buys almost nothing.
 */
const MAX_SNAPSHOTS_PER_SHEET = 3;

export interface RunSnapshot {
  runId: string;
  sheetId: string;
  label: string;
  cellCount: number;
  columnIds: number[];
  createdAt: string;
  restoredAt: string | null;
}

// ─────────────────────────────────────────────────────────────── the mirrored field list

let fields: string[] | null = null;

/**
 * The fields copied into and out of a snapshot, read from the schema rather than restated here.
 *
 * `cells` minus `rev`, which is bumped on restore rather than restored so every open grid treats the
 * restored value as newer than what it is showing. Generated rather than hand-written for the reason
 * undo.ts learned by hand-writing it: a list typed out once names ten of twenty-three columns and
 * silently drops the rest, and the next migration drops one more.
 *
 * `columnsMatch` is what keeps the two tables honest — see snapshots.test.ts, which fails the moment
 * a migration adds a column to `cells` that the snapshot table has no home for.
 */
export function snapshotFields(): string[] {
  if (!fields) {
    const of = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => String(c.name));
    const cellFields = of("cells").filter((n) => n !== "rev");
    const snapFields = new Set(of("run_snapshot_cells").filter((n) => n !== "snapshot_run_id"));
    // An unmirrored field is DROPPED from the copy rather than crashing the boot: a database that
    // will not open is a far worse failure than a restore that returns one field short, and the test
    // is where the mismatch is meant to be caught. It is warned about loudly so it cannot pass
    // unnoticed in a build where the test was not run.
    const missing = cellFields.filter((n) => !snapFields.has(n));
    if (missing.length > 0) {
      console.warn(`[snapshots] run_snapshot_cells has no column for cells.${missing.join(", cells.")} — restore will not put ${missing.length === 1 ? "it" : "them"} back.`);
    }
    fields = cellFields.filter((n) => snapFields.has(n));
  }
  return fields;
}

/** Exposed for the test: the two field lists, so a mismatch names itself. */
export function columnsMatch(): { cells: string[]; snapshot: string[] } {
  const of = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => String(c.name));
  return {
    cells: of("cells").filter((n) => n !== "rev").sort(),
    snapshot: of("run_snapshot_cells").filter((n) => n !== "snapshot_run_id").sort(),
  };
}

// ─────────────────────────────────────────────────────────────── taking one

/**
 * Copy every cell the run is about to replace.
 *
 * `rowSql`/`rowParams` are the run's OWN resolved scope, passed through rather than re-resolved, so
 * the snapshot covers exactly the rows the run will touch. Re-resolving would open the door to the
 * two sets disagreeing — a filter matching one more row between the two queries — and a cell that is
 * overwritten but not saved is the single failure this feature exists to prevent.
 *
 * Returns the number of cells saved. Zero means no restore point was created.
 */
export function takeRunSnapshot(
  runId: string,
  sheetId: string,
  label: string,
  columnIds: number[],
  rowSql: string,
  rowParams: Array<string | number>,
): number {
  if (columnIds.length === 0) return 0;
  const names = snapshotFields();
  const colHoles = columnIds.map(() => "?").join(",");

  return tx(() => {
    db.prepare(
      `INSERT INTO run_snapshots (run_id, sheet_id, label, cell_count, column_ids) VALUES (?, ?, ?, 0, ?)`,
    ).run(runId, sheetId, label, JSON.stringify(columnIds.map(Number)));

    const res = db.prepare(
      `INSERT INTO run_snapshot_cells (snapshot_run_id, ${names.join(", ")})
       SELECT ?, ${names.map((n) => `c.${n}`).join(", ")}
         FROM cells c
        WHERE c.column_id IN (${colHoles})
          AND c.status <> 'empty'
          AND c.row_id IN (${rowSql})`,
    ).run(runId, ...columnIds, ...rowParams);

    const count = Number(res.changes ?? 0);
    if (count === 0) {
      // Nothing to put back, so no entry. A restore point that restores emptiness is noise in the one
      // list that has to stay trustworthy, and it would push a real one off the end of the depth cap.
      db.prepare("DELETE FROM run_snapshots WHERE run_id = ?").run(runId);
      return 0;
    }
    db.prepare("UPDATE run_snapshots SET cell_count = ? WHERE run_id = ?").run(count, runId);
    prune(sheetId);
    return count;
  });
}

/**
 * Drop the oldest beyond the depth cap.
 *
 * The cells go with them through `ON DELETE CASCADE` on `snapshot_run_id`, which is why that foreign
 * key is there — a metadata row deleted on its own would leave a million orphaned cells behind with
 * nothing left pointing at them.
 */
function prune(sheetId: string): void {
  db.prepare(
    `DELETE FROM run_snapshots
      WHERE sheet_id = ?
        AND run_id NOT IN (SELECT run_id FROM run_snapshots WHERE sheet_id = ?
                            ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
  ).run(sheetId, sheetId, MAX_SNAPSHOTS_PER_SHEET);
}

// ─────────────────────────────────────────────────────────────── reading them

function toSnapshot(r: any): RunSnapshot {
  let columnIds: number[] = [];
  try { columnIds = (JSON.parse(r.column_ids ?? "[]") as unknown[]).map(Number); } catch { /* pre-column_ids row */ }
  return {
    runId: String(r.run_id), sheetId: String(r.sheet_id), label: String(r.label),
    cellCount: Number(r.cell_count), columnIds,
    createdAt: String(r.created_at), restoredAt: r.restored_at ?? null,
  };
}

export function listSnapshots(sheetId: string): RunSnapshot[] {
  return (db.prepare("SELECT * FROM run_snapshots WHERE sheet_id = ? ORDER BY created_at DESC, rowid DESC").all(sheetId) as any[])
    .map(toSnapshot);
}

export function getSnapshot(runId: string): RunSnapshot | null {
  const r = db.prepare("SELECT * FROM run_snapshots WHERE run_id = ?").get(runId) as any;
  return r ? toSnapshot(r) : null;
}

// ─────────────────────────────────────────────────────────────── putting it back

export interface RestoreResult {
  /** Cells put back to the value they held before the run. */
  restored: number;
  /** Cells the run FILLED that were empty before it, and are empty again. */
  cleared: number;
  /** Saved cells whose row or column has since been deleted, so there was nowhere to put them. */
  gone: number;
}

/**
 * Put back what the run replaced.
 *
 * TWO statements, because a run does two different things to a cell and only one of them is an
 * overwrite:
 *
 *   1. a cell that HELD something is set back to every field it held — status, value, error, the
 *      grade, the note, the cost that produced it;
 *   2. a cell that was EMPTY and which this run filled is emptied again. Without this, "put back what
 *      was here" would leave the run's output in every previously-blank cell, which is most of them
 *      on a first run — and the restore would look like it had half worked with nothing saying why.
 *
 * The second is scoped to the snapshot's own columns and to cells still stamped with this run's id,
 * so a cell that some later run has since rewritten is left alone. Restoring over work done after
 * the run being reversed would be a second destruction dressed up as a repair.
 */
export function restoreSnapshot(runId: string): RestoreResult {
  const snap = getSnapshot(runId);
  if (!snap) throw new Error("There is no saved copy for that run. Restore points are kept for the last few runs on a table only.");

  const names = snapshotFields();
  const setClause = names
    .filter((n) => n !== "row_id" && n !== "column_id")
    .map((n) => `${n} = s.${n}`)
    .join(", ");

  const out = tx(() => {
    const restored = Number(db.prepare(
      `UPDATE cells AS c
          SET ${setClause}, rev = c.rev + 1
         FROM run_snapshot_cells s
        WHERE s.snapshot_run_id = ?
          AND c.row_id = s.row_id AND c.column_id = s.column_id`,
    ).run(runId).changes ?? 0);

    let cleared = 0;
    if (snap.columnIds.length > 0) {
      const colHoles = snap.columnIds.map(() => "?").join(",");
      cleared = Number(db.prepare(
        // Every field a run writes is cleared, not only the value — a cell left in 'empty' still
        // carrying the error class, the cost and the confidence of the answer that was just removed
        // would report a price for a value that is no longer there.
        `UPDATE cells
            SET status = 'empty', value_text = NULL, value_json = NULL,
                error_type = NULL, error_msg = NULL, confidence = NULL, source_url = NULL, note = NULL,
                cost_usd = NULL, duration_ms = NULL,
                tokens_in = NULL, tokens_out = NULL, tokens_cache_read = NULL, tokens_cache_create = NULL,
                input_hash = NULL, stale = 0, run_id = NULL,
                rev = rev + 1, updated_at = datetime('now')
          WHERE column_id IN (${colHoles})
            AND run_id = ?
            AND NOT EXISTS (SELECT 1 FROM run_snapshot_cells s
                             WHERE s.snapshot_run_id = ? AND s.row_id = cells.row_id AND s.column_id = cells.column_id)`,
      ).run(...snap.columnIds, runId, runId).changes ?? 0);
    }

    db.prepare("UPDATE run_snapshots SET restored_at = datetime('now') WHERE run_id = ?").run(runId);
    return { restored, cleared, gone: Math.max(0, snap.cellCount - restored) };
  });

  // A restore is a bulk write by something other than an undoable operation, which is exactly the
  // case invalidateRedo exists for: a redo replayed afterwards would put a snapshot taken before all
  // this back over values that have just been deliberately restored.
  invalidateRedo(snap.sheetId);

  for (const id of snap.columnIds) markColumnDirty(id);
  markSheetDirty(snap.sheetId);
  // The values in the sheet changed, so any materialized view index answering from before the restore
  // is now matching rows on text that is no longer there.
  bumpDataVersion(snap.sheetId);
  // Cell-level invalidation is not enumerated: a restore can touch a million cells, and pushing a
  // million cell ids through the bus to redraw a grid showing fifty of them is worse than the sheet
  // -level signal above, which the grid already refetches on.
  markCellsDirty([]);

  return out;
}
