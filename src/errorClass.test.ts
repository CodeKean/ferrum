// What a failure means, and whether pressing the button again could help.
//
// The tests that matter here are the ones about REFUSING to offer a re-run. A panel that offers an
// action the engine will decline produces the worst possible loop: the user clicks, waits, is
// charged, sees the identical failure, and concludes the product is broken rather than that their
// key is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { errorFacts, ERR_CLASSES, MAX_FREE_RETRIES, SCHEMA_MAX_ATTEMPTS, type ErrClass } from "./errorClass.ts";
import { retryPolicy } from "./runs.ts";

const LANES = ["ai", "agent", "http", "mcp", "script", "lookup", "rollup", "send", "static"];

// ── everything has an answer ────────────────────────────────────────────────

test("every class has a cause and a to-do, on every lane", () => {
  // A blank sentence is how a panel goes back to being the empty box this replaced. There is no
  // class for which "we do not know" is an acceptable rendering — even `unknown` has advice.
  for (const cls of ERR_CLASSES) {
    for (const lane of LANES) {
      const f = errorFacts(cls, lane);
      assert.ok(f.cause.length > 10, `${cls}/${lane} needs a cause`);
      assert.ok(f.todo.length > 10, `${cls}/${lane} needs a to-do`);
    }
  }
});

test("a cell with no recorded class still gets advice, not a blank", () => {
  // Distinct from `unknown`. `unknown` means the engine looked and could not tell; null means
  // nothing recorded one at all, which is a gap in the engine rather than in the run.
  const none = errorFacts(null, "ai");
  assert.match(none.cause, /no reason was recorded/i);
  assert.notEqual(none.cause, errorFacts("unknown", "ai").cause);
});

// ── the refusals ────────────────────────────────────────────────────────────

test("rerunHelps is false exactly where the engine refuses to try again", () => {
  // The property that keeps two functions from drifting. `retryPolicy` decides what the ENGINE does
  // mid-run; `errorFacts` decides what the USER is offered afterwards — and by then every retry the
  // policy allowed has already been spent. If this ever fails, one of the two has been edited alone.
  for (const cls of ERR_CLASSES) {
    const facts = errorFacts(cls, "ai");
    // The state a cell is actually in when someone reads the panel: attempts exhausted.
    const verdict = retryPolicy(cls as ErrClass, 3, 3, MAX_FREE_RETRIES);
    if (!facts.rerunHelps) {
      assert.ok(
        verdict === "fail" || verdict === "pause_run",
        `${cls} tells the user not to re-run, so the engine must refuse it too — got ${verdict}`,
      );
    }
  }
});

test("auth and budget never offer a re-run, because the fix is not in the column", () => {
  for (const lane of LANES) {
    assert.equal(errorFacts("auth", lane).rerunHelps, false);
    assert.equal(errorFacts("budget", lane).rerunHelps, false);
  }
  assert.equal(errorFacts("auth", "ai").fixWhere, "settings_keys");
  assert.equal(errorFacts("budget", "ai").fixWhere, "settings_budget");
});

test("a schema failure is not offered a re-run — the engine already used both its tries", () => {
  // The one most likely to be argued with. A wrong-shaped answer comes back wrong-shaped again, so
  // the engine caps it at two attempts; by the time the cell reads `error`, both are gone.
  assert.equal(errorFacts("schema", "ai").rerunHelps, false);
  assert.equal(retryPolicy("schema", SCHEMA_MAX_ATTEMPTS, 5), "fail");
});

test("a rate limit says it already waited, so nobody clicks again straight away", () => {
  const f = errorFacts("rate_limit", "ai");
  assert.equal(f.rerunHelps, true, "it will eventually work");
  assert.match(f.todo, /already|minutes|fewer/i, "but not right now, and it says why");
  assert.equal(f.fixWhere, "wait");
});

// ── the AI fix, and where it points ─────────────────────────────────────────

