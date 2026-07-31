// Per-column completion stats — what the header progress bar and its hover breakdown show.
//
// ── Why this is a cache and not a maintained table ────────────────────────────────────────────
// Measured on the 1M-row sheet:
//   GROUP BY status for ONE column ........ 404ms
//   GROUP BY for ALL columns .............. 3,103ms
//   the same with a "status <> done" filter . 643ms  (no better once a column is mostly empty)
// So computing on demand is far too slow for a header that repaints during a run.
//
// The obvious fix — a stats table maintained by SQLite triggers — was benchmarked too, and it
// roughly DOUBLES write cost (96% overhead on bulk inserts). That would take the 1M-row script pass
// from 11s to ~25s, which is too much to pay on the thing the whole cost model rests on.
//
// So: an in-process cache, invalidated by writes, recomputed lazily per column. The reason that is
// enough is that DURING a run the header does not need this at all — the run record already tracks
// done/errors/skipped live. This only has to be right at rest, and it is recomputed once after a
// run finishes rather than continuously.
//
// Being a cache rather than a source of truth also means a missed invalidation degrades to a stale
// number for a minute, not to a wrong number forever.

import { db } from "./db.ts";
import { countRows } from "./store.ts";
import type { CellStatus } from "./types.ts";

export interface ColumnStats {
  columnId: number;
  total: number;
  byStatus: Partial<Record<CellStatus, number>>;
  stale: number;
  /**
   * Cells in a TERMINAL state — nothing further will happen to them without a re-run. A failure is
   * completed: the work is over, it just didn't produce a value. This is the number the progress bar
   * fills to, and it is why the breakdown can read "100% completed" with "2 failed" underneath it
   * without contradicting itself. `byStatus.error` is how many of these went badly.
   */
  completed: number;
  /**
   * Cells the user typed in, which a run leaves alone unless told otherwise.
   *
   * Here so the run confirmation can say honestly how many cells it is about to replace. Without it
   * that screen counted a hand edit as overwritable whichever way the run was configured — an
   * overstatement while edits are protected, and an understatement once they are not.
   *
   * Absent on stats cached by an older build; read as 0, which is exactly the behaviour that
   * preceded this field.
   */
  pinned?: number;
  /** 0-100, rounded. */
  pct: number;
  /** True while the numbers are being recomputed, so the UI can show the previous value rather
   *  than flashing an empty bar. */
  computing?: boolean;
  computedAt: number;
}

interface Entry {
  stats: ColumnStats;
  dirty: boolean;
}

const cache = new Map<number, Entry>();

/**
 * A missed invalidation self-heals within this window rather than persisting forever.
 *
 * Long on purpose. Invalidation is explicit — every write site calls markColumnDirty — so this is a
 * safety net, not the mechanism. At 60s it behaved like the mechanism: every column of an idle sheet
 * expired every minute and got recomputed, which on eleven million-row columns is 4.4s of background
 * work per minute forever, to produce numbers that had not changed.
 */
const TTL_MS = 10 * 60_000;

/**
 * The snapshot is also PERSISTED on the column row.
 *
 * Without that, the 404ms-per-column recompute is paid again on every server restart, and a sheet of
 * eleven million-row columns takes ~4.5s of blocking work before the header can show anything. On
 * disk it is paid once per meaningful change instead — and the changes that matter (a run finishing,
 * an import, an expand) all already call refreshColumnStats.
 */
/**
 * Bump this whenever the MEANING of a field changes, not just its shape.
 *
 * A persisted snapshot outlives the code that produced it. When `completed` changed from "succeeded"
 * to "reached a terminal state", every snapshot on disk kept answering the old question under the new
 * name — and because a hydrated snapshot counts as fresh, nothing would ever recompute it. A version
 * stamp turns that from a silent wrong number into a one-off recompute.
 */
const STATS_VERSION = 2;

