// Runs that start themselves, on a clock.
//
// The sibling of auto-run. That one answers "something changed, bring this back up to date"; this
// one answers "check again every morning whether it changed at all" — which is the only way to
// notice a company that renamed itself, a website that went dark, or a price that moved, because
// nothing in this workspace changed when they did.
//
// ── Spending on a timer ─────────────────────────────────────────────────────────────────────────
//
// A schedule MAY run a paid column, and so may auto-run. The two share one bargain rather than
// being opposites: both are switched on by hand for one named thing, and both carry an optional
// per-firing ceiling. What differs is the trigger — auto-run fires on somebody else's import or
// webhook, a schedule on a clock the user set.
//
// What that costs is never a surprise, and this is the part that matters:
//
//   SWITCHING ONE ON IS THE MOMENT OF CONSENT. Enabling a schedule that will spend is refused until
//   it is confirmed, and the refusal carries the columns that bill and an estimate of what one
//   firing costs. Creating the schedule is free and always starts OFF; the switch is the decision.
//
//   EVERY FIRING IS ON THE RECORD. Each run this schedule starts is stamped with its id, so what it
//   has spent — last time, and in total across every firing — is a query over the runs themselves
//   rather than a second tally that can drift from them.
//
// Beyond that, the same thing that makes auto-run safe: it creates an ORDINARY RUN. It appears in the
// run strip, it is cancellable, it obeys the sheet budget and its own per-run ceiling, it honours
// each column's run condition, and the unchanged-row skip means rows whose inputs did not move cost
// nothing. Anything a schedule does, pressing Run could have done.
//
// On top of that, three rules that exist only because this one starts without a person present:
//
//   NEW SCHEDULES ARE OFF. Creating one describes an intention; switching it on is a separate,
//   deliberate act. A form that starts spending the moment you finish filling it in is a form people
//   are right to be afraid of.
//
//   IT NEVER OVERLAPS ITSELF. If the run it started last time is still going, this tick is skipped
//   and says so. An hourly schedule over a slow million-row column would otherwise stack runs until
//   the queue was nothing but copies of the same work.
//
//   A MISSED WINDOW RUNS ONCE, NOT N TIMES. Close the laptop on Friday, open it on Monday, and an
//   hourly schedule is due 72 times over. Firing 72 runs to "catch up" would be the most expensive
//   possible reading of an instruction that meant "keep this fresh". The clock is advanced past
//   everything that was missed and the work runs once.
//
// ── Why failures are recorded rather than thrown ───────────────────────────────────────────────
//
// `createRun` refuses for good reasons — nothing matches the filter, the columns need a key that is
// not there, another run already has these columns. Those are all normal states for a schedule that
// fires unattended, and none of them should stop the ticker or take down the process. So each one is
// caught and written to the schedule as the reason nothing happened, which is also the only way the
// user can find out. A schedule that silently does nothing is indistinguishable from a broken one.

import { db, tx } from "./db.ts";
import { isFreeToRun } from "./autoRun.ts";
import { PAUSED_STATUSES } from "./runs.ts";
import type { RunScope } from "./scope.ts";

/**
 * The columns this schedule would run that bill per row, by name.
 *
 * Used to WARN, not to refuse — see the header. It is what the enable step puts in front of the user
 * and what every screen showing this schedule uses to mark it as one that spends.
 *
 * `isFreeToRun` is borrowed from auto-run because "does this cost money" is one question and must
 * have one answer. Both act on it the same way: by telling you, and by offering a ceiling.
 *
 * An empty scope means "every runnable column on the sheet", so that case is read the same way — as
 * every column — or a schedule with no explicit list would look free while running the lot.
 */
export function paidColumnsOf(s: Pick<Schedule, "sheetId" | "scope">): string[] {
  const ids = (s.scope.columnIds ?? []).map(Number).filter((n) => Number.isFinite(n));
  const rows = (ids.length > 0
    ? db
        .prepare(
          `SELECT name, kind, model, first_model, waterfall_json FROM columns
            WHERE sheet_id = ? AND deleted_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`,
        )
        .all(s.sheetId, ...ids)
    : db
        .prepare("SELECT name, kind, model, first_model, waterfall_json FROM columns WHERE sheet_id = ? AND deleted_at IS NULL")
        .all(s.sheetId)) as Array<{ name: string; kind: string; model: string | null; first_model: string | null; waterfall_json: string | null }>;

  return rows.filter((r) => !isFreeToRun(r)).map((r) => r.name);
}

