// Run engine tests.
//
// The per-cell executor is registered rather than imported, so every one of these runs with a FAKE
// executor and no provider access — which means the queue, the retry policy, cancellation, the cost
// gate and topological ordering are all verifiable today rather than after Phase 2.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db, setKv } from "./db.ts";
import { deleteProviderKey, saveProviderKey } from "./providers/keys.ts";
import {
  addColumn, createSheet, insertRows, listColumns, setCellValue, setColumnKind, setColumnModel, setColumnPrompt,
  setColumnSendConfig,
} from "./store.ts";
import { parseCatalog, seedCatalog } from "./providers/catalog.ts";
import { trashTable } from "./views.ts";
import { saveScript, approveScript } from "./scripts.ts";
import { resolveScope } from "./scope.ts";
import { DEFAULT_SEND, type SendConfig } from "./writeTarget.ts";
import {
  cancelRun, createRun, executeRun, getRun, registerCellExecutor, resumeRun, type CellOutcome,
} from "./runs.ts";

/** Let the event loop turn, without a clock: enough for one round of in-flight cells to land. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Satisfy the credential gates without weakening them.
 *
 * `createRun` refuses to start any paid lane without credentials, and a test data dir has none — so
 * it correctly refuses. Rather than adding a test-only bypass to production code (which would defeat
 * the point of a gate), these tests seed the SAME records the real checks read. The gate logic still
 * runs; only the round trips are skipped.
 *
 * Both are seeded because the gates diverged: `ai` and `agent` now go through the model provider,
 * while `mcp` still uses the Claude credential.
 */
function seedCredentials(): void {
  setKv("auth.canary", JSON.stringify({ ok: true, ms: 1 }));
  setKv("auth.canary_at", String(Date.now()));
  setKv("auth.mode", "subscription");
  saveProviderKey("openrouter", "sk-or-v1-" + "0".repeat(64));
}

function fixture(name: string, rows: Array<Record<string, string>>, cols = ["Company", "Country", "Website"]) {
  seedCredentials();
  const sheet = createSheet(name);
  const columns = cols.map((n) => addColumn(sheet.id, { name: n }));
  const ids = columns.map((c) => Number(c.id));
  insertRows(
    sheet.id,
    rows.map((r) => ({ values: Object.fromEntries(columns.map((c, i) => [String(ids[i]), r[cols[i]!] ?? ""])) })),
    0,
    ids,
  );
  return { sheet, columns, ids };
}

/** Attach an approved transform/condition script to a column. */
function attachScript(sheetId: string, columnId: number, hook: "transform" | "condition", code: string) {
  const saved = saveScript({ sheetId, columnId, hook, runtime: "js", intent: "test", code });
  assert.deepEqual(saved.errors, [], `script rejected: ${saved.errors.join("; ")}`);
  const ok = approveScript(Number(saved.script.id), saved.script.hash);
  assert.equal(ok.ok, true);
  return saved.script;
}

