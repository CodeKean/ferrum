// Boot. Single long-lived process that owns the DB writer, the SSE subscriber set, and (from Phase 2)
// the worker pool and its child processes. Deliberately not Next.js: HMR module re-evaluation would
// duplicate those module-scope singletons, which here means two pools leasing the same jobs and
// double-spending quota.

import { randomUUID } from "node:crypto";
import { dbCheckpoint, recoverAfterRestart, setKv } from "./db.ts";
import { backfillDeps } from "./refs.ts";
import { DATA_DIR, DB_PATH, isUnderSyncRoot } from "./paths.ts";
import { BIND_HOST, IS_SHARED, createServer } from "./server.ts";
import { countPeople, isClaimed, purgeExpiredSessions } from "./people.ts";
import { emitColumnStats } from "./bus.ts";
import { onStatsComputed } from "./columnStats.ts";
import { createRun, executeRun, registerCellExecutor } from "./runs.ts";
import { registerAutoRunStarter } from "./autoRun.ts";
import { registerScheduleRunner, startTicker } from "./schedules.ts";
import { backfillUsage } from "./usage.ts";
import { primeSecrets } from "./secrets.ts";
import { executeCell } from "./agent/executor.ts";

const PORT = Number(process.env.PORT ?? 4317);
const bootId = randomUUID();
setKv("boot_id", bootId);

const recovery = recoverAfterRestart(bootId);
if (recovery.reclaimedJobs > 0 || recovery.pausedRuns > 0) {
  console.log(
    `[boot] recovered ${recovery.reclaimedJobs} orphaned job(s); paused ${recovery.pausedRuns} interrupted run(s) — resume them from the UI.`,
  );
}

// One-time repair of a graph that was written wrong.
//
// Until today `rebuildDeps` could not see a script's `row.<column>` accesses, so every script column
// saved before the fix recorded no dependency at all — and a fixed writer does not repair edges that
// already exist. Without this the fix would only reach columns someone happened to edit again, and
// the columns quietly running in the wrong order would keep doing it.
const backfill = backfillDeps();
if (backfill && backfill.edgesAfter !== backfill.edgesBefore) {
  console.log(
    `[boot] rebuilt the dependency graph for ${backfill.columns} column(s): ` +
      `${backfill.edgesBefore} → ${backfill.edgesAfter} edges. Columns that read another column ` +
      `through a rule were not recorded as depending on it, so they could run before it.`,
  );
}

// Every attempt made before the usage rollup existed, folded into it once. Without this the cost
// screen opens on an empty history for a workspace that has been used for weeks, which reads as the
// feature being broken rather than as the record starting today.
const usage = backfillUsage();
if (usage > 0) console.log(`[boot] folded ${usage} past attempt(s) into the usage history.`);

// Stored keys into the redactor BEFORE anything can fail and be written down. Primed at boot
// rather than lazily, because the first thing that needs redacting is usually the first thing that
// goes wrong, and by then it is already in the database.
const secrets = primeSecrets();
if (secrets > 0) {
  console.log(`[boot] ${secrets} saved key(s) loaded — their values are redacted from anything stored or broadcast.`);
}

if (isUnderSyncRoot(DB_PATH)) {
  console.warn(
    `[boot] WARNING: the database sits under a file-sync folder (${DB_PATH}). SQLite WAL + sync clients corrupt each other. Set FERRUM_DATA_DIR to an unsynced path.`,
  );
}

// The per-cell lane. Registered here rather than imported by runs.ts so the engine keeps no
// dependency on a provider — which is what let the queue, retries and cancellation be tested long
// before a key existed.
registerCellExecutor(executeCell);

// Background stats computations push straight to the live stream as they land.
onStatsComputed((stats) => emitColumnStats(stats));

/**
 * What a column that keeps itself up to date actually does when its inputs move.
 *
 * Registered here, like the cell executor above, rather than imported — runs.ts already imports the
 * dependency graph, so wiring this the other way would close a cycle. It also means a module that
 * can start a PAID run cannot do so merely by being imported, which is what keeps the unit tests
 * from spending anything — and that matters more now that a paid column is allowed to use the
 * toggle at all.
 *
 * An ordinary run, deliberately: it shows in the run strip, it can be cancelled, it obeys the sheet
 * and per-run budgets and the column's run condition, and the unchanged-row skip means rows whose
 * inputs did not really move cost nothing. Anything this does, pressing Run could have done.
 */
registerAutoRunStarter((sheetId, columnId, rowIds, budgetUsd) => {
  const { run, resolved } = createRun({
    sheetId,
    scope: rowIds == null ? { columnIds: [columnId] } : { columnIds: [columnId], rowIds },
    // The column's own ceiling for this firing. Null means none, which is what every column had
    // before this setting existed. Hitting it PAUSES the run, so the rows already answered keep
    // their values and raising the limit carries on rather than starting again.
    budgetUsd,
  });
  void executeRun(run.id, resolved).catch((e) => {
    // Never throws into the caller: an auto-run that fails must not take down the write that
    // triggered it. The failure lands on the run record, where every other run failure lands.
    console.error("[auto-run]", run.id, e);
  });
});