/** How often the ticker looks for due schedules. Also the granularity anything here can promise. */
export const TICK_MS = 30_000;

/**
 * The shortest interval allowed.
 *
 * Not a technical limit — a floor on how expensive a mistake can be. "Every minute" over a paid
 * column is 1,440 runs a day, and nobody types that meaning it.
 */
export const MIN_INTERVAL_MIN = 5;

export type Cadence =
  | { kind: "interval"; minutes: number }
  /** Local time, because a day boundary is a human thing. `at` is minutes past midnight. */
  | { kind: "daily"; at: number }
  | { kind: "weekly"; weekday: number; at: number };

export interface Schedule {
  id: number;
  sheetId: string;
  name: string;
  cadence: Cadence;
  scope: RunScope;
  enabled: boolean;
  /** Recompute even rows whose inputs have not changed. Off by default: it turns a cheap run costly. */
  force: boolean;
  /** A ceiling for one firing of this schedule. Null means only the sheet-wide cap applies. */
  budgetUsd: number | null;
  /** UTC, ISO-ish (`YYYY-MM-DD HH:MM:SS`) to match everything else stored here. */
  nextAt: string;
  lastAt: string | null;
  lastRunId: string | null;
  /** What happened the last time it was due — empty until it has been. */
  lastStatus: string;
  runs: number;
  createdAt: string;
  /** What the last firing cost. Null when it has never fired — which is not the same as zero. */
  lastCostUsd: number | null;
  /** What every firing of this schedule has cost, added up. */
  totalCostUsd: number;
  /** The columns it runs that bill per row, by name. Empty means this schedule cannot spend. */
  paidColumns: string[];
}

const DAY_MIN = 24 * 60;
const WEEK_MIN = 7 * DAY_MIN;

/** `YYYY-MM-DD HH:MM:SS` in UTC — the format every other timestamp in this database uses. */
export const stamp = (d: Date): string => d.toISOString().slice(0, 19).replace("T", " ");

/** SQLite's `datetime('now')` is UTC with no zone marker, so it needs one before Date will take it. */
export const parseStamp = (s: string): Date => new Date(`${s.replace(" ", "T")}Z`);

/**
 * When this cadence is next due, strictly AFTER `from`.
 *
 * Strictly after matters: called with the moment a firing was due, it has to return the FOLLOWING
 * one. Returning the same instant would leave the schedule permanently due and fire it every tick.
 *
 * Daily and weekly are computed in LOCAL time. "Every day at 07:00" means seven in the morning where
 * the person is, and computing it in UTC would drift it by the offset and move it twice a year.
 */
export function nextAt(cadence: Cadence, from: Date): Date {
  if (cadence.kind === "interval") {
    const ms = Math.max(MIN_INTERVAL_MIN, Math.floor(cadence.minutes)) * 60_000;
    return new Date(from.getTime() + ms);
  }

  const at = clampMinute(cadence.at);
  const next = new Date(from);
  next.setHours(Math.floor(at / 60), at % 60, 0, 0);

  if (cadence.kind === "daily") {
    if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
    return next;
  }

  // Weekly: land on the right weekday first, then push a whole week if that instant has passed.
  const want = ((Math.floor(cadence.weekday) % 7) + 7) % 7;
  const shift = (want - next.getDay() + 7) % 7;
  next.setDate(next.getDate() + shift);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 7);
  return next;
}

const clampMinute = (n: number): number => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.min(DAY_MIN - 1, Math.max(0, v)) : 0;
};

/**
 * Move a due schedule's clock forward past everything it missed, landing in the future.
 *
 * This is the "closed laptop" rule. Advancing by one period would leave a schedule that was asleep
 * for three days still due, and it would fire on every tick until it had caught up — 72 runs for an
 * hourly schedule, which is exactly the bill nobody meant to authorise.
 *
 * Bounded rather than looped-until-true: a corrupt cadence that fails to advance would otherwise
 * spin here forever, inside the tick, with the database open.
 */
