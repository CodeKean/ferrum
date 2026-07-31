// The wording is the feature here, so the wording is what is tested.
//
// A blank panel is unhelpful. A panel that confidently says the wrong thing is worse — it sends
// someone to press a button that does not exist, or to fix a column that was never the problem. Each
// of these checks one sentence that would do that if it were wrong.

import { test } from "node:test";
import assert from "node:assert/strict";
import { attemptCost, attemptTook, explainCell, retryNote, statusWord } from "./explainCell.ts";

test("an empty static cell is not told to run something that cannot run", () => {
  const f = explainCell({ kind: "static", status: "empty" });
  assert.equal(f.runnable, false);
  assert.match(f.why ?? "", /type/i);
  assert.doesNotMatch(f.why ?? "", /run/i, "there is no run button on a static column");
});

test("an empty AI cell IS told to run", () => {
  const f = explainCell({ kind: "ai", status: "empty" });
  assert.equal(f.runnable, true);
  assert.match(f.why ?? "", /run/i);
});

test("skipped by a condition and skipped for want of input are different sentences", () => {
  // They send someone to two different places: one to the column's condition, one to another column.
  const cond = explainCell({ kind: "ai", status: "skipped", message: "the run condition was false" });
  const input = explainCell({ kind: "ai", status: "skipped", message: "nothing in Website" });
  assert.match(cond.why ?? "", /condition/i);
  assert.match(input.why ?? "", /Website/);
  assert.notEqual(cond.why, input.why);
});

test("skipped with no reason recorded does not invent one", () => {
  // With a condition on the column, either explanation is possible and the sentence says so rather
  // than picking one.
  const withCond = explainCell({ kind: "ai", status: "skipped", hasCondition: true });
  assert.match(withCond.why ?? "", /either/i);
  // Without a condition, only one explanation is available and it can be stated.
  const without = explainCell({ kind: "ai", status: "skipped", hasCondition: false });
  assert.doesNotMatch(without.why ?? "", /condition/i);
});

test("not_found says re-running will not help, because the instinct is to re-run", () => {
  const f = explainCell({ kind: "agent", status: "not_found" });
  assert.match(f.why ?? "", /not change|will not/i);
});

test("blocked points at the upstream column rather than this one", () => {
  const f = explainCell({ kind: "ai", status: "blocked" });
  assert.match(f.why ?? "", /depends on|upstream|first/i);
});

test("an error does not repeat the message back, but does say what to do about it", () => {
  // This test used to assert `why === null` whenever a message existed, on the reasoning that the
  // real error is already shown in full one element above. Right about the CAUSE and wrong about the
  // REMEDY: "429 Too Many Requests" says exactly what happened and nothing about what to do, and the
  // panel's only button was the re-run that a third of the failure classes have already been refused.
  const f = explainCell({ kind: "http", status: "error", message: "429 rate limited", errorType: "rate_limit" });
  assert.ok(f.why, "there is advice");
  assert.doesNotMatch(f.why!, /429/, "and it does not parrot the message back");

  // An error with nothing recorded still says something — and something different.
  const bare = explainCell({ kind: "http", status: "error" });
  assert.ok(bare.why);
  assert.notEqual(bare.why, f.why);
});

test("a wrong-shaped answer is not told to re-run, because the engine already gave up on it", () => {
  // The whole point of threading the class through. A schema failure gets at most two attempts,
  // both spent by the time anyone reads this, and the answer comes back the same shape every time.
  const schema = explainCell({ kind: "ai", status: "error", message: "bad shape", errorType: "schema" });
  assert.equal(schema.rerunHelps, false);
  assert.equal(schema.aiCanHelp, true, "but a model can propose a fix for it");
  // NOT narrowed to one part of the column, so not "output". The advice for this
  // class names two remedies — loosen the data type, or say in the instruction what shape you want —
  // and "output" tells the designer only the data type may change, which forbids the second. Live,
  // that produced a correct diagnosis with an empty proposal attached, twice running.
  assert.equal(schema.fixArea, null);
  // The HTTP lane keeps a real area, because there the shape genuinely is the request's problem.
  assert.equal(
    explainCell({ kind: "http", status: "error", message: "bad shape", errorType: "schema" }).fixArea,
    "request",
  );
});

test("a rejected key sends you to the key, not to the run button", () => {
  const auth = explainCell({ kind: "http", status: "error", message: "401", errorType: "auth" });
  assert.equal(auth.rerunHelps, false);
  assert.equal(auth.aiCanHelp, false, "no model can guess a working key");
  assert.equal(auth.fixWhere, "settings_keys");
  assert.match(auth.cause ?? "", /key/i);
});

