// Live update bus. ONE SSE stream for the whole app, multiplexed by event name.
//
// Why coalescing is not an optional optimisation: 200 cells each moving queued → running → done is
// ~600 state changes, and pushing one frame per change re-renders the grid into the ground. Writers
// mark a cell dirty; a timer drains the dirty set, reads those cells in a single query, and emits ONE
// frame containing all of them. A burst of 200 completions costs one flush, not 200.
//
// Per-cell `rev` makes the stream self-correcting: the client drops any delta whose rev it already
// holds, so a duplicate flush, an out-of-order frame, or a reconnect replay are all harmless.

import { redactSecrets } from "./redact.ts";
import { db, parseCellId } from "./db.ts";
import type { CellDelta } from "./types.ts";

const FLUSH_MS = 100;
/** A single flush is capped so one enormous run can't build a multi-megabyte frame. The remainder
 *  stays dirty and rides the next tick. */
const MAX_PER_FLUSH = 2000;

type Listener = (event: string, data: unknown, id?: number) => void;

const listeners = new Set<Listener>();
const dirtyCells = new Set<string>();
let seq = 0;
let timer: NodeJS.Timeout | null = null;

const deltaStmt = db.prepare(
  `SELECT rev, status, value_text, error_type, error_msg, cost_usd, duration_ms
     FROM cells WHERE row_id = ? AND column_id = ?`,
);

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

function broadcast(event: string, data: unknown, id?: number): void {
  for (const l of [...listeners]) {
    // One wedged client must never break delivery for the others, or a stalled browser tab
    // silently freezes every open view of the app.
    try { l(event, data, id); } catch { /* dropped */ }
  }
}

/** Mark a cell changed. Cheap and idempotent — call it on every write. */
export function markCellDirty(cellId: string): void {
  dirtyCells.add(cellId);
  ensureTimer();
}

export function markCellsDirty(ids: Iterable<string>): void {
  for (const id of ids) dirtyCells.add(id);
  ensureTimer();
}

function ensureTimer(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flush();
  }, FLUSH_MS);
  // Never hold the process open just to deliver a UI frame.
  timer.unref?.();
}

function flush(): void {
  if (dirtyCells.size === 0) return;

  const ids: string[] = [];
  for (const id of dirtyCells) {
    ids.push(id);
    if (ids.length >= MAX_PER_FLUSH) break;
  }
  for (const id of ids) dirtyCells.delete(id);

  const cells: CellDelta[] = [];
  for (const id of ids) {
    const parsed = parseCellId(id);
    if (!parsed) continue;
    const r = deltaStmt.get(parsed.rowId, parsed.columnId) as
      | { rev: number; status: string; value_text: string | null; error_type: string | null; error_msg: string | null; cost_usd: number | null; duration_ms: number | null }
      | undefined;
    if (!r) continue; // deleted between mark and flush
    const d: CellDelta = { i: id, r: r.rev, s: r.status as CellDelta["s"] };
    // While running there is no value yet, and sending null would blank the previous one in the UI.
    if (r.status !== "running" && r.status !== "queued") d.v = r.value_text;
    if (r.error_type) d.e = r.error_type;
    // The MESSAGE, not just the class. A cell that says "cancelled" or "timeout" tells you which
    // bucket it fell into; it does not tell you what happened, and the bucket name is what the grid
    // was rendering as the cell's entire explanation. Truncated because this rides a frame that can
    // carry hundreds of cells, and the full text is in the cell's detail drawer.
    //
    // Redacted first, because this text was built from someone else's response and an HTTP column's
    // URL is written by the user — putting a key in a query parameter is how plenty of APIs document
    // themselves, and a failed call names the URL it failed on. Redaction comes BEFORE the truncate:
    // cut first and a half-key can survive as a fragment no pattern matches.
    if (r.error_msg) d.m = redactSecrets(r.error_msg).slice(0, 160);
    if (r.cost_usd != null) d.c = r.cost_usd;
    if (r.duration_ms != null) d.d = r.duration_ms;
    cells.push(d);
  }

  if (cells.length > 0) broadcast("cells", { seq: ++seq, cells }, seq);

  // More arrived than one frame could carry — go again immediately rather than waiting for the
  // next write to re-arm the timer.
  if (dirtyCells.size > 0) ensureTimer();
}

/** Force a flush now (used on run completion so the final frame isn't held for 100ms). */
export function flushNow(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  flush();
}

/** Run/progress events bypass coalescing — they are low-frequency and the UI wants them promptly. */
export function emitRun(run: unknown): void {
  broadcast("run", { seq: ++seq, run }, seq);
}

/** Per-column completion stats. Low frequency: emitted when a run ends, not while it runs. */
export function emitColumnStats(stats: unknown): void {
  broadcast("columnStats", { seq: ++seq, stats }, seq);
}

export function emitQuota(quota: unknown): void {
  broadcast("quota", { seq: ++seq, quota }, seq);
}

export function currentSeq(): number {
  return seq;
}
