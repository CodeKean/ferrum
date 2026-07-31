// Schema-level housekeeping.
//
// `cell_attempts` is the one table with no owner: no foreign key, no delete path, one row per paid
// call, each carrying the whole rendered prompt. Its own schema comment said a retention sweep was
// owed; on the real database 93.5% of the rows described cells that had already been deleted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db, pruneCellAttempts, recoverAfterRestart, ATTEMPT_RETENTION_DAYS } from "./db.ts";

/** One attempt, aged by hand, with a tool call hanging off it. Returns its id. */
function attempt(daysAgo: number): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO cell_attempts (row_id, column_id, run_id, attempt, started_at, finished_at, status, rendered_prompt)
         VALUES (1, 1, 'r', 0, datetime('now', ?), datetime('now', ?), 'done', 'what does acme.com sell?')`,
      )
      .run(`-${daysAgo} days`, `-${daysAgo} days`).lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO cell_tool_calls (attempt_id, seq, tool_name, allowed) VALUES (?, 0, 'fetch_url', 1)",
  ).run(id);
  return id;
}

const exists = (id: number): boolean =>
  Number((db.prepare("SELECT COUNT(*) AS c FROM cell_attempts WHERE id = ?").get(id) as any).c) === 1;

const toolCalls = (id: number): number =>
  Number((db.prepare("SELECT COUNT(*) AS c FROM cell_tool_calls WHERE attempt_id = ?").get(id) as any).c);

test("attempts past the retention window are swept, and recent ones are not", () => {
  const old = attempt(ATTEMPT_RETENTION_DAYS + 5);
  const recent = attempt(1);

  assert.equal(pruneCellAttempts(), 1, "only the expired one goes");
  assert.equal(exists(old), false);
  assert.equal(exists(recent), true, "provenance inside the window is untouched");
  assert.equal(toolCalls(old), 0, "and its tool calls go with it, through the cascade");
  assert.equal(toolCalls(recent), 1);
});

test("one sweep is bounded, so a first run against years of history cannot be one huge delete", () => {
  attempt(ATTEMPT_RETENTION_DAYS + 5);
  attempt(ATTEMPT_RETENTION_DAYS + 6);
  assert.equal(pruneCellAttempts(ATTEMPT_RETENTION_DAYS, 1), 1, "the limit is obeyed");
  assert.equal(pruneCellAttempts(ATTEMPT_RETENTION_DAYS, 1), 1, "and the rest waits for the next sweep");
  assert.equal(pruneCellAttempts(), 0);
});

test("boot is what runs the sweep — nothing else ever called it", () => {
  // The whole finding: the function can be correct and still leak forever if nothing invokes it.
  // Boot recovery already runs exactly once per process, before the server is listening, which is
  // the one moment nobody is waiting on a delete.
  const old = attempt(ATTEMPT_RETENTION_DAYS + 400);
  recoverAfterRestart("boot-test");
  assert.equal(exists(old), false, "an ancient attempt does not survive a restart");
});
