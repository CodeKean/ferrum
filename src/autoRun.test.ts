// "Keep this column up to date by itself."
//
// A paid column may use this. What bounds it is a per-firing ceiling rather than a refusal, so the
// queue has one more thing to get right: the ceiling has to reach the run, and it has to be the one
// in force when the run starts rather than when the change was noticed.
//
// These test the QUEUE rather than the run, because the queue is where the safety lives: which
// columns are woken, how a burst is folded into one run, and what happens with nothing registered.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { addColumn, createSheet, insertRows, setColumnAutoRun, setColumnModel, setColumnPrompt } from "./store.ts";
import { rebuildDeps } from "./refs.ts";
import {
  autoRunRefusal, flush, isFreeToRun, noteUpstreamChange, pendingCount, registerAutoRunStarter,
} from "./autoRun.ts";

type Started = { sheetId: string; columnId: number; rowIds: number[] | null; budgetUsd: number | null };

/** Replace the starter with a recorder, so nothing here can begin a real run. */
function record(): Started[] {
  const seen: Started[] = [];
  registerAutoRunStarter((sheetId, columnId, rowIds, budgetUsd) => { seen.push({ sheetId, columnId, rowIds, budgetUsd }); });
  return seen;
}

/**
 * Source → Derived, with Derived reading Source through a prompt.
 *
 * Derived runs on a LOCAL model by default only because most of these tests are about the QUEUE and
 * a free column keeps them about that. A hosted model is woken just the same — see the paid tests
 * below.
 */
function pair(name: string, auto: boolean, rows = 3, model = "local:lmstudio/qwen") {
  const sheet = createSheet(name);
  const source = addColumn(sheet.id, { name: "Source", kind: "static", valueType: "text" });
  const derived = addColumn(sheet.id, { name: "Derived", kind: "ai", valueType: "text" });
  setColumnModel(derived.id, model);
  setColumnPrompt(derived.id, `Summarise {{col:${source.id}}}.`);
  rebuildDeps(sheet.id, Number(derived.id));
  if (auto) setColumnAutoRun(derived.id, true);

  const ids = [Number(source.id), Number(derived.id)];
  insertRows(sheet.id, Array.from({ length: rows }, (_, i) => ({ values: { [String(ids[0]!)]: `v${i}` } })), 0, ids);
  const rowIds = (
    db.prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY position").all(sheet.id) as Array<{ id: number }>
  ).map((r) => Number(r.id));
  return { sheet, source, derived, rowIds };
}

test("a column with the toggle on is woken when its input changes", () => {
  const seen = record();
  const f = pair("auto-on", true);

  noteUpstreamChange(f.sheet.id, Number(f.source.id), [f.rowIds[0]!]);
  assert.equal(flush(), 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.columnId, Number(f.derived.id));
  assert.deepEqual(seen[0]!.rowIds, [f.rowIds[0]]);
});

test("a column with the toggle OFF is never woken", () => {
  // The default, and the whole point of the toggle being a toggle.
  const seen = record();
  const f = pair("auto-off", false);

  noteUpstreamChange(f.sheet.id, Number(f.source.id), f.rowIds);
  assert.equal(flush(), 0);
  assert.equal(seen.length, 0);
});

test("a burst of changes becomes ONE run, not one run per change", () => {
  // An import of 100,000 rows must not start 100,000 paid runs. This is the property that makes the
  // feature safe to leave switched on.
  const seen = record();
  const f = pair("auto-burst", true, 5);

  for (const r of f.rowIds) noteUpstreamChange(f.sheet.id, Number(f.source.id), [r]);
  assert.equal(pendingCount(), 1, "five changes, one column queued");

  assert.equal(flush(), 1);
  assert.equal(seen.length, 1);
  assert.deepEqual([...(seen[0]!.rowIds ?? [])].sort((a, b) => a - b), [...f.rowIds].sort((a, b) => a - b));
});

test("a whole-sheet change swallows the individual rows queued beside it", () => {
  // Once the answer is "every row", adding row ids narrows nothing — and a scope carrying both would
  // be a run over a handful of rows when the whole column moved.
  const seen = record();
  const f = pair("auto-allrows", true, 4);

  noteUpstreamChange(f.sheet.id, Number(f.source.id), [f.rowIds[0]!]);
  noteUpstreamChange(f.sheet.id, Number(f.source.id), null);
  noteUpstreamChange(f.sheet.id, Number(f.source.id), [f.rowIds[2]!]);

  flush();
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.rowIds, null, "null means every row, and must not be narrowed back down");
});

