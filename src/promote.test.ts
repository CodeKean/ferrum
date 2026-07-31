// Promoting a model column to a free rule.
//
// The generation is the easy half and is worth nothing on its own. Everything tested here is the
// CHECKING, because the failure this feature can cause is silent and permanent: a plausible rule is
// approved, replaces the model, and is subtly wrong on every future row of a column nobody re-reads
// because it used to be right.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_EXAMPLES, detectMemorisation, judge, repairOneLineComments, scoreAgreement, splitExamples, type Example,
} from "./promote.ts";

const ex = (rowId: number, site: string, answer: string): Example =>
  ({ rowId, inputs: { Website: site }, answer });

/** n examples, each with a distinct one-off answer — the shape memorisation shows up in. */
function many(n: number): Example[] {
  return Array.from({ length: n }, (_, i) => ex(i + 1, `https://co${i}.example.com`, `co${i}.example.com`));
}

test("the split interleaves rather than cutting down the middle", () => {
  // Rows arrive grouped — one import, then another, then a webhook's worth. A straight cut trains on
  // one source and grades on a different one, so a rule that is right about everything scores badly.
  const examples = many(10);
  const { train, holdout } = splitExamples(examples);
  assert.ok(train.length > 0 && holdout.length > 0);
  assert.equal(train.length + holdout.length, 10);
  // Held-out rows are spread through the set, not bunched at one end.
  const ids = holdout.map((e) => e.rowId);
  assert.ok(Math.max(...ids) - Math.min(...ids) >= 5, "the holdout must span the set");
});

test("the split is deterministic, so two people get the same numbers", () => {
  const a = splitExamples(many(50));
  const b = splitExamples(many(50));
  assert.deepEqual(a.holdout.map((e) => e.rowId), b.holdout.map((e) => e.rowId));
});

test("a rule that returns nothing scores zero, not a hundred", () => {
  // Scoring perfectly by producing nothing is possible if rows with no output were
  // skipped instead of counted. A rule that answers nothing is the cheapest wrong rule there is.
  const holdout = many(10);
  const score = scoreAgreement(holdout, new Map());
  assert.equal(score.agreed, 0);
  assert.equal(score.errored, 10);
  assert.equal(score.rate, 0);
});

test("trailing whitespace is agreement; different case is not", () => {
  // Whitespace would bury the real disagreements. Case would not: "US" and "us" landing in a column
  // somebody will group by is a genuine difference, and calling it agreement is how a rule gets
  // promoted on a 98% that was really an 80%.
  const holdout = [ex(1, "a", "Acme"), ex(2, "b", "Beta")];
  const score = scoreAgreement(holdout, new Map([
    [1, { value: "Acme " }],
    [2, { value: "beta" }],
  ]));
  assert.equal(score.agreed, 1);
  assert.equal(score.examples[0]?.rowId, 2);
});

test("a rule that crashes is counted as broken, not merely as disagreeing", () => {
  const score = scoreAgreement([ex(1, "a", "Acme")], new Map([[1, { value: null, error: "x is not defined" }]]));
  assert.equal(score.errored, 1);
  assert.equal(score.agreed, 0);
  assert.match(score.examples[0]?.rule ?? "", /error:/);
});

test("disagreements come back with the inputs, so a person can look at them", () => {
  // "97% agreement" is a number nobody can act on. The three rows where it differs are a thing
  // somebody can read and say "the rule is right and the model was wrong" — which happens.
  const score = scoreAgreement([ex(7, "https://www.Acme.com/", "acme.com")], new Map([[7, { value: "www.acme.com" }]]));
  assert.equal(score.examples[0]?.inputs.Website, "https://www.Acme.com/");
  assert.equal(score.examples[0]?.model, "acme.com");
  assert.equal(score.examples[0]?.rule, "www.acme.com");
});

test("a lookup table wearing a rule is caught by the code, not by its score", () => {
  // The characteristic failure. It scores perfectly on the half it was written from and reads like a
  // rule to anyone skimming it.
  const train = many(20);
  const code = "function transform(row){\n" +
    train.map((e) => `  if (row.website === ${JSON.stringify(e.inputs.Website)}) return ${JSON.stringify(e.answer)};`).join("\n") +
    "\n  return null;\n}";
  const m = detectMemorisation(code, train);
  assert.ok(m.memorised, "the answers are written into the code verbatim");
  assert.equal(m.hits, m.looked);
});

test("an honest rule is not accused of memorising", () => {
  const train = many(20);
  const code = "function transform(row){ return new URL(row.website).hostname.replace(/^www\\./, ''); }";
  assert.equal(detectMemorisation(code, train).memorised, false);
});

test("a classifier naming its own categories is not memorisation", () => {
  // A column of yes/no has two answers, both of which any honest rule must contain. Flagging that
  // would refuse every classifier ever written.
  const train = Array.from({ length: 30 }, (_, i) => ex(i + 1, `t${i}`, i % 2 ? "decision maker" : "individual contributor"));
  const code = "function transform(row){ return row.title.match(/vp|head|chief/i) ? 'decision maker' : 'individual contributor'; }";
  const m = detectMemorisation(code, train);
  assert.equal(m.memorised, false, "a shared category is a bucket the rule may name");
  assert.equal(m.looked, 0, "answers shared by many rows are not distinctive");
});

