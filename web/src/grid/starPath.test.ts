// Turning "this item's field" into "every item's field".
//
// Small enough to look correct and be wrong: the first version of this used `/^d+$/` — a lost
// backslash — which matches the literal letter d and therefore starred nothing at all. The panel
// still offered the action, still made the column, and the column came out empty on every row,
// because the path it stored was `contacts.0.email`. Nothing errored. That is exactly the shape of
// bug a test catches and a screenshot does not.

import { test } from "node:test";
import assert from "node:assert/strict";
import { starPath } from "./starPath.ts";

test("every array index becomes a star, and nothing else does", () => {
  assert.equal(starPath("contacts.0.email"), "contacts.*.email");
  assert.equal(starPath("0.email"), "*.email");
  assert.equal(starPath("results.2.people.7.name"), "results.*.people.*.name");

  // Object keys are names, never indices — including the ones that look numeric-adjacent.
  assert.equal(starPath("company.domain"), "company.domain");
  assert.equal(starPath("d.dd"), "d.dd");
  assert.equal(starPath("v2.address1"), "v2.address1");
  assert.equal(starPath("plan"), "plan");

  // Already starred stays starred, so re-deriving from a starred node is not a no-op that silently
  // reverts to index 0.
  assert.equal(starPath("contacts.*.email"), "contacts.*.email");
});

test("the truncation row's synthetic path survives starring, which is why nothing may act on it", () => {
  // JsonTree caps a long array and appends one honest "…N more items not shown" row at
  // `<prefix>.__more`. `__more` is not numeric, so it is NOT starred — the path stays a literal key
  // that no value has, and a column built from it resolved to undefined on every row. The panel's
  // per-leaf action rendered on that row for a while and offered exactly that column.
  //
  // starPath is right to leave it alone; the fix belongs upstream, and this records which half owns
  // it so nobody "fixes" it here by teaching starPath about a sentinel it should not know.
  assert.equal(starPath("contacts.__more"), "contacts.__more");
  assert.equal(starPath("results.0.people.__more"), "results.*.people.__more");
});
