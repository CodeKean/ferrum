// Whether a run may replace a cell the user typed in.
//
// ── Why this is its own module ─────────────────────────────────────────────────────────────────
//
// Because the guard has to be applied in two places that cannot import each other. The run engine
// writes cells for the paid, send, lookup and rollup lanes; the script runner writes them for the
// script lane, in its own transaction, and `runs.ts` imports IT. Putting the helper in either one
// makes a cycle, and the alternative — a second copy — is exactly how one lane ends up honouring the
// setting and the other quietly ignoring it. That is not hypothetical: the first version of this
// change patched the four sites in the run engine and missed the script lane entirely, and only a
// test that actually ran a script column caught it.
//
// ── The default is protection ──────────────────────────────────────────────────────────────────
//
// A hand edit is a deliberate act, and silently overwriting one is the single thing a spreadsheet
// must never do. Every run created before this existed, and every run that does not ask, leaves
// typed values alone.

import { db } from "./db.ts";

/**
 * Runs allowed to overwrite hand-typed cells.
 *
 * Cached because the guard is evaluated on every write of every row — a database read there would
 * be a query per cell on a million-row run, for a value that cannot change once a run has started.
 */
const cache = new Map<string, boolean>();

/**
 * Whether this run may replace hand-typed cells.
 *
 * Reads the run row on a miss rather than assuming false, which is what makes a run RESUMED after a
 * crash behave the way it did before it. Without that, a resumed run would silently start protecting
 * the very cells it had been told to replace — half the rows updated, half not, for a reason nothing
 * on screen could explain.
 *
 * An absent run id means no run: a dry run, or a preview. Those never overwrite.
 */
export function overwritesEdited(runId: string | undefined | null): boolean {
  if (!runId) return false;
  const known = cache.get(runId);
  if (known != null) return known;
  let on = false;
  try {
    const row = db.prepare("SELECT overwrite_edited FROM runs WHERE id = ?").get(runId) as any;
    on = !!row?.overwrite_edited;
  } catch {
    // A database that cannot answer must not be read as permission to overwrite.
    on = false;
  }
  cache.set(runId, on);
  return on;
}

/** Called when a run is created, so the first cell does not pay for a lookup. */
export function noteRunOverwrite(runId: string, on: boolean): void {
  cache.set(runId, on);
}

/**
 * The clause that protects a hand-typed cell, or nothing.
 *
 * Two fixed literals chosen by a boolean — no user input goes anywhere near this string. Built
 * rather than parameterised because a WHERE clause cannot be a bound parameter, and the alternative
 * is two near-identical copies of every statement, which is how one of them loses the guard.
 */
export const pinGuard = (runId: string | undefined | null): string =>
  overwritesEdited(runId) ? "" : " AND pinned = 0";

/**
 * Clears the hand-typed marker alongside the value, when a run overwrites one.
 *
 * The marker means "you typed this". Once a run has replaced it that is false, and a cell still
 * carrying it would misreport its own history — including to the NEXT run, which would then protect
 * a value nobody typed.
 */
export const pinClear = (runId: string | undefined | null): string =>
  overwritesEdited(runId) ? ", pinned = 0" : "";
