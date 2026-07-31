// Waterfalls.
//
// Every property here is one whose failure costs money in one of two directions: a rule that accepts
// too easily stops at the cheap step and writes a blank-ish answer as final, and a rule that accepts
// too rarely runs every provider on every row. Both look like the feature working.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  accepts, describeAccept, emptyWaterfall, parseWaterfall, waterfallCost, waterfallSpends,
  type AcceptRule, type StepResult, type Waterfall,
} from "./waterfall.ts";

const step = (over: Partial<Waterfall["steps"][number]> = {}) => ({
  id: over.id ?? "s1", name: "Step", kind: "http" as const, enabled: true, config: {},
  costUsd: null as number | null, ...over,
});

test("waterfall.ts imports nothing, so the column editor can share it with the browser", () => {
  // One careless import of db.ts here pulls node:sqlite into the web bundle, and the failure is a
  // broken production build rather than a type error.
  const src = readFileSync(new URL("./waterfall.ts", import.meta.url), "utf8");
  const imports = src.split("\n").filter((l) => /^\s*import\s/.test(l) && !/^\s*import\s+type\s/.test(l));
  assert.deepEqual(imports, [], "waterfall.ts must stay import-free");
});

test("an error never accepts, whatever the rule says", () => {
  // The single most important line in the module. Treating a 500 as an answer stops the waterfall at
  // the one step that definitely did not work, and the row is blank forever.
  const failed: StepResult = { status: "error", valueText: null };
  for (const rule of [
    { kind: "any" }, { kind: "non_empty" }, { kind: "matches", pattern: ".*" },
    { kind: "confidence", min: "medium" },
  ] as AcceptRule[]) {
    assert.equal(accepts(failed, rule), false, `${rule.kind} accepted an errored step`);
  }
});

test("whitespace is not a value", () => {
  // A provider that returns " " has found nothing, and the string is truthy — so the naive check
  // stops the waterfall on a blank and never reaches the provider that had the answer.
  assert.equal(accepts({ status: "done", valueText: "   " }, { kind: "non_empty" }), false);
  assert.equal(accepts({ status: "done", valueText: "a@b.com" }, { kind: "non_empty" }), true);
});

test("a pattern that will not compile refuses rather than accepting everything", () => {
  // The loose failure: a broken regex that returns true ends every row at step one and skips every
  // paid provider behind it, silently, while the column reports itself finished.
  assert.equal(accepts({ status: "done", valueText: "anything" }, { kind: "matches", pattern: "([" }), false);
});

test("a confidence rule needs the grade, not just a value", () => {
  const r: StepResult = { status: "done", valueText: "Acme Ltd", confidence: "low" };
  assert.equal(accepts(r, { kind: "confidence", min: "medium" }), false);
  assert.equal(accepts({ ...r, confidence: "medium" }, { kind: "confidence", min: "medium" }), true);
  assert.equal(accepts({ ...r, confidence: "high" }, { kind: "confidence", min: "high" }), true);
  // No grade at all is the most doubtful state there is, and must not pass.
  assert.equal(accepts({ status: "done", valueText: "x" }, { kind: "confidence", min: "medium" }), false);
});

test("a script rule with no runner fails closed", () => {
  // An unevaluated rule must fail rather than pass: falling through costs money, but stopping on an
  // unchecked value writes a wrong answer and calls it done.
  const r: StepResult = { status: "done", valueText: "x" };
  assert.equal(accepts(r, { kind: "script", scriptId: 7 }), false);
  assert.equal(accepts(r, { kind: "script", scriptId: 7 }, () => true), true);
});

test("\"any\" still requires the step to have run", () => {
  assert.equal(accepts({ status: "done", valueText: null }, { kind: "any" }), true);
  assert.equal(accepts({ status: "not_found" }, { kind: "any" }), true);
  assert.equal(accepts({ status: "skipped" }, { kind: "any" }), false);
});