test("no AI fix is offered where a model could not possibly write one", () => {
  // Charging for a proposal whose only honest content is "fix your key" is exactly the spend this
  // feature exists to prevent elsewhere.
  for (const cls of ["auth", "budget", "rate_limit", "overloaded", "cancelled"] as ErrClass[]) {
    assert.equal(errorFacts(cls, "ai").aiCanHelp, false, `${cls} must not offer an AI fix`);
  }
});

test("a fix is aimed at the part of the column that is actually wrong", () => {
  // The same class is a different problem per lane, and advice that ignores that is advice nobody
  // follows: a timed-out agent searched too long; a timed-out endpoint is just slow.
  assert.equal(errorFacts("timeout", "agent").area, "search");
  assert.equal(errorFacts("timeout", "http").area, "request");
  assert.equal(errorFacts("timeout", "ai").area, "prompt");
  // Deliberately NOT narrowed, so not "output". The advice for a model-lane schema
  // failure names two remedies — loosen the data type, or say in the instruction what shape you want
  // — while "output" tells the designer only the data type may change, forbidding the second. The
  // contradiction is the reason; it is NOT a claim that this made the proposals better, which was
  // measured and did not happen. See the comment on that branch in errorClass.ts.
  assert.equal(errorFacts("schema", "ai").area, null);
  assert.equal(errorFacts("schema", "http").area, "request", "an http schema failure is about what it reads");
  assert.equal(errorFacts("script", "script").area, "rule");
});

/**
 * The pairs where a fix is offered and no single part of the column is named.
 *
 * Enumerated rather than allowed in general, which is the whole point of the test below. This
 * previously asserted that EVERY class offering a fix names a part — a rule that sounds right and is
 * not: a class whose advice honestly spans two parts must not narrow to one, because narrowing tells
 * the designer to leave everything else alone and it comes back with nothing to apply.
 *
 * So a deliberate null goes in this list and an accidental one still fails. Adding a line here is
 * the moment to check the class's `todo` really does name more than one remedy.
 */
const BREADTH_IS_DELIBERATE = new Set(
  // `schema` on every lane EXCEPT http. Only the http lane has one obvious culprit — which part of
  // the reply the column reads — and everywhere else the answer is genuinely "the data type or the
  // instruction". Written out per lane rather than as a wildcard so a new lane has to be considered
  // rather than inheriting the exception.
  ["ai", "agent", "mcp", "script", "lookup", "rollup", "send", "static"].map((l) => `schema/${l}`),
);

test("a fix is either aimed at one part of the column, or deliberately not aimed at all", () => {
  for (const cls of ERR_CLASSES) {
    for (const lane of LANES) {
      const f = errorFacts(cls, lane);
      if (!f.aiCanHelp) {
        assert.equal(f.area, null, `${cls}/${lane} names a target for a fix it will not offer`);
      } else if (BREADTH_IS_DELIBERATE.has(`${cls}/${lane}`)) {
        assert.equal(f.area, null, `${cls}/${lane} is listed as deliberately broad but names a part`);
        // The reason it is broad has to still be true, or the entry is stale.
        assert.match(f.todo, / or /, `${cls}/${lane} is only broad because its advice offers a choice`);
      } else {
        assert.ok(f.area, `${cls}/${lane} offers a fix with nowhere to apply it`);
      }
    }
  }
});

// ── the bundle invariant ────────────────────────────────────────────────────

test("errorClass imports nothing, so the browser can read it", () => {
  // The cell panel is client code and reads this table. ONE import of anything under src/ that
  // touches node:sqlite breaks the production bundle — not the typecheck, not a test, the build —
  // and the failure names a file that has nothing to do with the line that caused it.
  const src = readFileSync(new URL("./errorClass.ts", import.meta.url), "utf8");
  const imports = src.match(/^\s*import[\s{*]/gm) ?? [];
  assert.equal(imports.length, 0, `errorClass.ts must import nothing, found ${imports.length}`);
});
