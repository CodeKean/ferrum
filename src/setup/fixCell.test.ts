// The brief a failed cell sends on its own behalf.
//
// Every one of these is about a sentence that, if it were missing or wrong, would send a proposal at
// the wrong problem — and the person reading that proposal came here BECAUSE they did not know what
// was wrong, so they are the least equipped person in the building to catch it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFixIntent, type FixInput } from "./fixCell.ts";

const base: FixInput = {
  columnName: "Industry",
  kind: "ai",
  errorType: "schema",
  errorMsg: "expected one of: SaaS, Retail, Other",
  attemptsHere: 1,
  columnErrorTypes: [],
  renderedPrompt: null,
  inputs: [],
};

test("the failure class and the provider's own words are both there, and are not confused", () => {
  // The class is the engine's verdict and the message is the provider's; a brief carrying only one
  // of them loses either what kind of problem it is or what actually happened.
  const t = buildFixIntent(base);
  assert.match(t, /failure class the engine recorded: schema/);
  assert.match(t, /what came back: expected one of/);
});

test("one failure and nine failures are stated differently", () => {
  // The single most useful fact about a failure, and the one the message itself can never carry.
  assert.match(buildFixIntent(base), /tried once/);
  assert.match(buildFixIntent({ ...base, attemptsHere: 9 }), /tried 9 times.*not a one-off/s);
});

test("the whole column's split is included, with an instruction not to fix only this row", () => {
  // Otherwise a proposal happily rewrites the prompt to satisfy the one row it was shown and breaks
  // the eight hundred that were working.
  const t = buildFixIntent({ ...base, columnErrorTypes: [{ type: "schema", rows: 812 }, { type: "timeout", rows: 4 }] });
  assert.match(t, /812 schema, 4 timeout/);
  assert.match(t, /most of those rows, not only this one row/);
});

test("a single failing row is not told to generalise from itself", () => {
  // "Fix the cause behind most of those rows" is nonsense when the cause is one row, and an
  // instruction that does not apply is an instruction a model has to guess its way around.
  const t = buildFixIntent({ ...base, columnErrorTypes: [{ type: "schema", rows: 1 }] });
  assert.match(t, /1 schema/);
  assert.doesNotMatch(t, /not only this one row/);
});

test("what was actually sent is quoted, and a long one is cut with the cut declared", () => {
  const short = buildFixIntent({ ...base, renderedPrompt: "Classify Acme Ltd." });
  assert.match(short, /WHAT WAS ACTUALLY SENT/);
  assert.match(short, /Classify Acme Ltd\./);

  const long = buildFixIntent({ ...base, renderedPrompt: "x".repeat(5000) });
  // Declared, not silently truncated: a model that cannot tell it was handed a fragment will reason
  // about the fragment as though it were the whole instruction.
  assert.match(long, /\[3800 more characters\]/);
});

test("no prompt means no section, rather than an empty heading", () => {
  // The HTTP lane and every early refusal never build one. A heading with nothing under it reads as
  // a prompt that was lost.
  assert.doesNotMatch(buildFixIntent(base), /WHAT WAS ACTUALLY SENT/);
});

test("this row's values are listed by name, and a blank is shown as blank", () => {
  // "(empty)" is the answer on a large share of real failures — the row that failed is usually the
  // row with nothing in it — and an omitted line would read as a value that was simply not sent.
  const t = buildFixIntent({
    ...base,
    inputs: [{ name: "Company", value: "Acme Ltd" }, { name: "Website", value: "" }],
  });
  assert.match(t, /- Company: Acme Ltd/);
  assert.match(t, /- Website: \(empty\)/);
});

test("a wide table says how many columns it left out", () => {
  const inputs = Array.from({ length: 30 }, (_, i) => ({ name: `C${i}`, value: `v${i}` }));
  const t = buildFixIntent({ ...base, inputs });
  assert.match(t, /and 18 more columns/);
  assert.ok(!t.includes("C29"), "the cap is real, not decorative");
});

test("the model, the limits and private addresses are ruled out, every time", () => {
  // These are the three things a proposal could change that cost money or open a hole, and one
  // failed row is not a reason to revisit any of them. Asserted on the plainest possible input,
  // because a rule that only appears when some other section does is a rule that will go missing.
  const t = buildFixIntent(base);
  assert.match(t, /Do not change the model/);
  assert.match(t, /spending limit/);
  assert.match(t, /private addresses/);
});

test("it is told that an explanation with no change attached is no use", () => {
  // The observed failure mode, not a hypothetical one. The same enum column was diagnosed three
  // times; all three answers correctly said the instruction should name the allowed values, and two
  // of them attached no changed value at all — which the panel can do nothing with. Asserted on the
  // plainest input, because a rule that only appears alongside some other section will go missing.
  const t = buildFixIntent(base);
  assert.match(t, /RETURN THE CHANGE ITSELF/);
  assert.match(t, /cannot be applied/);
});

test("a class the engine never recorded is said to be missing, not left blank", () => {
  const t = buildFixIntent({ ...base, errorType: null, errorMsg: null });
  assert.match(t, /failure class the engine recorded: none recorded/);
  assert.doesNotMatch(t, /what came back/);
});