const rowsOf = (sheetId: string) =>
  (db.prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY position").all(sheetId) as any[]).map((r) => Number(r.id));

// ─────────────────────────────────────────────────────────────── the cost gate

test("a run condition narrows the row set BEFORE the paid lane sees it", async () => {
  const f = fixture("gate", [
    { Company: "A", Country: "US", Website: "https://a.com" },
    { Company: "B", Country: "FR", Website: "https://b.com" },
    { Company: "C", Country: "CA", Website: "https://c.com" },
    { Company: "D", Country: "DE", Website: "https://d.com" },
  ]);

  const paid = addColumn(f.sheet.id, { name: "Research", kind: "ai" });
  attachScript(f.sheet.id, Number(paid.id), "condition",
    `function condition(row) { return row.country === "US" || row.country === "CA"; }`);

  // Count exactly how many rows reach the executor — this is the number that costs money.
  const seen: number[] = [];
  registerCellExecutor(async (job) => {
    seen.push(job.rowId);
    return { status: "done", valueText: "researched", costUsd: 0.01 };
  });

  const { run, resolved } = createRun({ sheetId: f.sheet.id, scope: { columnIds: [Number(paid.id)] } });
  await executeRun(run.id, resolved);

  assert.equal(seen.length, 2, "only qualifying rows should reach the paid lane");
  const final = getRun(run.id)!;
  assert.equal(final.skipped, 2, "non-qualifying rows are reported as skipped, not silently dropped");
  assert.equal(final.done, 2);
  // Cost accrues only for rows that actually ran.
  assert.ok(Math.abs(final.costUsd - 0.02) < 1e-9);
});

// ─────────────────────────────────────────────────────────────── lane routing

test("a script column runs as ONE batch, not one job per row", async () => {
  const f = fixture("batch-lane", Array.from({ length: 250 }, (_, i) => ({
    Company: `Co ${i}`, Country: "US", Website: `https://c${i}.com`,
  })));

  const out = addColumn(f.sheet.id, { name: "Domain", kind: "script" });
  attachScript(f.sheet.id, Number(out.id), "transform",
    `function transform(row) { return (row.website || "").replace("https://", ""); }`);

  registerCellExecutor(async () => { throw new Error("the batch lane must not call the per-cell executor"); });

  const { run, resolved } = createRun({ sheetId: f.sheet.id, scope: { columnIds: [Number(out.id)] } });
  await executeRun(run.id, resolved);

  // No queue rows at all: a job per cell here would be 250 rows of bookkeeping for one stream pass.
  const jobs = Number((db.prepare("SELECT COUNT(*) c FROM jobs WHERE run_id = ?").get(run.id) as any).c);
  assert.equal(jobs, 0, "the batch lane must not create per-cell jobs");

  assert.equal(getRun(run.id)!.done, 250);
  const filled = Number((db.prepare("SELECT COUNT(*) c FROM cells WHERE column_id = ? AND status='done'").get(Number(out.id)) as any).c);
  assert.equal(filled, 250);
});

test("a paid column creates one durable job per row", async () => {
  const f = fixture("percell-lane", Array.from({ length: 5 }, (_, i) => ({ Company: `Co ${i}`, Country: "US", Website: "" })));
  const paid = addColumn(f.sheet.id, { name: "Summary", kind: "ai" });

  registerCellExecutor(async () => ({ status: "done", valueText: "ok" }));

  const { run, resolved } = createRun({ sheetId: f.sheet.id, scope: { columnIds: [Number(paid.id)] } });
  await executeRun(run.id, resolved);

  const jobs = Number((db.prepare("SELECT COUNT(*) c FROM jobs WHERE run_id = ?").get(run.id) as any).c);
  assert.equal(jobs, 5, "the per-cell lane is durable — a crash mid-run must be resumable");
  assert.equal(getRun(run.id)!.done, 5);
});

test("the question that was actually asked is kept, and a secret in it is not", async () => {
  // `cell_attempts.rendered_prompt` was declared in the first schema, SELECTed by the details route,
  // redacted on the way out, and rendered by a "Show what was sent" fold in the cell panel — and
  // NOTHING wrote it. The fold could never appear on any cell. This is the guard on the write, and
  // on the redaction happening at write time rather than only on the way to the browser: a scrub
  // that runs on read leaves the secret in the file on disk.
  const f = fixture("prompt-kept", [{ Company: "Acme", Country: "US", Website: "" }]);
  const paid = addColumn(f.sheet.id, { name: "Summary", kind: "ai" });

  registerCellExecutor(async () => ({
    status: "done",
    valueText: "ok",
    renderedPrompt: "Summarise Acme. Use key sk-or-v1-" + "0".repeat(64) + " if asked.",
  }));

  const { run, resolved } = createRun({ sheetId: f.sheet.id, scope: { columnIds: [Number(paid.id)] } });
  await executeRun(run.id, resolved);

  const got = db
    .prepare("SELECT rendered_prompt p FROM cell_attempts WHERE column_id = ?")
    .get(Number(paid.id)) as { p: string | null } | undefined;

  assert.ok(got?.p, "the prompt is stored, not dropped on the floor");
  assert.match(got!.p!, /Summarise Acme/, "and it is the prompt, not a placeholder");
  assert.doesNotMatch(got!.p!, /sk-or-v1-0{10}/, "with the credential scrubbed before it hit the disk");
});

test("a lane that renders no prompt stores nothing rather than an empty one", async () => {
  // A blank fold labelled "Show what was sent" showing nothing is worse than no fold: it reads as a
  // lost prompt rather than a lane that never had one. The HTTP lane and every early refusal return
  // before a prompt exists.
  const f = fixture("prompt-absent", [{ Company: "Acme", Country: "US", Website: "" }]);
  const paid = addColumn(f.sheet.id, { name: "Summary", kind: "ai" });

  registerCellExecutor(async () => ({ status: "done", valueText: "ok" }));

  const { run, resolved } = createRun({ sheetId: f.sheet.id, scope: { columnIds: [Number(paid.id)] } });
  await executeRun(run.id, resolved);

  const got = db
    .prepare("SELECT rendered_prompt p FROM cell_attempts WHERE column_id = ?")
    .get(Number(paid.id)) as { p: string | null } | undefined;
  assert.equal(got?.p, null);
});

test("how sure the model was is kept, and a later sure answer clears the doubt", async () => {
  // `cells.confidence` and `cells.source_url` have been in the schema since the first phase, getCell
  // returns both and the client types both — and NOTHING wrote either, while the finish tool made
  // `confidence` a REQUIRED field. Every answer this app has ever received carried one, and every
  // one was dropped on arrival.
  const f = fixture("confidence-kept", [{ Company: "Acme", Country: "US", Website: "" }]);
  const paid = addColumn(f.sheet.id, { name: "Industry", kind: "ai" });
  const col = Number(paid.id);
  const read = () =>
    db.prepare("SELECT confidence, source_url FROM cells WHERE column_id = ?").get(col) as
      | { confidence: string | null; source_url: string | null }
      | undefined;

  registerCellExecutor(async () => ({
    status: "done", valueText: "Biotech", confidence: "low", sourceUrl: "https://acme.example/about",
  }));
  let run = createRun({ sheetId: f.sheet.id, scope: { columnIds: [col] } });
  await executeRun(run.run.id, run.resolved);
  // Field by field, not deepEqual: a row from node:sqlite has a null prototype, so a structural
  // compare against an object literal fails on two values that are identical.
  assert.equal(read()?.confidence, "low");
  assert.equal(read()?.source_url, "https://acme.example/about");

  // The clearing half, and the reason the write is unconditional. A cell that said "answered, not
  // sure" must not go on saying it after a run that came back sure — the flag would outlive the
  // doubt it stood for, and it is the flag someone filters on to decide what to check by hand.
  registerCellExecutor(async () => ({ status: "done", valueText: "Biotechnology", confidence: "high" }));
  run = createRun({ sheetId: f.sheet.id, scope: { columnIds: [col], force: true } });
  await executeRun(run.run.id, run.resolved);
  assert.equal(read()?.confidence, "high");
  assert.equal(read()?.source_url, null);
});

// ──────────────────────────────────────────────── the cheap model, and when it is not enough

test("a cheap answer is credited to the savings ledger, at the expensive rate", async () => {
  // Named for what it checks. The DECISION to skip the expensive call lives in executeCell and is
  // covered by goodEnough in executor.test.ts — this file registers a fake executor, so it can only
  // verify what the engine does with an outcome that says it was answered cheaply. The saving is
  // priced from the column model, which on a two-model column is the one that was NOT called.
  const f = fixture("escalate-keep", [{ Company: "Acme", Country: "US", Website: "" }]);
  const paid = addColumn(f.sheet.id, { name: "Industry", kind: "ai" });
  const col = Number(paid.id);

  registerCellExecutor(async () => ({
    status: "done", valueText: "Biotech", confidence: "high", answeredBy: "first",
  }));

  const { run, resolved } = createRun({ sheetId: f.sheet.id, scope: { columnIds: [col] } });
  await executeRun(run.id, resolved);

  const saved = db
    .prepare("SELECT reason, cells FROM savings WHERE column_id = ? AND reason = 'first_model'")
    .get(col) as { reason: string; cells: number } | undefined;
  assert.equal(saved?.cells, 1, "the call that did not happen is counted, at the expensive rate");
});

test("an unsure cheap answer costs both calls, and the cell says why", async () => {
  // The failure this note exists for is subtler than it looks: a first model that is simply BROKEN
  // sends every row through to the expensive one, which answers correctly, so the column looks
  // perfect while the saving is silently zero and every row pays double the latency.
  const f = fixture("escalate-note", [{ Company: "Acme", Country: "US", Website: "" }]);
  const paid = addColumn(f.sheet.id, { name: "Industry", kind: "ai" });
  const col = Number(paid.id);

  registerCellExecutor(async () => ({
    status: "done",
    valueText: "Biotechnology",
    confidence: "high",
    answeredBy: "escalated",
    note: "The first model failed (timeout), so this row went to openrouter/big.",
    costUsd: 0.004,
  }));

  const { run, resolved } = createRun({ sheetId: f.sheet.id, scope: { columnIds: [col] } });
  await executeRun(run.id, resolved);

  const cell = db.prepare("SELECT note FROM cells WHERE column_id = ?").get(col) as { note: string | null };
  assert.match(String(cell.note), /first model failed \(timeout\)/);
  // And nothing is credited as saved, because nothing was saved.
  const saved = db
    .prepare("SELECT COUNT(*) n FROM savings WHERE column_id = ? AND reason = 'first_model'")
    .get(col) as { n: number };
  assert.equal(saved.n, 0);
});

test("an unsure cheap answer is not banked as an expensive call avoided", async () => {
  // The ledger keyed off `answeredBy: "first"` alone, and the executor stamps that on the not
  // good-enough path too — the row whose own note asks the user to go and spend on the strong model.
  // So every unsure row was counted as money saved while the screen beside it asked for that money.
  const f = fixture("escalate-unsure", [{ Company: "Acme", Country: "US", Website: "" }]);
  const paid = addColumn(f.sheet.id, { name: "Industry", kind: "ai" });
  const col = Number(paid.id);

  registerCellExecutor(async () => ({
    status: "done",
    valueText: "possibly Biotech",
    confidence: "low",
    answeredBy: "first",
    note: 'The first model was low. Nothing was spent. Run "openrouter/big" on this row to check it.',
  }));

  const { run, resolved } = createRun({ sheetId: f.sheet.id, scope: { columnIds: [col] } });
  await executeRun(run.id, resolved);

  // The cheap answer is KEPT — that part is right and is what the note is for.
  const cell = db.prepare("SELECT status, note FROM cells WHERE column_id = ?").get(col) as any;
  assert.equal(cell.status, "done");
  const saved = db
    .prepare("SELECT COUNT(*) n FROM savings WHERE column_id = ? AND reason = 'first_model'")
    .get(col) as { n: number };
  assert.equal(saved.n, 0, "an answer nobody was sure of did not avoid the expensive call");
});

// ─────────────────────────────────────────────────────────────── retry policy

test("an auth failure pauses the whole run instead of burning every cell", async () => {
  const f = fixture("auth-fail", Array.from({ length: 20 }, (_, i) => ({ Company: `Co ${i}`, Country: "US", Website: "" })));
  const paid = addColumn(f.sheet.id, { name: "Enrich", kind: "ai" });

  let calls = 0;
  registerCellExecutor(async () => {
    calls++;
    return { status: "error", errorType: "auth", errorMsg: "OAuth token has expired" } as CellOutcome;
  });

  const { run, resolved } = createRun({ sheetId: f.sheet.id, scope: { columnIds: [Number(paid.id)] } });
  await executeRun(run.id, resolved);

  // A dead token costs ~3 minutes per cell in backoff. Retrying 20 cells x 3 attempts would be an
  // hour of nothing, so the run stops on the first auth error.
  assert.ok(calls <= 6, `expected the run to stop quickly, but the executor was called ${calls} times`);
  // `paused_auth`, not `paused_quota`. This asserted the quota status for an AUTH failure, which was
  // the bug written down as the expectation: every pause landed on paused_quota because a plain
  // `paused` did not exist in the union, so all three causes told the user a rate limit had stopped
  // them. The statuses are kept apart because the advice differs — wait, versus fix your key.
  assert.equal(getRun(run.id)!.status, "paused_auth");
  assert.equal(getRun(run.id)!.errors, 0, "an auth failure is not the cell's fault and must not be counted as a cell error");

  // Cells go back to queued, not error — they were never attempted against a live credential.
  const errored = Number((db.prepare("SELECT COUNT(*) c FROM cells WHERE column_id = ? AND status='error'").get(Number(paid.id)) as any).c);
  assert.equal(errored, 0);
});

test("a rate limit retries without consuming an attempt; a budget error never retries", async () => {
  const f = fixture("retry-policy", [{ Company: "A", Country: "US", Website: "" }]);
  const rl = addColumn(f.sheet.id, { name: "RL", kind: "ai" });

  let attempts = 0;
  registerCellExecutor(async () => {
    attempts++;
    // Rate limited twice, then succeeds — must not exhaust the 3-attempt budget.
    if (attempts <= 2) return { status: "error", errorType: "rate_limit", errorMsg: "429" };
    return { status: "done", valueText: "recovered" };
  });

  let r = createRun({ sheetId: f.sheet.id, scope: { columnIds: [Number(rl.id)] } });
  await executeRun(r.run.id, r.resolved);
  assert.equal(getRun(r.run.id)!.done, 1, "a rate limit must not count against the retry budget");

  // Budget errors are terminal: raising a cap is the user's decision, not a retry.
  const bg = addColumn(f.sheet.id, { name: "Budget", kind: "ai" });
  let budgetCalls = 0;
  registerCellExecutor(async () => {
    budgetCalls++;
    return { status: "error", errorType: "budget", errorMsg: "over the per-cell cap" };
  });
  r = createRun({ sheetId: f.sheet.id, scope: { columnIds: [Number(bg.id)] } });
  await executeRun(r.run.id, r.resolved);

  assert.equal(budgetCalls, 1, "a budget error must never be retried");
  assert.equal(getRun(r.run.id)!.errors, 1);
});

// ─────────────────────────────────────────────────────────────── cancellation

test("cancelling stops spending but keeps everything already produced", async () => {
  const f = fixture("cancel", Array.from({ length: 40 }, (_, i) => ({ Company: `Co ${i}`, Country: "US", Website: "" })));
  const paid = addColumn(f.sheet.id, { name: "Slow", kind: "ai" });

  let started = 0;
  let runId = "";
  registerCellExecutor(async (job) => {
    started++;
    // Cancel partway through, the way a user would.
    if (started === 5 && runId) cancelRun(runId);
    await new Promise((r) => setTimeout(r, 5));
    return { status: "done", valueText: `v${job.rowId}` };
  });

  const { run, resolved } = createRun({ sheetId: f.sheet.id, scope: { columnIds: [Number(paid.id)] } });
  runId = run.id;
  await executeRun(run.id, resolved, { concurrency: 2 });

  assert.equal(getRun(run.id)!.status, "cancelled");
  assert.ok(started < 40, `cancel should stop dispatch, but ${started} of 40 started`);

  // Completed cells keep their values — cancel means "stop spending", not "undo".
  const kept = Number((db.prepare("SELECT COUNT(*) c FROM cells WHERE column_id = ? AND status='done'").get(Number(paid.id)) as any).c);
  assert.ok(kept > 0, "cells finished before the cancel must retain their values");
  // Nothing is left stuck mid-flight.
  const stuck = Number((db.prepare("SELECT COUNT(*) c FROM cells WHERE column_id = ? AND status='queued'").get(Number(paid.id)) as any).c);
  assert.equal(stuck, 0, "queued cells must be released, not left claiming they are pending");
});

// ─────────────────────────────────────────────────────────────── ordering

test("columns run in dependency order, so a downstream rule reads a filled upstream", async () => {
  const f = fixture("topo", [{ Company: "Acme", Country: "US", Website: "https://www.acme.com" }]);

  const domain = addColumn(f.sheet.id, { name: "Domain", kind: "script" });
  attachScript(f.sheet.id, Number(domain.id), "transform",
    `function transform(row) { return (row.website||"").replace(/^https:\\/\\/(www\\.)?/, ""); }`);

  // Reads Domain, so it must run AFTER it even though it was created later and has a lower id.
  const slug = addColumn(f.sheet.id, { name: "Slug", kind: "script" });
  attachScript(f.sheet.id, Number(slug.id), "transform",
    `function transform(row) { return "co-" + ((row.domain||"").split(".")[0] || "none"); }\n// reads {{col:${domain.id}}}`);

  const { run, resolved } = createRun({
    sheetId: f.sheet.id,
    scope: { columnIds: [Number(slug.id), Number(domain.id)] },  // deliberately reversed
  });
  await executeRun(run.id, resolved);

  const slugVal = (db.prepare("SELECT value_text v FROM cells WHERE column_id = ?").get(Number(slug.id)) as any).v;
  assert.equal(slugVal, "co-acme", "the downstream column must have seen a filled upstream");
});

test("a run against nothing is refused rather than started empty", () => {
  const f = fixture("empty-scope", [{ Company: "A", Country: "US", Website: "" }]);
  const col = addColumn(f.sheet.id, { name: "X", kind: "script" });
  assert.throws(
    () => createRun({ sheetId: f.sheet.id, scope: { columnIds: [Number(col.id)], rowIds: [999999] } }),
    /Nothing matches/,
  );
});

// ─────────────────────────────────────────────────────────── stopping a run

test("stopping a run aborts the calls already in flight", async () => {
  const { sheet, ids } = fixture("stop-inflight", [
    { Company: "a" }, { Company: "b" }, { Company: "c" }, { Company: "d" },
  ]);
  const target = ids[1]!;
  setColumnKind(target, "ai");

  let started = 0;
  let completedAfterAbort = 0;
  const inFlight = new Set<AbortSignal>();

  registerCellExecutor(async (job) => {
    started++;
    inFlight.add(job.signal!);
    // A call that would run for a long time — standing in for an agent doing web searches. If Stop
    // only affected the QUEUE, this would keep going and keep spending until it finished.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 30_000);
      job.signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
    if (job.signal?.aborted !== true) completedAfterAbort++;
    return { status: "done", valueText: "should not be written" } as CellOutcome;
  });

  const { run, resolved } = createRun({ sheetId: sheet.id, scope: { columnIds: [target] } });
  const exec = executeRun(run.id, resolved, { concurrency: 4 });

  // Let the workers actually get into the executor before stopping.
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(started > 0, "the run must have started work before we stop it");

  const t0 = Date.now();
  cancelRun(run.id);
  await exec;
  const elapsed = Date.now() - t0;

  // The regression this guards: every signal handed out was aborted, and the whole thing came down
  // in well under the 30s those calls would otherwise have taken. Before the fix, cancel returned
  // immediately while four calls kept running to completion behind it.
  assert.ok([...inFlight].every((s) => s.aborted), "every in-flight call must be aborted");
  assert.equal(completedAfterAbort, 0, "no call may run to completion after Stop");
  assert.ok(elapsed < 5000, `stopping took ${elapsed}ms — it should be near-instant`);
  assert.equal(getRun(run.id)!.status, "cancelled");
});

test("cells caught mid-flight end up stopped, with a reason, not spinning", async () => {
  const { sheet, ids } = fixture("stop-cells", [{ Company: "a" }, { Company: "b" }]);
  const target = ids[1]!;
  setColumnKind(target, "ai");

  registerCellExecutor(async (job) => {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 30_000);
      job.signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
    return { status: "done", valueText: "x" } as CellOutcome;
  });

  const { run, resolved } = createRun({ sheetId: sheet.id, scope: { columnIds: [target] } });
  const exec = executeRun(run.id, resolved, { concurrency: 2 });
  await new Promise((r) => setTimeout(r, 60));
  cancelRun(run.id);
  await exec;

  const cells = db
    .prepare("SELECT status, error_type, error_msg FROM cells WHERE column_id = ?")
    .all(target) as Array<{ status: string; error_type: string | null; error_msg: string | null }>;

  // A cell left `running` after its run ended spins forever: the run is over, nothing will ever
  // write to it again, and no amount of scrolling clears it.
  assert.equal(cells.filter((c) => c.status === "running").length, 0, "no cell may be left running");
  assert.equal(cells.filter((c) => c.status === "queued").length, 0, "no cell may be left queued");

  const stopped = cells.filter((c) => c.status === "cancelled");
  assert.ok(stopped.length > 0, "the interrupted cells must be marked stopped");
  // The user asked to be told WHY, so an empty message is a failure of this feature.
  assert.ok(stopped.every((c) => (c.error_msg ?? "").length > 0), "every stopped cell explains itself");
  assert.ok(stopped.every((c) => c.error_type === "cancelled"), "stopped is its own class, not a generic error");
});