test("nothing is queued when no starter is registered", () => {
  // Which is the case in every unit test, and is what stops importing this module from being able to
  // spend money.
  registerAutoRunStarter(null as never);
  const f = pair("auto-nostarter", true);
  noteUpstreamChange(f.sheet.id, Number(f.source.id), f.rowIds);
  assert.equal(pendingCount(), 0);
});

test("a column that does not read the changed one is left alone", () => {
  const seen = record();
  const f = pair("auto-unrelated", true);
  const other = addColumn(f.sheet.id, { name: "Unrelated", kind: "static", valueType: "text" });

  // Nothing reads Unrelated, so nothing should wake up.
  noteUpstreamChange(f.sheet.id, Number(other.id), f.rowIds);
  assert.equal(flush(), 0);
  assert.equal(seen.length, 0);
});

test("waking is transitive, so a chain keeps itself up to date end to end", () => {
  const seen = record();
  const f = pair("auto-chain", true);
  const last = addColumn(f.sheet.id, { name: "Last", kind: "ai", valueType: "text" });
  // Local, like the rest of the chain, so this test stays about the chain rather than about money.
  setColumnModel(last.id, "local:lmstudio/qwen");
  setColumnPrompt(last.id, `Rewrite {{col:${f.derived.id}}}.`);
  rebuildDeps(f.sheet.id, Number(last.id));
  setColumnAutoRun(last.id, true);

  // Changing the TOP of the chain must reach the bottom. Each link also re-fires as it writes, but
  // queuing both up front is what makes the chain converge rather than trickle.
  noteUpstreamChange(f.sheet.id, Number(f.source.id), [f.rowIds[0]!]);
  flush();
  assert.deepEqual(seen.map((s) => s.columnId).sort((a, b) => a - b),
    [Number(f.derived.id), Number(last.id)].sort((a, b) => a - b));
});

test("a starter that throws does not take down the write that triggered it", () => {
  // The usual refusal is "a run is already working this column", which is not an error worth
  // shouting about — that run is about to produce the values anyway.
  registerAutoRunStarter(() => { throw new Error("a run is already working that column"); });
  const f = pair("auto-throws", true);
  noteUpstreamChange(f.sheet.id, Number(f.source.id), f.rowIds);
  assert.doesNotThrow(() => flush());
  assert.equal(pendingCount(), 0, "the queue is still drained, so it cannot wedge");
});

test("a refusal is kept, so a column that never ran can say why", () => {
  // It used to be swallowed entirely, on the grounds that the next change would queue it again. That
  // is true of a change to an upstream cell and false of an import: refuse that firing and nothing
  // re-queues those rows, so they stay blank with the reason recorded nowhere at all — and the
  // refusals are things like a retired model and a missing provider key, which no amount of waiting
  // fixes.
  registerAutoRunStarter(() => { throw new Error('"Industry" is set to a model the provider no longer offers.'); });
  const f = pair("auto-refusal", true);
  const col = Number(f.derived.id);

  noteUpstreamChange(f.sheet.id, Number(f.source.id), f.rowIds);
  flush();
  assert.match(String(autoRunRefusal(col)), /no longer offers/);

  // And cleared by a firing that worked, so an old reason cannot outlive the thing it explained.
  registerAutoRunStarter(() => { /* started */ });
  noteUpstreamChange(f.sheet.id, Number(f.source.id), f.rowIds);
  flush();
  assert.equal(autoRunRefusal(col), null);
});

// ── a paid column starts itself, inside a ceiling ───────────────────────────
//
// Every test below asserted the opposite until the refusal came out, and the reversal was
// deliberate: refusing a paid column the toggle protected the wrong thing. Filling new rows as they
// arrive is what people turn it on for.
//
// What replaced the refusal is `auto_run_budget_usd`, read at fire time and handed to the run. The
// two properties worth guarding here are that the ceiling travels at all, and that "no ceiling" and
// "a ceiling of zero" stay different — `Number(null)` is 0, and a zero read as a limit would stop
// every firing rather than allowing every firing.

