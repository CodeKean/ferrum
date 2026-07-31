// Runs that start themselves.
//
// This is the one feature in the workspace that spends money with nobody watching, so the tests
// worth having are the ones about how much it can spend when something goes wrong: a missed window
// firing once instead of seventy-two times, a slow run not stacking copies of itself, and a
// schedule you switched on last month not going off the instant you switch it back on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { addColumn, createSheet, setColumnModel } from "./store.ts";
import {
  advance, createSchedule, deleteSchedule, describe as describeCadence, getSchedule, listSchedules,
  nextAt, normalizeCadence, parseStamp, registerScheduleRunner, runScheduleNow, stamp, tick,
  updateSchedule, type Cadence,
} from "./schedules.ts";

/** A local time on a known day, so the daily/weekly cases are not at the mercy of the clock. */
const local = (y: number, m: number, d: number, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0);

// ── the clock ──────────────────────────────────────────────────────────────────────────────────

test("an interval is measured from the moment given, not from the wall clock", () => {
  const from = local(2026, 7, 29, 10, 0);
  assert.equal(nextAt({ kind: "interval", minutes: 90 }, from).getTime(), local(2026, 7, 29, 11, 30).getTime());
});

test("an interval below the floor is raised to it rather than honoured", () => {
  // "Every minute" over a paid column is 1,440 runs a day, and nobody types that meaning it.
  const from = local(2026, 7, 29, 10, 0);
  assert.equal(nextAt({ kind: "interval", minutes: 1 }, from).getTime(), local(2026, 7, 29, 10, 5).getTime());
  assert.throws(() => normalizeCadence({ kind: "interval", minutes: 1 }), /shortest interval/i);
});

test("daily lands on today when the time is still ahead, and tomorrow when it has passed", () => {
  const at = 7 * 60; // 07:00
  assert.equal(nextAt({ kind: "daily", at }, local(2026, 7, 29, 3, 0)).getTime(), local(2026, 7, 29, 7, 0).getTime());
  assert.equal(nextAt({ kind: "daily", at }, local(2026, 7, 29, 9, 0)).getTime(), local(2026, 7, 30, 7, 0).getTime());
});

test("the next firing is strictly AFTER the one given, never the same instant", () => {
  // Called with the moment a firing was due, returning that same instant would leave the schedule
  // permanently due — it would fire on every single tick, forever.
  const due = local(2026, 7, 29, 7, 0);
  assert.ok(nextAt({ kind: "daily", at: 7 * 60 }, due).getTime() > due.getTime());
  assert.ok(nextAt({ kind: "weekly", weekday: due.getDay(), at: 7 * 60 }, due).getTime() > due.getTime());
});

test("weekly finds the right weekday and then keeps a whole week between firings", () => {
  // 2026-07-29 is a Wednesday.
  const wed = local(2026, 7, 29, 12, 0);
  assert.equal(wed.getDay(), 3);
  const friday = nextAt({ kind: "weekly", weekday: 5, at: 9 * 60 }, wed);
  assert.equal(friday.getDay(), 5);
  assert.equal(friday.getTime(), local(2026, 7, 31, 9, 0).getTime());
  assert.equal(nextAt({ kind: "weekly", weekday: 5, at: 9 * 60 }, friday).getTime(), local(2026, 8, 7, 9, 0).getTime());
});

test("a closed laptop costs ONE run, not one per missed window", () => {
  // The whole reason `advance` exists. Three days asleep on an hourly schedule is 72 missed
  // firings; catching up on all of them is the most expensive possible reading of "keep this fresh".
  const wasDue = local(2026, 7, 26, 10, 0);
  const now = local(2026, 7, 29, 10, 30);
  const next = advance({ kind: "interval", minutes: 60 }, wasDue, now);
  assert.ok(next.getTime() > now.getTime(), "lands in the future");
  assert.ok(next.getTime() - now.getTime() <= 60 * 60_000, "and within one period of it");
});

test("advancing always lands in the future even for a cadence that cannot move", () => {
  // A corrupt cadence must not spin inside the tick with the database open.
  const now = local(2026, 7, 29, 10, 0);
  const out = advance({ kind: "interval", minutes: 0 } as Cadence, local(2020, 1, 1), now);
  assert.ok(out.getTime() > now.getTime());
});