export function advance(cadence: Cadence, from: Date, now: Date): Date {
  let at = nextAt(cadence, from);
  for (let i = 0; i < 5000 && at.getTime() <= now.getTime(); i++) {
    const then = at;
    at = nextAt(cadence, at);
    // No forward progress — refuse to spin, and put it a period ahead of NOW so it is reachable.
    if (at.getTime() <= then.getTime()) return nextAt(cadence, now);
  }
  return at.getTime() > now.getTime() ? at : nextAt(cadence, now);
}

/** Plain English, for the list. The label is the whole reason a schedule can be reviewed at a glance. */
export function describe(cadence: Cadence): string {
  if (cadence.kind === "interval") {
    const m = Math.max(MIN_INTERVAL_MIN, Math.floor(cadence.minutes));
    if (m % WEEK_MIN === 0) return every(m / WEEK_MIN, "week");
    if (m % DAY_MIN === 0) return every(m / DAY_MIN, "day");
    if (m % 60 === 0) return every(m / 60, "hour");
    return every(m, "minute");
  }
  const time = clock(cadence.at);
  if (cadence.kind === "daily") return `Every day at ${time}`;
  return `Every ${DAYS[((Math.floor(cadence.weekday) % 7) + 7) % 7]} at ${time}`;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const every = (n: number, unit: string) => (n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`);
const clock = (at: number) => {
  const m = clampMinute(at);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** Refuses a cadence it cannot honour rather than quietly substituting one. */
export function normalizeCadence(raw: unknown): Cadence {
  const c = (raw ?? {}) as Record<string, unknown>;
  const kind = String(c.kind ?? "");
  if (kind === "daily") return { kind: "daily", at: clampMinute(Number(c.at)) };
  if (kind === "weekly") {
    return { kind: "weekly", weekday: ((Math.floor(Number(c.weekday) || 0) % 7) + 7) % 7, at: clampMinute(Number(c.at)) };
  }
  const minutes = Math.floor(Number(c.minutes));
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error("A schedule needs a cadence — how often, or what time of day.");
  }
  if (minutes < MIN_INTERVAL_MIN) {
    throw new Error(`The shortest interval is every ${MIN_INTERVAL_MIN} minutes.`);
  }
  return { kind: "interval", minutes };
}

const row = (r: any): Schedule => ({
  id: Number(r.id),
  sheetId: String(r.sheet_id),
  name: String(r.name ?? ""),
  cadence: JSON.parse(String(r.cadence_json)) as Cadence,
  scope: JSON.parse(String(r.scope_json ?? "{}")) as RunScope,
  enabled: !!r.enabled,
  force: !!r.force,
  budgetUsd: r.budget_usd == null ? null : Number(r.budget_usd),
  nextAt: String(r.next_at),
  lastAt: r.last_at == null ? null : String(r.last_at),
  lastRunId: r.last_run_id == null ? null : String(r.last_run_id),
  lastStatus: String(r.last_status ?? ""),
  runs: Number(r.runs ?? 0),
  createdAt: String(r.created_at ?? ""),
  // Read from the runs this schedule started, never from a counter of its own. Null rather than zero
  // on a schedule that has never fired: zero is a claim about money, null is the absence of one.
  lastCostUsd: r.last_cost_usd == null ? null : Number(r.last_cost_usd),
  totalCostUsd: Number(r.total_cost_usd ?? 0),
  paidColumns: [],
});

/**
 * Every read of a schedule carries what it has spent.
 *
 * Correlated sub-selects rather than a join, so a schedule that has never run still comes back — a
 * join would drop it — and so the result stays exactly one row per schedule. Both read
 * `runs.cost_usd`, the same figure the run strip and the usage screens show, so there is ONE number
 * for what a firing cost rather than three that can disagree.
 *
 * The last cost is looked up through the schedule's own `last_run_id`, not "the most recent run over
 * these columns": a run somebody started by hand is not this schedule's spending.
 */
const SCHEDULE_SELECT =
  "SELECT s.*, " +
  "(SELECT r.cost_usd FROM runs r WHERE r.id = s.last_run_id) AS last_cost_usd, " +
  "(SELECT COALESCE(SUM(r.cost_usd), 0) FROM runs r WHERE r.schedule_id = s.id) AS total_cost_usd " +
  "FROM schedules s";

/** The same schedule, with the paid columns it would run filled in. */
const withPaid = (s: Schedule): Schedule => ({ ...s, paidColumns: paidColumnsOf(s) });

export function listSchedules(sheetId: string): Schedule[] {
  return (db
    .prepare(`${SCHEDULE_SELECT} WHERE s.sheet_id = ? ORDER BY s.id`)
    .all(sheetId) as any[]).map(row).map(withPaid);
}

export function getSchedule(id: number): Schedule | null {
  const r = db.prepare(`${SCHEDULE_SELECT} WHERE s.id = ?`).get(Number(id)) as any;
  return r ? withPaid(row(r)) : null;
}

export interface NewSchedule {
  sheetId: string;
  name?: string;
  cadence: unknown;
  scope?: RunScope;
  force?: boolean;
  budgetUsd?: number | null;
}

export function createSchedule(input: NewSchedule): Schedule {
  const cadence = normalizeCadence(input.cadence);
  const budget = normalizeBudget(input.budgetUsd);
  const now = new Date();
  const id = db
    .prepare(
      `INSERT INTO schedules (sheet_id, name, cadence_json, scope_json, enabled, force, budget_usd, next_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?) RETURNING id`,
    )
    .get(
      input.sheetId,
      String(input.name ?? "").slice(0, 120),
      JSON.stringify(cadence),
      JSON.stringify(input.scope ?? {}),
      input.force ? 1 : 0,
      budget,
      // Stored even though it is off, so the list can answer "when would this next go" before you
      // commit to switching it on.
      stamp(nextAt(cadence, now)),
    ) as any;
  return getSchedule(Number(id.id))!;
}

function normalizeBudget(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error("A limit has to be an amount above zero, or left out.");
  return n;
}

export function updateSchedule(
  id: number,
  patch: { name?: string; cadence?: unknown; scope?: RunScope; force?: boolean; budgetUsd?: number | null; enabled?: boolean },
): Schedule {
  const before = getSchedule(id);
  if (!before) throw new Error("That schedule no longer exists.");

  const sets: string[] = [];
  const args: Array<string | number | null> = [];
  const put = (col: string, v: string | number | null) => { sets.push(`${col} = ?`); args.push(v); };

  if (patch.name !== undefined) put("name", String(patch.name).slice(0, 120));
  if (patch.scope !== undefined) put("scope_json", JSON.stringify(patch.scope ?? {}));
  if (patch.force !== undefined) put("force", patch.force ? 1 : 0);
  if (patch.budgetUsd !== undefined) put("budget_usd", normalizeBudget(patch.budgetUsd));

  let cadence = before.cadence;
  if (patch.cadence !== undefined) {
    cadence = normalizeCadence(patch.cadence);
    put("cadence_json", JSON.stringify(cadence));
  }

  /**
   * The clock is re-based when the cadence changes, and when it is switched ON.
   *
   * Both for the same reason. A schedule that sat switched off for a month has a `next_at` a month
   * in the past, and switching it on without re-basing would fire it the instant the next tick came
   * round — the user asked for "every day at seven", and got "right now", which on a paid column is
   * the difference between a plan and a surprise.
   */
  if (patch.cadence !== undefined || patch.enabled === true) {
    put("next_at", stamp(nextAt(cadence, new Date())));
  }
  if (patch.enabled !== undefined) put("enabled", patch.enabled ? 1 : 0);

  if (sets.length > 0) {
    args.push(Number(id));
    db.prepare(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  }
  return getSchedule(id)!;
}

export function deleteSchedule(id: number): void {
  db.prepare("DELETE FROM schedules WHERE id = ?").run(Number(id));
}

/**
 * Starts a run and hands back its id. Registered from the boot file rather than imported, for the
 * same two reasons auto-run's starter is: runs.ts already reaches into this side of the graph, and a
 * module that can start a PAID run should not be able to merely by being imported. Nothing registers
 * one in the tests, so nothing here spends anything.
 */
export type ScheduleRunner = (s: Schedule) => string;

let runner: ScheduleRunner | null = null;
export function registerScheduleRunner(fn: ScheduleRunner): void { runner = fn; }

/**
 * Whether a run this schedule started is still going. Its own last one only — never anyone else's.
 *
 * A PAUSED run counts, and every kind of paused counts. It has work left and a Resume waiting for a
 * decision, so firing a second run over the same columns is the stacking this rule exists to stop —
 * and on the budget pause it is worse than stacking, because each new firing spends the whole
 * per-firing ceiling again while the run that hit it sits there. The set is imported rather than
 * listed here for exactly the reason it exists: this check was written before `paused_budget`, and a
 * list written out in two places only agrees until one of them is added to.
 */
function stillRunning(runId: string | null): boolean {
  if (!runId) return false;
  const r = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as any;
  return !!r && (r.status === "running" || r.status === "pending" || PAUSED_STATUSES.has(r.status));
}

/**
 * Fire one schedule now, by hand, and leave the same trail the clock would.
 *
 * Through the SAME runner the ticker uses. A "test it" button that took a different path would
 * prove nothing about the path that runs at four in the morning. It does NOT move the clock: trying
 * a schedule out should not push its real next firing around.
 *
 * The overlap guard still applies — pressing this twice must not stack two runs any more than two
 * ticks may.
 */
export function runScheduleNow(s: Schedule): string {
  if (!runner) throw new Error("This engine cannot start runs.");
  if (stillRunning(s.lastRunId)) throw new Error("A run from this schedule is still going.");
  const runId = runner(s);
  db.prepare(
    "UPDATE schedules SET last_at = ?, last_status = ?, last_run_id = ?, runs = runs + 1 WHERE id = ?",
  ).run(stamp(new Date()), "Started by hand.", runId, s.id);
  return runId;
}

export interface TickResult {
  due: number;
  started: number;
  skipped: number;
}

/**
 * One pass of the clock: fire everything that is due.
 *
 * Exported so a test can drive it directly with an injected `now` instead of waiting on a timer —
 * a scheduler tested only through its own interval is a scheduler tested at one speed.
 */
export function tick(now: Date = new Date()): TickResult {
  const out: TickResult = { due: 0, started: 0, skipped: 0 };
  if (!runner) return out;

  const dueRows = db
    .prepare(
      `SELECT s.* FROM schedules s
         JOIN sheets sh ON sh.id = s.sheet_id AND sh.deleted_at IS NULL
        WHERE s.enabled = 1 AND s.next_at <= ?
        ORDER BY s.next_at`,
    )
    .all(stamp(now)) as any[];

  for (const raw of dueRows) {
    const s = row(raw);
    out.due++;

    /**
     * The clock moves FIRST, before anything is attempted.
     *
     * If starting the run threw and the clock had not moved, the schedule would still be due on the
     * next tick, and on every tick after that — a failing schedule would hammer whatever it was
     * failing against every thirty seconds. Moving it first means one attempt per window, whatever
     * the outcome.
     */
    const next = advance(s.cadence, parseStamp(s.nextAt), now);

    let status: string;
    let runId: string | null = null;

    if (stillRunning(s.lastRunId)) {
      status = "The previous run was still going, so this turn was skipped.";
      out.skipped++;
    } else {
      try {
        runId = runner(s);
        status = "Started.";
        out.started++;
      } catch (e) {
        // Every ordinary refusal lands here: nothing matched the filter, a key is missing, another
        // run holds these columns. Recorded, never thrown — one schedule's problem must not stop the
        // others in the same tick, and must not take the process down.
        status = e instanceof Error ? e.message : String(e);
        out.skipped++;
      }
    }

    tx(() => {
      db.prepare(
        `UPDATE schedules
            SET next_at = ?, last_at = ?, last_status = ?,
                last_run_id = COALESCE(?, last_run_id),
                runs = runs + ?
          WHERE id = ?`,
      ).run(stamp(next), stamp(now), status.slice(0, 300), runId, runId ? 1 : 0, s.id);
    });
  }

  return out;
}

/** The heartbeat. Returns a stop function so a test, or shutdown, can end it. */
export function startTicker(onError?: (e: unknown) => void): () => void {
  const t = setInterval(() => {
    try { tick(); } catch (e) { onError?.(e); }
  }, TICK_MS);
  // Unref'd: a timer is not a reason for the process to stay alive during shutdown.
  t.unref();
  return () => clearInterval(t);
}
