// "Keep this column up to date by itself."
//
// Auto-run means "re-run what went out of date", so it rests on two other things being true: the
// stale cascade has to mark cells out of date, and script columns have to record their dependencies
// so there is a graph saying what "downstream" means. The three are one feature and none of them
// works alone.
//
// ── What makes this safe to leave switched on ────────────────────────────────────────────────────
//
// A COLUMN THAT BILLS PER ROW MAY USE THIS. Refusing the toggle outright on a paid lane protects
// the wrong thing: importing a list and watching the enrichment fill itself is the single reason
// anyone turns this on, and a tool that cannot do it is worse at the job people arrive with than the
// ones it replaces.
//
// What bounds the bill instead is `columns.auto_run_budget_usd`, read at flush and handed to the run
// as its own `budgetUsd`. The switch being per column and flipped by hand is the deliberate act; the
// ceiling is what stops that act turning into an open-ended one months later, when an import lands
// and the person who flipped it is not in the room. A NULL ceiling is allowed, because a person can
// genuinely mean "no limit" — what matters is that they were shown the consequence when they chose
// it, which is the settings panel's job, not this module's.
//
// The rest of the old rule still holds and is enforced elsewhere: nothing ESCALATES to a dearer
// model on its own, nothing retries on a better model, and being unsure flags the row rather than
// spending on it. Deciding to keep a named column current is a choice a person makes once. Deciding
// mid-run that this row deserves a more expensive answer is not.
//
// It creates an ORDINARY RUN. Not a hidden background write: it appears in the run strip, it is
// cancellable, it is subject to the sheet and per-run budgets, it honours the column's run
// condition, and the engine's unchanged-row skip means rows whose inputs did not actually move cost
// nothing. Anything auto-run can do, pressing Run could have done.
//
// It also COALESCES, and that matters far more now that it can spend. An import of 100,000 rows is
// one run, not 100,000 — changes are collected for a moment and then acted on together, so the
// ceiling applies to the whole burst rather than being reset by each write inside it.

import { db } from "./db.ts";
import { transitiveDownstream } from "./refs.ts";
import { isLocalModel } from "./providers/local.ts";
import { parseWaterfall, waterfallSpends } from "./waterfall.ts";

/**
 * The lanes that cost money per row.
 *
 * `http` and `mcp` are in here even though Ferrum cannot see their price: the user's own endpoint or
 * provider is billing them, and "we do not know the rate" is not the same as "there is no rate".
 */
const PAID_KINDS = new Set(["ai", "agent", "http", "mcp", "waterfall"]);

/**
 * Does this column cost nothing to run?
 *
 * It is not a permission check, and the name says so. The body computes "is this free", and every
 * caller wants that answer for its own reason rather than to refuse something: the settings panel to
 * decide whether to warn and whether to offer a ceiling, `schedules.ts` to label the schedules that
 * spend.
 *
 * Free means: a lane that never calls out, or a waterfall whose every enabled step is free, or a
 * model column whose every reachable model is local.
 */
export function isFreeToRun(
  // `waterfall_json` is REQUIRED, not optional, and that is load-bearing. Optional, a caller whose
  // SELECT forgot the column passes `undefined`, which parses as no steps, which reads as "spends
  // nothing" — a paid waterfall silently cleared to run itself unattended. Required makes that a
  // compile error instead of a bill.
  row: { kind: string; model: string | null; first_model: string | null; waterfall_json: string | null },
): boolean {
  if (!PAID_KINDS.has(row.kind)) return true;

  // A waterfall is only as free as its most expensive step, and it is asked directly rather than
  // guessed at from the column's own `model` — which a waterfall column does not use for anything.
  // Reading it here rather than treating every waterfall as paid means a column of script and lookup
  // steps keeps itself current for nothing, which is exactly the case the toggle is for.
  if (row.kind === "waterfall") {
    const { waterfall } = parseWaterfall(row.waterfall_json ?? null);
    return !waterfallSpends(waterfall, isLocalModel);
  }

  // Only the model lanes can be free, and only when every model they could reach is local. A cheap
  // FIRST model does not make the column free — the whole point of that setting is that some rows
  // end up on the expensive one.
  if (row.kind !== "ai" && row.kind !== "agent") return false;
  const m = (row.model ?? "").trim();
  if (!m || m === "auto") return false;
  if (!isLocalModel(m)) return false;
  const f = (row.first_model ?? "").trim();
  return !f || isLocalModel(f);
}