function loadPersisted(columnId: number): ColumnStats | null {
  const r = db.prepare("SELECT stats_json FROM columns WHERE id = ?").get(columnId) as any;
  if (!r?.stats_json) return null;
  try {
    const s = JSON.parse(r.stats_json) as ColumnStats & { v?: number };
    if (s?.v !== STATS_VERSION || typeof s.total !== "number") return null;
    return s;
  } catch {
    return null;
  }
}

function persist(stats: ColumnStats): void {
  try {
    const payload = JSON.stringify({ ...stats, v: STATS_VERSION });
    db.prepare("UPDATE columns SET stats_json = ? WHERE id = ?").run(payload, stats.columnId);
    // Freshly computed and freshly written, so the disk no longer needs the tombstone below.
    clearedOnDisk.delete(stats.columnId);
  } catch { /* a stats write must never break the operation that triggered it */ }
}

/** Statuses that count as "this cell has been dealt with" — see ColumnStats.completed. */
const COMPLETED: ReadonlySet<CellStatus> = new Set<CellStatus>(["done", "not_found", "skipped", "error"]);

const clearPersistedStmt = db.prepare("UPDATE columns SET stats_json = NULL WHERE id = ?");

/**
 * Columns whose persisted snapshot has already been thrown away while they were out of memory.
 *
 * Purely a guard against repeating the UPDATE: a run writes to the same column thousands of times in
 * a row, and one statement per cell would make the invalidation more expensive than the recompute it
 * exists to schedule.
 */
const clearedOnDisk = new Set<number>();

export function markColumnDirty(columnId: number | null | undefined): void {
  if (columnId == null) return;
  const id = Number(columnId);
  const e = cache.get(id);
  if (e) e.dirty = true;

  // The disk snapshot is invalidated TOO, not only when the column happens to be cold.
  //
  // Returning early on a cache hit was the defect, and it is the common case rather than the rare
  // one: reading the header caches the column, the run then writes to it, and the flag was set in
  // memory while the snapshot on disk — which outlives the process the memory does not — kept the
  // pre-write numbers. hydrate() serves anything it finds there as fresh, so the next restart
  // reported them as fact for the whole ten-minute TTL. Reproduced: a column whose two failures had
  // been fixed still read `{error: 2}` after the restart, with `computing` unset, i.e. presented as
  // current rather than as a stale number being refreshed.
  //
  // The `clearedOnDisk` tombstone is what keeps this cheap: a run marks the same column dirty
  // thousands of times, and only the first mark after each persist() pays for the UPDATE.
  if (clearedOnDisk.has(id)) return;
  clearedOnDisk.add(id);
  try { clearPersistedStmt.run(id); } catch { /* a stats write must never break the operation that triggered it */ }
}

export function markColumnsDirty(columnIds: Iterable<number>): void {
  for (const id of columnIds) markColumnDirty(id);
}

/** Invalidate every column of a sheet — used after an import or a schema change. */
export function markSheetDirty(sheetId: string): void {
  for (const r of db.prepare("SELECT id FROM columns WHERE sheet_id = ? AND deleted_at IS NULL").all(sheetId) as any[]) {
    markColumnDirty(Number(r.id));
  }
}

// Covered end to end by ix_cells_col_status (column_id, status): the planner never touches the table.
const statusStmt = db.prepare(
  "SELECT status, COUNT(*) AS n FROM cells WHERE column_id = ? GROUP BY status",
);

/**
 * The stale count, written to ride a PARTIAL index.
 *
 * `stale` is in no index, so this cannot use the composite above: it walks that index for the column
 * and then fetches every one of the column's cells from the table to read one flag. Measured on a
 * million-cell column: **933ms**, against 57ms for the status histogram immediately above it — so
 * this one statement was most of what a column's recompute cost, and the ~400ms figure the budget in
 * getSheetColumnStats is built around understates it by more than half.
 *
 * The index it rides is `ix_cells_col_stale` in db.ts — `ON cells(column_id) WHERE stale = 1`. (This
 * note used to ask for it under a name that was never created, which read as "still to do" long
 * after it had been.)
 *
 * Partial on purpose — stale cells are a small minority, so the index stays tiny and the count
 * becomes a range scan over just them. The predicate below is written as `stale = 1` to match that
 * WHERE clause literally, which is what makes the index eligible; do not relax it to `stale <> 0`.
 */
