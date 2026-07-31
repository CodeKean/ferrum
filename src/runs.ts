// The run engine: turning a scope into work, executing it, and reporting progress.
//
// ── The shape that matters ────────────────────────────────────────────────────────────────────
// Columns fall into two execution shapes, and conflating them is the mistake that would throw away
// the whole cost model:
//
//   BATCH lane   (script, derived, formula) — the entire column runs in ONE pass. A million rows in
//                seconds. Creating a job per cell here would mean a million queue rows and a million
//                transactions to do work that takes eleven seconds as a single stream.
//
//   PER-CELL lane (ai, agent, mcp, http) — genuinely one unit of spend per row, so it gets a durable
//                job row each, with concurrency, retries, and an auth gate.
//
// A run walks its columns in TOPOLOGICAL order and picks the right shape for each.

import { createHash, randomUUID } from "node:crypto";
import { db, tx, cellId, getKv } from "./db.ts";
import { emitColumnStats, emitRun, flushNow, markCellsDirty } from "./bus.ts";
import { resolveScope, type RunScope } from "./scope.ts";
import { checkValue } from "./validate.ts";
import { markDownstreamStale, parseRefs, topoDepths } from "./refs.ts";
import { noteUpstreamChange } from "./autoRun.ts";
import { assertRunnable } from "./scripts.ts";
// Error text is redacted on the way INTO the database, not only on the way out to a browser.
// It was wired into the SSE broadcast alone, which protected the screen and left the stored copy
// intact — and the stored copy is the one that gets backed up, copied to another machine, and handed
// over when someone asks what went wrong. An HTTP column's URL is written by the user, and putting a
// key in a query parameter is how a great many APIs document themselves.
import { redactSecrets } from "./redact.ts";
import { noteRunOverwrite, pinClear, pinGuard } from "./pinGuard.ts";
import { MAX_FREE_RETRIES, SCHEMA_MAX_ATTEMPTS } from "./errorClass.ts";
import { recordSaving } from "./savings.ts";
import { Pacer } from "./pace.ts";
import { takeRunSnapshot } from "./snapshots.ts";
import { runScriptColumn } from "./runtime/scriptRunner.ts";
import { refreshDerivedColumn, refreshChildren, derivedChildren } from "./derive.ts";
import { noteRelationChange, refreshLookupColumn } from "./lookup.ts";
import { refreshRollupColumn } from "./rollup.ts";
import { recordUsage } from "./usage.ts";
import { getMcpServer } from "./mcp/servers.ts";
import { closeRunPool } from "./mcp/client.ts";
import { assertModelProviderReady } from "./providers/keys.ts";
import { cachedModel, catalogLoaded, listModels } from "./providers/catalog.ts";
import { DEFAULT_MODEL, effectiveDefaultModel } from "./providers/resolve.ts";
import { isLocalModel } from "./providers/local.ts";
import { splitModelId } from "./providers/registry.ts";
import { getColumn, getSheet } from "./store.ts";
import {
  applyWrite, buildWriteItems, emptyBuildStats, ensureBackRefColumn, resolveSendScope, targetOf,
  DEFAULT_SEND, type RowOutcome, type SendConfig,
} from "./writeTarget.ts";
import { markColumnDirty, refreshColumnStats } from "./columnStats.ts";
import type { ErrClass, RunStatus } from "./types.ts";

/** Lanes that spend money per row, and therefore need the auth gate and a concurrency limit. */
//  is here because it is per-row and needs the queue, the abort signal and the progress
// counter — not because it spends anything. It is the one lane in this set that is free.
const PER_CELL_KINDS = new Set(["ai", "agent", "mcp", "http", "waterfall", "wait"]);

/** RAM-bound, not quota-bound: each agent subprocess is ~1 GiB. */
const DEFAULT_CONCURRENCY = 6;

/**
 * SQLite binds at most 32,766 parameters in one statement, so anything that puts a row id per row
 * into an IN-list has to be chunked. Learned the hard way: a gated run over 32,766 rows threw "too
 * many SQL variables" and died with its cells stuck mid-flight. 2,000 matches the script lane's
 * batch size, so both lanes move through a column in the same steps.
 */
const ID_CHUNK = 2000;

/** A run in one of these states is FINISHED. Nothing may move it, re-stamp it, or add to its counts. */
const TERMINAL_STATUSES = new Set<RunStatus>(["done", "failed", "cancelled"]);

/**
 * A run in one of these is STOPPED WITH WORK LEFT — not finished, and Resume is what it is waiting for.
 *
 * One exported set rather than a list written out wherever the question is asked, because the list
 * grew and the copies did not: `paused_budget` was added for the spending cap and the schedule
 * ticker's "is my last run still going" check never learned about it. A schedule whose run stopped at
 * its ceiling therefore looked idle, so the next window started a fresh run and spent the whole
 * ceiling again — every window, indefinitely, while the paused runs piled up.
 */
export const PAUSED_STATUSES = new Set<RunStatus>(["paused", "paused_quota", "paused_auth", "paused_budget"]);

/**
 * Cell states that mean "this pass has not produced an answer yet".
 *
 * Used by resume: a cell already stamped with this run's id and holding a value, an error or a skip
 * is work the run has DONE, and re-running it would spend a second time on something the user has
 * already paid for.
 */
const UNFINISHED_CELL_STATUSES = new Set(["queued", "running"]);

export interface StartRunInput {
  sheetId: string;
  scope: RunScope;
  /** Skip the input-hash short circuit and recompute even unchanged cells. */
  force?: boolean;
  /**
   * Stop this run once it has spent this much. Null or absent means no per-run ceiling.
   *
   * `budgetExceeded` READS `runs.budget_usd` before every cell, so something has to write it. A
   * column that is checked and never set is a cap that looks implemented and cannot be turned on.
   * Schedules and auto-running columns are the two writers.
   *
   * It is the more useful of the two for the case people actually worry about — "I am about to run
   * a paid column over 200,000 rows and I want a hard stop at $20" — because a sheet cap counts
   * everything ever spent on the table, so it cannot express a ceiling for one run.
   */
  budgetUsd?: number | null;
  /**
   * Replace cells the user typed in, instead of leaving them alone.
   *
   * OFF unless asked for, and that default is not negotiable: a hand edit is a deliberate act, and
   * silently overwriting one is the single thing a spreadsheet must never do. But "never, under any
   * circumstances" was its own problem — someone who pasted a hundred placeholder values, or fixed
   * ten cells before deciding the column's prompt was wrong, had no way to hand those rows back to
   * the column short of clearing them by hand, one at a time.
   *
   * When it is on, the run also CLEARS the hand-typed marker on the cells it replaces: the value is
   * no longer the one that was typed, and a cell still claiming "edited by you" would be a lie that
   * outlives the edit.
   */
  overwriteEdited?: boolean;
  /**
   * How many rows this run is a SAMPLE of, when it is one.
   *
   * A sample run is an ordinary run over a handful of spread-out row ids — nothing about executing it
   * is special, and its results are kept rather than thrown away, because rows that were paid for
   * should stay bought. The one thing it needs to remember is the size of the set it was drawn from,
   * since a forecast of "and the rest will cost X" is meaningless without it, and by the time the
   * forecast is read the scope that produced it is gone.
   */
  sampleOfRows?: number;
  /**
   * The schedule that started this run, when one did.
   *
   * Stamped on the row so a schedule's spend — the last firing, and the total across every firing —
   * is a query over the runs themselves. A counter kept beside them would be a second record of the
   * same money, and two records of the same money disagree eventually.
   */
  scheduleId?: number;
  /**
   * Who pressed Run.
   *
   * Null on a single-user install, where the question has one answer. On a shared instance it is the
   * only thing that makes spend answerable: "who ran the agent column over 40,000 rows" has to be a
   * query over the runs, not a guess from the timestamps.
   */
  startedBy?: number | null;
}

export interface RunSummary {
  id: string;
  sheetId: string;
  status: RunStatus;
  total: number;
  done: number;
  errors: number;
  skipped: number;
  costUsd: number;
  startedAt: string | null;
  finishedAt: string | null;
  pauseReason: string | null;
  /** Plain-English scope description, so a paused run can explain itself later. */
  summary: string;
  /** Which columns this run touches, so the header can show live bars on exactly those. */
  columnIds: number[];
}

// In-process control flags. The DB is the durable record; these make cancel responsive without
// polling a table on every row.
const cancelling = new Set<string>();
const paused = new Set<string>();

/**
 * Runs that have an executor in THIS process right now.
 *
 * Resume re-enters execution, and so would a second click on Resume, a retry from the UI, or a
 * resume racing the original run's own tail. Two executors on one run means two writers on the same
 * cells, twice the spend on every paid column, and two terminal blocks racing to stamp the record —
 * so entering twice is refused rather than merely discouraged.
 */
const live = new Set<string>();

/**
 * Runs whose Resume arrived while they were still `live`, and so could not be acted on yet.
 *
 * Refusing to enter twice is right; treating that refusal as "nothing to do" was not. See
 * `resumeRun` for what the no-op cost, and the tail of `executeRun` for where it is made good.
 */
const resumeWhileLive = new Set<string>();

/**
 * One abort signal per live run — the thing that makes Stop mean STOP.
 *
 * Without it, cancelling only stopped the queue from handing out MORE rows. Every cell already in
 * flight ran to completion: at concurrency 6 on the agent lane that is six more full agent runs,
 * each doing its own web searches, continuing to spend for as long as their timeouts allowed, all
 * after the user had pressed Stop and watched the run report itself cancelled.
 *
 * The signal is threaded down to the provider's fetch, so aborting tears down the socket rather than
 * politely waiting for a reply nobody wants.
 */
const aborters = new Map<string, AbortController>();

function aborterFor(runId: string): AbortController {
  let a = aborters.get(runId);
  if (!a) {
    a = new AbortController();
    // A run cancelled before this lane started must not be handed a fresh, un-aborted signal — that
    // is a signal that says "carry on" about a run the user has already stopped.
    if (cancelling.has(runId)) a.abort();
    aborters.set(runId, a);
  }
  return a;
}

/** A sleep that wakes on abort. A retry backoff that ignored the signal would keep a cancelled run alive for its full delay and then spend again on the other side of it. */
function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done, { once: true });
  });
}

// ─────────────────────────────────────────────────────────────── creating a run

/**
 * Refuse a second run over a column another run is already working.
 *
 * Measured on the shipping build: two overlapping runs both executed in full — 8,000 cell writes
 * where one run does 4,000 — because nothing ever asked. On a paid column that is the same cell
 * bought twice, and the two writers race for the same row, so the value that survives is whichever
 * finished last rather than whichever was asked for last.
 *
 * COLUMN granularity, not row. Resolving every active run's row set means a full scope resolution
 * per run on the create path — the one screen whose own comment says it has to feel instant — and
 * two runs on one column is the case that actually double-spends.
 *
 * Only `running` and `cancelling` block, and that is deliberate in both directions:
 *   - `pending` is a window that closes in the same tick (the route enters `executeRun` synchronously)
 *     and NOTHING heals it — `recoverAfterRestart` only touches running/cancelling — so blocking on
 *     it would let one interrupted request brick a column's Run button permanently;
 *   - a PAUSED run is executing nothing, and refusing every future run until somebody remembers to
 *     resume it is a worse failure than the one being prevented.
 */
/**
 * Refuse a run whose model has been retired.
 *
 * Providers sunset model ids routinely, and a column pointed at a retired one fails on EVERY row —
 * so this is not a cost check, it is the difference between one clear refusal and a hundred thousand
 * identical failures with a bill for the retries.
 *
 * The confirm dialog already disabled its button for this, and that was the whole of the protection:
 * a client-side guard on one screen. Anything not going through that dialog — the API directly, and
 * as of today an auto-run column, which calls straight into `createRun` — walked past it. Building
 * auto-run is what made a client-only gate untenable, so the gate moved to where every path meets.
 *
 * Only when the price list has actually been READ. `cachedModel` returns null both for a model that
 * does not exist and for a list nobody has fetched yet, and treating a cold cache as evidence of a
 * sunset would refuse every paid run for the first seconds after boot, or whenever OpenRouter is
 * briefly unreachable. Unknown is not the same as gone, and only one of them is worth blocking.
 */