test("a stopped run does not retry the call it was stopped during", async () => {
  const { sheet, ids } = fixture("stop-no-retry", [{ Company: "a" }]);
  const target = ids[1]!;
  setColumnKind(target, "ai");

  let calls = 0;
  registerCellExecutor(async (job) => {
    calls++;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 5000);
      job.signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
    // An error on the far side of the abort. The retry policy would normally have another go — and
    // another go is another paid call, made after the user pressed Stop.
    return { status: "error", errorType: "overloaded", errorMsg: "boom" } as CellOutcome;
  });

  const { run, resolved } = createRun({ sheetId: sheet.id, scope: { columnIds: [target] } });
  const exec = executeRun(run.id, resolved, { concurrency: 1 });
  await new Promise((r) => setTimeout(r, 50));
  cancelRun(run.id);
  await exec;

  assert.equal(calls, 1, `the executor was called ${calls} times — a stopped run must not retry`);
});

// ─────────────────────────────────────────────────────── budgets

test("a run stops when it reaches its budget, and pauses rather than failing", async () => {
  const { sheet, ids } = fixture("budget-run", Array.from({ length: 20 }, (_, i) => ({ Company: `c${i}` })));
  const target = ids[1]!;
  setColumnKind(target, "ai");

  let calls = 0;
  registerCellExecutor(async () => {
    calls++;
    // Ten cents a cell against a fifty-cent cap: the gate must stop this at five, not at twenty.
    return { status: "done", valueText: "x", costUsd: 0.1 } as CellOutcome;
  });

  const { run, resolved } = createRun({ sheetId: sheet.id, scope: { columnIds: [target] } });
  db.prepare("UPDATE runs SET budget_usd = 0.5 WHERE id = ?").run(run.id);

  await executeRun(run.id, resolved, { concurrency: 1 });

  const after = getRun(run.id)!;
  assert.ok(calls <= 6, `spent past the cap: ${calls} cells at $0.10 against a $0.50 budget`);
  assert.ok(Number(after.costUsd) >= 0.5, "the cap is a floor to stop at, not a ceiling never reached");
  // Paused, not cancelled and not failed: the finished rows keep their values, and raising the cap
  // and resuming is a decision the user gets to make.
  assert.match(after.status, /paused/);
  assert.match(after.pauseReason ?? "", /limit/);
});