test("a cadence describes itself in words a person can check at a glance", () => {
  assert.equal(describeCadence({ kind: "interval", minutes: 60 }), "Every hour");
  assert.equal(describeCadence({ kind: "interval", minutes: 180 }), "Every 3 hours");
  assert.equal(describeCadence({ kind: "interval", minutes: 1440 }), "Every day");
  assert.equal(describeCadence({ kind: "daily", at: 7 * 60 + 30 }), "Every day at 07:30");
  assert.equal(describeCadence({ kind: "weekly", weekday: 1, at: 9 * 60 }), "Every Monday at 09:00");
});

// ── the schedule record ────────────────────────────────────────────────────────────────────────

function sheet(name: string) {
  return createSheet(`ZZ sched ${name} ${Math.random().toString(36).slice(2, 7)}`);
}

test("a new schedule is switched OFF, whatever was asked for", () => {
  const s = sheet("off");
  const sc = createSchedule({ sheetId: s.id, cadence: { kind: "interval", minutes: 60 }, ...( { enabled: true } as any) });
  assert.equal(sc.enabled, false, "filling in a form must not start spending money");
  assert.ok(sc.nextAt, "but it still says when it would go, so that can be reviewed first");
});

test("switching one on re-bases its clock instead of firing it immediately", () => {
  // A schedule that sat off for a month has a next_at a month in the past. Switching it on without
  // re-basing would fire it on the next tick — the user asked for "every day at seven" and got "now".
  const s = sheet("rebase");
  const sc = createSchedule({ sheetId: s.id, cadence: { kind: "daily", at: 7 * 60 } });
  db.prepare("UPDATE schedules SET next_at = '2020-01-01 00:00:00' WHERE id = ?").run(sc.id);
  const on = updateSchedule(sc.id, { enabled: true });
  assert.ok(parseStamp(on.nextAt).getTime() > Date.now(), `next_at was ${on.nextAt}`);
});

test("changing the cadence re-bases the clock too", () => {
  const s = sheet("recadence");
  const sc = createSchedule({ sheetId: s.id, cadence: { kind: "interval", minutes: 60 } });
  db.prepare("UPDATE schedules SET next_at = '2020-01-01 00:00:00' WHERE id = ?").run(sc.id);
  const changed = updateSchedule(sc.id, { cadence: { kind: "interval", minutes: 120 } });
  assert.ok(parseStamp(changed.nextAt).getTime() > Date.now());
});

test("a budget has to be an amount, or absent — never zero", () => {
  const s = sheet("budget");
  assert.throws(() => createSchedule({ sheetId: s.id, cadence: { kind: "interval", minutes: 60 }, budgetUsd: 0 }), /above zero/i);
  assert.throws(() => createSchedule({ sheetId: s.id, cadence: { kind: "interval", minutes: 60 }, budgetUsd: -5 }), /above zero/i);
  assert.equal(createSchedule({ sheetId: s.id, cadence: { kind: "interval", minutes: 60 } }).budgetUsd, null);
});

// ── the ticker ─────────────────────────────────────────────────────────────────────────────────

/** Swap the runner for a counter, so nothing in this file can start a real (paid) run. */
function withRunner<T>(fn: (calls: string[], fail?: (msg: string) => void) => T): T {
  const calls: string[] = [];
  let failWith: string | null = null;
  registerScheduleRunner((s) => {
    if (failWith) throw new Error(failWith);
    calls.push(String(s.id));
    return `run-${s.id}-${calls.length}`;
  });
  try {
    return fn(calls, (m) => { failWith = m; });
  } finally {
    registerScheduleRunner(() => { throw new Error("no runner"); });
  }
}

const makeDue = (id: number) => db.prepare("UPDATE schedules SET next_at = '2020-01-01 00:00:00' WHERE id = ?").run(id);

test("only enabled schedules fire", () => {
  withRunner((calls) => {
    const s = sheet("enabled");
    const off = createSchedule({ sheetId: s.id, cadence: { kind: "interval", minutes: 60 } });
    makeDue(off.id);
    tick(new Date());
    assert.deepEqual(calls, [], "an off schedule that is 'due' is not due at all");
  });
});

