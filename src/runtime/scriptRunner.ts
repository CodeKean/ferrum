// Runs a generated script across a whole column.
//
// THE RULE THAT MAKES THIS VIABLE: a script column runs ONCE over the dataset, never once per row.
// A PowerShell spawn is 50-100ms; at a million rows that is 14-28 hours of pure process startup
// before any work happens. So both runtimes stream: rows go in as batches, results come back as
// batches, one process (or one worker) for the entire column.

import { Worker } from "node:worker_threads";
import { pinClear, pinGuard } from "../pinGuard.ts";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { db, tx } from "./../db.ts";
import { markCellsDirty } from "./../bus.ts";
import { cellId } from "./../db.ts";
import { SCRIPTS_DIR } from "./../paths.ts";
import { markColumnDirty } from "./../columnStats.ts";
import { redactSecrets } from "./../redact.ts";
import type { ScriptRuntime } from "./../types.ts";

const BATCH = 2000;
/** A batch that has not returned in this long means the script is hung (a runaway regex, an infinite
 *  loop). The worker is disposable, so it is killed and the batch fails rather than wedging a run. */
const BATCH_TIMEOUT_MS = 30_000;

export interface ScriptRowResult {
  rowId: number;
  value: unknown;
  error?: string;
}

export interface ScriptRunInput {
  sheetId: string;
  columnId: number;
  /** Column ids the script reads, in the order the row object should expose them. */
  refColumnIds: number[];
  code: string;
  runtime: ScriptRuntime;
  hook: "transform" | "condition";
  /** Row ids to process. Streamed in batches; never all materialized as objects at once. */
  rowIds: number[];
  /** The run this pass belongs to, when there is one. Stamped on the cells and on the attempt rows,
   *  so a value can be traced back to the run that produced it — which is also what lets a resumed
   *  run tell the cells it has already written from the ones it has not reached yet. */
  runId?: string;
  /**
   * Leave alone any cell whose inputs and script are unchanged since it was last computed.
   *
   * Opt IN rather than opt out, because the callers differ: a run wants the skip (re-running a
   * column after adding fifty rows should cost fifty rows of work), while a dry run is the user
   * asking to SEE the script work and must always produce output.
   */
  skipUnchanged?: boolean;
  /**
   * Aborted when the run is stopped.
   *
   * Checked at every batch boundary and mid-batch. Without it Stop only stopped the queue: a column
   * already in flight ran to completion, writing cells and bumping counters seconds after the user
   * had watched the run report itself stopped.
   */
  signal?: AbortSignal;
  /** Checked at every batch boundary. Returning true ends the pass where it stands — this is how a
   *  PAUSE reaches a lane that has no per-row queue to stop handing out. */
  shouldStop?: () => boolean;
  /**
   * Take each batch's results INSTEAD of having them written to the column's cells.
   *
   * A run CONDITION is a filter, not a value. The rows it gates live in the very column it is
   * gating, so writing its answer into them destroys the values the run is about to produce.
   * Supplying this switches the pass to collect-only — no cell is touched — and hands the results
   * over batch by batch, so a million-row gate costs one array of row ids rather than a million
   * buffered objects.
   */
  onResults?: (results: ScriptRowResult[]) => void;
  onProgress?: (done: number, total: number) => void;
}

export interface ScriptRunResult {
  processed: number;
  errors: number;
  /** Cells left alone because neither their inputs nor the script changed since they were computed. */
  skipped: number;
  ms: number;
  /** How many OS processes were spawned. Asserted as 1 in the tests — see the rule above. */
  spawns: number;
  /** True when the pass ended early because the run was stopped or paused, so the caller knows the
   *  column is NOT finished and must not report it as such. */
  stopped: boolean;
}

/**
 * Read a batch of rows as `{ columnKey: value }` objects.
 *
 * Keys are the column's normalized key, not its id, so generated code reads `row.website` rather
 * than `row["7"]` — which is what makes a generated script legible in review.
 */
