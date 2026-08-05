// Live run state.
//
// Run events are low-frequency (a handful per run), so unlike cell deltas they are not coalesced —
// the UI wants them promptly. What IS smoothed is the ETA: an unrounded estimate recomputed every
// second visibly twitches, and a number that jitters reads as broken even when it is accurate.

export interface RunState {
  id: string;
  sheetId: string;
  // Mirrors RunStatus in src/types.ts. Every screen that reads it does so through
  // `status.startsWith("paused")`, so a new pause reason behaves correctly here whether or not this
  // line is updated — but it is listed anyway, because a union that quietly falls behind the engine
  // is how `send` went missing from three separate hand-written lists elsewhere in this app.
  status:
    | "pending" | "running"
    | "paused" | "paused_quota" | "paused_auth" | "paused_budget"
    | "cancelling" | "cancelled" | "done" | "failed";
  total: number;
  done: number;
  errors: number;
  skipped: number;
  /** Ran and produced no value. Counted apart from `done`, because it is not what "done" means. */
  blank: number;
  costUsd: number;
  /** The part of `costUsd` that bought nothing. A subset of it, never an extra charge. */
  wasteUsd: number;
  startedAt: string | null;
  finishedAt: string | null;
  pauseReason: string | null;
  summary: string;
}

type Listener = () => void;

const TERMINAL = new Set(["done", "cancelled", "failed"]);
/** How long a finished run stays on screen. The final cost is the number people want to read, so it
 *  must not vanish the instant the last cell lands. */
const LINGER_MS = 8000;

class RunStore {
  private runs = new Map<string, RunState>();
  private listeners = new Set<Listener>();
  private version = 0;
  private linger = new Map<string, number>();

  /** Completion samples for the ETA, as [epochMs, doneCount]. */
  private samples = new Map<string, Array<[number, number]>>();
  private etaCache = new Map<string, number | null>();

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  };

  getVersion = (): number => this.version;

  private notify(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  /** Runs worth showing: anything live, plus a finished one still within its linger window. */
  visible(sheetId: string | null): RunState[] {
    const now = Date.now();
    const out: RunState[] = [];
    for (const r of this.runs.values()) {
      if (sheetId && r.sheetId !== sheetId) continue;
      if (!TERMINAL.has(r.status)) { out.push(r); continue; }
      const until = this.linger.get(r.id);
      if (until != null && now < until) out.push(r);
    }
    return out;
  }

  upsert(run: RunState): void {
    const prev = this.runs.get(run.id);
    this.runs.set(run.id, run);

    if (!prev || prev.done !== run.done) {
      const s = this.samples.get(run.id) ?? [];
      s.push([Date.now(), run.done]);
      // A short window keeps the ETA responsive when throughput changes, without tracking a run's
      // entire history.
      if (s.length > 40) s.shift();
      this.samples.set(run.id, s);
      this.etaCache.delete(run.id);
    }

    if (TERMINAL.has(run.status) && !this.linger.has(run.id)) {
      this.linger.set(run.id, Date.now() + LINGER_MS);
      // Re-render once the linger expires so the strip actually leaves.
      setTimeout(() => { this.notify(); }, LINGER_MS + 50);
    }
    this.notify();
  }

  /**
   * Seconds remaining, from an exponentially-weighted rate over recent samples.
   *
   * Rounded to 5s granularity and cached per done-count: recomputing every tick produces a readout
   * that flickers between "2:35" and "2:31" and back, which looks like a bug.
   */
  eta(runId: string): number | null {
    const cached = this.etaCache.get(runId);
    if (cached !== undefined) return cached;

    const run = this.runs.get(runId);
    const s = this.samples.get(runId);
    if (!run || !s || s.length < 3 || run.done <= 0) return null;

    let weight = 0;
    let rate = 0;
    for (let i = 1; i < s.length; i++) {
      const [t0, d0] = s[i - 1]!;
      const [t1, d1] = s[i]!;
      const dt = (t1 - t0) / 1000;
      const dd = d1 - d0;
      if (dt <= 0 || dd <= 0) continue;
      // Newer samples dominate, so a run that speeds up or slows down is reflected quickly.
      const w = Math.pow(1.35, i);
      rate += (dd / dt) * w;
      weight += w;
    }
    if (weight === 0) return null;

    const perSec = rate / weight;
    if (perSec <= 0) return null;

    // A blank cell is finished work. Leaving it out of the completed total made the ETA count rows
    // that were never coming back as still to do, so it climbed on a column answering mostly blanks.
    const remaining = Math.max(0, run.total - run.done - run.skipped - run.blank);
    const secs = Math.round(remaining / perSec / 5) * 5;
    this.etaCache.set(runId, secs);
    return secs;
  }

  clear(): void {
    this.runs.clear();
    this.samples.clear();
    this.linger.clear();
    this.etaCache.clear();
    this.notify();
  }
}

export const runStore = new RunStore();

export function formatDuration(secs: number | null): string {
  if (secs == null) return "—";
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return `${m}:${String(s).padStart(2, "0")}`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function elapsedSeconds(startedAt: string | null, now: number): number | null {
  if (!startedAt) return null;
  // SQLite datetime('now') is UTC without a zone marker; parsing it as local would shift the
  // elapsed time by the timezone offset — which on a 20-second run reads as a wildly wrong number.
  const t = Date.parse(startedAt.includes("T") ? startedAt : startedAt.replace(" ", "T") + "Z");
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 1000));
}
