import test from "node:test";
import assert from "node:assert/strict";
import { pricingVerdict } from "./pricingVerdict.ts";

// The rule that decides whether the Run button is alive. It used to give one answer to two different
// questions, so a briefly unreachable price list greyed out every paid column in the app under advice
// ("pick a model with a price") that nobody could act on.

test("a fully priced run is not blocked", () => {
  assert.deepEqual(
    pricingVerdict({ columns: [{}], incomplete: false, catalogueReachable: true }),
    { unpriced: false, blocked: false, unknownCatalogue: false },
  );
});

test("a column with no published price BLOCKS the run", () => {
  // The model is gone. Every row would fail, and only the user can fix it.
  const v = pricingVerdict({ columns: [{ unpriced: true }], incomplete: true, catalogueReachable: true });
  assert.equal(v.blocked, true);
  assert.equal(v.unknownCatalogue, false);
});

test("an unreachable price list does NOT block the run", () => {
  // Nothing is wrong with the column, and refusing every paid run because a price sheet timed out
  // is the worse failure of the two. It proceeds behind the typed confirmation instead.
  const v = pricingVerdict({ columns: [{ unpriced: true }], incomplete: true, catalogueReachable: false });
  assert.equal(v.blocked, false);
  assert.equal(v.unknownCatalogue, true);
  assert.equal(v.unpriced, true);
});

test("`incomplete` alone is enough, without a per-column flag", () => {
  // Read as well as the per-column flag so a future estimate that sets one without the other still
  // fails closed rather than pricing a run at zero.
  assert.equal(pricingVerdict({ columns: [], incomplete: true, catalogueReachable: true }).blocked, true);
});

test("a per-column flag alone is enough, without `incomplete`", () => {
  assert.equal(pricingVerdict({ columns: [{ unpriced: true }], incomplete: false }).blocked, true);
});

test("a missing catalogueReachable reads as reachable", () => {
  // An older engine does not send the field. It must not accidentally unlock the gate.
  const v = pricingVerdict({ columns: [{ unpriced: true }], incomplete: true });
  assert.equal(v.blocked, true);
  assert.equal(v.unknownCatalogue, false);
});

test("an unreachable catalogue on a run that priced fine changes nothing", () => {
  // Nothing came back unpriced, so there is nothing to warn about either way.
  assert.deepEqual(
    pricingVerdict({ columns: [{}], incomplete: false, catalogueReachable: false }),
    { unpriced: false, blocked: false, unknownCatalogue: false },
  );
});

test("no cost at all is not a block", () => {
  // The dialog is still resolving. Blocking here would mean the button is dead before there is any
  // reason to think it should be.
  assert.deepEqual(pricingVerdict(null), { unpriced: false, blocked: false, unknownCatalogue: false });
  assert.deepEqual(pricingVerdict(undefined), { unpriced: false, blocked: false, unknownCatalogue: false });
});