function readBatch(rowIds: number[], refColumnIds: number[], keys: Map<number, string>) {
  if (rowIds.length === 0 || refColumnIds.length === 0) {
    return rowIds.map((rowId) => ({ rowId, values: {} as Record<string, string | null> }));
  }
  const rows = db
    .prepare(
      `SELECT row_id, column_id, value_text FROM cells
        WHERE row_id IN (${rowIds.map(() => "?").join(",")})
          AND column_id IN (${refColumnIds.map(() => "?").join(",")})`,
    )
    .all(...rowIds, ...refColumnIds) as any[];

  const byRow = new Map<number, Record<string, string | null>>();
  for (const id of rowIds) byRow.set(id, {});
  for (const c of rows) {
    const key = keys.get(Number(c.column_id));
    if (key) byRow.get(Number(c.row_id))![key] = c.value_text;
  }
  return rowIds.map((rowId) => ({ rowId, values: byRow.get(rowId)! }));
}

type ScriptRow = { rowId: number; values: Record<string, string | null> };

/**
 * The fingerprint of everything that decides this cell's value: the exact bytes of the script, and
 * the exact values it is about to be handed.
 *
 * Built from `refColumnIds` IN ORDER rather than from the row object's own key order, because that
 * order comes out of a SQL result set and is not guaranteed to be the same on the next pass — a hash
 * that moved with it would never match, and the skip it exists for would never fire.
 */
function inputHashOf(
  scriptHash: string,
  refColumnIds: number[],
  keys: Map<number, string>,
  values: Record<string, string | null>,
): string {
  const h = createHash("sha256").update(scriptHash);
  for (const id of refColumnIds) {
    const key = keys.get(id);
    const v = key == null ? null : values[key] ?? null;
    // Length-prefixed, so no arrangement of cell text can fake a different one: a plain separator
    // would let ["a","b"] and ["a b", null] agree, and an agreeing hash is a cell that never
    // recomputes again. A null and an empty string are different inputs and hash differently.
    h.update(` ${v == null ? -1 : v.length} `);
    if (v != null) h.update(v);
  }
  return h.digest("hex");
}

/**
 * Work out which rows in this batch actually need computing.
 *
 * This is the whole point of storing `input_hash`: re-running a column after adding fifty rows
 * should cost fifty rows of work, not the whole table, and on the paid lanes that difference is
 * money. A cell is left alone only when it is `done`, not stale, and its stored hash equals the hash
 * of the exact values this pass would feed the script plus the script's own bytes. Anything else
 * recomputes, which is the safe direction — a wrong skip is a value that never updates again.
 */
function planBatch(
  columnId: number,
  rows: ScriptRow[],
  refColumnIds: number[],
  keys: Map<number, string>,
  scriptHash: string,
  skipUnchanged: boolean,
): { rows: ScriptRow[]; hashes: Map<number, string>; skipped: number } {
  const hashes = new Map<number, string>();
  for (const r of rows) hashes.set(r.rowId, inputHashOf(scriptHash, refColumnIds, keys, r.values));
  if (!skipUnchanged || rows.length === 0) return { rows, hashes, skipped: 0 };

  const existing = db
    .prepare(
      `SELECT row_id, status, stale, input_hash FROM cells
        WHERE column_id = ? AND row_id IN (${rows.map(() => "?").join(",")})`,
    )
    .all(columnId, ...rows.map((r) => r.rowId)) as any[];

  const unchanged = new Set<number>();
  for (const c of existing) {
    // `stale` is deliberately part of the test. A cell flagged by an upstream change recomputes even
    // when the hash agrees, because otherwise the flag has no way to clear.
    if (
      c.status === "done" && Number(c.stale) === 0 && c.input_hash &&
      c.input_hash === hashes.get(Number(c.row_id))
    ) {
      unchanged.add(Number(c.row_id));
    }
  }
  if (unchanged.size === 0) return { rows, hashes, skipped: 0 };
  return { rows: rows.filter((r) => !unchanged.has(r.rowId)), hashes, skipped: unchanged.size };
}