test("a due schedule fires once, and is not due again on the next tick", () => {
  withRunner((calls) => {
    const s = sheet("once");
    const sc = createSchedule({ sheetId: s.id, cadence: { kind: "interval", minutes: 60 } });
    updateSchedule(sc.id, { enabled: true });
    makeDue(sc.id);

    tick(new Date());
    assert.equal(calls.length, 1);
    tick(new Date());
    assert.equal(calls.length, 1, "the clock moved past now, so the second tick finds nothing");

    const after = getSchedule(sc.id)!;
    assert.equal(after.runs, 1);
    assert.equal(after.lastStatus, "Started.");
    assert.ok(parseStamp(after.nextAt).getTime() > Date.now());
  });
});

test("a schedule never stacks a second run on top of its own", () => {
  withRunner((calls) => {
    const s = sheet("overlap");
    const sc = createSchedule({ sheetId: s.id, cadence: { kind: "interval", minutes: 60 } });
    updateSchedule(sc.id, { enabled: true });
    makeDue(sc.id);
    tick(new Date());
    const runId = getSchedule(sc.id)!.lastRunId!;
    // That run is still going.
    db.prepare("INSERT INTO runs (id, sheet_id, kind, scope_json, status, total) VALUES (?, ?, 'sheet', '{}', 'running', 1)")
      .run(runId, s.id);

    makeDue(sc.id);
    tick(new Date());
    assert.equal(calls.length, 1, "the second turn was skipped, not queued");
    assert.match(getSchedule(sc.id)!.lastStatus, /still going/i);
    // And the clock still moved, so it is not stuck retrying every 30 seconds.
    assert.ok(parseStamp(getSchedule(sc.id)!.nextAt).getTime() > Date.now());
  });
});

test("a refusal is recorded on the schedule rather than thrown at the ticker", () => {
  withRunner((calls, fail) => {
    const s = sheet("refuse");
    const a = createSchedule({ sheetId: s.id, cadence: { kind: "interval", minutes: 60 } });
    updateSchedule(a.id, { enabled: true });
    makeDue(a.id);
    fail!("Nothing matches that selection, so no run was started.");

    // Must not throw: one schedule's problem cannot stop the tick or take the process down.
    const out = tick(new Date());
    assert.equal(out.started, 0);
    assert.equal(out.skipped, 1);
    assert.match(getSchedule(a.id)!.lastStatus, /Nothing matches/);
    assert.equal(calls.length, 0);
  });
});

test("a schedule on a trashed table does not fire", () => {
  withRunner((calls) => {
    const s = sheet("trashed");
    const sc = createSchedule({ sheetId: s.id, cadence: { kind: "interval", minutes: 60 } });
    updateSchedule(sc.id, { enabled: true });
    makeDue(sc.id);
    db.prepare("UPDATE sheets SET deleted_at = datetime('now') WHERE id = ?").run(s.id);
    tick(new Date());
    assert.deepEqual(calls, []);
  });
});

test("running one by hand does not move its real clock", () => {
  withRunner((calls) => {
    const s = sheet("byhand");
    const sc = createSchedule({ sheetId: s.id, cadence: { kind: "daily", at: 7 * 60 } });
    const on = updateSchedule(sc.id, { enabled: true });
    runScheduleNow(getSchedule(sc.id)!);
    assert.equal(calls.length, 1);
    const after = getSchedule(sc.id)!;
    assert.equal(after.nextAt, on.nextAt, "trying it out must not push the real firing around");
    assert.match(after.lastStatus, /by hand/i);
  });
});

test("deleting a schedule removes it, and a sheet's list is only its own", () => {
  const a = sheet("list-a");
  const b = sheet("list-b");
  const one = createSchedule({ sheetId: a.id, cadence: { kind: "interval", minutes: 60 } });
  createSchedule({ sheetId: b.id, cadence: { kind: "interval", minutes: 60 } });
  assert.equal(listSchedules(a.id).length, 1);
  deleteSchedule(one.id);
  assert.equal(listSchedules(a.id).length, 0);
  assert.equal(listSchedules(b.id).length, 1, "deleting one table's schedule left the other alone");
});

test("stamps survive a round trip", () => {
  const d = new Date("2026-07-29T10:20:30Z");
  assert.equal(stamp(d), "2026-07-29 10:20:30");
  assert.equal(parseStamp(stamp(d)).getTime(), d.getTime());
});

// ── spending on a timer ─────────────────────────────────────────────────────
//
// A schedule MAY run a paid column, unlike auto-run — the difference is that a cadence is an
// instruction the user wrote, not a reaction to somebody else's import. What it must never be is a
// surprise, so the cost is attached to the schedule at every point it can be read.