test("a sheet budget counts every run against it, not just the current one", async () => {
  const { sheet, ids } = fixture("budget-sheet", Array.from({ length: 10 }, (_, i) => ({ Company: `c${i}` })));
  const target = ids[1]!;
  setColumnKind(target, "ai");
  db.prepare("UPDATE sheets SET budget_usd = 0.3 WHERE id = ?").run(sheet.id);

  registerCellExecutor(async () => ({ status: "done", valueText: "x", costUsd: 0.1 } as CellOutcome));

  const a = createRun({ sheetId: sheet.id, scope: { columnIds: [target] } });
  await executeRun(a.run.id, a.resolved, { concurrency: 1 });

  // A cap that reset per run would be defeated by starting a second one — which is exactly what
  // someone does the moment the first stops.
  const b = createRun({ sheetId: sheet.id, scope: { columnIds: [target], force: true } as never });
  await executeRun(b.run.id, b.resolved, { concurrency: 1 });

  const spent = Number(
    (db.prepare("SELECT COALESCE(SUM(cost_usd),0) c FROM runs WHERE sheet_id = ?").get(sheet.id) as any).c,
  );
  assert.ok(spent < 0.6, `the sheet cap did not hold across runs: spent $${spent.toFixed(2)}`);
  assert.match(getRun(b.run.id)!.status, /paused/);
});

test("the budget counts the cells already in the air, not only the ones that landed", async () => {
  // `runs.cost_usd` is written when a cell LANDS, so checking it before dispatching is check-then-act:
  // with six workers the cap was crossed by six cells that had already been bought, every time.
  const f = fixture("budget-inflight", Array.from({ length: 30 }, (_, i) => ({ Company: `c${i}` })));
  const paid = addColumn(f.sheet.id, { name: "Enrich", kind: "ai" });

  let calls = 0;
  registerCellExecutor(async () => {
    calls++;
    // Over a macrotask, so all six workers are genuinely in flight at once — the situation the gate
    // was blind to. A cell that resolves synchronously makes the lane behave serially and hides it.
    await turn();
    return { status: "done", valueText: "x", costUsd: 0.1 } as CellOutcome;
  });

  const { run, resolved } = createRun({ sheetId: f.sheet.id, scope: { columnIds: [Number(paid.id)] } });
  db.prepare("UPDATE runs SET budget_usd = 1 WHERE id = ?").run(run.id);

  await executeRun(run.id, resolved, { concurrency: 6 });

  // What this pins is the property the reservation actually delivers, and no more than that.
  //
  // The opening wave overshoots whatever happens: no cell has landed yet, so there is no observed
  // price to reserve against. After it, the gate counts what is in flight. The exact landing count
  // is timing-dependent — measured at 11 here — because a worker can clear the gate in the moment
  // between a sibling reserving and that reservation being visible. Twelve is the number that says
  // the reservation did nothing at all: two full waves of six bought against a cap of ten cells.
  //
  // So this asserts "fewer than two full waves", not a round number. An earlier version of this test
  // asserted <= 10 on the arithmetic 6 + 4, which the fix does not guarantee and never did.
  // THIS IS NOT A HARD CAP and the code says so too — an exact one needs the price before the call,
  // which only the executor knows.
  assert.ok(calls < 12, `bought ${calls} cells at $0.10 against a $1.00 cap — the reservation is not holding`);
  assert.match(getRun(run.id)!.status, /paused/);
});