/** Persist a batch of results. One transaction per batch — per-statement commits would dominate. */
function writeBatch(
  columnId: number,
  hook: "transform" | "condition",
  results: ScriptRowResult[],
  hashes: Map<number, string>,
  runId: string | undefined,
): number {
  let errors = 0;
  const dirty: string[] = [];

  tx(() => {
    // COALESCE on the run id: a dry run has none, and writing NULL there would erase the record of
    // which run last produced the value.
    const ok = db.prepare(
      `UPDATE cells SET value_text = ?, value_json = ?, status = 'done', error_type = NULL,
                        error_msg = NULL, stale = 0, input_hash = ?, rev = rev + 1,
                        run_id = COALESCE(?, run_id), updated_at = datetime('now')${pinClear(runId)}
        WHERE row_id = ? AND column_id = ?${pinGuard(runId)}`,
    );
    const skip = db.prepare(
      `UPDATE cells SET status = 'skipped', note = ?, rev = rev + 1,
                        run_id = COALESCE(?, run_id), updated_at = datetime('now')
        WHERE row_id = ? AND column_id = ?${pinGuard(runId)}`,
    );
    const bad = db.prepare(
      `UPDATE cells SET status = 'error', error_type = 'script', error_msg = ?, rev = rev + 1,
                        run_id = COALESCE(?, run_id), updated_at = datetime('now')
        WHERE row_id = ? AND column_id = ?${pinGuard(runId)}`,
    );
    // Immutable history, for FAILURES only.
    //
    // Deliberately not one row per success: this lane exists because a script column is one pass
    // over the whole table, and a million provenance rows per pass is the exact cost that shape was
    // chosen to avoid. A success already records everything there is to know on the cell itself
    // (status, input_hash, updated_at); a failure is rare, is the thing the detail drawer is opened
    // for, and is the one outcome the next pass would otherwise overwrite without trace.
    const attempt = db.prepare(
      `INSERT INTO cell_attempts (row_id, column_id, run_id, attempt, started_at, finished_at,
                                  status, script_hash, error_type, error_msg)
       VALUES (?, ?, ?, 1, datetime('now'), datetime('now'), 'error', ?, 'script', ?)`,
    );

    for (const r of results) {
      const hash = hashes.get(r.rowId) ?? null;
      if (r.error) {
        // Redacted before it is STORED, not only before it is broadcast.
        //
        // A script gets row values rather than credentials, so this is the lower-risk of the two
        // paths — but a script that builds a request and throws with the request in the message puts
        // whatever it built into a database row that the cell drawer, the CSV export and every
        // future reader can see. The paid lane already redacts on write (`writeCellOutcome`); this
        // one did not, which meant the rule held everywhere except the lane that runs user code.
        const msg = redactSecrets(r.error).slice(0, 500);
        bad.run(msg, runId ?? null, r.rowId, columnId);
        attempt.run(r.rowId, columnId, runId ?? null, hash, msg);
        errors++;
      } else if (hook === "condition") {
        // A condition writes a gate result, not a value: false means this row is skipped and nothing
        // downstream spends anything on it. Only reached when the caller asked for the answer to be
        // written — a gate run by the run engine takes its results instead, because the column it
        // gates is not its to write to.
        if (r.value) ok.run("true", JSON.stringify(true), hash, runId ?? null, r.rowId, columnId);
        else skip.run("condition returned false", runId ?? null, r.rowId, columnId);
      } else {
        const text = r.value == null ? null : typeof r.value === "string" ? r.value : JSON.stringify(r.value);
        ok.run(text, r.value == null ? null : JSON.stringify(r.value), hash, runId ?? null, r.rowId, columnId);
      }
      dirty.push(cellId(r.rowId, columnId));
    }
  });

  markColumnDirty(columnId);
  markCellsDirty(dirty);
  return errors;
}

// ─────────────────────────────────────────────────────────────── JS runtime

const workerPath = join(fileURLToPath(new URL(".", import.meta.url)), "jsWorker.ts");

