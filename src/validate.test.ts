// Per-column rules.
//
// The properties here are the ones whose failure is invisible in the result. A rule that silently
// passes everything looks exactly like a column with no rules; an empty-cell check that fires on
// every rule marks a whole unfilled column as broken; and a pattern that backtracks does not fail,
// it hangs — on a million-row column that is an engine with no error and no end.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkValue, parseRules, patternRisk, rulesProblem, type RuleSet } from "./validate.ts";

const set = (rules: RuleSet["rules"], onFail: RuleSet["onFail"] = "reject"): RuleSet => ({ rules, onFail });

test("a value inside every rule passes", () => {
  assert.equal(checkValue("42", set([{ kind: "min", value: 1 }, { kind: "max", value: 100 }])), null);
});

test("the first failure is what comes back, not all of them", () => {
  // The message lands in a cell error, on one line. Three joined rules tell you less than one does.
  const msg = checkValue("0", set([{ kind: "min", value: 1 }, { kind: "max", value: -5 }]));
  assert.equal(msg, "This must be at least 1.");
});

test("a custom message replaces the generated one", () => {
  assert.equal(
    checkValue("0", set([{ kind: "min", value: 1, message: "Headcount of zero means the company is closed." }])),
    "Headcount of zero means the company is closed.",
  );
});

test("an empty cell is judged by `required` and by nothing else", () => {
  // The one that would have been worst in practice: applying "at least 3 characters" to every cell
  // nobody has filled in yet marks a whole unstarted column as failing.
  assert.equal(checkValue("", set([{ kind: "min_length", value: 3 }])), null);
  assert.equal(checkValue("   ", set([{ kind: "max_length", value: 2 }])), null);
  assert.equal(checkValue("", set([{ kind: "required" }])), "This must not be empty.");
});

test("a numeric rule does not judge a value that is not a number", () => {
  // Coercion owns the shape. Reporting "must be at least 1" for the value "abc" points at the wrong
  // problem and sends the reader to the wrong place to fix it.
  assert.equal(checkValue("abc", set([{ kind: "min", value: 1 }])), null);
});

test("length is counted in characters, not code units", () => {
  // "🙂" is two UTF-16 code units and one character. `.length` would call a two-emoji value four
  // characters long and refuse it against a max of 3.
  assert.equal(checkValue("🙂🙂", set([{ kind: "max_length", value: 2 }])), null);
  assert.equal(checkValue("🙂🙂🙂", set([{ kind: "max_length", value: 2 }])), "This must be at most 2 characters.");
});

test("one_of and not_one_of ignore case and surrounding space", () => {
  assert.equal(checkValue(" Active ", set([{ kind: "one_of", value: ["active", "churned"] }])), null);
  assert.ok(checkValue("Trial", set([{ kind: "one_of", value: ["active", "churned"] }])));
  assert.ok(checkValue("SPAM", set([{ kind: "not_one_of", value: ["spam"] }])));
});

test("a pattern is applied, and an unanchored one is not treated as anchored", () => {
  assert.equal(checkValue("AB-123", set([{ kind: "pattern", value: "^[A-Z]{2}-\\d+$" }])), null);
  assert.ok(checkValue("ab-123", set([{ kind: "pattern", value: "^[A-Z]{2}-\\d+$" }])));
});

test("a catastrophically backtracking pattern is refused before it can be stored", () => {
  // Not a slow run — an engine that never finishes and says nothing. The check is structural and
  // deliberately blunt; a rejected pattern costs a rewrite, an accepted one costs the table.
  assert.ok(patternRisk("(a+)+$"));
  assert.ok(patternRisk("(x*)*"));
  assert.ok(patternRisk("[a-"), "an invalid pattern is also refused");
  assert.equal(patternRisk("^[A-Z]{2}-\\d+$"), null, "an ordinary pattern is fine");
  assert.ok(rulesProblem(set([{ kind: "pattern", value: "(a+)+$" }])));
});

test("an incomplete rule is refused on the way in, and judges nothing if it got in anyway", () => {
  // A rule missing its bound cannot be evaluated, and a rule that cannot be evaluated passes
  // everything — which is indistinguishable from having no rule at all.
  assert.ok(rulesProblem(set([{ kind: "min" }])));
  assert.equal(checkValue("anything", set([{ kind: "min" }])), null);
});

test("an unreadable stored rule set means no rules, not a broken column", () => {
  // A rule that vanishes lets a bad value through. A rule that throws makes every write to the
  // column fail with a parse error. The first is recoverable.
  assert.equal(parseRules("{not json"), null);
  assert.equal(parseRules(null), null);
  assert.equal(parseRules('{"rules":[]}'), null);
  assert.deepEqual(parseRules('{"rules":[{"kind":"required"}],"onFail":"warn"}'), {
    rules: [{ kind: "required" }], onFail: "warn",
  });
});

test("an unknown rule kind is dropped rather than trusted", () => {
  const parsed = parseRules('{"rules":[{"kind":"required"},{"kind":"summon_demon"}]}');
  assert.deepEqual(parsed?.rules, [{ kind: "required" }]);
  assert.equal(parsed?.onFail, "reject", "and the default is to refuse, not to let it through");
});

test("validate imports nothing, so the browser can read it", () => {
  // The column editor checks a rule as it is typed and the engine checks it before a write. If those
  // two ever disagreed, one of them would be refusing what the other accepts. One module, and it
  // reaches the client through the @shared alias — which ONE import of anything touching
  // node:sqlite would break, at build time, naming an unrelated file.
  const src = readFileSync(new URL("./validate.ts", import.meta.url), "utf8");
  const imports = src.match(/^\s*import[\s{*]/gm) ?? [];
  assert.equal(imports.length, 0, `validate.ts must import nothing, found ${imports.length}`);
});