test("a cell that throws does not abandon the workers running beside it", async () => {
  // `Promise.all` rejects on the first worker to fail, and the run is then terminalised and its
  // in-flight cells stamped cancelled while five workers are still dispatching paid cells against a
  // run nothing owns any more.
  const f = fixture("worker-throw", Array.from({ length: 6 }, (_, i) => ({ Company: `c${i}` })));
  const paid = addColumn(f.sheet.id, { name: "Enrich", kind: "ai" });

  let n = 0;
  registerCellExecutor(async () => {
    // The first cell poisons the WRITE rather than the call: a BigInt cannot be serialised, so the
    // throw happens inside the engine instead of being caught and recorded as a cell error.
    if (++n === 1) return { status: "done", value: 1n } as CellOutcome;
    // Slower than the failure, so "did the siblings finish" is a real question rather than luck.
    for (let i = 0; i < 200; i++) await Promise.resolve();
    return { status: "done", valueText: "ok" };
  });

  const { run, resolved } = createRun({ sheetId: f.sheet.id, scope: { columnIds: [Number(paid.id)] } });
  await assert.rejects(executeRun(run.id, resolved, { concurrency: 6 }));

  assert.equal(getRun(run.id)!.done, 5, "every worker was waited for before the pass gave up");
});

test("a Resume pressed while a cell is still in flight is not dropped", async () => {
  // Resume refuses to enter a live run, which is right — two executors on one run is two writers and
  // twice the spend. Treating that refusal as "nothing to do" was not: the workers had already left
  // the column on the pause flag, so the click did nothing and the run finished over the rows it
  // still owed.
  const f = fixture("resume-live", Array.from({ length: 4 }, (_, i) => ({ Company: `c${i}` })));
  // Seeded so the price list is answered from cache: the resumed pass is entered on its own and this
  // test waits for it by turning the event loop, not by waiting on a network call.
  seedCatalog(parseCatalog({ data: [{ id: "openai/gpt-oss-20b", name: "R", pricing: { prompt: "0", completion: "0" } }] }));
  const paid = addColumn(f.sheet.id, { name: "Enrich", kind: "ai" });
  const col = Number(paid.id);

  let n = 0;
  registerCellExecutor(async (job) => {
    const call = ++n;
    // A dead credential pauses the whole run and hands this cell back as queued.
    if (call === 1) return { status: "error", errorType: "auth", errorMsg: "token expired" };
    if (call === 2) {
      // The user fixes the key and presses Resume while THIS cell is still running.
      await turn();
      resumeRun(job.runId);
      await turn();
    }
    return { status: "done", valueText: "ok" };
  });

  const { run, resolved } = createRun({ sheetId: f.sheet.id, scope: { columnIds: [col] } });
  await executeRun(run.id, resolved, { concurrency: 2 });
  // The resume re-enters once the pass lets go, so the work it asked for happens on its own.
  for (let i = 0; i < 100 && getRun(run.id)!.status !== "done"; i++) await turn();

  const done = Number(
    (db.prepare("SELECT COUNT(*) c FROM cells WHERE column_id = ? AND status = 'done'").get(col) as any).c,
  );
  assert.equal(done, 4, "the cell the pause handed back was left queued in a run that called itself finished");
  assert.equal(getRun(run.id)!.status, "done");
});

test("no budget set means no cap, not a zero-dollar one", async () => {
  const { sheet, ids } = fixture("budget-none", Array.from({ length: 5 }, (_, i) => ({ Company: `c${i}` })));
  const target = ids[1]!;
  setColumnKind(target, "ai");

  registerCellExecutor(async () => ({ status: "done", valueText: "x", costUsd: 0.1 } as CellOutcome));

  const { run, resolved } = createRun({ sheetId: sheet.id, scope: { columnIds: [target] } });
  await executeRun(run.id, resolved, { concurrency: 1 });

  // Reading an absent budget as 0 would make every run stop before its first cell — a cost control
  // that breaks the product is not a cost control.
  assert.equal(getRun(run.id)!.status, "done");
});

test("a column on a local model does not require a hosted key", () => {
  const { sheet, ids } = fixture("local-no-key", [{ Company: "a" }]);
  const target = ids[1]!;
  setColumnKind(target, "ai");
  db.prepare("UPDATE columns SET model = ? WHERE id = ?").run("local:ollama/llama3.1:8b", target);

  // Remove every credential. A local column reaches nothing outside this machine and spends nothing,
  // so demanding a hosted key would make the free lane unreachable for the person who chose it
  // precisely to avoid signing up anywhere.
  deleteProviderKey("openrouter");

  assert.doesNotThrow(() => createRun({ sheetId: sheet.id, scope: { columnIds: [target] } }));
});

test("a HOSTED column still requires a key", () => {
  const { sheet, ids } = fixture("hosted-needs-key", [{ Company: "a" }]);
  const target = ids[1]!;
  setColumnKind(target, "ai");
  deleteProviderKey("openrouter");

  // The other half of the same rule: relaxing the gate for local models must not relax it for the
  // lane that spends money, or a missing key surfaces as an error on every row mid-run.
  assert.throws(() => createRun({ sheetId: sheet.id, scope: { columnIds: [target] } }));
});

// ────────────────────────────────────────────────── two runs over the same cells

test("a second run over a column another run is working is refused", async () => {
  const { sheet, ids } = fixture("overlap", Array.from({ length: 8 }, (_, i) => ({ Company: `c${i}` })));
  const target = ids[1]!;
  const other = ids[2]!;
  setColumnKind(target, "ai");
  setColumnKind(other, "ai");

  // Measured on the shipping build: two overlapping runs both executed in full — 8,000 cell writes
  // where one run does 4,000 — because nothing ever asked. Hold the first run open inside the
  // executor so the second is created while it is genuinely mid-flight.
  let release = (): void => {};
  const held = new Promise<void>((r) => { release = r; });
  registerCellExecutor(async () => { await held; return { status: "done", valueText: "x" } as CellOutcome; });

  const first = createRun({ sheetId: sheet.id, scope: { columnIds: [target] } });
  const exec = executeRun(first.run.id, first.resolved, { concurrency: 1 });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(getRun(first.run.id)!.status, "running", "the first run must actually be in flight");

  assert.throws(
    () => createRun({ sheetId: sheet.id, scope: { columnIds: [target] } }),
    /already working on/,
    "a second run over the same column must be refused, not run alongside the first",
  );

  // A run over a DIFFERENT column is untouched: the guard is about the cells being written twice,
  // not about the table being busy.
  assert.doesNotThrow(() => createRun({ sheetId: sheet.id, scope: { columnIds: [other] } }));

  release();
  await exec;

  // And once the first run is over, the column is free again.
  assert.doesNotThrow(() => createRun({ sheetId: sheet.id, scope: { columnIds: [target] } }));
});

// ────────────────────────────────────────────────── not paying twice for an unchanged cell