function assertModelsStillExist(columnIds: number[]): void {
  if (!catalogLoaded()) return;

  const gone = new Map<string, string>();
  for (const id of columnIds) {
    const col = getColumn(id);
    if (!col || (col.kind !== "ai" && col.kind !== "agent")) continue;
    const modelId = col.model && col.model !== "auto" ? col.model : effectiveDefaultModel();
    // A local model is not on anyone's published list and never will be.
    if (isLocalModel(modelId)) continue;
    // Nor is a model reached DIRECTLY from its vendor. The catalogue this checks against is
    // OpenRouter's price sheet and nothing else, so `claude-sonnet-4` bought straight from Anthropic
    // is absent from it — not retired, just not listed there. Without this line every direct-provider
    // column would be refused as sunset the moment the sheet loaded, which is the same "looks built
    // and isn't" failure as never wiring the provider at all.
    if (splitModelId(modelId).provider !== "openrouter") continue;
    if (!cachedModel(modelId)) gone.set(modelId, col.name);
  }
  if (gone.size === 0) return;

  const parts = [...gone].map(([model, name]) => `"${name}" is set to ${model}`);
  throw new Error(
    `This run was not started, because ${parts.join(", and ")} — which the provider no longer ` +
      `offers. Every row would fail. Pick a current model on the column's Mode tab.`,
  );
}

function assertNoOverlappingRun(sheetId: string, columnIds: number[]): void {
  const wanted = new Set(columnIds.map(Number));
  for (const r of db
    .prepare("SELECT id, scope_json FROM runs WHERE sheet_id = ? AND status IN ('running','cancelling')")
    .all(sheetId) as any[]) {
    let theirs: number[] = [];
    try {
      const s = JSON.parse(r.scope_json ?? "{}");
      // The RESOLVED list, because an empty request meant "everything runnable" at the time and the
      // requested list would be empty for exactly the widest run there is.
      theirs = (s?.resolvedColumnIds ?? s?.columnIds ?? []).map(Number);
    } catch { continue; } // a scope nobody can parse cannot be shown to overlap
    const clash = [...new Set(theirs.filter((id) => wanted.has(id)))];
    if (clash.length === 0) continue;

    const names = clash.map((id) => getColumn(id)?.name ?? `column ${id}`);
    const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");
    throw new Error(
      `A run is already working on ${shown}. Wait for it to finish, or stop it first — two runs on ` +
      "one column write over each other and pay for the same cells twice.",
    );
  }
}