test("a column on a hosted model IS woken, and carries its ceiling", () => {
  // This asserted the opposite until the refusal came out. Refusing it protected the wrong thing:
  // filling new rows as they arrive is the reason people turn the toggle on, and a tool that cannot
  // do it is worse at the job than the ones it replaces. The ceiling is the bound now.
  const seen = record();
  const f = pair("auto-paid", true, 3, "openrouter/some-paid-model");
  db.prepare("UPDATE columns SET auto_run_budget_usd = ? WHERE id = ?").run(2.5, Number(f.derived.id));

  noteUpstreamChange(f.sheet.id, Number(f.source.id), f.rowIds);
  assert.equal(flush(), 1, "queued");
  assert.equal(seen.length, 1, "and started");
  assert.equal(seen[0]!.budgetUsd, 2.5, "the run is handed the column's ceiling");
});

test("no ceiling set means no ceiling passed, not a ceiling of zero", () => {
  // The distinction that matters most in this file. Zero would read as "may spend nothing" and stop
  // every firing; null means "no limit". `Number(null)` is 0, so anything that coerces on the way
  // through turns one into the other silently.
  const seen = record();
  const f = pair("auto-paid-nocap", true, 3, "openrouter/some-paid-model");

  noteUpstreamChange(f.sheet.id, Number(f.source.id), f.rowIds);
  assert.equal(flush(), 1);
  assert.equal(seen[0]!.budgetUsd, null);
});

test('"auto" is woken too, and is still treated as paid everywhere it matters', () => {
  // The workspace default can be pointed at a hosted model by anyone without touching this column,
  // so "auto" is never assumed free. That no longer stops it running — it decides whether the
  // settings panel warns and offers a ceiling.
  const seen = record();
  const f = pair("auto-auto", true, 3, "auto");

  noteUpstreamChange(f.sheet.id, Number(f.source.id), f.rowIds);
  assert.equal(flush(), 1);
  assert.equal(seen.length, 1);
  assert.equal(isFreeToRun({ kind: "ai", model: "auto", first_model: null, waterfall_json: null }), false);
});

test("a cheap first model does not make a paid column free", () => {
  // The whole point of that setting is that some rows do NOT clear the bar, and those rows are the
  // ones that reach the model being paid for. A column that can reach a paid model is a paid column.
  // Still true, and still what the warning and the ceiling offer key off.
  assert.equal(
    isFreeToRun({ kind: "ai", model: "openrouter/some-paid-model", first_model: "local:lmstudio/qwen", waterfall_json: null }),
    false,
  );
  assert.equal(
    isFreeToRun({ kind: "ai", model: "local:lmstudio/qwen", first_model: "local:lmstudio/qwen", waterfall_json: null }),
    true,
  );
});

test("the ceiling is read when it fires, not when the change was noticed", () => {
  // A change sits in the queue for a couple of seconds, and lowering a limit is something people do
  // precisely because a run is about to happen. Reading it at note time would honour the older and
  // always larger number.
  const seen = record();
  const f = pair("auto-cap-late", true, 3, "openrouter/some-paid-model");
  db.prepare("UPDATE columns SET auto_run_budget_usd = ? WHERE id = ?").run(10, Number(f.derived.id));

  noteUpstreamChange(f.sheet.id, Number(f.source.id), f.rowIds);
  db.prepare("UPDATE columns SET auto_run_budget_usd = ? WHERE id = ?").run(1, Number(f.derived.id));

  assert.equal(flush(), 1);
  assert.equal(seen[0]!.budgetUsd, 1, "the limit in force at fire time");
});

test("script, lookup and rollup columns still wake, because they cost nothing", () => {
  // The guard must not swallow the case the feature is actually for. A rule column recomputing the
  // instant its input moves is free, useful, and the reason anyone turns the toggle on.
  const seen = record();
  const sheet = createSheet("auto-free-kinds");
  const source = addColumn(sheet.id, { name: "Source", kind: "static", valueType: "text" });
  const rule = addColumn(sheet.id, { name: "Rule", kind: "script", valueType: "text" });
  setColumnPrompt(rule.id, `Clean {{col:${source.id}}}.`);
  rebuildDeps(sheet.id, Number(rule.id));
  setColumnAutoRun(rule.id, true);
  insertRows(sheet.id, [{ values: { [String(source.id)]: "x" } }], 0, [Number(source.id), Number(rule.id)]);

  noteUpstreamChange(sheet.id, Number(source.id), null);
  assert.equal(flush(), 1);
  assert.equal(seen[0]!.columnId, Number(rule.id));
});
