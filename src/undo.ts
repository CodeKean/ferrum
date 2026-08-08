// Undo and redo.
//
// The app could destroy a column holding a million values with one confirm dialog and no way back.
// A confirmation is not a safety net — it is a speed bump in front of an irreversible action, and
// people click through speed bumps.
//
// TWO STRATEGIES, chosen per operation by what it costs to reverse:
//
//   SOFT DELETE for anything whose data is large. Deleting a column marks the column row and leaves
//   every cell exactly where it is, so undo is one UPDATE regardless of whether the sheet has ten
//   rows or a million. Snapshotting those cells instead would mean copying a million records to
//   support an undo that will usually never be used.
//
//   SNAPSHOT for anything small. A row is one record and its thirty cells; capturing them costs
//   nothing and the restore is exact — including the row's original id, so a back-reference written
//   by a fan-out still points at the right parent after the undo.
//
// The log is SERVER-SIDE and per sheet. It has to be: the data lives here, several surfaces mutate
// it, and a browser-side stack would be wrong the moment a second tab was open or the page reloaded.
//
// What is deliberately NOT undoable: money. A run that spent $40 cannot be un-spent, so runs are not
// in this log. The VALUES a run wrote are ordinary cell writes and could be reverted, but the charge
// stands, and an undo that silently implies otherwise would be a lie.

import { db, tx } from "./db.ts";
import { markCellsDirty } from "./bus.ts";
import { markColumnDirty, markSheetDirty } from "./columnStats.ts";
import {
  bumpDataVersion, getColumn, invalidateRowCount, moveColumn, nextRowPosition, renameColumn,
} from "./store.ts";

/** Per sheet. Deep enough to cover a working session, short of unbounded growth. */
const MAX_DEPTH = 50;

/**
 * A third value for `undone`, beyond 0 (behind you) and 1 (ahead of you): an entry that could not be
 * applied.
 *
 * A failed undo used to stay at 0, and undo always takes the NEWEST entry at 0 — so one operation
 * that could not be reversed sat at the top of the stack forever and every older operation behind it
 * became permanently unreachable. Retiring the entry into a state neither stack selects costs the one
 * step that could not be reversed and keeps the rest of the session's history usable. The row is
 * kept rather than deleted, so the payload is still there to look at.
 */
const FAILED = 2;

export type UndoKind =
  | "column.create"
  | "column.delete"
  | "column.rename"
  | "column.field"
  | "row.delete"
  | "rows.delete"
  | "rows.add"
  | "cell.edit"
  | "cells.bulk"
  | "sheet.rename"
  // One kind for every scalar setting that lives ON the sheet row — the row label, the default view,
  // what the rows are. A kind per setting would be three near-identical cases whose only difference
  // is a column name, and the next setting would make it four.
  | "sheet.setting"
  | "view.delete";

export interface UndoEntry {
  id: number;
  kind: UndoKind;
  /** Shown on the button and in the toast: "Undo delete column \"Industry\"". */
  label: string;
  undone: boolean;
}

/**
 * Record an operation as reversible.
 *
 * Recording DISCARDS the redo branch, which is the standard and correct behaviour: once you undo
 * three steps and then do something new, the three you undid are no longer reachable — keeping them
 * would let a redo replay an operation against a state it was never valid for.
 */
export function record(sheetId: string, kind: UndoKind, label: string, payload: unknown): number {
  return tx(() => {
    invalidateRedo(sheetId);
    const res = db
      .prepare("INSERT INTO undo_log (sheet_id, kind, label, payload) VALUES (?, ?, ?, ?)")
      .run(sheetId, kind, label, JSON.stringify(payload));

    // Trim the oldest beyond the depth cap. Done here rather than on a timer so the table cannot
    // grow between sweeps on a long editing session.
    db.prepare(
      `DELETE FROM undo_log
        WHERE sheet_id = ?
          AND id NOT IN (SELECT id FROM undo_log WHERE sheet_id = ? ORDER BY id DESC LIMIT ?)`,
    ).run(sheetId, sheetId, MAX_DEPTH);

    return Number(res.lastInsertRowid);
  });
}