test("an unchanged paid cell is skipped on a re-run, and a changed input is not", async () => {
  const f = fixture("input-hash", [
    { Company: "Acme", Country: "US", Website: "" },
    { Company: "Zinc", Country: "US", Website: "" },
  ]);
  const rows = rowsOf(f.sheet.id);
  const paid = addColumn(f.sheet.id, { name: "Blurb", kind: "ai" });
  // The reference is what makes the cell's inputs knowable. Without one every row would hash
  // identically, and the engine deliberately skips nothing at all rather than skip everything.
  setColumnPrompt(Number(paid.id), `Describe {{col:${f.ids[0]}}}`);

  let calls = 0;
  registerCellExecutor(async () => { calls++; return { status: "done", valueText: "blurb" } as CellOutcome; });

  const a = createRun({ sheetId: f.sheet.id, scope: { columnIds: [Number(paid.id)] } });
  await executeRun(a.run.id, a.resolved);
  assert.equal(calls, 2);

  // `cells.input_hash` was in the schema and NO per-cell path ever wrote it, so re-running an
  // untouched column bought every cell a second time.
  const stamped = Number(
    (db.prepare("SELECT COUNT(*) c FROM cells WHERE column_id = ? AND input_hash IS NOT NULL")
      .get(Number(paid.id)) as any).c,
  );
  assert.equal(stamped, 2, "a finished paid cell must record what it was computed from");

  const b = createRun({ sheetId: f.sheet.id, scope: { columnIds: [Number(paid.id)] } });
  await executeRun(b.run.id, b.resolved);
  assert.equal(calls, 2, "nothing changed, so the re-run must not spend again");
  assert.equal(getRun(b.run.id)!.skipped, 2, "the skipped cells still have to add up to the total");

  // Change ONE upstream value: that row alone is worth paying for again.
  setCellValue(rows[0]!, f.ids[0]!, "Acme Corp");
  const c = createRun({ sheetId: f.sheet.id, scope: { columnIds: [Number(paid.id)] } });
  await executeRun(c.run.id, c.resolved);
  assert.equal(calls, 3, "a changed input must recompute, and only the row that changed");

  // `force` is the escape hatch, and it has to actually work — a skip nobody can override is a value
  // that never updates again.
  const d = createRun({ sheetId: f.sheet.id, scope: { columnIds: [Number(paid.id)] }, force: true });
  await executeRun(d.run.id, d.resolved);
  assert.equal(calls, 5, "force must recompute every row");
});

test("a column that references nothing is never skipped", async () => {
  const f = fixture("input-hash-norefs", [{ Company: "a" }, { Company: "b" }]);
  const paid = addColumn(f.sheet.id, { name: "Haiku", kind: "ai" });
  setColumnPrompt(Number(paid.id), "Write a haiku.");

  let calls = 0;
  registerCellExecutor(async () => { calls++; return { status: "done", valueText: "x" } as CellOutcome; });

  const a = createRun({ sheetId: f.sheet.id, scope: { columnIds: [Number(paid.id)] } });
  await executeRun(a.run.id, a.resolved);
  const b = createRun({ sheetId: f.sheet.id, scope: { columnIds: [Number(paid.id)] } });
  await executeRun(b.run.id, b.resolved);

  // Every row of such a column hashes identically, so a skip would not mean "leave the unchanged
  // cells alone" — it would mean "never run this column again after its first pass".
  assert.equal(calls, 4, "with no knowable inputs the engine must skip nothing rather than guess");
});

// ────────────────────────────────────────────────── send columns, through the run engine

/** A destination table plus a row-to-row send config that matches on Company. */
function sendFixture(name: string) {
  const f = fixture(name, [
    { Company: "Acme", Country: "US", Website: "" },
    { Company: "Zinc", Country: "US", Website: "" },
  ]);
  const dest = createSheet(`${name}-dest`);
  const destCompany = Number(addColumn(dest.id, { name: "Company" }).id);
  const send = addColumn(f.sheet.id, { name: "To CRM", kind: "send" });
  const cfg: SendConfig = {
    ...DEFAULT_SEND,
    targetSheetId: dest.id,
    method: "row",
    mapping: { [destCompany]: { from: "row", columnId: f.ids[0]! } },
    keySource: { from: "row", columnId: f.ids[0]! },
    onConflict: "upsert",
    withBackRef: false,
  };
  setColumnSendConfig(Number(send.id), cfg as unknown as Record<string, unknown>);
  return { ...f, dest, destCompany, sendId: Number(send.id) };
}

const cellsOf = (columnId: number) =>
  db
    .prepare(
      "SELECT row_id, status, value_text, error_msg, note FROM cells WHERE column_id = ? ORDER BY row_id",
    )
    .all(columnId) as Array<{
      row_id: number; status: string; value_text: string | null; error_msg: string | null; note: string | null;
    }>;

const destRowCount = (sheetId: string) =>
  Number((db.prepare("SELECT COUNT(*) c FROM rows WHERE sheet_id = ?").get(sheetId) as any).c);

test("a send column says what became of each row, not 'sent' for all three outcomes", async () => {
  const f = sendFixture("send-outcomes");
  registerCellExecutor(async () => { throw new Error("a send column must not touch the per-cell lane"); });

  const a = createRun({ sheetId: f.sheet.id, scope: { columnIds: [f.sendId] } });
  await executeRun(a.run.id, a.resolved);

  assert.deepEqual(cellsOf(f.sendId).map((c) => c.value_text), ["sent", "sent"]);
  assert.equal(destRowCount(f.dest.id), 2);

  // Re-running an idempotent send UPDATES over there. A cell reading "sent" either way, so a
  // send that created nothing looked exactly like one that created every row.
  const b = createRun({ sheetId: f.sheet.id, scope: { columnIds: [f.sendId] } });
  await executeRun(b.run.id, b.resolved);
  assert.deepEqual(cellsOf(f.sendId).map((c) => c.value_text), ["updated", "updated"]);
  assert.equal(destRowCount(f.dest.id), 2, "a keyed re-run must not double the destination");
});

test("a row whose match key is blank is reported as skipped, with the reason", async () => {
  const f = sendFixture("send-blank-key");
  const rows = rowsOf(f.sheet.id);
  setCellValue(rows[1]!, f.ids[0]!, "");
  registerCellExecutor(async () => ({ status: "done" } as CellOutcome));

  const a = createRun({ sheetId: f.sheet.id, scope: { columnIds: [f.sendId] } });
  await executeRun(a.run.id, a.resolved);

  const cells = cellsOf(f.sendId);
  assert.equal(cells[0]!.value_text, "sent");
  // A row written with no key can never be found again, so it is refused rather than added — and the
  // cell has to say which of the two it was and why.
  assert.match(cells[1]!.value_text ?? "", /^skipped — /);
  assert.equal(getRun(a.run.id)!.skipped, 1, "a row that wrote nothing is a skip, not a success");
  assert.equal(getRun(a.run.id)!.done, 1);
  // The plan-level notice about blank keys reaches the user instead of dying inside the writer.
  assert.ok((cells[0]!.note ?? "").length > 0, "the write's warnings must be surfaced somewhere");
});