test("an unreadable step is dropped and REPORTED, never guessed at", () => {
  // A step that silently disappears makes the waterfall fall through to a more expensive one, and
  // the user is charged for a change they never made.
  const { waterfall, dropped } = parseWaterfall(JSON.stringify({
    steps: [step({ id: "a" }), { id: "b", kind: "carrier-pigeon", name: "Nope" }, step({ id: "c" })],
  }));
  assert.equal(waterfall.steps.length, 2);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0]!, /kind of step this build does not have/);
});

test("two steps sharing an id is refused, because provenance would name the wrong one", () => {
  const { waterfall, dropped } = parseWaterfall(JSON.stringify({ steps: [step({ id: "x" }), step({ id: "x" })] }));
  assert.equal(waterfall.steps.length, 1);
  assert.match(dropped[0]!, /share the id/);
});

test("a step with no explicit enabled flag runs", () => {
  // Defaulting to off would make a freshly-built waterfall do nothing and look broken.
  const { waterfall } = parseWaterfall(JSON.stringify({ steps: [{ id: "a", name: "A", kind: "http" }] }));
  assert.equal(waterfall.steps[0]!.enabled, true);
});

test("an unreadable waterfall runs NOTHING rather than something arbitrary", () => {
  const { waterfall, dropped } = parseWaterfall("{not json");
  assert.deepEqual(waterfall.steps, []);
  assert.equal(dropped.length, 1);
});

test("cost is reported both ways, and undeclared steps are named", () => {
  // Best case is what people quote themselves; worst case is what arrives when the cheap steps miss.
  // A total that quietly omits an undeclared paid API reads as authoritative and is short by exactly
  // the amount that matters.
  const w = parseWaterfall(JSON.stringify({
    steps: [
      step({ id: "a", name: "Cheap", costUsd: 0.001 }),
      step({ id: "b", name: "Pricey", costUsd: 0.02 }),
      step({ id: "c", name: "Mystery API" }),
      step({ id: "d", name: "Off", costUsd: 5, enabled: false }),
    ],
  })).waterfall;
  const cost = waterfallCost(w);
  assert.equal(cost.best, 0.001);
  assert.equal(Number(cost.worst.toFixed(4)), 0.021, "a disabled step is not part of the worst case");
  assert.deepEqual(cost.unpriced, ["Mystery API"]);
});

test("anything not provably free counts as spending", () => {
  // The auto-run and schedule gates read this. Guessing wrong in the permissive direction is an
  // unattended bill, so only a script, a lookup and a confirmed local model are free.
  const local = (id: string) => id.startsWith("local/");
  const spends = (steps: unknown[]) => waterfallSpends(parseWaterfall(JSON.stringify({ steps })).waterfall, local);

  assert.equal(spends([step({ kind: "script" }), step({ id: "s2", kind: "lookup" })]), false);
  assert.equal(spends([step({ kind: "ai", config: { model: "local/llama" } })]), false);
  assert.equal(spends([step({ kind: "ai", config: { model: "openai/gpt-4" } })]), true);
  // "auto" is not proof of anything — it resolves to whatever the workspace default happens to be.
  assert.equal(spends([step({ kind: "ai", config: { model: "auto" } })]), true);
  assert.equal(spends([step({ kind: "http" })]), true, "an unknown endpoint is assumed to cost");
  assert.equal(spends([step({ kind: "http", enabled: false })]), false, "a disabled step spends nothing");
});

test("every rule can say what it does in words", () => {
  // The rule is shown on the step's row rather than buried, so a waterfall can be audited without
  // opening five dialogs. A rule with no sentence is a rule nobody checks.
  for (const rule of [
    { kind: "any" }, { kind: "non_empty" }, { kind: "matches", pattern: "@" },
    { kind: "confidence", min: "high" }, { kind: "script", scriptId: 1 },
  ] as AcceptRule[]) {
    assert.ok(describeAccept(rule).length > 0);
  }
});

test("an empty waterfall is a valid one", () => {
  const w = emptyWaterfall();
  assert.deepEqual(w.steps, []);
  assert.equal(w.accept.kind, "non_empty");
  assert.equal(waterfallCost(w).worst, 0);
});