test("a projection is described as one, not as the rule it is stored as", () => {
  // A derived child is saved with kind "script", so the panel called it "a rule that runs on this
  // row's values" while the badge two lines above it said "pulled out of Enrichment" — two
  // descriptions of one column, in one panel, disagreeing with each other.
  const f = explainCell({ kind: "script", status: "done", derivedFrom: "Enrichment" });
  assert.match(f.what, /Enrichment/);
  assert.doesNotMatch(f.what, /rule/i);
  assert.match(f.what, /costs nothing|re-reads/i, "and it says the re-read is free");
});

test("an overridden projection that drifted says what to do, not that it is out of date", () => {
  // "Something this cell reads changed after it ran" is technically true and useless here. Nothing
  // is stale: your value and the source disagree, and the fix is to pick one.
  const f = explainCell({ kind: "script", status: "done", pinned: true, stale: true, derivedFrom: "Enrichment" });
  assert.match(f.why ?? "", /no longer matches/i);
  assert.match(f.why ?? "", /keep yours|restore/i);
  assert.doesNotMatch(f.why ?? "", /out of date/i);
});

test("pinned and stale are added to the reason, not swapped for it", () => {
  const f = explainCell({ kind: "ai", status: "not_found", pinned: true, stale: true });
  assert.match(f.why ?? "", /not change|will not/i, "the status reason survives");
  assert.match(f.why ?? "", /typed this value/i);
  assert.match(f.why ?? "", /out of date/i);
});

test("a done cell with a value needs no explanation at all", () => {
  assert.equal(explainCell({ kind: "ai", status: "done" }).why, null);
});

test("which kinds cost money is right, because it decides whether re-running is free", () => {
  assert.equal(explainCell({ kind: "script", status: "done" }).costs, false);
  assert.equal(explainCell({ kind: "lookup", status: "done" }).costs, false);
  assert.equal(explainCell({ kind: "rollup", status: "done" }).costs, false);
  assert.equal(explainCell({ kind: "ai", status: "done" }).costs, true);
  assert.equal(explainCell({ kind: "agent", status: "done" }).costs, true);
  assert.equal(explainCell({ kind: "http", status: "done" }).costs, true);
});

test("every kind has a line saying what it does", () => {
  for (const k of ["static", "script", "http", "mcp", "ai", "agent", "send", "lookup", "rollup"]) {
    const f = explainCell({ kind: k, status: "done" });
    assert.ok(f.what.trim(), `${k} needs a description`);
    assert.equal(f.kind, k);
  }
});

test("an unknown kind degrades to something harmless rather than crashing", () => {
  const f = explainCell({ kind: "wormhole", status: "empty" });
  assert.equal(f.kind, "static");
  assert.ok(f.what);
});

// ── the small formatters ────────────────────────────────────────────────────

test("a sub-cent cost is shown in cents, because counting zeros is not reading", () => {
  assert.equal(attemptCost(0.0004), "0.04¢");
  assert.equal(attemptCost(0.012), "$0.012");
  assert.equal(attemptCost(0), "free");
  // Null means unknown, which is not zero — a cell on an unpriced model shows nothing rather than
  // claiming it was free.
  assert.equal(attemptCost(null), null);
});

test("a duration is shown at a precision that matches how long it took", () => {
  assert.equal(attemptTook(420), "420ms");
  assert.equal(attemptTook(4200), "4.2s");
  assert.equal(attemptTook(125_000), "2m 5s");
  assert.equal(attemptTook(null), null);
});

test("one attempt is not worth a note; several are", () => {
  assert.equal(retryNote([]), null);
  assert.equal(retryNote([{ id: 1, attempt: 1, status: "done" }]), null);
  // Succeeding on the third try every time is a column about to start failing.
  assert.match(
    retryNote([
      { id: 3, attempt: 3, status: "done" },
      { id: 2, attempt: 2, status: "done" },
      { id: 1, attempt: 1, status: "done" },
    ]) ?? "",
    /3 tries/,
  );
  assert.match(
    retryNote([
      { id: 2, attempt: 2, status: "done" },
      { id: 1, attempt: 1, status: "error" },
    ]) ?? "",
    /Failed 1 time/,
  );
});

// ── the status word ─────────────────────────────────────────────────────────

test("a static column never claims to have run", () => {
  // The panel says "Nothing runs" two lines below this pill, so "Ran successfully" is not a small
  // inaccuracy — it is a visible contradiction.
  assert.equal(statusWord("static", "done"), "Has a value");
  assert.equal(statusWord("static", "empty"), "Empty");
});

test("every other column keeps the run wording", () => {
  assert.equal(statusWord("ai", "done"), "Ran successfully");
  assert.equal(statusWord("ai", "empty"), "Never run");
  assert.equal(statusWord("http", "error"), "Failed");
});

test("an unknown status is shown rather than swallowed", () => {
  // A status this file has not heard of still has to appear — a blank pill is worse than a raw word.
  assert.equal(statusWord("ai", "quarantined"), "quarantined");
});