async function runJs(input: ScriptRunInput, keys: Map<number, string>, hash: string): Promise<ScriptRunResult> {
  const started = Date.now();
  const worker = new Worker(workerPath, {
    workerData: { code: input.code, hook: input.hook },
    // tsx registers the TS loader for the worker too.
    execArgv: ["--import", "tsx"],
  });

  let processed = 0;
  let errors = 0;
  let skipped = 0;
  let stopped = false;
  const stopNow = () => input.signal?.aborted === true || input.shouldStop?.() === true;
  // A gate's answer is wanted for THIS pass and stored nowhere, so there is nothing to short-circuit.
  const skipUnchanged = input.skipUnchanged === true && !input.onResults;

  // Stop means stop: tear the worker down the moment the run is aborted rather than letting a hung
  // batch hold a thread — and its memory — for the rest of its thirty-second timeout.
  const onAbort = () => { void worker.terminate(); };
  input.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await new Promise<void>((resolve, reject) => {
      worker.once("message", (m: any) => (m.error ? reject(new Error(m.error)) : resolve()));
      worker.once("error", reject);
    });

    for (let i = 0; i < input.rowIds.length; i += BATCH) {
      // The batch boundary is this lane's only checkpoint — it has no per-row queue to stop handing
      // out — and at 2,000 rows it comes round often enough for Stop and Pause to feel immediate.
      if (stopNow()) { stopped = true; break; }

      const slice = input.rowIds.slice(i, i + BATCH);
      const plan = planBatch(
        input.columnId, readBatch(slice, input.refColumnIds, keys),
        input.refColumnIds, keys, hash, skipUnchanged,
      );
      skipped += plan.skipped;
      if (plan.rows.length === 0) continue;

      let abortedMidBatch = false;
      const results = await new Promise<ScriptRowResult[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Script batch timed out — likely an infinite loop or runaway regex."));
        }, BATCH_TIMEOUT_MS);
        const onMessage = (m: any) => {
          cleanup();
          if (m.error) reject(new Error(m.error));
          else resolve(m.results);
        };
        // An abort answers the batch itself, rather than leaving this promise waiting on a worker
        // that has just been terminated and will never reply.
        const onStop = () => { cleanup(); abortedMidBatch = true; resolve([]); };
        function cleanup() {
          clearTimeout(timer);
          worker.off("message", onMessage);
          input.signal?.removeEventListener("abort", onStop);
        }
        input.signal?.addEventListener("abort", onStop, { once: true });
        worker.once("message", onMessage);
        worker.postMessage({ id: i, rows: plan.rows });
      });
      // Nothing came back for this batch, so there is nothing to write and nothing to count.
      if (abortedMidBatch) { stopped = true; break; }

      if (input.onResults) {
        input.onResults(results);
        for (const r of results) if (r.error) errors++;
      } else {
        errors += writeBatch(input.columnId, input.hook, results, plan.hashes, input.runId);
      }
      processed += results.length;
      input.onProgress?.(processed, input.rowIds.length);
    }
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    await worker.terminate();
  }

  return { processed, errors, skipped, ms: Date.now() - started, spawns: 0, stopped };
}

// ─────────────────────────────────────────────────────────────── shell runtime

/**
 * Run a PowerShell or bash script over the whole column in ONE process.
 *
 * Row values are written to the child's stdin as NDJSON and never interpolated into the command
 * line. That is the difference between a cell containing `; Remove-Item -Recurse C:\` being inert
 * data and being executed. The generated script is trusted once approved; the row data flowing
 * through it never is.
 */