const staleStmt = db.prepare(
  "SELECT COUNT(*) AS n FROM cells WHERE column_id = ? AND stale = 1",
);

/**
 * Hand-typed cells, on the same trick as the stale count above.
 *
 * Rides `ix_cells_col_pinned` — `ON cells(column_id) WHERE pinned = 1` — so it scans only the
 * pinned cells rather than the column. Written as `pinned = 1` to match that WHERE clause
 * literally, which is what makes the index eligible; do not relax it to `pinned <> 0`.
 *
 * NOT folded into the status histogram, deliberately. That query is covered end to end by
 * ix_cells_col_status and never touches the table; adding `SUM(pinned)` to it would force a row
 * fetch per cell and cost it that plan, which is precisely how the stale count came to be the
 * expensive half of a recompute.
 */
const pinnedStmt = db.prepare(
  "SELECT COUNT(*) AS n FROM cells WHERE column_id = ? AND pinned = 1",
);

function compute(columnId: number, sheetId: string): ColumnStats {
  const byStatus: Partial<Record<CellStatus, number>> = {};
  let counted = 0;
  let completed = 0;

  for (const r of statusStmt.all(columnId) as any[]) {
    const n = Number(r.n);
    byStatus[r.status as CellStatus] = n;
    counted += n;
    if (COMPLETED.has(r.status as CellStatus)) completed += n;
  }

  // `total` comes from the sheet's row count, not from summing the statuses: a column added but not
  // yet backfilled has fewer cells than rows, and reporting 100% because 3 of 3 existing cells are
  // done would be a lie about a million-row table.
  const total = Math.max(counted, countRows(sheetId));
  const missing = total - counted;
  if (missing > 0) byStatus.empty = (byStatus.empty ?? 0) + missing;

  return {
    columnId,
    total,
    byStatus,
    stale: Number((staleStmt.get(columnId) as any)?.n ?? 0),
    pinned: Number((pinnedStmt.get(columnId) as any)?.n ?? 0),
    completed,
    pct: total === 0 ? 0 : Math.round((completed / total) * 100),
    computedAt: Date.now(),
  };
}

/**
 * The one definition of "these numbers are good enough to serve".
 *
 * It is a single function because it was briefly two: the request path treated a column as stale once
 * its TTL expired, while the warmer treated anything present on disk as warm. So an expired column
 * was never fresh enough to serve and never stale enough to warm, and the header sat on "…" forever.
 *
 * Deliberately NOT a type predicate (`e is Entry`): "not fresh" does not mean "absent". An expired
 * entry still holds the previous numbers, and those are what the header shows while a recompute is
 * pending — narrowing the false branch to `undefined` would quietly delete that path.
 */
function isFresh(e: Entry | undefined): boolean {
  return !!e && !e.dirty && Date.now() - e.stats.computedAt < TTL_MS;
}

export function getColumnStats(columnId: number, sheetId: string): ColumnStats {
  const e = cache.get(columnId);
  if (e && isFresh(e)) return e.stats;

  const stats = compute(columnId, sheetId);
  cache.set(columnId, { stats, dirty: false });
  persist(stats);
  return stats;
}

/** Warm the in-memory cache from disk. Cheap, and it means a restart does not re-pay the recompute. */
function hydrate(columnId: number): ColumnStats | null {
  const stored = loadPersisted(columnId);
  if (!stored) return null;
  cache.set(columnId, { stats: stored, dirty: false });
  return stored;
}

/**
 * Stats for a whole sheet.
 *
 * `budgetMs` bounds how long this may spend recomputing. A sheet with eleven stale million-row
 * columns would otherwise be 4.5 seconds of blocking work on a header repaint — so it refreshes what
 * it can afford and returns the previous numbers for the rest, flagged as `computing` so the UI
 * shows the old value rather than flashing an empty bar.
 */