test("a schedule naming a paid column says so, and a free one says nothing", () => {
  const s = sheet("paid-flag");
  const free = addColumn(s.id, { name: "Rule", kind: "script", valueType: "text" });
  const paid = addColumn(s.id, { name: "Enrich", kind: "ai", valueType: "text" });
  setColumnModel(paid.id, "openrouter/some-paid-model");

  const cheap = createSchedule({
    sheetId: s.id, cadence: { kind: "daily", at: 420 }, scope: { columnIds: [Number(free.id)] },
  });
  assert.deepEqual(getSchedule(cheap.id)!.paidColumns, []);

  const dear = createSchedule({
    sheetId: s.id, cadence: { kind: "daily", at: 420 }, scope: { columnIds: [Number(paid.id)] },
  });
  assert.deepEqual(getSchedule(dear.id)!.paidColumns, ["Enrich"]);
});

test("an empty scope is read as every column, so it cannot look free while running the lot", () => {
  // The trap: a schedule with no explicit column list runs everything on the sheet. Reading that as
  // "no paid columns named" would let the most expensive schedule possible present itself as free.
  const s = sheet("paid-allcols");
  const paid = addColumn(s.id, { name: "Enrich", kind: "ai", valueType: "text" });
  setColumnModel(paid.id, "openrouter/some-paid-model");

  const sc = createSchedule({ sheetId: s.id, cadence: { kind: "daily", at: 420 } });
  assert.deepEqual(getSchedule(sc.id)!.paidColumns, ["Enrich"]);
});

test("a column on a local model is not counted as paid", () => {
  // The guard must not mark every model column as spending. A local model bills nothing, and a
  // schedule over one is exactly the case this feature is pleasant for.
  const s = sheet("paid-local");
  const local = addColumn(s.id, { name: "Summary", kind: "ai", valueType: "text" });
  setColumnModel(local.id, "local:lmstudio/qwen");

  const sc = createSchedule({
    sheetId: s.id, cadence: { kind: "daily", at: 420 }, scope: { columnIds: [Number(local.id)] },
  });
  assert.deepEqual(getSchedule(sc.id)!.paidColumns, []);
});

test("a schedule that has never fired reports null spend, not zero", () => {
  // Zero is a claim about money — "this has cost nothing" — and it is not the same as "this has never
  // run". The first invites you to leave it on; the second tells you nothing has happened yet.
  const s = sheet("cost-null");
  const sc = createSchedule({ sheetId: s.id, cadence: { kind: "daily", at: 420 } });
  const got = getSchedule(sc.id)!;
  assert.equal(got.lastCostUsd, null);
  assert.equal(got.totalCostUsd, 0, "nothing spent across zero firings really is zero");
});

test("what every firing cost is added up from the runs themselves", () => {
  // Read from `runs`, never from a counter kept beside the schedule. Two records of the same money
  // disagree eventually, and this is the number somebody will actually check.
  const s = sheet("cost-total");
  const sc = createSchedule({ sheetId: s.id, cadence: { kind: "daily", at: 420 } });

  const add = (runId: string, usd: number) =>
    db.prepare(
      `INSERT INTO runs (id, sheet_id, kind, scope_json, status, total, cost_usd, schedule_id, started_at)
       VALUES (?, ?, 'sheet', '{}', 'done', 1, ?, ?, datetime('now'))`,
    ).run(runId, s.id, usd, sc.id);

  const tag = String(sc.id);
  add(`r-${tag}-1`, 0.25);
  add(`r-${tag}-2`, 0.5);
  // A run of the same sheet that this schedule did NOT start must not be counted as its spending.
  db.prepare(
    `INSERT INTO runs (id, sheet_id, kind, scope_json, status, total, cost_usd, started_at)
     VALUES (?, ?, 'sheet', '{}', 'done', 1, 99, datetime('now'))`,
  ).run(`r-${tag}-byhand`, s.id);

  db.prepare("UPDATE schedules SET last_run_id = ? WHERE id = ?").run(`r-${tag}-2`, sc.id);

  const got = getSchedule(sc.id)!;
  assert.equal(got.totalCostUsd, 0.75);
  assert.equal(got.lastCostUsd, 0.5, "the LAST firing, found through the schedule's own last run id");
});