async function runShell(input: ScriptRunInput, keys: Map<number, string>, hash: string): Promise<ScriptRunResult> {
  const started = Date.now();
  const ext = input.runtime === "powershell" ? "ps1" : "sh";
  const scriptPath = join(SCRIPTS_DIR, `${hash.slice(0, 16)}-${randomUUID().slice(0, 8)}.${ext}`);
  writeFileSync(scriptPath, input.code, "utf8");

  const [cmd, args] =
    input.runtime === "powershell"
      ? ["powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath]]
      : ["bash", [scriptPath]];

  // shell:false — the arguments array is passed directly, so nothing is re-parsed by a shell.
  const child = spawn(cmd, args as string[], { shell: false, stdio: ["pipe", "pipe", "pipe"] });

  let processed = 0;
  let errors = 0;
  let skipped = 0;
  let stopped = false;
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += String(d).slice(0, 2000); });

  // Reaping the process tree is needed in two places now — on abort and on the way out — so it is a
  // function rather than a block. On Windows child.kill() orphans descendants, hence taskkill /T.
  const reap = (): void => {
    if (child.killed || child.exitCode != null) return;
    try {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: false });
      else child.kill("SIGKILL");
    } catch { /* already gone */ }
  };

  // A stopped run kills the child while the feed loop below may still be writing to it. Without a
  // handler that EPIPE is an unhandled stream error, which takes the whole engine down with it.
  child.stdin.on("error", () => { /* the child is gone; the stop path already knows */ });

  const stopNow = () => input.signal?.aborted === true || input.shouldStop?.() === true;
  const skipUnchanged = input.skipUnchanged === true && !input.onResults;
  const onAbort = () => { stopped = true; reap(); };
  input.signal?.addEventListener("abort", onAbort, { once: true });

  const pending = new Map<number, { rowId: number }>();
  const hashes = new Map<number, string>();
  let buffer = "";
  const results: ScriptRowResult[] = [];

  const done = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      let nl: number;
      // Results stream back line by line; a partial line at the end of a chunk is held over.
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as { rowId: number; value?: unknown; error?: string };
          results.push({ rowId: Number(obj.rowId), value: obj.value ?? null, error: obj.error });
          pending.delete(Number(obj.rowId));
        } catch {
          // A script that prints something other than NDJSON is a script bug, surfaced as such
          // rather than silently discarded.
          stderr += `\nunparseable output line: ${line.slice(0, 200)}`;
        }
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      // A stopped run kills the child on purpose, so its non-zero exit is the kill and not a script
      // failure. Reporting it as one would turn every Stop into a red run.
      if (stopped) resolve();
      else if (code !== 0 && results.length === 0) reject(new Error(`Script exited with code ${code}. ${stderr.slice(0, 500)}`));
      else resolve();
    });
  });

  for (let i = 0; i < input.rowIds.length; i += BATCH) {
    if (stopNow()) { stopped = true; break; }
    const slice = input.rowIds.slice(i, i + BATCH);
    const plan = planBatch(
      input.columnId, readBatch(slice, input.refColumnIds, keys),
      input.refColumnIds, keys, hash, skipUnchanged,
    );
    skipped += plan.skipped;
    for (const r of plan.rows) {
      pending.set(r.rowId, { rowId: r.rowId });
      hashes.set(r.rowId, plan.hashes.get(r.rowId)!);
      child.stdin.write(JSON.stringify({ rowId: r.rowId, values: r.values }) + "\n");
    }
    input.onProgress?.(Math.min(i + BATCH, input.rowIds.length), input.rowIds.length);
  }
  // Stop feeding it, then bring it down: the rows already handed over have been computed and their
  // answers are still worth keeping, but nothing further is going in.
  if (stopped) reap();
  try { child.stdin.end(); } catch { /* the child is already gone */ }

  try {
    await done;
    if (input.onResults) {
      input.onResults(results);
      for (const r of results) if (r.error) errors++;
    } else {
      errors = writeBatch(input.columnId, input.hook, results, hashes, input.runId);
    }
    processed = results.length;
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    try { unlinkSync(scriptPath); } catch { /* best effort */ }
    reap();
  }

  return { processed, errors, skipped, ms: Date.now() - started, spawns: 1, stopped };
}

// ─────────────────────────────────────────────────────────────── entry

export async function runScriptColumn(input: ScriptRunInput): Promise<ScriptRunResult> {
  const keys = new Map<number, string>();
  for (const r of db.prepare("SELECT id, key FROM columns WHERE sheet_id = ?").all(input.sheetId) as any[]) {
    keys.set(Number(r.id), String(r.key).replace(/\s+/g, "_"));
  }
  const hash = createHash("sha256").update(input.code).digest("hex");

  return input.runtime === "js" ? runJs(input, keys, hash) : runShell(input, keys, hash);
}