/**
 * Discard the redo branch WITHOUT recording anything.
 *
 * `record` already does this for every operation that is itself reversible. What it cannot cover is
 * everything else that writes: a run, an import, a delivery, a deduplication. Those left the branch
 * alive, so pressing Redo afterwards replayed a snapshot taken BEFORE the write and put a pre-run
 * value back over the result — silently, over data that had just been paid for.
 *
 * A redo is only valid against the state it was undone from. Once anything else has written to the
 * table, it is not, and the honest thing is to have no redo rather than a wrong one.
 */
export function invalidateRedo(sheetId: string): void {
  db.prepare("DELETE FROM undo_log WHERE sheet_id = ? AND undone = 1").run(sheetId);
}

/** What the Undo and Redo buttons should say, and whether they are live. */
export function undoState(sheetId: string): { undo: UndoEntry | null; redo: UndoEntry | null } {
  const toEntry = (r: any): UndoEntry | null =>
    r ? { id: Number(r.id), kind: r.kind, label: r.label, undone: !!r.undone } : null;

  return {
    undo: toEntry(
      db.prepare("SELECT * FROM undo_log WHERE sheet_id = ? AND undone = 0 ORDER BY id DESC LIMIT 1").get(sheetId),
    ),
    // The OLDEST undone entry — redo walks forward through exactly the order undo walked back.
    redo: toEntry(
      db.prepare("SELECT * FROM undo_log WHERE sheet_id = ? AND undone = 1 ORDER BY id ASC LIMIT 1").get(sheetId),
    ),
  };
}

export function undo(sheetId: string): { ok: boolean; label?: string; error?: string } {
  const row = db
    .prepare("SELECT * FROM undo_log WHERE sheet_id = ? AND undone = 0 ORDER BY id DESC LIMIT 1")
    .get(sheetId) as any;
  if (!row) return { ok: false, error: "Nothing to undo." };

  try {
    tx(() => {
      apply(row.kind as UndoKind, JSON.parse(row.payload), "undo");
      db.prepare("UPDATE undo_log SET undone = 1 WHERE id = ?").run(row.id);
    });
    markSheetDirty(sheetId);
    return { ok: true, label: row.label };
  } catch (e) {
    // The entry is RETIRED even though it failed — see FAILED. Leaving it un-undone was the safer
    // looking choice and was the worse one: the button does not advance, so the same doomed entry is
    // retried on every press and the whole session's history sits behind it, unreachable.
    //
    // The two ordinary ways an inverse stops being appliable are handled before it gets here — a
    // deleted row whose position has been taken is relocated, and a rename goes through the store's
    // own clash check. What reaches this point is genuinely un-appliable, so it is spent rather than
    // left to block everything older than itself.
    retire(row.id);
    return { ok: false, error: `${e instanceof Error ? e.message : String(e)} This step was skipped, so the changes before it can still be undone.` };
  }
}

export function redo(sheetId: string): { ok: boolean; label?: string; error?: string } {
  const row = db
    .prepare("SELECT * FROM undo_log WHERE sheet_id = ? AND undone = 1 ORDER BY id ASC LIMIT 1")
    .get(sheetId) as any;
  if (!row) return { ok: false, error: "Nothing to redo." };

  try {
    tx(() => {
      apply(row.kind as UndoKind, JSON.parse(row.payload), "redo");
      db.prepare("UPDATE undo_log SET undone = 0 WHERE id = ?").run(row.id);
    });
    markSheetDirty(sheetId);
    return { ok: true, label: row.label };
  } catch (e) {
    // Retired for the same reason undo retires: redo takes the OLDEST entry ahead of you, so one
    // that cannot be replayed blocks every later one just as completely.
    retire(row.id);
    return { ok: false, error: `${e instanceof Error ? e.message : String(e)} This step was skipped, so the changes after it can still be redone.` };
  }
}

