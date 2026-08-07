import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEnumValues, MAX_ENUM_VALUES } from "./enumValues.ts";

// The list that decides what a valid answer is. A duplicate spelling or a blank slipping through
// here silently changes the constraint, so each cleaning rule is pinned.

test("a plain list is kept in order", () => {
  assert.deepEqual(normalizeEnumValues(["Small", "Medium", "Large"]).values, ["Small", "Medium", "Large"]);
});

test("null and undefined mean no constraint, not an error", () => {
  assert.deepEqual(normalizeEnumValues(null), { values: [] });
  assert.deepEqual(normalizeEnumValues(undefined), { values: [] });
});

test("a non-array is refused so the caller can answer 400", () => {
  assert.equal(normalizeEnumValues("Small,Medium").error !== undefined, true);
  assert.equal(normalizeEnumValues(42).error !== undefined, true);
  assert.deepEqual(normalizeEnumValues("x").values, []);
});

test("blanks and whitespace-only entries are dropped, and each is trimmed", () => {
  assert.deepEqual(normalizeEnumValues(["  A ", "", "   ", "B"]).values, ["A", "B"]);
});

test("case-insensitive duplicates collapse, keeping the FIRST spelling", () => {
  // The first spelling is the one the model is told and coercion stores, so it must win.
  assert.deepEqual(normalizeEnumValues(["Biotech", "biotech", "BIOTECH", "Pharma"]).values, ["Biotech", "Pharma"]);
});

test("non-string entries are skipped, not stringified", () => {
  assert.deepEqual(normalizeEnumValues(["A", 3, null, { x: 1 }, "B"]).values, ["A", "B"]);
});

test("an over-long list keeps the first MAX and drops the rest rather than failing", () => {
  const many = Array.from({ length: MAX_ENUM_VALUES + 50 }, (_, i) => `opt${i}`);
  const out = normalizeEnumValues(many);
  assert.equal(out.error, undefined);
  assert.equal(out.values.length, MAX_ENUM_VALUES);
  assert.equal(out.values[0], "opt0");
});

test("the cap counts DISTINCT options, so duplicates do not eat the budget", () => {
  const withDupes = ["keep", "keep", "keep", "second"];
  assert.deepEqual(normalizeEnumValues(withDupes).values, ["keep", "second"]);
});