/**
 * How long changes are collected before a run starts.
 *
 * Long enough that a burst — an import, a paste, a run filling an upstream column — lands as one
 * run rather than a run per write. Short enough that editing one cell feels like it reacted.
 */
const COALESCE_MS = 2000;

/**
 * Starts a run. Registered by the boot file rather than imported, because runs.ts already imports
 * refs.ts and this would close the cycle — and because a module that can start a paid run should not
 * be able to do so merely by being imported. In tests nothing registers one, so nothing auto-runs.
 */
export type RunStarter = (
  sheetId: string,
  columnId: number,
  rowIds: number[] | null,
  /** The column's ceiling for this firing, in dollars. Null means no ceiling. */
  budgetUsd: number | null,
) => void;

let starter: RunStarter | null = null;
export function registerAutoRunStarter(fn: RunStarter): void { starter = fn; }

/** sheetId -> columnId -> row ids, or null meaning "every row of this sheet". */
const pending = new Map<string, Map<number, Set<number> | null>>();
let timer: NodeJS.Timeout | null = null;

/**
 * Why the last firing of a column produced no run, by column id.
 *
 * A refusal used to be swallowed here with a comment saying the next change would queue it again.
 * That holds for a change to an upstream cell and does NOT hold for `noteRowsArrived`, whose trigger
 * is an import: refuse that flush and nothing re-queues those rows, so they stay blank with the
 * reason recorded nowhere at all. `schedules.ts` writes its refusals onto the schedule for the same
 * reason — a run that quietly does nothing is indistinguishable from a broken one.
 *
 * In memory rather than on the column, because the columns table has nowhere to put it; the console
 * line beside it is what survives a restart.
 */
const refusals = new Map<number, string>();

/** Why nothing ran for this column last time it was queued, or null if the last firing was fine. */
export function autoRunRefusal(columnId: number): string | null {
  return refusals.get(Number(columnId)) ?? null;
}

/** Exposed so a test can drive the queue without waiting on a timer. */
export function pendingCount(): number {
  let n = 0;
  for (const cols of pending.values()) n += cols.size;
  return n;
}

/**
 * An upstream column changed. Work out what should re-run itself, and queue it.
 *
 * Called from the same place the stale cascade runs, with the column that CHANGED — not the ones
 * that went stale. The downstream set is derived here so the caller does not have to know which of
 * them happen to have the toggle on.
 */
export function noteUpstreamChange(sheetId: string, changedColumnId: number, rowIds: number[] | null): void {
  if (!starter) return;

  const downstream = transitiveDownstream(sheetId, Number(changedColumnId));
  if (downstream.length === 0) return;

  // Only the ones asking to keep themselves current, and only columns that still exist. Paid ones
  // included: the ceiling, not a veto, is what bounds them now, and it is read at flush.
  const auto = db
    .prepare(
      `SELECT id FROM columns
        WHERE id IN (${downstream.map(() => "?").join(",")})
          AND auto_run = 1 AND deleted_at IS NULL`,
    )
    .all(...downstream) as Array<{ id: number }>;
  if (auto.length === 0) return;

  let sheet = pending.get(sheetId);
  if (!sheet) { sheet = new Map(); pending.set(sheetId, sheet); }

  for (const { id } of auto) {
    const columnId = Number(id);
    if (!sheet.has(columnId)) {
      sheet.set(columnId, rowIds == null ? null : new Set(rowIds));
      continue;
    }
    const existing = sheet.get(columnId);
    // Once a whole-sheet change is queued, adding individual rows narrows nothing — null wins.
    if (existing == null) continue;
    if (rowIds == null) { sheet.set(columnId, null); continue; }
    for (const r of rowIds) existing.add(r);
  }

  schedule();
}