test("a send into a TRASHED table fails the column, not the whole run", async () => {
  const f = sendFixture("send-trashed");
  // The destination keeps its id, its columns and its rows in the trash, so every statement in the
  // writer succeeds against it: the send reported "done" and filed the records where nobody looks.
  trashTable(f.dest.id);

  const script = addColumn(f.sheet.id, { name: "Domain", kind: "script" });
  attachScript(f.sheet.id, Number(script.id), "transform", `function transform(row) { return "ok"; }`);
  registerCellExecutor(async () => ({ status: "done" } as CellOutcome));

  const a = createRun({ sheetId: f.sheet.id, scope: { columnIds: [f.sendId, Number(script.id)] } });
  await executeRun(a.run.id, a.resolved);

  const cells = cellsOf(f.sendId);
  assert.ok(cells.every((c) => c.status === "error"), "the refusal lands on the cells");
  assert.ok(
    cells.every((c) => /trash|archived|gone/i.test(c.error_msg ?? "")),
    "and it says which of the destination's states stopped it",
  );
  assert.equal(destRowCount(f.dest.id), 0, "nothing may be written into a trashed table");
  assert.equal(getRun(a.run.id)!.errors, 2);
  // A throw out of the send takes the whole run down with it and leaves every other column's work
  // unreported, for a fault that belongs to one column's settings.
  assert.notEqual(getRun(a.run.id)!.status, "failed");
  const other = Number(
    (db.prepare("SELECT COUNT(*) c FROM cells WHERE column_id = ? AND status = 'done'")
      .get(Number(script.id)) as any).c,
  );
  assert.equal(other, 2, "the other column in the same run must still have run");
});

// ── a model the provider has retired ─────────────────────────────────────────────────────────────
//
// Providers sunset ids routinely. A column pointed at a retired one fails on EVERY row, so this is
// not a cost check — it is the difference between one clear refusal and a hundred thousand identical
// failures with a bill for the retries.
//
// The confirm dialog already disabled its button for this, and that was the whole protection: a
// client-side guard on one screen. The API walked past it, and so did auto-run, which calls straight
// into createRun.

test("a run is refused when a column names a model the provider no longer offers", () => {
  seedCatalog(parseCatalog({
    data: [{ id: "real/model", name: "Real", pricing: { prompt: "0.000001", completion: "0.000002" } }],
  }));

  const sheet = createSheet("sunset-gone");
  const col = addColumn(sheet.id, { name: "Enrich", kind: "ai", valueType: "text" });
  setColumnModel(col.id, "retired/model-v1");
  setColumnPrompt(col.id, "Say something.");
  insertRows(sheet.id, [{ values: {} }], 0, [Number(col.id)]);

  assert.throws(
    () => createRun({ sheetId: sheet.id, scope: { columnIds: [Number(col.id)] } }),
    (e: unknown) => {
      const m = (e as Error).message;
      assert.match(m, /no longer offers/);
      // Names the column AND the model, because "pick a current model" is useless without both.
      assert.match(m, /"Enrich"/);
      assert.match(m, /retired\/model-v1/);
      return true;
    },
  );
});

test("a model that IS on the list runs normally", () => {
  seedCatalog(parseCatalog({
    data: [{ id: "real/model", name: "Real", pricing: { prompt: "0.000001", completion: "0.000002" } }],
  }));

  const sheet = createSheet("sunset-fine");
  const col = addColumn(sheet.id, { name: "Enrich", kind: "ai", valueType: "text" });
  setColumnModel(col.id, "real/model");
  setColumnPrompt(col.id, "Say something.");
  insertRows(sheet.id, [{ values: {} }], 0, [Number(col.id)]);

  // The guard must not have made every paid column unrunnable, which is the way a check like this
  // usually fails.
  assert.doesNotThrow(() => createRun({ sheetId: sheet.id, scope: { columnIds: [Number(col.id)] } }));
});

test("a script column is never blocked by the model gate", () => {
  // It names no model, so there is nothing to have been retired.
  seedCatalog(parseCatalog({ data: [{ id: "real/model", name: "R", pricing: { prompt: "0", completion: "0" } }] }));
  const sheet = createSheet("sunset-script");
  const col = addColumn(sheet.id, { name: "Rule", kind: "script", valueType: "text" });
  insertRows(sheet.id, [{ values: {} }], 0, [Number(col.id)]);
  assert.doesNotThrow(() => createRun({ sheetId: sheet.id, scope: { columnIds: [Number(col.id)] } }));
});

// ─────────────────────────────────────────────────── overwriting a hand edit

/**
 * A hand-typed cell is `pinned`, and a run leaves it alone. That is the right default and stays the
 * default — silently replacing something the user typed is the one thing a spreadsheet must never
 * do. But it was absolute, so someone who pasted placeholder values, or corrected ten cells before
 * realising the column's prompt was wrong, could not hand those rows back to the column at all.
 *
 * These check the two directions of that switch, and the third thing that goes with it: once a run
 * has replaced a typed value, the cell must stop claiming it was typed.
 */
function pinnedFixture(name: string) {
  const { sheet, ids } = fixture(name, [{ Company: "Acme" }, { Company: "Beta" }]);
  const target = ids[1]!;
  setColumnKind(target, "script");
  attachScript(sheet.id, target, "transform", `function transform(row) { return "COMPUTED"; }`);
  const rows = rowsOf(sheet.id);
  // Row one is typed in by hand; row two is left for the column to fill.
  setCellValue(rows[0]!, target, "TYPED BY HAND");
  db.prepare("UPDATE cells SET pinned = 1 WHERE row_id = ? AND column_id = ?").run(rows[0]!, target);
  return { sheet, target, rows };
}

const valueAt = (rowId: number, columnId: number) =>
  db.prepare("SELECT value_text, pinned FROM cells WHERE row_id = ? AND column_id = ?")
    .get(rowId, columnId) as { value_text: string | null; pinned: number } | undefined;

test("by default a run leaves a hand-typed cell exactly as it was", async () => {
  const { sheet, target, rows } = pinnedFixture("pin-default");
  const { run, resolved } = createRun({ sheetId: sheet.id, scope: { columnIds: [target] }, force: true });
  await executeRun(run.id, resolved);

  assert.equal(valueAt(rows[0]!, target)?.value_text, "TYPED BY HAND", "the edit must survive");
  assert.equal(valueAt(rows[0]!, target)?.pinned, 1, "and still be marked as yours");
  assert.equal(valueAt(rows[1]!, target)?.value_text, "COMPUTED", "the unpinned row still runs");
});

test("with overwriteEdited the run replaces it, and stops calling it hand-typed", async () => {
  const { sheet, target, rows } = pinnedFixture("pin-overwrite");
  const { run, resolved } = createRun({
    sheetId: sheet.id, scope: { columnIds: [target] }, force: true, overwriteEdited: true,
  });
  await executeRun(run.id, resolved);

  const cell = valueAt(rows[0]!, target);
  assert.equal(cell?.value_text, "COMPUTED", "the run was told to replace it");
  // The marker means "you typed this". After the run replaced it that is false, and leaving it set
  // would make the NEXT run protect a value nobody typed.
  assert.equal(cell?.pinned, 0, "the hand-typed marker must be cleared with the value");
});

test("the choice is recorded on the run, so a resume cannot forget it", () => {
  const { sheet, target } = pinnedFixture("pin-persist");
  const { run } = createRun({
    sheetId: sheet.id, scope: { columnIds: [target] }, force: true, overwriteEdited: true,
  });
  const stored = db.prepare("SELECT overwrite_edited FROM runs WHERE id = ?").get(run.id) as any;
  // In memory only, a run resumed after a crash would silently start protecting the cells it had
  // been told to replace — half the rows updated, half not, for no visible reason.
  assert.equal(stored.overwrite_edited, 1);

  const { run: plain } = createRun({ sheetId: sheet.id, scope: { columnIds: [target] }, force: true });
  assert.equal((db.prepare("SELECT overwrite_edited FROM runs WHERE id = ?").get(plain.id) as any).overwrite_edited, 0);
});