export function createRun(input: StartRunInput): { run: RunSummary; resolved: ReturnType<typeof resolveScope> } {
  const resolved = resolveScope(input.sheetId, input.scope);
  if (resolved.rowCount === 0) throw new Error("Nothing matches that selection, so no run was started.");
  if (resolved.columnIds.length === 0) throw new Error("No runnable columns in that selection.");

  assertNoOverlappingRun(input.sheetId, resolved.columnIds);
  assertModelsStillExist(resolved.columnIds);

  // Refuse rather than start, if a column in scope needs credentials that are not there. This is the
  // gate that stops 200,000 jobs being enqueued against a dead token.
  //
  // Checked PER KIND, because they no longer need the same thing: `ai` and `agent` go through the
  // model provider, while `http` and `mcp` spend elsewhere. Asserting one credential for all of them
  // would both refuse runs that need nothing and wave through the ones that do — and a missing model
  // key that is not caught here surfaces as an error on every single row, which reads like an outage
  // rather than a setting.
  const cols = resolved.columnIds.map((id) => getColumn(id));
  const kinds = cols.map((c) => c?.kind ?? "static");
  // A column on a LOCAL model needs no hosted key. Demanding one would refuse a run that is about to
  // spend nothing and reach nothing outside this machine — which would make the free lane
  // unreachable for exactly the person who chose it to avoid signing up anywhere.
  const needsHostedKey = cols.some(
    (c) => c && (c.kind === "ai" || c.kind === "agent") && !isLocalModel(c.model ?? ""),
  );
  if (needsHostedKey) assertModelProviderReady();

  // An `mcp` column asserted the CLAUDE credential here, which was simply the wrong question: the
  // lane talks to a connected app the user registered, and most of those want no key at all. It
  // refused runs that were about to spend nothing on anything of Anthropic's. What it actually needs
  // is the app to still exist, checked here rather than discovered once per row mid-run.
  for (const c of cols) {
    if (!c || c.kind !== "mcp") continue;
    const serverId = String((c.mcpConfig as any)?.serverId ?? "");
    if (!serverId || !getMcpServer(serverId)) {
      throw new Error(`"${c.name}" uses a connected app that is not set up. Choose one in the column's Tool tab.`);
    }
  }

  const id = randomUUID();
  const sheet = getSheet(input.sheetId);

  tx(() => {
    db.prepare(
      // The bound values below must line up with this list one for one. They did not: there were
      // EIGHT placeholders and SEVEN arguments, so `schedule_id` silently took the trailing NULL on
      // every run ever created. Nothing failed — the driver fills a missing parameter — so a
      // schedule's spend, which is defined as a query over the runs it started, was a query over an
      // empty set. It read as $0.00 spent, forever, and the only way to notice was to already
      // suspect it.
      `INSERT INTO runs (id, sheet_id, kind, scope_json, status, total, budget_usd, overwrite_edited, schedule_id, started_by, started_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(
      id,
      input.sheetId,
      // A sample is labelled as one. It resolves through explicit row ids like any "run selected"
      // does, so without this it would appear in the run history as an ordinary small run and its
      // cost would read as the whole job's rather than as the down payment on it.
      input.sampleOfRows != null ? "sample"
        : input.scope.rowIds?.length ? "rows"
        : input.scope.viewId ? "column"
        : "sheet",
      // resolvedColumnIds, not the requested ones: an empty request means "every runnable column",
      // and the header needs the actual list to know which bars to drive.
      JSON.stringify({
        ...input.scope,
        // Both places, because the two ends disagree: the client sends `force` inside the scope and
        // the route reads it at the top level. Dropping it here is a silent no-op — the user asks
        // for a recompute and every unchanged cell is skipped anyway.
        force: input.force === true || input.scope.force === true,
        useStrongModel: input.scope.useStrongModel === true,
        resolvedColumnIds: resolved.columnIds,
        summary: resolved.summary,
        sheetName: sheet?.name,
        ...(input.sampleOfRows != null ? { sampleOfRows: input.sampleOfRows } : {}),
      }),
      resolved.rowCount * resolved.columnIds.length,
      // Only a positive, finite number is a cap. Zero would mean "stop before the first cell", which
      // nobody means by a budget and which would read as the run being broken.
      Number.isFinite(Number(input.budgetUsd)) && Number(input.budgetUsd) > 0 ? Number(input.budgetUsd) : null,
      input.overwriteEdited === true ? 1 : 0,
      Number.isFinite(Number(input.scheduleId)) ? Number(input.scheduleId) : null,
      Number.isFinite(Number(input.startedBy)) ? Number(input.startedBy) : null,
    );

    // The copy is taken HERE, inside the transaction that creates the run, because this is the last
    // moment at which nothing can have been written yet — the route enters executeRun synchronously
    // as soon as createRun returns. Taken afterwards it would be a copy of a column the run had
    // already started replacing, which is worse than no copy at all: it would look like a way back
    // and would not be one.
    takeRunSnapshot(id, input.sheetId, resolved.summary, resolved.columnIds, resolved.sql, resolved.params);
  });

  // Cached before the first cell is written, so the guard costs no lookup on the hot path.
  noteRunOverwrite(id, input.overwriteEdited === true);

  const run = getRun(id)!;
  emitRun(run);
  return { run, resolved };
}

export function getRun(id: string): RunSummary | null {
  const r = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as any;
  if (!r) return null;
  let summary = "";
  let columnIds: number[] = [];
  try {
    const scope = JSON.parse(r.scope_json);
    summary = scope?.summary ?? "";
    columnIds = (scope?.resolvedColumnIds ?? scope?.columnIds ?? []).map(Number);
  } catch { /* scope may predate summaries */ }
  return {
    id: r.id, sheetId: r.sheet_id, status: r.status,
    total: r.total, done: r.done_c, errors: r.error_c, skipped: r.skipped_c,
    costUsd: r.cost_usd, startedAt: r.started_at, finishedAt: r.finished_at,
    pauseReason: r.pause_reason, summary, columnIds,
  };
}

export function listRuns(sheetId: string, limit = 15): RunSummary[] {
  return (db.prepare("SELECT id FROM runs WHERE sheet_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(sheetId, limit) as any[])
    .map((r) => getRun(r.id)!)
    .filter(Boolean);
}

/** The status a run is in right now, straight from the record. Cheap: a primary-key point read. */
function statusOf(id: string): RunStatus | null {
  const r = db.prepare("SELECT status FROM runs WHERE id = ?").get(id) as any;
  return r ? (r.status as RunStatus) : null;
}

function setRunStatus(id: string, status: RunStatus, pauseReason?: string): void {
  // A finished run stays finished.
  //
  // Work still unwinding after a Stop must not write straight through. The run is marked cancelled,
  // and seconds later a column that has not noticed yet would re-stamp `finished_at` and set the
  // status back, so the record would say the run ended AFTER the user stopped it and a cancelled run
  // could quietly report itself done.
  const current = statusOf(id);
  if (current === null || TERMINAL_STATUSES.has(current)) return;

  db.prepare(
    `UPDATE runs SET status = ?, pause_reason = ?,
                     finished_at = CASE WHEN ? IN ('done','failed','cancelled') THEN datetime('now') ELSE finished_at END
      WHERE id = ?`,
  ).run(status, pauseReason ?? null, status, id);
  const run = getRun(id);
  if (run) emitRun(run);
}

function bump(id: string, field: "done_c" | "error_c" | "skipped_c", n: number): void {
  if (n === 0) return;
  // Counters stop when the run does, for the same reason: a total that keeps climbing after the run
  // is over is a number nobody can reconcile with what they watched happen.
  const current = statusOf(id);
  if (current === null || TERMINAL_STATUSES.has(current)) return;
  db.prepare(`UPDATE runs SET ${field} = ${field} + ? WHERE id = ?`).run(n, id);
}

type StoredScope = RunScope & { resolvedColumnIds?: number[]; summary?: string };

/**
 * The scope a run was created with, read back from its OWN record.
 *
 * Resume needs it long after the request that started the run has gone — and after a restart, so has
 * the process that held it. The run record is the only thing that survives, which is why the scope
 * is written into it at creation rather than kept in memory.
 */
function scopeOf(id: string): StoredScope {
  const r = db.prepare("SELECT scope_json FROM runs WHERE id = ?").get(id) as any;
  try { return JSON.parse(r?.scope_json ?? "{}") as StoredScope; } catch { return {}; }
}

/**
 * Record a run's failure. Mirrors what the create route does, so a run that dies inside a resume —
 * where nobody is holding the promise — reports itself exactly the same way.
 *
 * Deliberately writes the status directly: a failure must land even on a run that something else has
 * already marked terminal, or a crash disappears.
 */
function failRun(id: string, e: unknown): void {
  console.error("[run]", id, e);
  db.prepare("UPDATE runs SET status = 'failed', pause_reason = ?, finished_at = datetime('now') WHERE id = ?")
    .run(String(e instanceof Error ? e.message : e).slice(0, 500), id);
  const run = getRun(id);
  if (run) emitRun(run);
}

// ─────────────────────────────────────────────────────────────── control

export function cancelRun(id: string): void {
  cancelling.add(id);
  db.prepare("UPDATE runs SET cancel_requested = 1 WHERE id = ?").run(id);
  setRunStatus(id, "cancelling");

  // Tear down everything in flight FIRST, before touching any state. Every millisecond between the
  // click and this line is a millisecond of calls the user has already said they do not want.
  //
  // Only an aborter that already exists: minting one for an id nothing is running under leaves an
  // entry in the map that nothing will ever remove.
  aborters.get(id)?.abort();

  // Queued work is dropped; anything already finished KEEPS its value. Cancel means "stop
  // spending", not "undo".
  tx(() => {
    // `leased` too: a claimed job left behind by a stopped run is reclaimed by the next boot, which
    // would re-queue the very work the user stopped.
    db.prepare("UPDATE jobs SET status = 'cancelled', leased_at = NULL, lease_expires_at = NULL WHERE run_id = ? AND status IN ('ready','blocked','leased')").run(id);
    db.prepare(
      `UPDATE cells SET status = 'empty', rev = rev + 1
        WHERE status = 'queued'
          AND (row_id, column_id) IN (SELECT row_id, column_id FROM jobs WHERE run_id = ? AND status = 'cancelled')`,
    ).run(id);

    // Cells caught mid-flight get a TERMINAL state and a reason.
    //
    // Previously they were left as `running` and simply abandoned: the run reported itself
    // cancelled while a scatter of cells span forever, with nothing in the app able to clear them
    // short of a re-run. A stopped cell is not an error and not a success — it is a cell that was
    // interrupted, and it says so, so the next run can pick it up and the user knows which rows
    // were caught in the middle.
    db.prepare(
      `UPDATE cells SET status = 'cancelled', error_type = 'cancelled',
                        error_msg = 'Stopped before this finished. Run the column again to retry it.',
                        rev = rev + 1, updated_at = datetime('now')
        WHERE status IN ('running','queued')
          AND (row_id, column_id) IN (SELECT row_id, column_id FROM jobs WHERE run_id = ?)`,
    ).run(id);
  });

  // The grid is told, rather than finding out on its next scroll. Without this the stopped cells
  // keep their spinner on screen until something else happens to repaint them.
  const stopped = db
    .prepare(
      `SELECT row_id, column_id FROM cells
        WHERE status = 'cancelled'
          AND (row_id, column_id) IN (SELECT row_id, column_id FROM jobs WHERE run_id = ?)`,
    )
    .all(id) as Array<{ row_id: number; column_id: number }>;
  if (stopped.length > 0) {
    markCellsDirty(stopped.map((c) => cellId(Number(c.row_id), Number(c.column_id))));
    for (const c of new Set(stopped.map((s) => Number(s.column_id)))) markColumnDirty(c);
  }

  setRunStatus(id, "cancelled");
}

/** Called when a run finishes, however it finished. Leaking an aborter per run would grow forever. */
function releaseRun(id: string): void {
  aborters.delete(id);
}

/**
 * Stop a run where it stands, keeping what it has already done.
 *
 * `why` matters because the status is what the UI explains the stop WITH. Recording every pause as
 * `paused_quota` would tell a person who pressed Pause that a rate limit had stopped them: the app
 * blaming the provider for the user's own click. `paused` is the plain one; the quota and
 * auth variants stay for the cases that really are those things, because the resume advice differs
 * (wait, versus fix your key).
 */
export function pauseRun(
  id: string,
  reason = "Paused.",
  why: "user" | "quota" | "auth" | "budget" = "user",
): void {
  paused.add(id);
  setRunStatus(
    id,
    why === "quota" ? "paused_quota"
    : why === "auth" ? "paused_auth"
    // The spending limit the user themselves set. Reported as a rate limit, it was the one pause
    // they chose being blamed on the provider — and the advice ("wait") was the opposite of the
    // useful one ("raise it or accept it").
    : why === "budget" ? "paused_budget"
    : "paused",
    reason,
  );
}

/**
 * Pick the work a paused or interrupted run still owes, and go and do it.
 *
 * Resume has to re-enter execution rather than flip two flags and a status string. If `executeRun`'s
 * only caller were the route that creates a run, every crash-interrupted run (recovery parks them all
 * at `paused_quota`, and the boot banner tells the user to resume from the UI) would be a dead end,
 * and so would every run that hit its budget.
 *
 * The scope is rebuilt from the run's own record rather than remembered, because the process that
 * started it may not be this one. It CONTINUES rather than repeats: each column is narrowed to the
 * cells this run has not already written, which is what makes resuming safe to press on a run that
 * has spent real money.
 */
export function resumeRun(id: string): void {
  const run = getRun(id);
  if (!run) throw new Error("That run no longer exists.");
  // Finished is finished. Resuming a done or cancelled run would walk every column from the top,
  // which on a paid lane means paying twice for work the user already has.
  if (TERMINAL_STATUSES.has(run.status)) {
    throw new Error("That run has already finished. Start a new run to do more work.");
  }

  paused.delete(id);
  cancelling.delete(id);
  db.prepare("UPDATE runs SET cancel_requested = 0, pause_reason = NULL WHERE id = ?").run(id);
  setRunStatus(id, "running");

  /**
   * Already executing here — but that is not the same as "the flags above were all it was waiting
   * on", which is what this used to assume.
   *
   * A worker inside a cell can take minutes on the agent lane, and its siblings have already left
   * the column on the pause flag. Returning here left that Resume as a no-op: the column's
   * undispatched rows stayed undispatched, and the run went on to stamp itself finished over them.
   * So it is remembered instead, and acted on when the pass that could not be joined lets go.
   */
  if (live.has(id)) { resumeWhileLive.add(id); return; }
  resumeWhileLive.delete(id);

  const scope = scopeOf(id);
  const resolved = resolveScope(run.sheetId, {
    ...scope,
    // The columns the run actually resolved to, not the ones it was asked for: an empty request
    // meant "everything runnable" at the time, and a column added since is not part of this run.
    columnIds: scope.resolvedColumnIds ?? scope.columnIds,
  });

  // Fire and forget, like starting a run: a large resume must not be held open on the request.
  void executeRun(id, resolved, { onlyOutstanding: true }).catch((e) => failRun(id, e));
}

const isCancelled = (id: string) => cancelling.has(id) || Number((db.prepare("SELECT cancel_requested c FROM runs WHERE id = ?").get(id) as any)?.c ?? 0) === 1;

/**
 * Has this run been asked to stop, either way?
 *
 * Pause and cancel differ only in what they leave behind — both mean "no more work from here" — and
 * every lane has to honour both. Checking only cancel would let a paused run execute every remaining
 * column to completion, `send` columns included, and then sit at 100% calling itself paused with no
 * way out.
 */
const stopRequested = (id: string): boolean => paused.has(id) || isCancelled(id);

// ─────────────────────────────────────────────────────────────── the per-cell executor boundary
//
// The AI, agent, MCP and HTTP lanes all reduce to "given a row's inputs, produce one value". They
// are registered rather than imported so the queue, retries, cancellation, progress and the auth
// gate are all testable today with a fake executor and no provider access.

export interface CellJob {
  runId: string;
  sheetId: string;
  rowId: number;
  columnId: number;
  kind: string;
  attempt: number;
  /**
   * Aborted when the run is stopped. An executor that ignores this makes Stop take as long as the
   * slowest in-flight cell, so pass it to every fetch and every nested call.
   */
  signal?: AbortSignal;
  /**
   * Skip the column's cheap first model and go straight to the one it is configured with.
   *
   * The ONLY way a paid model is reached on a two-model column, and it is set from one place: a run
   * the user started on purpose, having seen what it would cost. Nothing in the engine sets this on
   * its own — that is the whole point of it existing as a flag rather than as a fallback.
   */
  useStrongModel?: boolean;
}

export interface CellOutcome {
  status: "done" | "not_found" | "error" | "skipped";
  valueText?: string | null;
  value?: unknown;
  errorType?: ErrClass;
  errorMsg?: string;
  costUsd?: number;
  durationMs?: number;
  /**
   * What actually answered, and what it consumed.
   *
   * `cells` and `cell_attempts` have had columns for all of this since the first phase and NOTHING
   * ever wrote them — the executor computed the token counts, priced them, and then kept only the
   * dollar figure. So the workspace could say what it had spent and could not say on what: no
   * per-model breakdown, no tokens, and no way to tell a column that is expensive because it is long
   * from one that is expensive because it runs on the wrong model.
   *
   * `model` is what ANSWERED rather than what was asked for — providers substitute, and attributing
   * spend to a model that never ran is worse than attributing none.
   */
  model?: string;
  /**
   * The instruction as it was actually sent, with this row's values already substituted.
   *
   * Not the column's prompt — that is on screen already and is the same on every row. This is the
   * one thing that explains why THIS row answered the way it did, and it is what the cell panel's
   * "Show what was sent" fold reads. See executeCell for why it took a wrapper to collect.
   */
  renderedPrompt?: string | null;
  /**
   * How sure the model said it was, and where it got the answer.
   *
   * `cells.confidence` and `cells.source_url` have existed since the first schema, `getCell` returns
   * both, the client types both — and NOTHING wrote either. The finish tool makes `confidence` a
   * REQUIRED field, so every answer this app has ever received carried one and every one was thrown
   * away on arrival.
   *
   * They are not decoration. "It answered, and it was not sure" is a different cell from "it
   * answered" — it is the row to check by hand, and it is the signal the escalate-when-unsure lane
   * decides on.
   */
  confidence?: "high" | "medium" | "low" | null;
  sourceUrl?: string | null;
  /**
   * How many turns the agent loop took, and what it finally handed back.
   *
   * `cell_attempts.num_turns` and `raw_result` are the last two of the fields that were declared in
   * the first schema and written by nothing. Both have been sitting in the loop's own result object
   * the whole time.
   *
   * Worth keeping for different reasons. Turns is the shape of the bill: an agent that answers in one
   * turn and one that grinds to eight cost wildly different amounts for the same cell, and the run
   * summary cannot tell you which. The raw envelope is what makes a schema failure diagnosable —
   * "the model said {found:true, value:{...}}" versus "it never called finish at all" are the same
   * error message today.
   */
  turns?: number;
  rawResult?: unknown;
  /**
   * Which half of a two-model column produced this: the cheap first try, or the escalation after it.
   *
   * Absent on a column that is not set up that way, which is every column by default. `model` already
   * says WHICH model answered; this says what that meant — a screen should not have to compare a
   * model id against a column setting to work out whether a row was cheap or expensive.
   */
  answeredBy?: "first" | "escalated";
  /**
   * Which STEP of a waterfall produced this, by name.
   *
   * A separate field rather than widening `answeredBy`, and not for tidiness: the savings ledger
   * decides what to credit by comparing `answeredBy === "first"`, so a free-text step name in that
   * field would be read as an escalation the moment somebody called a step "first". Two different
   * questions — which half of a two-model column, and which of N providers — kept as two fields.
   */
  answeredByStep?: string;
  /**
   * One sentence of context that is not an error.
   *
   * Today: why a two-model column escalated this row. Kept separate from `errorMsg` because a cell
   * carrying this is a SUCCESS — putting it in the error field would paint a working row red, and
   * the batch lane already writes `cells.note` for exactly this kind of remark.
   */
  note?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheRead?: number;
  cacheCreate?: number;
  /**
   * Third-party units this call burned, in the provider's own currency — credits, enrichments,
   * lookups.
   *
   * Kept beside the dollar figure rather than folded into it, because the units are what the
   * provider's own dashboard shows. A total in credits can be checked against the bill; a total in
   * dollars derived from a price someone typed cannot.
   */
  units?: number;
  unit?: string;
  /**
   * This answer came from the cache — nothing was bought.
   *
   * Carried on the outcome rather than inferred from a zero cost, because a genuinely free call and
   * a reused answer are different facts: one ran and one did not, and only the second is a saving.
   */
  fromCache?: boolean;
}

export type CellExecutor = (job: CellJob) => Promise<CellOutcome>;

/**
 * Did the cheap model actually settle this row, so the expensive call was genuinely never needed?
 *
 * `answeredBy: "first"` on its own does NOT say that, and reading it as if it did is what put
 * failures in the savings ledger. The executor stamps the same flag on the not-good-enough path —
 * the row where the cheap model was unsure, and where the cell's own note tells the user to re-run it
 * on the strong model. Every one of those was banked as a call avoided while the screen beside it
 * asked for that money to be spent after all.
 *
 * The bar is the executor's `goodEnough`, restated rather than imported on purpose: the executor is
 * REGISTERED with this module rather than imported by it, which is what keeps the queue, the budget
 * gate and the retries testable with no provider access at all.
 */
const answeredCheaply = (o: CellOutcome): boolean =>
  o.answeredBy === "first" && o.status === "done" && o.confidence === "high";

let executor: CellExecutor | null = null;
export function registerCellExecutor(fn: CellExecutor): void { executor = fn; }

/** Errors that must never burn an attempt or keep retrying. */
/**
 * Has this run, or the sheet it belongs to, spent its allowance?
 *
 * Returns the reason to show, or null. Checked before every cell, which is cheap: two indexed reads
 * against rows the run is already writing to, against a per-cell cost of a network round trip.
 *
 * The SHEET budget counts every run ever made against it, not just this one. A cap that reset per
 * run would be trivially defeated by starting a second run, which is exactly what someone does after
 * the first one stops.
 *
 * `pendingUsd` is what this run has DISPATCHED and not yet been billed for. Every figure below comes
 * from `runs.cost_usd`, which is written when a cell lands — so on its own this is check-then-act,
 * and with six workers the cap was always crossed by up to six cells that had already been bought.
 * Counting the money in the air against all three caps is what makes the check mean something; it
 * is not a reservation the caller can rely on being exact, so see `runPerCell` for what overshoot
 * is left.
 */
function budgetExceeded(runId: string, sheetId: string, pendingUsd = 0): string | null {
  const pending = Number.isFinite(pendingUsd) ? Math.max(0, pendingUsd) : 0;
  const run = db.prepare("SELECT cost_usd, budget_usd FROM runs WHERE id = ?").get(runId) as any;
  const runSpent = Number(run?.cost_usd ?? 0) + pending;
  const runCap = run?.budget_usd == null ? null : Number(run.budget_usd);
  if (runCap != null && runCap > 0 && runSpent >= runCap) {
    return `this run reached its $${runCap.toFixed(2)} limit`;
  }

  const sheet = db.prepare("SELECT budget_usd FROM sheets WHERE id = ?").get(sheetId) as any;
  const sheetCap = sheet?.budget_usd == null ? null : Number(sheet.budget_usd);
  if (sheetCap != null && sheetCap > 0) {
    const spent = pending + Number(
      (db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM runs WHERE sheet_id = ?").get(sheetId) as any).c,
    );
    if (spent >= sheetCap) return `this sheet reached its $${sheetCap.toFixed(2)} limit`;
  }

  /**
   * The WORKBOOK cap — the third of three, and the one that was storable and unenforced.
   *
   * `workbooks.budget_usd` has been in the schema since workbooks existed. It is copied when a
   * workbook is duplicated, so a copy faithfully carried a limit that had never stopped anything.
   * Nothing read it: the only two caps that worked were the run's and the sheet's.
   *
   * It is the one people actually want. A workbook is a project, and "this project may cost $200"
   * is the sentence somebody means — a per-table cap has to be set on every table and re-set on
   * every table added, which is how a workspace ends up with a cap on four tables and none on the
   * fifth.
   *
   * Counted over every table in the workbook INCLUDING the trashed ones. Money spent on a table
   * that was later deleted was still spent, and letting a delete reset the counter would make the
   * cap avoidable by tidying up.
   */
  const wb = db.prepare(
    `SELECT w.id, w.budget_usd FROM workbooks w JOIN sheets s ON s.workbook_id = w.id WHERE s.id = ?`,
  ).get(sheetId) as any;
  const wbCap = wb?.budget_usd == null ? null : Number(wb.budget_usd);
  if (wbCap != null && wbCap > 0) {
    const spent = pending + Number(
      (db.prepare(
        `SELECT COALESCE(SUM(r.cost_usd), 0) AS c FROM runs r
           JOIN sheets s ON s.id = r.sheet_id
          WHERE s.workbook_id = ?`,
      ).get(String(wb.id)) as any).c,
    );
    if (spent >= wbCap) return `this workbook reached its $${wbCap.toFixed(2)} limit`;
  }

  return null;
}

/**
 * What the engine does about a failure. The behaviour is unchanged; the CONSTANTS now come from
 * `errorClass.ts`, which is also what tells the user whether pressing the button again could help.
 *
 * Two functions on purpose. This one answers "should the engine try again, right now, mid-run" and
 * has four answers; `errorFacts` answers "should the user press the button", by which point every
 * retry this function allowed has already happened. Same rule, two questions — and a property test
 * asserts they cannot drift, because a panel that offers a re-run the engine will refuse is worse
 * than a panel with no button at all.
 */
export function retryPolicy(
  cls: ErrClass,
  attempt: number,
  maxAttempts: number,
  freeRetries = 0,
): "retry" | "retry_free" | "fail" | "pause_run" {
  switch (cls) {
    // A dead token costs ~3 minutes per cell in backoff. Retrying is how a run becomes a ten-hour
    // hang, so the whole run stops instead.
    case "auth": return "pause_run";
    // Not the cell's fault — retry without consuming an attempt, and let the breaker slow things.
    case "rate_limit": return freeRetries < MAX_FREE_RETRIES ? "retry_free" : "fail";
    case "budget": return "fail";     // raising a cap is the user's decision
    // Capped at one retry, but never MORE than the column allows: a column configured not to retry
    // must not retry, and a schema failure is no exception to that.
    case "schema": return attempt < Math.min(SCHEMA_MAX_ATTEMPTS, maxAttempts) ? "retry" : "fail";
    default: return attempt < maxAttempts ? "retry" : "fail";
  }
}

/**
 * How many goes one cell of this column gets.
 *
 * HTTP columns say so themselves, because the answer depends on the endpoint being called and only
 * the person who configured it knows whether a retry is safe. A webhook that creates a record is not
 * something to fire three times on a hiccup.
 */
function attemptsFor(column: { kind?: string; httpConfig?: unknown } | null | undefined): number {
  const cfg = (column as any)?.httpConfig;
  if (column?.kind !== "http" || !cfg) return 3;
  if (cfg.retryOnFailure === false) return 1;
  const n = Number(cfg.maxRetries);
  return Number.isFinite(n) ? Math.max(1, Math.min(6, Math.floor(n) + 1)) : 3;
}

// ─────────────────────────────────────────────────────────────── execution

export interface ExecuteOptions {
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
  /** Only cells in one of these statuses run. Defaults to the run's own scope — this is the override
   *  resume uses, which asks a different question of the same rows. */
  statuses?: string[];
  /** Resume: skip the cells this run has already written, whatever their status. */
  onlyOutstanding?: boolean;
}

/**
 * The rows in `rowIds` whose cell in this column satisfies `keep`.
 *
 * Chunked, because SQLite binds at most 32,766 parameters per statement and an IN-list over the
 * whole scope is a run that dies at 32,766 rows with its cells stuck. Order is preserved: the chunks
 * are walked in order and each row is tested in place.
 */
function filterByCell(
  columnId: number,
  rowIds: number[],
  keep: (cell: { status: string; runId: string | null }) => boolean,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < rowIds.length; i += ID_CHUNK) {
    const chunk = rowIds.slice(i, i + ID_CHUNK);
    const byRow = new Map<number, { status: string; runId: string | null }>();
    for (const c of db
      .prepare(
        `SELECT row_id, status, run_id FROM cells
          WHERE column_id = ? AND row_id IN (${chunk.map(() => "?").join(",")})`,
      )
      .all(columnId, ...chunk) as any[]) {
      byRow.set(Number(c.row_id), { status: String(c.status), runId: c.run_id == null ? null : String(c.run_id) });
    }
    // A row with no cell row at all reads as empty in the grid, so it reads as empty here too.
    for (const rowId of chunk) if (keep(byRow.get(rowId) ?? { status: "empty", runId: null })) out.push(rowId);
  }
  return out;
}

/**
 * Execute a run to completion.
 *
 * Columns are processed in topological order so a row's upstreams are filled before its downstreams
 * read them. Within a column, the lane decides the shape.
 */
export async function executeRun(
  runId: string,
  resolved: ReturnType<typeof resolveScope>,
  opts: ExecuteOptions = {},
): Promise<RunSummary> {
  // One executor per run. See `live`.
  if (live.has(runId)) return getRun(runId)!;
  live.add(runId);

  setRunStatus(runId, "running");

  // Warm the price list once, before anything is decided.
  //
  // Every price this run needs is read SYNCHRONOUSLY from the cached catalogue — the per-cell budget
  // gate between an agent's turns cannot make a network call, and neither can the savings ledger.
  // On a cold cache all of them get null, which is honest but useless: a run that skipped 25,000
  // rows reported "25,000 cells at an unknown price" and a saving of nothing, on a model whose rate
  // is published and one fetch away.
  //
  // Deliberately not fatal. An unreachable price list is a reason to report less, never a reason to
  // refuse work — the paid gate has its own refusal for the case where a cap genuinely cannot be
  // enforced.
  await listModels().catch(() => { /* stale or absent: every reader already handles null. */ });

  // Two point reads on the run's own record — the only setup that cannot throw, and the only setup
  // the `finally` needs.
  const run = getRun(runId)!;
  const sheetId = run.sheetId;

  /** Declared out here so the `finally` can still report on a run that threw before the loop began. */
  let ordered: number[] = [];
  let doneTotal = 0;
  /** Set when the loop leaves work behind, so the terminal block below knows this is not "finished". */
  let interrupted = false;

  try {
    // Inside the try, not above it. Building the row set or the topological order can throw — a
    // deleted column, a cycle, a scope SQL that no longer binds — and out here that left the run
    // stamped `running` for ever with its id still in `live`: no resume (it refuses a live run) and,
    // now that overlapping runs are refused, no new run on those columns either.
    const scope = scopeOf(runId);
    const force = scope.force === true;
    const useStrongModel = scope.useStrongModel === true;
    const statuses = (opts.statuses ?? scope.statuses ?? []).map(String);
    const depths = topoDepths(sheetId);
    ordered = [...resolved.columnIds].sort((a, b) => (depths.get(a) ?? 0) - (depths.get(b) ?? 0));

    const rowIds = (db.prepare(resolved.sql).all(...resolved.params) as any[]).map((r) => Number(r.id));

    for (const columnId of ordered) {
      // Pause as well as cancel. Checking only cancel here is exactly why a paused run executed
      // every remaining script, derived and SEND column to completion — writing into another table
      // after the user had pressed Pause — and then stuck at 100%, paused, with no finish time.
      if (stopRequested(runId)) { interrupted = true; break; }
      const col = getColumn(columnId);
      if (!col) continue;

      // Which CELLS of this column the run should touch. Two filters, one pass over the rows.
      let targetRows = rowIds;
      const want = new Set(statuses);
      const outstanding = opts.onlyOutstanding === true;
      if (want.size > 0 || outstanding) {
        const narrowed = filterByCell(columnId, rowIds, (c) => {
          // Status narrowing is PER COLUMN, not per row.
          //
          // A row qualifies for "retry only the rows that failed" by having ONE matching cell
          // anywhere in scope. Running every scoped column on that row re-runs the columns that
          // already succeeded — measured on a live table as 13 columns, one agent and two HTTP calls
          // among them, to retry a single free script cell. The scope picks the rows; this picks the
          // cells.
          //
          // On a resume, a cell this run has already CLAIMED counts as in scope whatever the scope
          // asked for: the run itself is what moved it off 'error' and onto 'queued'.
          const claimed = outstanding && UNFINISHED_CELL_STATUSES.has(c.status);
          if (want.size > 0 && !want.has(c.status) && !claimed) return false;
          // Resume: leave alone whatever this run has already written. The run id on the cell is the
          // only thing that tells a value this run produced from one that was already there.
          if (outstanding && c.runId === runId && !UNFINISHED_CELL_STATUSES.has(c.status)) return false;
          return true;
        });
        // Counted as skipped so the progress the user sees still adds up to the total the run was
        // created with — but only on the first pass over this column. A resume counting them again
        // would push the run past its own total.
        if (!outstanding) bump(runId, "skipped_c", rowIds.length - narrowed.length);
        targetRows = narrowed;
      }

      // A condition gate runs FIRST and for free, narrowing the row set before any paid lane sees it.
      if (targetRows.length > 0 && col.conditionScriptId) {
        const before = targetRows.length;
        targetRows = await applyConditionGate(runId, sheetId, columnId, Number(col.conditionScriptId), targetRows);
        // The point of writing a condition is the money it does not spend, and that number appeared
        // nowhere — so the feature had to be taken on faith by exactly the person who wrote it to
        // avoid taking cost on faith.
        recordSaving({
          runId, sheetId, columnId,
          reason: "condition",
          cells: Math.max(0, before - targetRows.length),
        });
      }

      if (targetRows.length === 0) continue;

      if (PER_CELL_KINDS.has(col.kind)) {
        const pass = await runPerCell(runId, sheetId, columnId, col.kind, targetRows, opts, force, useStrongModel);
        doneTotal += pass.processed;
        // The workers walked away from this column with rows still undispatched. Read from the pass
        // rather than from the pause flag, which a Resume arriving mid-pass has already cleared —
        // and a run that walked ON to the next column here would leave those rows unrun and then
        // stamp itself done.
        if (pass.pausedMidPass) interrupted = true;
      } else {
        const n = await runBatch(runId, sheetId, columnId, targetRows, force);
        doneTotal += n;
      }
      opts.onProgress?.(doneTotal, run.total);

      // Anything projecting out of this column is now stale — refresh it, since it is free.
      if (derivedChildren(sheetId, columnId).length > 0) refreshChildren(sheetId, columnId);

      if (interrupted) break;
    }
    // A stop that arrives during the last column has no next iteration to catch it.
    if (stopRequested(runId)) interrupted = true;
  } finally {
    // ALL of the bookkeeping, on every exit.
    //
    // On the happy path alone it would not be enough: a throw anywhere in the loop — an unapproved
    // script, a batch timeout, a missing executor — would leak the abort controller and the flag-set
    // entries, leave the run's cells stuck on 'queued' and 'running', and leave the run itself
    // claiming to be running forever.
    flushNow();
    // Exact numbers once, at the end. During the run the header reads live progress from the run
    // record instead, which is why this never needs to happen per batch.
    emitColumnStats(refreshColumnStats(ordered, sheetId));

    const final = getRun(runId)!;
    if (isCancelled(runId)) {
      setRunStatus(runId, "cancelled");
    } else if (paused.has(runId) || PAUSED_STATUSES.has(final.status)) {
      // Paused with work left stays paused — that is the state Resume exists for. Paused with
      // NOTHING left is finished, and saying so is the difference between a run that can be closed
      // and one that sits at 100% with no finish time and nothing able to clear it.
      if (!interrupted) setRunStatus(runId, "done");
    } else if (final.status === "running" && !interrupted) {
      setRunStatus(runId, "done");
    }

    cancelling.delete(runId);
    paused.delete(runId);
    releaseRun(runId);
    live.delete(runId);

    // Every MCP connection this run opened, including the spawned processes. Awaiting it would make
    // a slow-closing server hold up the run's own completion, and the run is already over by here —
    // so it is fired and any failure swallowed, exactly like the other cleanup on this path.
    void closeRunPool(runId).catch(() => { /* a process that is already gone is the goal */ });

    // A Resume pressed while this pass was still running could not join it — see `resumeRun`. It is
    // honoured here, once `live` is let go and the pool is closed, so the work the pass walked away
    // from is actually done rather than sitting queued in a run that has called itself finished.
    if (resumeWhileLive.delete(runId) && !TERMINAL_STATUSES.has(getRun(runId)?.status ?? "failed")) {
      try { resumeRun(runId); } catch { /* whatever refused it has already said so on the run */ }
    }
  }
  return getRun(runId)!;
}

/**
 * Evaluate a column's run condition and return the rows that qualify.
 *
 * This is the cost gate. It is deliberately evaluated before anything in a paid lane runs, and its
 * cost is a single batch pass regardless of row count.
 *
 * THE GATE OWNS NO CELL. Running it as an ordinary pass over the column it gates would write the
 * literal string "true" over the real value of every passing row, marked done and not stale, and
 * leave it there if anything went wrong before the transform overwrote it: a script timeout, a Stop,
 * a crash, a transform whose approval had been revoked. That is 1,000 real values replaced by "true"
 * while the run reports nothing done at all. A condition decides WHICH ROWS RUN; it is a filter, and
 * it takes its answers back instead of writing them.
 */
async function applyConditionGate(
  runId: string, sheetId: string, columnId: number, scriptId: number, rowIds: number[],
): Promise<number[]> {
  const script = assertRunnable(scriptId);

  const passing: number[] = [];
  let failed = 0;
  const res = await runScriptColumn({
    sheetId, columnId, runId,
    refColumnIds: script.refs.map(Number),
    code: script.code, runtime: script.runtime, hook: "condition",
    rowIds,
    signal: aborterFor(runId).signal,
    shouldStop: () => stopRequested(runId),
    onResults: (results) => {
      for (const r of results) {
        if (r.error) failed++;
        else if (r.value) passing.push(r.rowId);
      }
    },
  });

  // A row the gate could not answer for does not run: a condition that threw is not a licence to
  // spend. It is counted as an error rather than a skip, because a broken condition script that
  // reported skips would look exactly like a column nobody qualified for.
  bump(runId, "error_c", failed);
  bump(runId, "skipped_c", Math.max(0, res.processed - passing.length - failed));

  // A gate stopped part way through has no answer for the rows it never reached, and running them on
  // the strength of a pass that did not finish is spending against an unevaluated condition.
  return res.stopped ? [] : passing;
}

/** The batch lane — the whole column in one streaming pass. */
async function runBatch(
  runId: string, sheetId: string, columnId: number, rowIds: number[], force: boolean,
): Promise<number> {
  const col = getColumn(columnId);
  if (!col) return 0;

  // A send column writes this table's rows into another table. Batch lane, because it is one pass
  // and one transaction whatever the row count — a job per row would mean a million queue entries
  // to do work that is a single statement.
  if (col.kind === "send") return runSend(runId, sheetId, columnId, rowIds);

  // A lookup reads a value across a relation. Batch lane for the same reason `send` is: the match,
  // the read and the write are ONE statement per batch driven by an index, so a job per row would
  // queue a million entries to do work that is a handful of statements — and it would turn a free
  // lane into the slowest one in the product.
  //
  // Scoped to `rowIds` rather than refreshing the sheet, so a run narrowed by a filter stays
  // narrowed. A lookup that quietly recomputed every row would be the fourth instance in this
  // codebase of "no narrowing means every row".
  // A rollup groups the other side of a link. Same lane and same reasoning as a lookup: one
  // index-driven statement per batch, so a job per row would be a million queue entries for work
  // that is a GROUP BY.
  if (col.kind === "rollup") {
    try {
      const n = refreshRollupColumn(sheetId, columnId, rowIds);
      bump(runId, "done_c", n);
      return n;
    } catch (e) {
      writeColumnCells(
        runId,
        sheetId, columnId, rowIds.map((r) => [r, null] as const), "error",
        e instanceof Error ? e.message : String(e),
      );
      bump(runId, "error_c", rowIds.length);
      return rowIds.length;
    }
  }

  if (col.kind === "lookup") {
    try {
      const n = refreshLookupColumn(sheetId, columnId, rowIds);
      bump(runId, "done_c", n);
      return n;
    } catch (e) {
      // On the CELLS, not thrown — the same choice the send lane makes, for the same reason. A throw
      // here takes the whole run down and leaves every other column's work unreported, over a fault
      // that belongs to one column's settings. "The field this column reads has been deleted from
      // the other table" is only useful where the reader is looking.
      writeColumnCells(
        runId,
        sheetId, columnId, rowIds.map((r) => [r, null] as const), "error",
        e instanceof Error ? e.message : String(e),
      );
      bump(runId, "error_c", rowIds.length);
      return rowIds.length;
    }
  }

  // A derived column is a pure projection: no script, no scope, just recompute it.
  const derived = db.prepare("SELECT source_column_id FROM columns WHERE id = ?").get(columnId) as any;
  if (derived?.source_column_id) {
    const n = refreshDerivedColumn(sheetId, columnId);
    bump(runId, "done_c", n);
    return n;
  }

  if (!col.transformScriptId) return 0;
  const script = assertRunnable(Number(col.transformScriptId));

  // Intra-column progress. A 200,000-row column is ONE call into the script lane, so with no
  // callback the header sat at zero for the whole pass and then jumped: the bar was measuring
  // columns while claiming to measure rows.
  let credited = 0;

  const res = await runScriptColumn({
    sheetId, columnId, runId,
    refColumnIds: script.refs.map(Number),
    code: script.code, runtime: script.runtime, hook: "transform",
    rowIds,
    // Recompute only what changed, unless the user explicitly asked for everything. The cell's
    // stored input hash is the record of what it was last computed from.
    skipUnchanged: !force,
    signal: aborterFor(runId).signal,
    shouldStop: () => stopRequested(runId),
    onProgress: (processed) => {
      const delta = processed - credited;
      if (delta <= 0) return;
      credited = processed;
      bump(runId, "done_c", delta);
    },
  });

  // Reconcile. The per-batch credit counts every processed row as done, because a batch's failures
  // are not known until it has been written — so this can subtract, moving the errors across.
  bump(runId, "done_c", res.processed - res.errors - credited);
  bump(runId, "error_c", res.errors);
  bump(runId, "skipped_c", res.skipped);
  return res.processed + res.skipped;
}

/**
 * Send these rows into another table.
 *
 * Free, deterministic, and idempotent by the configured match key — which is what makes it safe to
 * put behind a run condition and leave alone. Re-running updates the rows it created rather than
 * doubling the destination.
 *
 * Each source row's own cell records what happened to it, so the column reads as a column rather
 * than as a button that leaves no trace: "sent", "updated", "skipped", or the count when one row
 * produced several. A row that produced nothing is `not_found` — the engine looked and there was
 * nothing to send — which is a success, not an error.
 */
function runSend(runId: string, sheetId: string, columnId: number, rowIds: number[]): number {
  const col = getColumn(columnId);
  const cfg = { ...DEFAULT_SEND, ...((col?.sendConfig ?? {}) as Partial<SendConfig>) } as SendConfig;

  // The same admissibility check the dry run makes, through the SAME helper, so the two cannot
  // disagree — which they did: the preview checked the destination and the run did not. A target in
  // the TRASH keeps its id, its columns and its rows, so every statement below would succeed against
  // it, report "done", create a back-reference column inside the trash, and file the user's records
  // somewhere they will never look.
  //
  // `conditionApplied` is true here because `executeRun` has already narrowed `rowIds` through the
  // gate. The preview cannot, which is the caveat only it has to carry.
  const scope = resolveSendScope(cfg, rowIds, {
    conditionScriptId: col?.conditionScriptId ?? null,
    conditionApplied: true,
  });
  if (scope.errors.length > 0) {
    // On the CELLS, not thrown. A throw out of here takes the whole run down and leaves every other
    // column's work unreported, for a fault that belongs to one column's settings — and a run that
    // reports "0 done" and explains nothing is unreadable.
    writeColumnCells(runId, sheetId, columnId, rowIds.map((r) => [r, null] as const), "error", scope.errors.join(" "));
    bump(runId, "error_c", rowIds.length);
    return rowIds.length;
  }

  const src = getSheet(sheetId);
  const sourceName = src?.name ?? "Source";
  // The source table's NAME, so the run resolves the same back-reference column the preview does.
  // `targetOf` only ever finds one, never creates it, which is why the ensure below still has to run.
  const target = targetOf(cfg, sourceName);
  if (cfg.withBackRef) target.backRefColumnId = ensureBackRefColumn(cfg.targetSheetId, sourceName);

  // `.slice(0, cap)` inside the builder drops the tail of a long list in silence. Without these
  // counts a row holding 140 contacts and capped at 50 reads "sent 50 rows" — a partial number
  // nobody can tell is partial.
  const stats = emptyBuildStats();
  const items = buildWriteItems(cfg, rowIds, stats);
  const result = applyWrite(items, target);

  if (result.errors.length > 0) {
    writeColumnCells(runId, sheetId, columnId, rowIds.map((r) => [r, null] as const), "error", result.errors.join(" "));
    bump(runId, "error_c", rowIds.length);
    return rowIds.length;
  }

  // What actually became of each SOURCE row, from the writer that took the branch. This used to
  // count the items it BUILT, so an insert, an in-place update and a no-op skip all rendered as
  // "sent": a send that changed nothing over there looked exactly like one that wrote every row.
  let skipped = 0;
  const values: Array<readonly [number, string | null]> = rowIds.map((r) => {
    const o = result.outcomes[String(r)];
    const text = sendCellText(o, stats.totalByRow.get(r));
    // Nothing was built from this row at all — an empty list. `writeColumnCells` makes that
    // `not_found`, which is a success: the engine looked and the answer genuinely is "none".
    if (o == null || text == null) return [r, null] as const;
    if (o.inserted + o.updated === 0) skipped++;
    return [r, text] as const;
  });

  // The two ways a send silently grows its destination on every run — no match key at all, and rows
  // whose key cell is blank. Surfaced on the cells rather than discovered on the third run.
  const warnings = [...scope.warnings, ...result.warnings];
  writeColumnCells(runId, sheetId, columnId, values, "done", undefined, warnings.join(" ") || undefined);
  // A row that wrote nothing over there is a SKIP, not a success. Counting the whole scope as done —
  // which is what this did — reported a send that changed nothing as a column fully filled.
  bump(runId, "done_c", rowIds.length - skipped);
  bump(runId, "skipped_c", skipped);
  return rowIds.length;
}

/**
 * What one source row's cell should say about its send.
 *
 * Only `applyWrite` knows which branch each item took, so it reports back per source row and this
 * turns that into the cell's words: "sent", "updated", "skipped — a row over there already matches".
 *
 * `held` is what the row actually contained BEFORE the per-row cap, so a row of 140 contacts capped
 * at 50 reads "sent 50 of 140 rows" instead of a count that looks complete and is not.
 */
function sendCellText(o: RowOutcome | undefined, held: number | undefined): string | null {
  if (!o) return null;
  const written = o.inserted + o.updated + o.skipped;
  if (written === 0) return null;

  const capped = held != null && held > written;
  const say = (n: number, verb: string): string =>
    capped ? `${verb} ${n} of ${held} rows` : n === 1 ? verb : `${verb} ${n} rows`;

  const parts: string[] = [];
  if (o.inserted > 0) parts.push(say(o.inserted, "sent"));
  if (o.updated > 0) parts.push(say(o.updated, "updated"));
  if (o.skipped > 0) parts.push(say(o.skipped, "skipped"));
  // The reason belongs to the skip: "skipped" on its own is a status with no cause, and the cause is
  // the only part the user can act on.
  return o.reason ? `${parts.join(", ")} — ${o.reason}` : parts.join(", ");
}

/** Write one column's cells for a set of rows in a single transaction. */
/**
 * Write one outcome across a batch of a column''s cells.
 *
 * Shared by the send and lookup lanes. Both are batch lanes whose failures are COLUMN-level -- a
 * missing destination, a deleted link -- and both have to land somewhere the reader is actually
 * looking, which is the grid, not a run summary.
 */
function writeColumnCells(
  runId: string,
  sheetId: string,
  columnId: number,
  values: Array<readonly [number, string | null]>,
  status: "done" | "error",
  errorMsg?: string,
  /** Column-level notices about a write that SUCCEEDED — read by the cell detail drawer. Kept off
   *  `error_msg` so a config warning cannot render as a per-cell failure in the grid. */
  note?: string,
): void {
  tx(() => {
    const upd = db.prepare(
      `UPDATE cells
          SET value_text = ?, value_json = ?, status = ?, error_msg = ?, note = ?, stale = 0${pinClear(runId)},
              rev = rev + 1, updated_at = datetime('now')
        WHERE row_id = ? AND column_id = ?${pinGuard(runId)}`,
    );
    for (const [rowId, text] of values) {
      // Nothing to send from this row is `not_found`, not an error: the engine looked and the answer
      // genuinely is "none". Conflating the two makes a retry loop re-ask an unanswerable question.
      const s = status === "done" && text == null ? "not_found" : status;
      upd.run(
        text, text == null ? null : JSON.stringify(text), s,
        // Redacted on write, like every other error path. This one carries a message built from a
        // send CONFIG — which can hold `{{secret:...}}` in a destination or a header — so an error
        // that quotes what it tried to write is exactly where a key would surface.
        redactSecrets(errorMsg) ?? null, note ?? null, rowId, columnId,
      );
    }

    // Inside the same transaction as the write: a downstream cell must never be readable as fresh
    // against a new upstream value. Only for a write that produced values — a failed batch has not
    // changed anything for a downstream column to be out of date about.
    if (status === "done") {
      const rows = values.map(([rowId]) => Number(rowId));
      markDownstreamStale(sheetId, Number(columnId), rows);
      // Relations are a SECOND graph: cross-table, keyed rather than declared, and invisible to
      // column_deps. Re-index and flag across it here or a lookup silently keeps an old answer.
      noteRelationChange(sheetId, Number(columnId), rows);
      // Whatever keeps itself up to date now has something to react to.
      noteUpstreamChange(sheetId, Number(columnId), rows);
    }
  });
  markCellsDirty(values.map(([rowId]) => cellId(rowId, columnId)));
  markColumnDirty(columnId);
}

/**
 * Column fields that cannot change what one of this column's cells computes to.
 *
 * The fingerprint below is built by EXCLUSION rather than by listing what matters, because the two
 * mistakes are not symmetrical: an extra field costs a needless recompute, a missing one is a cell
 * that is skipped for ever and never updates again. `stats_json` has to be excluded specifically —
 * the run itself writes it, so including it would move the hash on every pass and the skip could
 * never fire at all.
 */
const NON_COMPUTING_COLUMN_FIELDS = new Set([
  "stats_json", "position", "width", "frozen", "format", "description", "created_at", "deleted_at",
]);

/**
 * The fingerprint of everything that decides a per-cell lane's answer: the column's configuration,
 * and the exact upstream values this pass would hand it.
 *
 * Mirrors `inputHashOf` in the script runner, including the length prefix — a plain separator would
 * let ["a","b"] and ["a b", null] agree, and an agreeing hash is a cell that never recomputes again.
 *
 * References are parsed LIVE from the column rather than read out of `column_deps`, because that
 * edge list is rebuilt only when a SCRIPT is saved: a prompt edited through the column PATCH route
 * leaves it stale, and a stale dependency list is exactly the input a wrong skip is made of.
 *
 * Returns NULL — meaning "skip nothing" — when the column references no other column. Every row
 * would then hash identically, so a skip would not mean "leave the unchanged cells alone", it would
 * mean "never run this column again after its first pass".
 */
function perCellInputHashes(sheetId: string, columnId: number, rowIds: number[]): Map<number, string> | null {
  const raw = db.prepare("SELECT * FROM columns WHERE id = ?").get(columnId) as any;
  if (!raw) return null;

  const refIds = [...new Set([
    ...parseRefs(raw.prompt, { sheetId, selfId: columnId }).ids,
    ...parseRefs(raw.http_config, { sheetId, selfId: columnId }).ids,
  ])];
  if (refIds.length === 0) return null;

  const config = createHash("sha256");
  for (const k of Object.keys(raw).sort()) {
    if (NON_COMPUTING_COLUMN_FIELDS.has(k)) continue;
    // Length-prefixed, exactly as the cell values are below: two fields concatenated raw would let
    // one field's text impersonate the start of the next, and two configurations whose hashes agree
    // is a cell that never recomputes again.
    const v = raw[k] == null ? null : String(raw[k]);
    config.update(`${k} ${v == null ? -1 : v.length} `);
    if (v != null) config.update(v);
  }
  const configHash = config.digest("hex");

  const out = new Map<number, string>();
  for (let i = 0; i < rowIds.length; i += ID_CHUNK) {
    const chunk = rowIds.slice(i, i + ID_CHUNK);
    const byRow = new Map<number, Map<number, string | null>>();
    for (const c of db
      .prepare(
        `SELECT row_id, column_id, value_text FROM cells
          WHERE row_id IN (${chunk.map(() => "?").join(",")})
            AND column_id IN (${refIds.map(() => "?").join(",")})`,
      )
      .all(...chunk, ...refIds) as any[]) {
      const bag = byRow.get(Number(c.row_id)) ?? new Map<number, string | null>();
      bag.set(Number(c.column_id), c.value_text ?? null);
      byRow.set(Number(c.row_id), bag);
    }
    for (const rowId of chunk) {
      const bag = byRow.get(rowId);
      const h = createHash("sha256").update(configHash);
      // In refId ORDER, not the result set's: that order comes out of SQLite and is not guaranteed
      // to repeat, and a hash that moved with it would never match its stored self.
      for (const id of refIds) {
        const v = bag?.get(id) ?? null;
        h.update(` ${v == null ? -1 : v.length} `);
        if (v != null) h.update(v);
      }
      out.set(rowId, h.digest("hex"));
    }
  }
  return out;
}

/**
 * The rows whose cell is already the answer to exactly this question.
 *
 * `done` and not stale only. An error, a not_found or a cancelled cell is work the next pass is
 * meant to retry, and skipping it would drop the retry the user came back for.
 */
function unchangedRows(columnId: number, rowIds: number[], hashes: Map<number, string>): number[] {
  const out: number[] = [];
  for (let i = 0; i < rowIds.length; i += ID_CHUNK) {
    const chunk = rowIds.slice(i, i + ID_CHUNK);
    for (const c of db
      .prepare(
        `SELECT row_id, input_hash FROM cells
          WHERE column_id = ? AND status = 'done' AND stale = 0 AND input_hash IS NOT NULL
            AND row_id IN (${chunk.map(() => "?").join(",")})`,
      )
      .all(columnId, ...chunk) as any[]) {
      if (c.input_hash === hashes.get(Number(c.row_id))) out.push(Number(c.row_id));
    }
  }
  return out;
}

/**
 * The per-cell lane — one durable job per row, bounded concurrency, retries, cancellation.
 *
 * Reports whether the pass ended because the run was PAUSED as well as how many rows it got through:
 * the caller has to know it left rows behind, and the pause flag it would otherwise read can have
 * been cleared by a Resume in the meantime.
 */
async function runPerCell(
  runId: string, sheetId: string, columnId: number, kind: string, rowIds: number[], opts: ExecuteOptions,
  force: boolean,
  useStrongModel: boolean,
): Promise<{ processed: number; pausedMidPass: boolean }> {
  if (!executor) {
    throw new Error(
      `This column runs on the "${kind}" lane, which needs a model provider. Configure one in Settings, ` +
      "or use a script column — those run locally and cost nothing.",
    );
  }

  // Recompute only what changed, unless the user explicitly asked for everything — the same bargain
  // the script lane strikes, on the lane where the difference is money rather than seconds.
  // `cells.input_hash` was in the schema and NO per-cell path ever wrote it, so every re-run of an
  // untouched column bought every one of its cells a second time.
  //
  // Computed even on a FORCED pass: `force` decides whether to skip, never whether to record. A
  // forced pass that left the hash unwritten would make the very next ordinary pass recompute
  // everything all over again — and the UI's ordinary "run this column" sends force.
  const hashes = perCellInputHashes(sheetId, columnId, rowIds);
  let targetRows = rowIds;
  if (hashes && !force) {
    const fresh = new Set(unchangedRows(columnId, rowIds, hashes));
    if (fresh.size > 0) {
      targetRows = rowIds.filter((r) => !fresh.has(r));
      // Counted, so the progress the user watches still adds up to the total the run was created
      // with rather than stalling short of it.
      bump(runId, "skipped_c", fresh.size);
      // And recorded as money not spent. This is the single largest saving the engine makes and it
      // was completely invisible: a re-run over a million unchanged rows showed a small bill and no
      // reason for it, which reads as the run having done nothing rather than as it having correctly
      // declined to buy the same answer twice.
      recordSaving({ runId, sheetId, columnId, reason: "unchanged", cells: fresh.size });
    }
  }
  if (targetRows.length === 0) return { processed: 0, pausedMidPass: false };

  // Read once, outside the workers. Reading it per attempt would let a mid-run config edit change
  // the retry budget of rows already in flight, so two rows of the same run would be treated
  // differently for reasons nothing in the run's own record explains.
  const maxAttempts = attemptsFor(getColumn(columnId));

  // Enqueue durably first, so a crash mid-run resumes rather than losing the work. ON CONFLICT makes
  // a double-click idempotent.
  tx(() => {
    const ins = db.prepare(
      `INSERT OR IGNORE INTO jobs (run_id, row_id, column_id, sheet_id, status, max_attempts)
       VALUES (?, ?, ?, ?, 'ready', ?)`,
    );
    const q = db.prepare(
      `UPDATE cells SET status = 'queued', rev = rev + 1 WHERE row_id = ? AND column_id = ?${pinGuard(runId)}`,
    );
    for (const rowId of targetRows) { ins.run(runId, rowId, columnId, sheetId, maxAttempts); q.run(rowId, columnId); }
  });
  markCellsDirty(targetRows.map((r) => cellId(r, columnId)));

  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  /**
   * How fast this column is allowed to go — the ceiling, and the per-minute cap.
   *
   * ONE pacer for the column, shared by every worker, because both limits are about the column as a
   * whole. A per-worker pacer would multiply the rate limit by the worker count, which is the same
   * as not having one.
   *
   * The ceiling STARTS at the configured concurrency and moves down from there when the provider
   * says so. Nothing here ever exceeds what was asked for — the engine is allowed to decide it is
   * going too fast, never that it knows better than the setting.
   */
  const pacer = new Pacer({
    max: concurrency,
    perMinute: Number(getColumn(columnId)?.rateLimitPerMin ?? 0),
  });
  const signal = aborterFor(runId).signal;
  // Which boot claimed the job. Crash recovery reclaims anything leased by a PREVIOUS boot, and the
  // whole branch is dead unless something actually takes the lease out.
  const bootId = getKv("boot_id");
  const lease = db.prepare(
    `UPDATE jobs SET status = 'leased', attempt = ?, leased_at = datetime('now'),
                     lease_expires_at = datetime('now', '+1 hour'), boot_id = ?
      WHERE run_id = ? AND row_id = ? AND column_id = ? AND status IN ('ready','blocked','leased')`,
  );
  let cursor = 0;
  let processed = 0;

  /**
   * What this pass has dispatched and not yet been billed for, in dollars, and the dearest cell it
   * has seen so far.
   *
   * The budget gate reads `runs.cost_usd`, which is written when a cell LANDS — so on its own the
   * check is check-then-act and every cap was crossed by up to one cell per worker, already bought.
   * Each dispatch now puts the dearest price this pass has actually seen into `reservedUsd`, in the
   * same synchronous step as the check, and the gate counts that as spent.
   *
   * It is NOT a hard cap and is not claimed as one. The first cells of a pass have no observed price
   * to reserve against, so a column still overshoots by up to its concurrency on its FIRST wave;
   * after that the overshoot is bounded by how much dearer a cell can be than the dearest one so
   * far. Making it exact needs a price known before the call, which only the executor has.
   */
  let reservedUsd = 0;
  let dearestCellUsd = 0;
  /**
   * Whether a worker walked away because the run was paused.
   *
   * Reported by the workers rather than re-read from the flag, because the flag can be cleared by a
   * Resume between a worker exiting and this pass closing itself out — and `finishColumnPass` would
   * then mark rows that were never dispatched as done.
   */
  let pausedMidPass = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (isCancelled(runId)) return;
      if (paused.has(runId)) { pausedMidPass = true; return; }

      // The budget gate, checked BEFORE dispatching another cell rather than after the money is
      // gone. Every other cost control in this app is advisory — it shows a number and lets you
      // proceed — so this is the only one that actually stops a runaway.
      //
      // Paused, not cancelled: the rows already done keep their values, and raising the cap and
      // resuming is a decision the user can make. Cancelling would make hitting a budget
      // indistinguishable from abandoning the work.
      const over = budgetExceeded(runId, sheetId, reservedUsd);
      if (over) {
        pauseRun(runId, over, "budget");
        pausedMidPass = true;
        return;
      }

      // Reserved HERE, before the first `await` of the round. Reserving after the wait below would
      // let every worker clear the gate before any of them had claimed anything, which is the
      // check-then-act this exists to close.
      const reservation = dearestCellUsd;
      reservedUsd += reservation;
      let unreserved = false;
      const unreserve = () => { if (unreserved) return; unreserved = true; reservedUsd -= reservation; };

      /**
       * Whether this row was ever told to slow down, even if a retry then succeeded.
       *
       * Reporting only the LAST outcome would throw the signal away on exactly the rows that carry
       * it: a rate limit followed by a successful retry is the provider saying "too fast" and the
       * engine hearing "fine". Tracked across the retries and reported once, when the slot is
       * released.
       */
      let sawRateLimit = false;
      /** The pacer slot and the reservation go back exactly once, whichever way this row leaves. */
      let tookSlot = false;
      let released = false;
      const release = (errorType: string | null | undefined) => {
        unreserve();
        if (!tookSlot || released) return;
        released = true;
        pacer.done(sawRateLimit ? "rate_limit" : errorType ?? null);
      };

      try {
        /**
         * Wait for permission to dispatch.
         *
         * BEFORE the cursor is taken, deliberately. Taking a row and then waiting would hold that row
         * hostage to this worker for the length of the wait, so a rate-limited column would have its
         * rows dealt out to workers that are all asleep while the queue looks busy.
         *
         * A false return means the run was stopped while waiting, and the correct response is to walk
         * away without dispatching — a pacer that let one more call through per worker on cancel would
         * undo the whole point of the abort plumbing.
         */
        if (!(await pacer.take(signal))) return;
        tookSlot = true;
        if (isCancelled(runId)) return;
        if (paused.has(runId)) { pausedMidPass = true; return; }

        const i = cursor++;
        if (i >= targetRows.length) return;
        const rowId = targetRows[i]!;

        db.prepare(
          `UPDATE cells SET status = 'running', rev = rev + 1 WHERE row_id = ? AND column_id = ?${pinGuard(runId)}`,
        ).run(rowId, columnId);
        markCellsDirty([cellId(rowId, columnId)]);

        let attempt = 0;
        let freeRetries = 0;

        for (;;) {
          attempt++;
          // Claim the job before spending anything on it. A cell that dies with the process is then
          // recoverable: the next boot reclaims the lease, puts the cell back to queued, and resume
          // picks it up — instead of a `running` cell nothing will ever come back to.
          lease.run(attempt, bootId, runId, rowId, columnId);
          let outcome: CellOutcome;
          try {
            outcome = await executor!({ runId, sheetId, rowId, columnId, kind, attempt, signal, useStrongModel });
          } catch (e) {
            outcome = { status: "error", errorType: "unknown", errorMsg: e instanceof Error ? e.message : String(e) };
          }
          // What the next dispatch reserves against. Read from every outcome, including a failed one:
          // a call that errored after the tokens were spent still cost what it cost.
          if (Number.isFinite(Number(outcome.costUsd))) {
            dearestCellUsd = Math.max(dearestCellUsd, Number(outcome.costUsd));
          }

          // Checked HERE, not only at the top of the loop.
          //
          // The top-of-loop check governs whether to start another ROW; this one governs what happens
          // to the row already in hand. Without it a cancelled call's failure was fed to the retry
          // policy, which cheerfully retried it — so pressing Stop could be followed by several more
          // calls per worker. `cancelRun` has already written the terminal state and the reason, so
          // there is nothing to write here; walking away is the correct move.
          if (isCancelled(runId)) { release(null); return; }

          if (outcome.status !== "error") {
            // An answer that was reused rather than bought. Recorded one cell at a time because that
            // is how they arrive — unlike the other two reasons, which are decided for a whole batch
            // before it runs.
            if (outcome.fromCache) {
              recordSaving({ runId, sheetId, columnId, reason: "cache", cells: 1 });
            }
            // The cheap model answered AND was sure, so the expensive one was never asked. Counted at
            // the expensive rate, because that is the call that did not happen — see SavingReason.
            if (answeredCheaply(outcome)) {
              recordSaving({ runId, sheetId, columnId, reason: "first_model", cells: 1 });
            }
            writeCellOutcome(runId, rowId, columnId, attempt, outcome, hashes?.get(rowId), sheetId);
            release(null);
            break;
          }

          // Remembered whether or not a retry rescues the row — see `sawRateLimit`.
          if (outcome.errorType === "rate_limit") sawRateLimit = true;

          const action = retryPolicy(outcome.errorType ?? "unknown", attempt, maxAttempts, freeRetries);
          if (action === "pause_run") {
            pauseRun(runId, "authentication stopped working mid-run", "auth");
            pausedMidPass = true;
            // Back to queued, not error: the cell was never actually attempted against a live
            // credential, and marking it failed would misreport the run. Its job goes back with it,
            // because a lease left hanging is work nothing will ever pick up again.
            tx(() => {
              db.prepare("UPDATE cells SET status = 'queued', rev = rev + 1 WHERE row_id = ? AND column_id = ?")
                .run(rowId, columnId);
              db.prepare(
                `UPDATE jobs SET status = 'ready', leased_at = NULL, lease_expires_at = NULL
                  WHERE run_id = ? AND row_id = ? AND column_id = ? AND status = 'leased'`,
              ).run(runId, rowId, columnId);
            });
            markCellsDirty([cellId(rowId, columnId)]);
            release(outcome.errorType);
            return;
          }
          // Backoffs wake on abort. Otherwise a cancelled run sits out its full delay, up to eight
          // seconds, and then calls the provider again on the far side of it.
          if (action === "retry_free") { attempt--; freeRetries++; await interruptibleSleep(1000 * Math.min(8, freeRetries), signal); if (isCancelled(runId)) { release(outcome.errorType); return; } continue; }
          if (action === "retry") { await interruptibleSleep(300 * attempt, signal); if (isCancelled(runId)) { release(outcome.errorType); return; } continue; }

          writeCellOutcome(runId, rowId, columnId, attempt, outcome, hashes?.get(rowId), sheetId);
          release(outcome.errorType);
          break;
        }
      } finally {
        // The last word on the slot and the reservation, because the code above can THROW: both
        // `writeCellOutcome` and the lease are multi-statement database calls, and a throw that
        // escaped here left `Pacer.inFlight` permanently high — after which the pacer makes every
        // remaining worker of the run wait a quarter of a second, forever, for a slot that no longer
        // exists. On every ordinary exit this is a no-op; `release` is idempotent.
        release(null);
      }

      processed++;
      opts.onProgress?.(processed, targetRows.length);
    }
  };

  try {
    /**
     * allSettled, not all.
     *
     * `all` rejects on the FIRST worker to throw, and the caller's `finally` then terminalises the
     * run and stamps its in-flight cells cancelled while the other five workers are still dispatching
     * paid cells against a run nothing owns any more. Every worker is awaited; the first failure is
     * still the pass's failure and is rethrown once they have all actually stopped.
     */
    const settled = await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, targetRows.length) }, worker),
    );
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
  } finally {
    finishColumnPass(runId, columnId, pausedMidPass);
  }
  return { processed, pausedMidPass };
}

/**
 * Close out one per-cell column pass, however it ended.
 *
 * On the happy path this is nearly a no-op. It exists for the other exits — a throw out of the
 * executor, a pause, a Stop — where two things would otherwise be left behind: cells stuck on `running`,
 * which spin forever because the pass that owned them is over and nothing will write to them again;
 * and every undispatched job marked `done`, which erased the only record of the work that was NOT
 * done and left resume nothing to go on.
 */
function finishColumnPass(runId: string, columnId: number, pausedMidPass = false): void {
  const stopped = isCancelled(runId);
  // What the workers DID, not only what the flag says now: a Resume between the last worker leaving
  // and this running clears the flag, and the undispatched jobs would then be marked done — erasing
  // the only record of the work the run still owes.
  const pausing = !stopped && (pausedMidPass || paused.has(runId));

  const stuck = (db
    .prepare(
      `SELECT row_id FROM cells
        WHERE column_id = ? AND status = 'running'
          AND row_id IN (SELECT row_id FROM jobs WHERE run_id = ? AND column_id = ?)`,
    )
    .all(columnId, runId, columnId) as any[]).map((r) => Number(r.row_id));

  tx(() => {
    if (stuck.length > 0) {
      // Paused, not stopped: back to QUEUED, because resuming is meant to pick it up. Stopped or
      // crashed: a terminal state with a reason, because nothing is coming back for it.
      const upd = db.prepare(
        pausing
          ? `UPDATE cells SET status = 'queued', rev = rev + 1, updated_at = datetime('now')
              WHERE row_id = ? AND column_id = ?`
          : `UPDATE cells SET status = 'cancelled', error_type = 'cancelled',
                              error_msg = 'Stopped before this finished. Run the column again to retry it.',
                              rev = rev + 1, updated_at = datetime('now')
              WHERE row_id = ? AND column_id = ?`,
      );
      for (const rowId of stuck) upd.run(rowId, columnId);
    }

    if (stopped) {
      db.prepare(
        `UPDATE jobs SET status = 'cancelled', leased_at = NULL, lease_expires_at = NULL
          WHERE run_id = ? AND column_id = ? AND status IN ('ready','blocked','leased')`,
      ).run(runId, columnId);
    } else if (pausing) {
      // Handed back, not finished. These are the rows the run still owes.
      db.prepare(
        `UPDATE jobs SET status = 'ready', leased_at = NULL, lease_expires_at = NULL
          WHERE run_id = ? AND column_id = ? AND status = 'leased'`,
      ).run(runId, columnId);
    } else {
      // Only the jobs whose cell actually reached a terminal outcome. Marking every `ready` job done
      // unconditionally would report work as complete that was never dispatched at all.
      db.prepare(
        `UPDATE jobs SET status = 'done', leased_at = NULL, lease_expires_at = NULL
          WHERE run_id = ? AND column_id = ? AND status IN ('ready','blocked','leased')
            AND row_id IN (SELECT row_id FROM cells WHERE column_id = ?
                            AND status IN ('done','error','skipped','not_found','cancelled'))`,
      ).run(runId, columnId, columnId);
    }
  });

  if (stuck.length > 0) {
    markCellsDirty(stuck.map((r) => cellId(r, columnId)));
    markColumnDirty(columnId);
  }
}

function writeCellOutcome(
  runId: string, rowId: number, columnId: number, attempt: number, o: CellOutcome,
  /** What this cell was computed FROM, so an unchanged re-run can leave it alone. */
  inputHash?: string,
  /** The sheet, so the write can cascade staleness to whatever reads this cell. */
  sheetId?: string,
): void {
  let text = o.valueText ?? (o.value == null ? null : typeof o.value === "string" ? o.value : JSON.stringify(o.value));

  /**
   * The column's rules, applied at the ONE point every lane's answer passes through.
   *
   * Not at the three `coerce` call sites. A rule attached to the http lane and not the ai lane — or
   * to neither, once a fourth lane is written — is a rule the user believes is guarding the column,
   * and a guard that covers some of the ways in is the same as no guard except that it is trusted.
   * Here it covers ai, agent, http, script, waterfall, lookup and rollup at once, and whatever comes
   * next inherits it without anyone remembering to add it.
   *
   * Only a `done` cell is judged. An error already carries the reason it failed, and replacing that
   * with "must be at least 1" swaps the real cause for a consequence of it.
   */
  if (o.status === "done") {
    const rules = getColumn(String(columnId))?.validation;
    const problem = rules ? checkValue(text, rules) : null;
    if (rules && problem) {
      if (rules.onFail === "reject") {
        // An error cell, exactly as a coercion failure produces. The refused value is in the
        // message: a cell that says only "broke a rule" sends you to re-run the row — and pay again
        // — to find out what came back.
        o = { ...o, status: "error", errorType: "schema", errorMsg: `${problem} Got "${String(text ?? "").slice(0, 60)}"` };
        text = null;
      } else {
        // `warn`: the value is kept and the note carries the reason. That is what makes a rule safe
        // to add to a column that already holds a million rows nobody is going to re-run.
        o = { ...o, note: problem };
      }
    }
  }

  tx(() => {
    db.prepare(
      `UPDATE cells SET status = ?, value_text = ?, value_json = ?, error_type = ?, error_msg = ?,
                        confidence = ?, source_url = ?, note = ?,
                        cost_usd = ?, duration_ms = ?,
                        tokens_in = ?, tokens_out = ?, tokens_cache_read = ?, tokens_cache_create = ?,
                        attempt = ?, input_hash = ?, stale = 0${pinClear(runId)},
                        rev = rev + 1, run_id = ?, updated_at = datetime('now')
        WHERE row_id = ? AND column_id = ?${pinGuard(runId)}`,
    ).run(
      o.status, text, o.value === undefined ? null : JSON.stringify(o.value),
      o.errorType ?? null, redactSecrets(o.errorMsg)?.slice(0, 500) ?? null,
      // Written for the first time. Both columns are read by getCell and typed in the client, and
      // both have been null on every row in every database this app has ever created — while the
      // finish tool made `confidence` a REQUIRED field, so the answer was there every single time.
      //
      // Overwritten unconditionally, INCLUDING with null: a re-run that comes back sure must clear
      // the "not sure" from the run before it, or the flag outlives the doubt it stood for.
      o.confidence ?? null,
      o.sourceUrl ? String(o.sourceUrl).slice(0, 2000) : null,
      // Cleared on a re-run that has nothing to say, for the same reason as the two above: a note
      // explaining why a row escalated last time is a lie once the row no longer escalates.
      o.note ? redactSecrets(o.note).slice(0, 300) : null,
      o.costUsd ?? null, o.durationMs ?? null,
      o.tokensIn ?? null, o.tokensOut ?? null, o.cacheRead ?? null, o.cacheCreate ?? null,
      attempt,
      // Only a DONE cell records its inputs, and anything else CLEARS them. An error, a not_found or
      // a cancelled cell is work the next pass is meant to retry; leaving a stale hash on one would
      // let a later status change turn it into a skip nobody asked for.
      o.status === "done" ? inputHash ?? null : null,
      runId, rowId, columnId,
    );

    // A new value here makes every cell that reads it out of date — in the same transaction as the
    // write, so a downstream cell is never briefly readable as fresh against a value that changed.
    // Only for a cell that produced an answer: an error or a cancellation has already had its input
    // hash cleared, so the next run retries it regardless and nothing downstream has moved.
    if (sheetId && (o.status === "done" || o.status === "not_found")) {
      markDownstreamStale(sheetId, Number(columnId), [Number(rowId)]);
      noteRelationChange(sheetId, Number(columnId), [Number(rowId)]);
      noteUpstreamChange(sheetId, Number(columnId), [Number(rowId)]);
    }

    // Immutable history: one row per attempt, which is what the cell drawer reads. The cell itself
    // only ever holds the LAST outcome, so without this a retry erases the failure that caused it —
    // and a paid call leaves no record that it was ever made.
    db.prepare(
      `INSERT INTO cell_attempts (row_id, column_id, run_id, attempt, started_at, finished_at,
                                  status, model, cost_usd, duration_ms,
                                  tokens_in, tokens_out, tokens_cache_read, tokens_cache_create,
                                  error_type, error_msg, rendered_prompt, num_turns, raw_result)
       VALUES (?, ?, ?, ?, datetime('now', ?), datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rowId, columnId, runId, attempt,
      `-${Math.max(0, Math.round((o.durationMs ?? 0) / 1000))} seconds`,
      o.status, o.model ?? null, o.costUsd ?? null, o.durationMs ?? null,
      o.tokensIn ?? null, o.tokensOut ?? null, o.cacheRead ?? null, o.cacheCreate ?? null,
      o.errorType ?? null, redactSecrets(o.errorMsg)?.slice(0, 500) ?? null,
      // Redacted going IN, not only coming out. A prompt is the column's instruction with this row's
      // values substituted, so a column that names a key resolves it into the stored string — and a
      // scrub that only happens on the way to the browser leaves the secret sitting in the file on
      // disk. The details route scrubs again on read; that one is now the second line, not the first.
      o.renderedPrompt ? redactSecrets(o.renderedPrompt) ?? null : null,
      Number.isFinite(Number(o.turns)) ? Number(o.turns) : null,
      // Capped and scrubbed like every other field built from text this app did not write. The
      // envelope is the model's own object, so it can be large and can quote anything it was shown.
      o.rawResult === undefined
        ? null
        : redactSecrets(JSON.stringify(o.rawResult) ?? "")?.slice(0, 4000) ?? null,
    );

    // The rollup that the usage screens read, incremented from the SAME outcome as the attempt row
    // above. Two writers deriving spend separately is how a total stops matching its own breakdown.
    if (sheetId) {
      recordUsage({
        sheetId, columnId, lane: getColumn(columnId)?.kind ?? '',
        model: o.model, status: o.status,
        costUsd: o.costUsd, tokensIn: o.tokensIn, tokensOut: o.tokensOut,
        cacheRead: o.cacheRead, cacheCreate: o.cacheCreate, durationMs: o.durationMs,
        units: o.units, unit: o.unit,
      });
    }

    // Release the lease. A job left leased is reclaimed by the next boot and its cell re-queued —
    // work that has already been done, and on a paid lane already been charged for.
    db.prepare(
      `UPDATE jobs SET status = ?, attempt = ?, last_error_type = ?, last_error = ?,
                       leased_at = NULL, lease_expires_at = NULL
        WHERE run_id = ? AND row_id = ? AND column_id = ?`,
    ).run(
      o.status === "error" ? "failed" : "done", attempt,
      o.errorType ?? null, redactSecrets(o.errorMsg)?.slice(0, 500) ?? null,
      runId, rowId, columnId,
    );
  });

  markColumnDirty(columnId);
  if (o.costUsd) db.prepare("UPDATE runs SET cost_usd = cost_usd + ? WHERE id = ?").run(o.costUsd, runId);
  bump(runId, o.status === "error" ? "error_c" : o.status === "skipped" ? "skipped_c" : "done_c", 1);
  markCellsDirty([cellId(rowId, columnId)]);
}