/**
 * New rows arrived — from a CSV import or a webhook delivery.
 *
 * Different from a value CHANGING, and it needs its own door. New rows have no upstream cell whose
 * write could be noticed: `insertRows` writes the imported values straight in, so nothing passes
 * through the cell-write paths that carry `noteUpstreamChange`. Without this, the settings panel's
 * promise that an auto-run column reacts "on an import" stayed false — which is the single most
 * useful case for the toggle, since importing a list and watching the enrichment fill itself is the
 * reason anyone turns it on.
 *
 * Every auto-run column on the table is queued for EVERY row, not just the new ones. That sounds
 * wasteful and is not: the engine skips any row whose inputs have not changed since it last ran, so
 * rows that were already computed cost nothing, and the alternative — tracking exactly which rows an
 * import created — is a second source of truth that can disagree with the first.
 */
export function noteRowsArrived(sheetId: string): void {
  if (!starter) return;

  const auto = db
    .prepare("SELECT id FROM columns WHERE sheet_id = ? AND auto_run = 1 AND deleted_at IS NULL")
    .all(sheetId) as Array<{ id: number }>;
  if (auto.length === 0) return;

  let sheet = pending.get(sheetId);
  if (!sheet) { sheet = new Map(); pending.set(sheetId, sheet); }
  for (const { id } of auto) sheet.set(Number(id), null);

  schedule();
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; flush(); }, COALESCE_MS);
  // Never hold the process open for a queued auto-run. Shutting down mid-coalesce should exit, and
  // the work is not lost — the cells are still marked out of date and the next change re-queues it.
  timer.unref?.();
}

/** Start a run for everything queued. Exported so a test can drive it without the timer. */
export function flush(): number {
  if (!starter) { pending.clear(); return 0; }

  const work: Array<{ sheetId: string; columnId: number; rowIds: number[] | null; budgetUsd: number | null }> = [];
  for (const [sheetId, cols] of pending) {
    for (const [columnId, rows] of cols) {
      /**
       * The ceiling is read HERE, not when the change was noted.
       *
       * A change can sit in the queue for a couple of seconds, and lowering a limit is something
       * people do precisely because a run is about to happen. Reading it at note time would honour
       * the number that was set when the row was touched, which is the older one and always the
       * larger of the two in the case that matters.
       *
       * A column deleted mid-coalesce returns no row. It gets no ceiling and no run, because the
       * starter below will find nothing to run either.
       */
      const row = db
        .prepare("SELECT auto_run_budget_usd FROM columns WHERE id = ? AND deleted_at IS NULL")
        .get(columnId) as { auto_run_budget_usd: number | null } | undefined;
      if (!row) continue;
      work.push({
        sheetId,
        columnId,
        rowIds: rows == null ? null : [...rows],
        budgetUsd: row.auto_run_budget_usd == null ? null : Number(row.auto_run_budget_usd),
      });
    }
  }
  pending.clear();

  for (const w of work) {
    try {
      starter(w.sheetId, w.columnId, w.rowIds, w.budgetUsd);
      refusals.delete(w.columnId);
    } catch (e) {
      // Recorded, never thrown: one column's refusal must not take down the write that triggered it,
      // and the usual refusal — a run is already working this column — is not a failure, because that
      // run is about to produce the values anyway.
      //
      // But it is not nothing either, and swallowing it in silence was the actual bug. A retired
      // model, a missing provider key and an unset connected app all land here too, and after an
      // import there is no second change coming to queue the work again: the rows simply stay blank,
      // with the reason nowhere on screen, in the log, or in the database.
      const msg = e instanceof Error ? e.message : String(e);
      refusals.set(w.columnId, msg);
      console.error("[auto-run] column", w.columnId, "did not start:", msg);
    }
  }
  return work.length;
}