test("the unsure rows are the ones that RAN and were not settled — never the unstarted ones", () => {
  // The whole safety of the "run the better model on the unsure rows" action. A never-run cell is not
  // unsure, it is unstarted, and sweeping those in would turn a small deliberate spend into running
  // the entire column — which is the bill the cheap-first setting exists to avoid.
  const f = fixture("unsure-scope", Array.from({ length: 5 }, (_, i) => ({ Company: `Co ${i}`, Country: "US", Website: "" })));
  const col = Number(addColumn(f.sheet.id, { name: "Industry", kind: "ai" }).id);
  const rows = rowsOf(f.sheet.id);

  const set = (i: number, status: string, confidence: string | null) =>
    db.prepare(
      `INSERT INTO cells (row_id, column_id, status, confidence, value_text)
       VALUES (?, ?, ?, ?, 'x')
       ON CONFLICT(row_id, column_id) DO UPDATE SET status = excluded.status, confidence = excluded.confidence`,
    ).run(rows[i]!, col, status, confidence);

  set(0, "done", "high");      // settled — must NOT be offered
  set(1, "done", "medium");    // answered, hedged
  set(2, "done", null);        // answered, said nothing about how sure
  set(3, "not_found", "high"); // a small model giving up is not a finding
  set(4, "error", null);       // never got an answer at all
  // Row 5 has no cell row at all — never run.

  const resolved = resolveScope(f.sheet.id, { columnIds: [col], unsure: true });
  const got = (db.prepare(resolved.sql).all(...resolved.params) as Array<{ id: number }>).map((r) => Number(r.id));

  const want = [rows[1]!, rows[2]!, rows[3]!, rows[4]!];
  assert.deepEqual(got.sort((a, b) => a - b), want.sort((a, b) => a - b));
  assert.ok(!got.includes(rows[0]!), "a confident answer is not paid for twice");
  assert.match(resolved.summary, /not sure/i, "and the run dialog says which rows it means");
});

test("a workbook budget stops a run, and it was storable and unenforced until now", async () => {
  // `workbooks.budget_usd` has been in the schema since workbooks existed, and is COPIED when a
  // workbook is duplicated — so a copy faithfully carried a limit that had never stopped anything.
  // The run cap and the sheet cap worked; this one had no reader.
  //
  // It is also the one people actually want: a workbook is a project, and "this project may cost
  // $200" is the sentence somebody means. A per-table cap has to be set on every table and re-set on
  // every table added, which is how a workspace ends up capped on four tables and open on the fifth.
  // MORE rows than the concurrency, deliberately. The gate is checked before dispatching another
  // row, so it cannot stop work already in flight — with three rows and six workers all three go at
  // once and the cap has nothing to prevent. That is honest behaviour, and testing it on three rows
  // would have asserted the opposite of what the engine promises.
  const f = fixture("ZZ wb budget", Array.from({ length: 30 }, (_, i) => ({ Company: `C${i}` })));
  const wb = (db.prepare("SELECT workbook_id FROM sheets WHERE id = ?").get(f.sheet.id) as any).workbook_id;
  db.prepare("UPDATE workbooks SET budget_usd = ? WHERE id = ?").run(0.05, wb);

  let calls = 0;
  registerCellExecutor(async () => {
    calls++;
    return { status: "done", value: "x", costUsd: 0.04 };
  });

  // The model gate refuses a column pointed at a model the catalogue does not list, so the local
  // default is registered as real — the gate still runs, only the round trip is skipped.
  seedCatalog(parseCatalog({ data: [{ id: "openai/gpt-oss-20b", name: "R", pricing: { prompt: "0.0000001", completion: "0.0000001" } }] }));
  const col = addColumn(f.sheet.id, { name: "Answer", kind: "ai" });
  const r = createRun({ sheetId: f.sheet.id, scope: { columnIds: [Number(col.id)] } });
  await executeRun(r.run.id, r.resolved);

  const run = getRun(r.run.id)!;
  // paused_budget, not plain paused: the reason is part of the status so a resumed run can tell a
  // cap from somebody pressing Pause.
  assert.equal(run.status, "paused_budget", "hitting a cap pauses so the rows already done keep their values");
  assert.match(run.pauseReason ?? "", /workbook reached its \$0\.05 limit/);
  assert.ok(calls < 30, `the run stopped early rather than finishing every row (ran ${calls})`);
});

test("money spent on a table that was later deleted still counts against the workbook", async () => {
  // Letting a delete reset the counter would make the cap avoidable by tidying up.
  const f = fixture("ZZ wb budget 2", [{ Company: "A" }]);
  const wb = (db.prepare("SELECT workbook_id FROM sheets WHERE id = ?").get(f.sheet.id) as any).workbook_id;
  db.prepare("UPDATE workbooks SET budget_usd = ? WHERE id = ?").run(1, wb);

  // A second table in the same workbook, which has already spent the whole allowance and is gone.
  const other = createSheet("ZZ wb budget 2 - gone");
  db.prepare("UPDATE sheets SET workbook_id = ? WHERE id = ?").run(wb, other.id);
  db.prepare("INSERT INTO runs (id, sheet_id, kind, total, cost_usd) VALUES (?, ?, 'sheet', 0, ?)")
    .run(`zz-spent-${Math.random().toString(36).slice(2)}`, other.id, 5);
  trashTable(other.id);

  registerCellExecutor(async () => ({ status: "done", value: "x", costUsd: 0.01 }));
  // The model gate refuses a column pointed at a model the catalogue does not list, so the local
  // default is registered as real — the gate still runs, only the round trip is skipped.
  seedCatalog(parseCatalog({ data: [{ id: "openai/gpt-oss-20b", name: "R", pricing: { prompt: "0.0000001", completion: "0.0000001" } }] }));
  const col = addColumn(f.sheet.id, { name: "Answer", kind: "ai" });
  const r = createRun({ sheetId: f.sheet.id, scope: { columnIds: [Number(col.id)] } });
  await executeRun(r.run.id, r.resolved);

  assert.equal(getRun(r.run.id)!.status, "paused_budget");
  assert.match(getRun(r.run.id)!.pauseReason ?? "", /workbook reached/);
});

test("a run records the schedule that started it, and who pressed Run", async () => {
  // Reproduced: the INSERT had EIGHT placeholders and SEVEN arguments, so `schedule_id` silently
  // took the trailing NULL on every run ever created. Nothing failed — the driver fills a missing
  // parameter — so a schedule's spend, which is DEFINED as a query over the runs it started, was a
  // query over an empty set. It read as $0.00 spent forever, and the only way to notice was to
  // already suspect it.
  const f = fixture(`ZZ run-attrib-a`, [{ Company: "Acme" }, { Company: "Beta" }]);
  const paid = addColumn(f.sheet.id, { name: "Summary", kind: "ai" });
  const { run } = createRun({ sheetId: f.sheet.id, scope: { columnIds: [Number(paid.id)] }, scheduleId: 77, startedBy: 5 });
  const row = db.prepare("SELECT schedule_id, started_by FROM runs WHERE id = ?").get(run.id) as any;
  assert.equal(Number(row.schedule_id), 77);
  assert.equal(Number(row.started_by), 5);
});

test("a run started by nobody in particular says so, rather than pretending", async () => {
  const f = fixture(`ZZ run-attrib-b`, [{ Company: "Acme" }, { Company: "Beta" }]);
  const paid = addColumn(f.sheet.id, { name: "Summary", kind: "ai" });
  const { run } = createRun({ sheetId: f.sheet.id, scope: { columnIds: [Number(paid.id)] } });
  const row = db.prepare("SELECT schedule_id, started_by FROM runs WHERE id = ?").get(run.id) as any;
  assert.equal(row.schedule_id, null);
  assert.equal(row.started_by, null);
});