export function getSheetColumnStats(sheetId: string, budgetMs = 250): ColumnStats[] {
  const columns = db.prepare("SELECT id FROM columns WHERE sheet_id = ? AND deleted_at IS NULL ORDER BY position").all(sheetId) as any[];
  const started = Date.now();
  const out: ColumnStats[] = [];

  for (const c of columns) {
    const id = Number(c.id);
    let e = cache.get(id);
    // Not in memory? Try disk before spending 400ms recomputing.
    if (!e) { const stored = hydrate(id); if (stored) e = cache.get(id); }

    if (e && isFresh(e)) { out.push(e.stats); continue; }

    // A single column can take ~400ms, so an exhausted budget must stop BEFORE starting another
    // one — otherwise one column overshoots the budget by its entire cost.
    //
    // The `budgetMs <= 0` case is explicit rather than relying on the elapsed comparison: at the
    // first iteration elapsed is 0, and `0 > 0` is false, so a zero budget would still compute one
    // column and cost ~400ms. That is exactly the bug this endpoint exists to avoid.
    if (budgetMs <= 0 || Date.now() - started >= budgetMs) {
      out.push(
        e
          ? { ...e.stats, computing: true }          // stale numbers beat no numbers
          : {
              // Nothing known at all: report unknown rather than inventing 0%, which would render a
              // full column of work as "not started".
              columnId: id, total: countRows(sheetId), byStatus: {}, stale: 0,
              completed: 0, pct: 0, computing: true, computedAt: 0,
            },
      );
      continue;
    }

    out.push(getColumnStats(id, sheetId));
  }
  return out;
}

/** Force a recompute — used after a run finishes, so the final numbers are exact. */
export function refreshColumnStats(columnIds: Iterable<number>, sheetId: string): ColumnStats[] {
  const out: ColumnStats[] = [];
  for (const id of columnIds) {
    cache.delete(id);
    out.push(getColumnStats(id, sheetId));
  }
  return out;
}

export function clearStatsCache(): void {
  cache.clear();
  // The tombstones go with it, or the next invalidation of a column cleared before this call would
  // believe the disk had already been dealt with.
  clearedOnDisk.clear();
}

// ─────────────────────────────────────────────────────────────── background warming
//
// A column's first-ever compute costs ~400ms. Doing that for eleven columns inside a request means a
// ~4.5s response; making the client poll until it converges is worse. Instead the work is scheduled
// ONE COLUMN PER TICK, so the event loop stays responsive between them, and each result is pushed as
// it lands. It happens once per column ever, because the result is persisted.

const warming = new Set<string>();
type StatsPush = (stats: ColumnStats[]) => void;
let pushStats: StatsPush | null = null;

/** Wired at boot to the SSE bus. Kept as a hook so this module has no dependency on transport. */
export function onStatsComputed(fn: StatsPush): void { pushStats = fn; }

export function warmSheetStats(sheetId: string): void {
  if (warming.has(sheetId)) return;

  const pending = (db.prepare("SELECT id FROM columns WHERE sheet_id = ? AND deleted_at IS NULL ORDER BY position").all(sheetId) as any[])
    .map((c) => Number(c.id))
    .filter((id) => {
      // Pull from disk first: a persisted snapshot is free and may already be fresh, which saves the
      // ~400ms recompute. Then apply the SAME freshness test the request path uses, so every column
      // it refused to serve is a column this warms.
      if (!cache.has(id)) hydrate(id);
      return !isFresh(cache.get(id));
    });

  if (pending.length === 0) return;
  warming.add(sheetId);

  const step = (): void => {
    const id = pending.shift();
    if (id == null) { warming.delete(sheetId); return; }
    try {
      const stats = getColumnStats(id, sheetId);
      pushStats?.([stats]);
    } catch { /* a column that fails to compute must not stall the rest */ }
    // Yield between columns so a 400ms compute cannot block the grid's own requests back to back.
    setTimeout(step, 0).unref?.();
  };
  setTimeout(step, 0).unref?.();
}