/** Take an entry out of both stacks. Runs outside the rolled-back transaction, on purpose. */
function retire(id: number): void {
  db.prepare("UPDATE undo_log SET undone = ? WHERE id = ?").run(FAILED, id);
}

// ─────────────────────────────────────────────────────────────── the inverses
//
// One function per kind, handling BOTH directions. Undo and redo of the same operation are exact
// mirrors, and writing them as two separate functions is how they drift — the classic result being a
// redo that does not restore quite what the undo removed.

/**
 * The fields whose forward setter in store.ts bumps `prompt_version`.
 *
 * The inverse used to bump it for EVERY field, including ones the forward path never versions — a
 * description, an auto-run toggle, a pin. The counter only ever goes up, so undoing one of those
 * left the column claiming its rule had changed, which invalidates every cell's input hash and turns
 * a re-run that should have skipped the lot into a full re-spend. Versioning describes what a value
 * was PRODUCED from, so only the producing fields belong here.
 */
const VERSIONED_FIELDS: ReadonlySet<string> = new Set([
  "value_type", "kind", "model", "prompt", "http_config", "send_config",
]);

function apply(kind: UndoKind, p: any, dir: "undo" | "redo"): void {
  switch (kind) {
    case "column.create": {
      // The exact inverse of column.delete, which is why it shares its soft-delete mechanism rather
      // than hard-dropping anything: undoing a creation must not destroy cells the user filled in
      // after it, and a redo has to bring those same cells back untouched.
      //
      // Recorded as a LIST because one AI-setup action can add several columns at once, and undoing
      // half of "add these four columns" is not an undo. All of them move together or none do.
      const ids = (Array.isArray(p.columnIds) ? p.columnIds : [p.columnId]).map(Number);
      let changed = 0;
      for (const id of ids) {
        changed += setColumnDeleted(id, dir === "undo" ? p.deletedAt : null);
        markColumnDirty(id);
      }
      // Every one already gone is the only genuine failure. A partial hit means someone deleted one
      // of them in between, and completing the rest is still the more useful outcome.
      if (changed === 0) throw new Error("Those columns no longer exist.");
      break;
    }

    case "column.delete": {
      // Soft-deleted, so the cells were never touched. Both directions are one UPDATE each.
      //
      // A LIST or a single id: a bulk delete records `columnIds`, the single-column route still
      // records `columnId`, and this reads either — the same shape `column.create` accepts, so undo
      // of a five-column delete brings all five back together or fails as one.
      const ids = (Array.isArray(p.columnIds) ? p.columnIds : [p.columnId]).map(Number);
      let changed = 0;
      for (const id of ids) {
        changed += setColumnDeleted(id, dir === "undo" ? null : p.deletedAt);
        markColumnDirty(id);
      }
      if (changed === 0) throw new Error(ids.length === 1 ? "That column no longer exists." : "Those columns no longer exist.");
      break;
    }

    case "column.rename": {
      const columnId = Number(p.columnId);
      if (!getColumn(columnId)) throw new Error("That column no longer exists.");
      // Through the store's own rename rather than a hand-written UPDATE. It normalizes the key
      // exactly as the forward path did — one definition, not two — and its clash check turns "that
      // name has been taken since" into a sentence a person can act on, instead of a raw
      // UNIQUE(sheet_id, key) failure.
      renameColumn(columnId, String(dir === "undo" ? p.from : p.to));
      break;
    }

    case "column.field": {
      // kind / model / value_type — one shape for all three, because the inverse of "set this
      // field" is identical whichever field it was.
      const columnId = Number(p.columnId);
      // Both directions are null-normalized here rather than at the write, so the comparison below
      // and the value bound to SQL agree about what "no value" is.
      const from = p.from ?? null;
      const to = p.to ?? null;
      const value = dir === "undo" ? from : to;

      // An entry whose two directions are IDENTICAL cannot describe a change, so applying it can
      // only destroy.
      //
      // Reproduced: "Change the destination for X" is recorded with `{from: null, to: null}`, so one
      // press of Undo executed `UPDATE columns SET send_config = NULL` and erased the destination,
      // the mapping, the conflict rule and the cap — and Redo, being the exact mirror, did it again.
      // Where the payload IS honest this branch was already a no-op write, so refusing to run it
      // costs nothing; it also stops a no-op undo of a versioned field from bumping prompt_version
      // and invalidating every cell's input hash for a change that never happened.
      if (from === to) {
        if (!getColumn(columnId)) throw new Error("That column no longer exists.");
        break;
      }

      // Position is NOT an ordinary field. moveColumn renumbers every column of the sheet densely,
      // so replaying one absolute position left two columns sharing it and one index vacant — the
      // order came back wrong and the duplicate was stored with nothing to say so. The inverse has
      // to go through the same renumber the move itself used.
      if (p.field === "position") {
        if (!getColumn(columnId)) throw new Error("That column no longer exists.");
        moveColumn(columnId, Number(value));
        break;
      }

      // The field name is whitelisted at the call site, never taken from a request.
      const bump = VERSIONED_FIELDS.has(String(p.field)) ? ", prompt_version = prompt_version + 1" : "";
      const res = db
        .prepare(`UPDATE columns SET ${p.field} = ?${bump}, updated_at = datetime('now') WHERE id = ?`)
        .run(value, columnId);
      if (Number(res.changes ?? 0) === 0) throw new Error("That column no longer exists.");
      break;
    }

    case "row.delete":
      if (dir === "undo") restoreRow(p);
      else deleteRowHard(Number(p.row.id));
      break;

    /**
     * MANY rows deleted at once, reversed. One entry holds every snapshot, so a bulk delete is one
     * press to take back rather than one press per row.
     *
     * Best-effort per row rather than all-or-nothing: a row that was independently restored (undo) or
     * re-deleted (redo) in between is SKIPPED, not a throw that abandons the rest. Restoring nine of
     * ten rows is the useful outcome; failing all ten because one came back another way is not.
     */
    case "rows.delete": {
      const snaps: any[] = Array.isArray(p.rows) ? p.rows : [];
      for (const s of snaps) {
        const id = Number(s.row.id);
        const present = db.prepare("SELECT 1 FROM rows WHERE id = ?").get(id);
        if (dir === "undo") { if (!present) restoreRow(s); }
        else if (present) deleteRowHard(id);
      }
      break;
    }

    /**
     * ADDING rows, reversed.
     *
     * The cheapest entry in this file and among the most wanted: "+ Row" is one click, "add 500 rows"
     * is one field, and until now neither could be taken back — the only way out was selecting them
     * and deleting them by hand, which on 500 rows is not a way out.
     *
     * Reversed by ID rather than by snapshot, because the rows are BRAND NEW: they hold nothing worth
     * saving, so there is nothing to restore and nothing to copy. Redo re-inserts them at the same
     * ids, so anything that referenced one in between still points at the right row.
     */
    case "rows.add": {
      const ids = (p.rowIds ?? []).map(Number);
      if (ids.length === 0) throw new Error("That entry does not say which rows were added.");
      if (dir === "undo") {
        // A row that has since been FILLED IN is left alone. Undoing "add 500 rows" an hour later,
        // after forty of them were enriched, must not throw away the forty — the user is undoing the
        // creation, not the work, and this is the one case where those differ.
        const kept = ids.filter((id: number) =>
          db.prepare(
            `SELECT 1 FROM cells WHERE row_id = ? AND status <> 'empty'
              AND value_text IS NOT NULL AND TRIM(value_text) <> '' LIMIT 1`,
          ).get(id),
        );
        const removable = ids.filter((id: number) => !kept.includes(id));
        if (removable.length === 0) {
          throw new Error("Those rows have values in them now, so they were left alone.");
        }
        for (const id of removable) deleteRowHard(id);
        // Recorded on the payload so a REDO puts back exactly what an undo removed, rather than
        // re-inserting rows that were never taken away.
        p.removed = removable;
      } else {
        const sheetId = String(p.sheetId);
        const ins = db.prepare("INSERT OR IGNORE INTO rows (id, sheet_id, position) VALUES (?, ?, ?)");
        const cols = db
          .prepare("SELECT id FROM columns WHERE sheet_id = ? AND deleted_at IS NULL")
          .all(sheetId) as Array<{ id: number }>;
        const cell = db.prepare("INSERT OR IGNORE INTO cells (row_id, column_id, status) VALUES (?, ?, 'empty')");
        let pos = nextRowPosition(sheetId);
        for (const id of (p.removed ?? ids).map(Number)) {
          ins.run(id, sheetId, pos++);
          for (const c of cols) cell.run(id, Number(c.id));
        }
        invalidateRowCount(sheetId);
        bumpDataVersion(sheetId);
      }
      break;
    }

    case "sheet.rename": {
      const name = String(dir === "undo" ? p.from : p.to).trim();
      if (!name) throw new Error("That entry does not say what the table was called.");
      const res = db.prepare("UPDATE sheets SET name = ?, updated_at = datetime('now') WHERE id = ?")
        .run(name, String(p.sheetId));
      if (Number(res.changes ?? 0) === 0) throw new Error("That table no longer exists.");
      break;
    }

    /**
     * A scalar setting on the sheet row. The payload names the column, so one case covers all of
     * them — but the column name is checked against a fixed list rather than interpolated, because
     * this value reaches SQL and an undo entry is a stored document.
     */
    case "sheet.setting": {
      const FIELDS = ["primary_column_id", "default_view_id", "kind"] as const;
      const field = String(p.field ?? "");
      if (!(FIELDS as readonly string[]).includes(field)) {
        throw new Error("That entry names a table setting this version does not know how to put back.");
      }
      const v = dir === "undo" ? p.from : p.to;
      const res = db
        .prepare(`UPDATE sheets SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(v ?? null, String(p.sheetId));
      if (Number(res.changes ?? 0) === 0) throw new Error("That table no longer exists.");
      break;
    }

    case "view.delete":
      if (dir === "undo") {
        const v = p.view;
        if (db.prepare("SELECT 1 FROM views WHERE id = ?").get(Number(v.id))) {
          throw new Error("That view is already back.");
        }
        // Restored with its ORIGINAL id: a run can target a view by id, and anything holding one —
        // a bookmark, another tab — would point at nothing if the restore minted a new one.
        db.prepare(
          `INSERT INTO views (id, sheet_id, name, position, filter_json, sorts_json, columns_json,
                              group_by, row_height, search, is_shared, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          v.id, v.sheet_id, v.name, v.position, v.filter_json, v.sorts_json, v.columns_json,
          v.group_by, v.row_height, v.search, v.is_shared, v.created_at, v.updated_at,
        );
      } else {
        const res = db.prepare("DELETE FROM views WHERE id = ?").run(Number(p.view.id));
        if (Number(res.changes ?? 0) === 0) throw new Error("That view no longer exists.");
      }
      break;

    case "cell.edit": {
      const v = dir === "undo" ? p.before : p.after;
      // Every field the forward edit overwrites is restored, not only the four the value lives in:
      // setCellValue also clears the error class and message and drops the stale flag, so restoring
      // status alone put a cell back into 'error' with nothing left to say what had gone wrong.
      // (Fields absent from an older payload restore as empty, which is the state the edit had
      // already left them in.)
      const res = db.prepare(
        `UPDATE cells SET status = ?, value_text = ?, value_json = ?, pinned = ?,
                          error_type = ?, error_msg = ?, stale = ?, rev = rev + 1,
                          updated_at = datetime('now')
          WHERE row_id = ? AND column_id = ?`,
      ).run(
        v.status, v.valueText ?? null, v.valueJson ?? null, v.pinned ? 1 : 0,
        v.errorType ?? null, v.errorMsg ?? null, v.stale ? 1 : 0,
        Number(p.rowId), Number(p.columnId),
      );
      // A dedupe, an import or a column purge can remove the cell between the edit and the undo.
      // Without this the UPDATE matched nothing, the entry was marked as applied, and the button
      // reported success for an operation that did not happen.
      if (Number(res.changes ?? 0) === 0) throw new Error("That cell no longer exists.");
      markCellsDirty([`${p.rowId}:${p.columnId}`]);
      markColumnDirty(Number(p.columnId));
      break;
    }

    /**
     * A whole pasted block, reversed in one step.
     *
     * The alternative was one `cell.edit` per cell, which is what the client would have produced by
     * looping the single-cell route: a thousand entries, an undo stack holding nothing but this
     * paste, and a user pressing Undo a thousand times to get back where they were. The MAX_DEPTH of
     * 50 makes that worse than tedious — the paste would evict the entire rest of the session's
     * history and then still not be fully undone.
     *
     * Rows the paste CREATED come out on the same step, and they come out FIRST: their cells are in
     * the same list, and restoring a cell on a row that is about to be deleted is wasted work whose
     * only other outcome is a spurious "that cell no longer exists".
     *
     * Unlike `rows.add`, rows are removed here without the "it has values now, leave it" guard. The
     * paste is what put the values in them; keeping a row because the operation being undone filled
     * it would make this undo a no-op in every ordinary case.
     */
    case "cells.bulk": {
      const cells = (p.cells ?? []) as any[];
      const addedRowIds = (p.addedRowIds ?? []).map(Number) as number[];
      const gone = new Set(addedRowIds);

      if (dir === "undo") {
        for (const id of addedRowIds) deleteRowHard(id);
      } else {
        const sheetId = String(p.sheetId);
        const ins = db.prepare("INSERT OR IGNORE INTO rows (id, sheet_id, position) VALUES (?, ?, ?)");
        const cols = db
          .prepare("SELECT id FROM columns WHERE sheet_id = ? AND deleted_at IS NULL")
          .all(sheetId) as Array<{ id: number }>;
        const cell = db.prepare("INSERT OR IGNORE INTO cells (row_id, column_id, status) VALUES (?, ?, 'empty')");
        let pos = nextRowPosition(sheetId);
        for (const id of addedRowIds) {
          ins.run(id, sheetId, pos++);
          for (const c of cols) cell.run(id, Number(c.id));
        }
        gone.clear(); // on redo those rows are back, so their cells are writable again
      }

      const write = db.prepare(
        `UPDATE cells SET status = ?, value_text = ?, value_json = ?, pinned = ?,
                          error_type = ?, error_msg = ?, stale = ?, rev = rev + 1,
                          updated_at = datetime('now')
          WHERE row_id = ? AND column_id = ?`,
      );
      const dirty: string[] = [];
      const columnsTouched = new Set<number>();
      let missing = 0;
      for (const c of cells) {
        if (gone.has(Number(c.rowId))) continue; // its row was just removed, on purpose
        const v = dir === "undo" ? c.before : c.after;
        const res = write.run(
          v.status, v.valueText ?? null, v.valueJson ?? null, v.pinned ? 1 : 0,
          v.errorType ?? null, v.errorMsg ?? null, v.stale ? 1 : 0,
          Number(c.rowId), Number(c.columnId),
        );
        if (Number(res.changes ?? 0) === 0) { missing++; continue; }
        dirty.push(`${c.rowId}:${c.columnId}`);
        columnsTouched.add(Number(c.columnId));
      }

      // A paste whose every target has since been deleted did nothing, and saying it succeeded would
      // be the same lie `cell.edit` refuses to tell. Some of them missing is survivable and normal —
      // a dedupe ran, a column was dropped — so that only costs the cells it could not reach.
      if (missing > 0 && dirty.length === 0 && addedRowIds.length === 0) {
        throw new Error("Those cells no longer exist.");
      }

      if (dirty.length > 0) markCellsDirty(dirty);
      for (const id of columnsTouched) markColumnDirty(id);
      if (addedRowIds.length > 0) {
        invalidateRowCount(String(p.sheetId));
        bumpDataVersion(String(p.sheetId));
      }
      break;
    }

    default:
      // Fail closed on a kind this build does not know — an entry written by a newer version, or a
      // kind removed since. Silently doing nothing would consume the entry and report success.
      throw new Error(`This change cannot be reversed: Ferrum does not recognise "${String(kind)}".`);
  }
}

/** Returns how many rows the flag actually moved, so a vanished column is not reported as undone. */
function setColumnDeleted(columnId: number, deletedAt: string | null): number {
  const col = db.prepare("SELECT sheet_id, position FROM columns WHERE id = ?").get(columnId) as any;
  if (!col) return 0;

  // Coming BACK is the direction that can fail. `ux_columns_sheet_pos` only covers live columns, so
  // while this one was deleted the sheet was free to put something else on its position — a webhook
  // shifting everything right, a drag, another column added. Restoring it then violates the index
  // and the undo dies on a raw constraint error, which is a miserable way to lose a column twice.
  //
  // So a taken position sends it to the END rather than refusing. The user gets their column back,
  // which is what they asked for; the exact slot is the part that could not be honoured, and it is
  // the part they can fix with one drag.
  if (deletedAt === null) {
    const taken = db
      .prepare("SELECT 1 FROM columns WHERE sheet_id = ? AND position = ? AND deleted_at IS NULL AND id != ?")
      .get(col.sheet_id, col.position, columnId);
    if (taken) {
      const max = db
        .prepare("SELECT MAX(position) AS m FROM columns WHERE sheet_id = ? AND deleted_at IS NULL")
        .get(col.sheet_id) as any;
      db.prepare("UPDATE columns SET position = ? WHERE id = ?").run(Number(max?.m ?? -1) + 1, columnId);
    }
  }
  const res = db.prepare("UPDATE columns SET deleted_at = ? WHERE id = ?").run(deletedAt, columnId);
  const changed = Number(res.changes ?? 0);

  // The materialized view index has to be told the live column set moved.
  //
  // A free-text search matches over a sheet's LIVE columns, so hiding or restoring one changes which
  // rows a view contains — which is exactly why `deleteColumn` bumps the data version. The INVERSE
  // did not, so the index went on answering from before the restore: reproduced end to end as a
  // search matching 1 row, deleting the column it matched in, undoing that delete, and the search
  // still returning 0 with the column and its values plainly back on screen.
  if (changed > 0) bumpDataVersion(String(col.sheet_id));
  return changed;
}

/**
 * The cells INSERT, generated from the table itself.
 *
 * Written out by hand it named ten of the cells table's twenty-three columns, so restoring a row
 * threw away the input hash, the run id, the attempt, the cost, the tokens, the duration, the
 * confidence, the source URL, the note and the timestamp — every one of them already sitting in the
 * payload, because snapshotRow does SELECT *. An undo that silently returns a thinner row than the
 * one it removed is the kind of loss nobody goes looking for. Reading the column list out of the
 * schema means the next migration cannot quietly drop a twenty-fourth field the same way.
 *
 * `rev` is the one deliberate exception: it is BUMPED rather than restored, so every open grid treats
 * the restored cell as newer than whatever it is still showing.
 */
let cellInsert: { stmt: ReturnType<typeof db.prepare>; names: string[] } | null = null;

function restoreCellsStmt(): { stmt: ReturnType<typeof db.prepare>; names: string[] } {
  if (!cellInsert) {
    const cols = (db.prepare("PRAGMA table_info(cells)").all() as any[]).filter((c) => c.name !== "rev");
    const names = cols.map((c) => String(c.name));
    // A payload captured before a migration added a column carries no value for it, and SQLite would
    // refuse the NULL on a NOT NULL column — so the table's OWN default stands in, taken verbatim
    // from the schema rather than restated here where it could drift.
    const holes = cols.map((c) => (c.notnull && c.dflt_value != null ? `COALESCE(?, ${c.dflt_value})` : "?"));
    cellInsert = {
      stmt: db.prepare(`INSERT INTO cells (${names.join(", ")}, rev) VALUES (${holes.join(", ")}, ?)`),
      names,
    };
  }
  return cellInsert;
}

/**
 * Put a deleted row back, id and all.
 *
 * The id matters: a fan-out writes a back-reference holding the parent's row id, and restoring the
 * row under a fresh id would leave every one of those children pointing at nothing. SQLite lets an
 * explicit INTEGER PRIMARY KEY be supplied, so the original is reused.
 */
function restoreRow(p: any): void {
  const sheetId = String(p.row.sheet_id);
  const rowId = Number(p.row.id);

  if (db.prepare("SELECT 1 FROM rows WHERE id = ?").get(rowId)) {
    throw new Error("That row is already back in the table.");
  }

  // The POSITION may have been taken since — a later insert takes MAX(position)+1, and after this
  // row was removed that is its old slot — while (sheet_id, position) is UNIQUE. Positions are
  // explicitly not meaningful here (deletes leave holes and nothing compacts them), so the row goes
  // to the end rather than failing: getting the row and its values back is the entire point, and the
  // alternative was an entry that could never be applied sitting on top of the whole stack.
  const wanted = Number(p.row.position);
  const taken = db.prepare("SELECT 1 FROM rows WHERE sheet_id = ? AND position = ?").get(sheetId, wanted);
  const position = taken ? nextRowPosition(sheetId) : wanted;

  db.prepare("INSERT INTO rows (id, sheet_id, position, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(rowId, sheetId, position, p.row.dedupe_key ?? null, p.row.created_at);

  const { stmt, names } = restoreCellsStmt();
  for (const c of p.cells ?? []) {
    // row_id comes from the row being restored, not from the cell, so a payload written before the
    // relocation above still lands on the row that actually exists.
    const values: any[] = names.map((n) => (n === "row_id" ? rowId : c[n] ?? null));
    values.push(Number(c.rev ?? 0) + 1);
    stmt.run(...values);
  }
  invalidateRowCount(sheetId);
  // The row count changed, so any materialized view index for this sheet is now short by one row and
  // its stored total is wrong. Bumping the version is what makes the next read rebuild it.
  bumpDataVersion(sheetId);
  markCellsDirty((p.cells ?? []).map((c: any) => `${rowId}:${c.column_id}`));
}

function deleteRowHard(rowId: number): void {
  const row = db.prepare("SELECT sheet_id FROM rows WHERE id = ?").get(rowId) as any;
  if (!row?.sheet_id) throw new Error("That row no longer exists.");
  db.prepare("DELETE FROM cells WHERE row_id = ?").run(rowId);
  db.prepare("DELETE FROM rows WHERE id = ?").run(rowId);
  invalidateRowCount(String(row.sheet_id));
  bumpDataVersion(String(row.sheet_id));
}

/** Everything needed to put a row back. Called BEFORE the delete, obviously. */
export function snapshotRow(rowId: number): { row: any; cells: any[] } | null {
  const row = db.prepare("SELECT * FROM rows WHERE id = ?").get(rowId) as any;
  if (!row) return null;
  const cells = db.prepare("SELECT * FROM cells WHERE row_id = ?").all(rowId) as any[];
  return { row, cells };
}