test("memorisation OVERRIDES a high score, rather than being weighed against it", () => {
  // A memorised rule can post a high number if the split happened to be kind. Promoting on that score
  // ships a lookup table that returns nothing for every row the sheet has not seen yet.
  const report = judge(
    { checked: 20, agreed: 20, rate: 1, errored: 0, examples: [] },
    { hits: 9, looked: 10, memorised: true },
  );
  assert.equal(report.verdict, "no");
  assert.match(report.summary, /not a rule/);
});

test("nothing to check against is refused, not scored as perfect", () => {
  const report = judge({ checked: 0, agreed: 0, rate: 0, errored: 0, examples: [] }, { hits: 0, looked: 0, memorised: false });
  assert.equal(report.verdict, "no");
  assert.match(report.summary, /no rows left over/);
});

test("the three verdicts land where they should, and say the numbers", () => {
  const clean = { hits: 0, looked: 5, memorised: false };
  const at = (rate: number) => judge(
    { checked: 100, agreed: Math.round(rate * 100), rate, errored: 0, examples: [] }, clean,
  );
  assert.equal(at(0.99).verdict, "promote");
  assert.equal(at(0.98).verdict, "promote");
  assert.equal(at(0.95).verdict, "close");
  assert.equal(at(0.90).verdict, "close");
  assert.equal(at(0.89).verdict, "no");
  // Every verdict carries the count, not just a percentage — a rate with no denominator is what lets
  // "100%" over four rows read like "100%" over four hundred.
  for (const r of [0.99, 0.95, 0.5]) assert.match(at(r).summary, /\d+ of 100 /);
});

test("a broken rule says it broke, rather than only that it disagreed", () => {
  const report = judge(
    { checked: 100, agreed: 40, rate: 0.4, errored: 30, examples: [] },
    { hits: 0, looked: 5, memorised: false },
  );
  assert.match(report.summary, /broke on 30/);
});

test("the minimum example count is high enough for its own percentage to mean something", () => {
  // An agreement figure over eight rows is noise presented as a percentage, and the whole point of
  // this feature is that its numbers can be trusted.
  assert.ok(MIN_EXAMPLES >= 30);
  const { holdout } = splitExamples(many(MIN_EXAMPLES));
  assert.ok(holdout.length >= 10, "the holdout alone has to be big enough to grade on");
});

test("a one-line rule with // comments is repaired rather than failing to parse", () => {
  // Measured on the free design model: it returned a CORRECT root-domain rule with its indentation
  // intact and every newline stripped, plus three // comments. On one line a line comment runs to the
  // end, so the whole rest of the function was dead and it failed with "Unexpected token ')'". The
  // report would then have said "this column is doing something a rule cannot reproduce", which is
  // the opposite of true.
  const broken =
    "function transform(row) {  const url = row.website;  // Remove protocol  " +
    "let s = url.split('://')[1] || url;  // Trim path  return s.split('/')[0];}";
  assert.throws(() => new Function(broken), "the original must genuinely not parse");
  const fixed = repairOneLineComments(broken);
  assert.doesNotThrow(() => new Function(fixed));
  assert.equal((new Function(`${fixed} return transform({website:"https://www.acme.com/x"});`))(), "www.acme.com");
});

test("code that already has newlines is left exactly alone", () => {
  const fine = "function transform(row) {\n  // fine here\n  return row.a;\n}";
  assert.equal(repairOneLineComments(fine), fine);
});

test("code with no comments is left exactly alone", () => {
  const fine = "function transform(row) { return row.a; }";
  assert.equal(repairOneLineComments(fine), fine);
});

test("a // inside a string is not a comment", () => {
  // The first version of the repair was a regular expression, and it mangled the very rule that
  // prompted the fix: url.split('://') contains //, so every protocol string was rewritten into a
  // block comment and the code failed with "Unexpected token '*'". Telling a comment from a protocol
  // needs to know whether you are inside a quote.
  const code = "function transform(row) {  const s = row.website.split('://')[1] || row.website;  // strip path  return s.split('/')[0];}";
  const fixed = repairOneLineComments(code);
  assert.ok(fixed.includes("'://'"), "the protocol string must survive untouched");
  assert.doesNotThrow(() => new Function(fixed));
  assert.equal(
    (new Function(`${fixed} return transform({website:"https://acme.com/pricing"});`))(),
    "acme.com",
  );
});

test("an escaped quote does not end the string it is inside", () => {
  // Built with String.fromCharCode for the backslash rather than written as an escape, because the
  // first version of this test escaped it wrongly, fed the scanner code that was not valid
  // JavaScript, and then blamed the scanner for the parse error.
  const BS = String.fromCharCode(92);
  const code = `function transform(row) {  const q = 'it${BS}'s // not a comment';  return q;}`;
  assert.doesNotThrow(() => new Function(code), "the fixture itself must be valid JavaScript");

  const fixed = repairOneLineComments(code);
  assert.doesNotThrow(() => new Function(fixed));
  assert.equal((new Function(`${fixed} return transform({});`))(), "it's // not a comment");
});