/**
 * The clock half of the same idea: a run that starts itself because time passed rather than because
 * something changed.
 *
 * An ordinary run, for exactly the reasons the auto-run starter above is one — it shows in the run
 * strip, it can be cancelled, and it obeys both budgets. The schedule's own per-firing ceiling is
 * passed through, so "check this every morning, and never spend more than $5 doing it" is one
 * setting rather than a hope.
 *
 * Anything `createRun` refuses — nothing matched, a missing key, columns already busy — throws out
 * of here and is caught by the ticker, which writes it onto the schedule as the reason nothing
 * happened. A schedule that quietly does nothing is indistinguishable from a broken one.
 */
registerScheduleRunner((s) => {
  const { run, resolved } = createRun({
    sheetId: s.sheetId,
    scope: s.scope ?? {},
    force: s.force,
    budgetUsd: s.budgetUsd,
    // Stamped so the schedule's spend is a query over the runs it started rather than a tally kept
    // alongside them. Two records of the same money eventually disagree, and this is the one number
    // somebody will actually check.
    scheduleId: s.id,
  });
  void executeRun(run.id, resolved).catch((e) => {
    console.error("[schedule]", s.id, run.id, e);
  });
  return run.id;
});

const stopTicker = startTicker((e) => console.error("[schedule] tick failed:", e));

/**
 * Sessions that have already expired, swept once at boot.
 *
 * `whoIs` refuses them anyway, so this changes no behaviour — it stops the table growing without
 * bound on an instance that has been running for a year.
 */
const swept = purgeExpiredSessions();
if (swept > 0) console.log(`[boot] cleared ${swept} expired session(s).`);

const app = createServer(bootId);
const server = app.listen(PORT, BIND_HOST);

// The banner is bound to the `listening` EVENT, not to app.listen's callback.
//
// Express 5 invokes that callback even when the bind fails — verified here: against a port already
// in use it ran with `server.listening === false`, and the EADDRINUSE error arrived afterwards. So a
// second instance printed "Ferrum → http://127.0.0.1:4317" and only then admitted it had not
// started. Anyone reading the top of the log would believe it was up. The `listening` event does not
// fire on a failed bind, so it is the only honest place for this.
server.on("listening", () => {
  console.log(`Ferrum → http://${BIND_HOST === "0.0.0.0" ? "localhost" : BIND_HOST}:${PORT}`);
  console.log(`  data   ${DATA_DIR}`);
  /**
   * The banner a shared instance needs, and the one warning worth printing in red.
   *
   * Bound to a public address, Ferrum drops the localhost-only guard — it has to, because a server
   * answers to its own name. What replaces that guard is the sign-in, and until somebody claims the
   * instance there is no sign-in. So an UNCLAIMED public instance is genuinely open, and the only
   * honest thing to do is say so, loudly, with the one action that closes it.
   *
   * Not a refusal to start: the first person to reach the address is meant to claim it, and an
   * instance that will not boot until it is claimed cannot be claimed. The window is real and it is
   * measured in minutes — but it is a window somebody has to be TOLD about, or they will not close
   * it in those minutes.
   */
  if (IS_SHARED) {
    console.log(`  mode   shared — reachable from other machines (FERRUM_HOST=${BIND_HOST})`);
    if (isClaimed()) {
      const { total, active } = countPeople();
      console.log(`  people ${active} active of ${total}. Everyone signs in.`);
    } else {
      console.warn(
        "\n  !!  THIS INSTANCE IS OPEN. Nobody has claimed it, so anyone who can reach this\n" +
        "  !!  address has full access to every table and every saved key. Open it now and\n" +
        "  !!  create the first account — that turns sign-in on for everyone.\n" +
        "  !!  Put it behind HTTPS before you invite anybody: sessions travel in a cookie.\n",
      );
    }
  }
});

// A second instance must die loudly. Silently failing to bind leaves a process that looks alive, and
// two engines against one database means two pools leasing the same jobs and double-spending quota —
// but the way it actually bites first is subtler: the survivor may be pointed at a DIFFERENT data
// dir, so the app answers on the right port out of the wrong (often empty) database.
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[boot] port ${PORT} is already in use — another Ferrum is running. Stop it first, or set PORT.`,
    );
  } else {
    console.error(`[boot] could not listen on ${PORT}:`, err);
  }
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${signal}] shutting down…`);
  // Stop the clock before the database is checkpointed, so a tick cannot start a run into a process
  // that is halfway out the door.
  stopTicker();
  server.close(() => {
    // Fold the WAL back into the main DB so the sidecar doesn't grow across restarts.
    dbCheckpoint();
    process.exit(0);
  });
  // Don't hang forever on a client holding an SSE connection open.
  setTimeout(() => { dbCheckpoint(); process.exit(0); }, 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
