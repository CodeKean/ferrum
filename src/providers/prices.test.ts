// A price the user typed.
//
// Worth testing carefully because every mistake here is silent and large. A scale read wrong is a
// factor of a thousand — on a million-row column, $20 against $20,000. A missing price read as zero
// is a per-cell limit that never fires. Cached tokens counted twice overstates the one workload this
// app is built for, where the same instruction is sent a million times.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  deletePrice, modelPricePerMillion, priceTokens, pricesFor, savePrice, toPerMillion, typedPrice,
} from "./prices.ts";

/**
 * A REAL provider id, because a price is found by mapping a model id back to its provider — and
 * `splitModelId` only recognises registered ones. A made-up id resolves to OpenRouter and can never
 * find the price stored under it, so testing with one would test nothing.
 *
 * AI21 is the least likely of the twenty-one to be in use. Anything already stored under it is saved
 * and put back, so running the suite cannot cost someone a price they typed.
 */
const P = "ai21";
const saved = typedPrice(`${P}:__none__`);
const clean = () => { deletePrice(P); deletePrice(P, "big"); deletePrice(P, "small"); };

after(() => {
  clean();
  if (saved) savePrice({ provider: P, input: saved.input, output: saved.output, cachedInput: saved.cachedInput, scale: saved.scale, note: saved.note });
});

// ── the scale ───────────────────────────────────────────────────────────────

test("per-million is stored as typed", () => {
  clean();
  savePrice({ provider: P, input: 3, output: 15, scale: 1_000_000 });
  const m = modelPricePerMillion(`${P}:anything`)!;
  assert.equal(m.inputPerM, 3);
  assert.equal(m.outputPerM, 15);
  assert.equal(m.source, "typed");
  clean();
});

test("per-thousand is converted, because getting this wrong is a factor of a thousand on the bill", () => {
  clean();
  // "$0.003 per 1K input" is the same rate as "$3.00 per 1M". A vendor quoting the small scale must
  // not end up priced a thousand times cheaper than one quoting the large one.
  savePrice({ provider: P, input: 0.003, output: 0.015, scale: 1_000 });
  const m = modelPricePerMillion(`${P}:anything`)!;
  assert.equal(m.inputPerM, 3);
  assert.equal(m.outputPerM, 15);
  clean();
});

test("an unrecognised stored scale is read as per-million rather than refused", () => {
  // Refusing would return no price, which silently disables any per-cell limit — worse than picking
  // the scale every vendor leads with.
  assert.equal(toPerMillion({ input: 3, output: 15, scale: 7 as any, updatedAt: "" }).inputPerM, 3);
});

// ── which price wins ────────────────────────────────────────────────────────

test("a per-model price beats the provider-wide one", () => {
  clean();
  savePrice({ provider: P, input: 1, output: 1, scale: 1_000_000 });
  savePrice({ provider: P, model: "big", input: 15, output: 75, scale: 1_000_000 });
  // Opus is roughly fifteen times Haiku. One shared number would be wrong in whichever direction the
  // other model ran, so this is not a nicety.
  assert.equal(modelPricePerMillion(`${P}:big`)!.inputPerM, 15);
  assert.equal(modelPricePerMillion(`${P}:small`)!.inputPerM, 1, "falls back to the provider price");
  clean();
});

test("no price typed and none published means null, never zero", () => {
  clean();
  // Zero would report a paid run as free and let a per-cell limit pass every row.
  assert.equal(modelPricePerMillion(`${P}:anything`), null);
  assert.equal(priceTokens(`${P}:anything`, { inputTokens: 1e6, outputTokens: 1e6 }), null);
});

test("deleting a per-model price falls back rather than leaving the model unpriced", () => {
  clean();
  savePrice({ provider: P, input: 2, output: 2, scale: 1_000_000 });
  savePrice({ provider: P, model: "big", input: 20, output: 20, scale: 1_000_000 });
  deletePrice(P, "big");
  assert.equal(modelPricePerMillion(`${P}:big`)!.inputPerM, 2);
  clean();
});

// ── the arithmetic ──────────────────────────────────────────────────────────

test("tokens are priced from the two rates separately", () => {
  clean();
  savePrice({ provider: P, input: 3, output: 15, scale: 1_000_000 });
  // 1M in at $3 + 0.5M out at $15 = $3 + $7.50.
  assert.equal(priceTokens(`${P}:x`, { inputTokens: 1_000_000, outputTokens: 500_000 }), 10.5);
  clean();
});

test("a cached token is billed once, at the cache rate — not twice", () => {
  clean();
  savePrice({ provider: P, input: 3, output: 15, cachedInput: 0.3, scale: 1_000_000 });
  // Providers report cached tokens as a SUBSET of the input count. Adding both would charge the same
  // tokens twice; charging all of them at full input rate would overstate this app's whole workload,
  // where one instruction is re-sent a million times.
  const usd = priceTokens(`${P}:x`, { inputTokens: 1_000_000, cachedInputTokens: 900_000, outputTokens: 0 })!;
  // 100k fresh at $3/M = $0.30, 900k cached at $0.30/M = $0.27.
  assert.ok(Math.abs(usd - 0.57) < 1e-9, `expected 0.57, got ${usd}`);
  clean();
});

test("no cache rate means cached tokens cost full price, not free", () => {
  clean();
  savePrice({ provider: P, input: 3, output: 0, scale: 1_000_000 });
  // Assuming an unstated discount would understate the bill, which is the wrong way to be wrong.
  assert.equal(priceTokens(`${P}:x`, { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 }), 3);
  clean();
});

test("more cached tokens than input tokens cannot make a call cheaper than free", () => {
  clean();
  savePrice({ provider: P, input: 3, output: 0, cachedInput: 0, scale: 1_000_000 });
  // A provider reporting an inconsistent pair must not produce a negative fresh-token count, which
  // would subtract from the run total and corrupt every figure above it.
  const usd = priceTokens(`${P}:x`, { inputTokens: 1000, cachedInputTokens: 999_999, outputTokens: 0 })!;
  assert.ok(usd >= 0, `a call cannot cost less than nothing: ${usd}`);
  clean();
});

// ── refusals ────────────────────────────────────────────────────────────────

test("an empty form is refused, because a stored zero reports every run as free", () => {
  clean();
  assert.throws(() => savePrice({ provider: P, input: 0, output: 0, scale: 1_000_000 }), /zero/i);
  assert.equal(typedPrice(`${P}:x`), null, "and nothing is stored");
});

test("one rate is enough — some models charge for output only", () => {
  clean();
  savePrice({ provider: P, input: 0, output: 15, scale: 1_000_000 });
  assert.equal(modelPricePerMillion(`${P}:x`)!.outputPerM, 15);
  clean();
});

test("a price with no provider is refused", () => {
  assert.throws(() => savePrice({ provider: "  ", input: 1, output: 1, scale: 1_000_000 }), /provider/i);
});

test("negative rates are read as zero rather than credited back", () => {
  clean();
  savePrice({ provider: P, input: -5, output: 15, scale: 1_000_000 });
  assert.equal(modelPricePerMillion(`${P}:x`)!.inputPerM, 0);
  clean();
});

// ── listing ─────────────────────────────────────────────────────────────────

test("prices list back per provider, with model overrides separate", () => {
  clean();
  savePrice({ provider: P, input: 1, output: 1, scale: 1_000_000 });
  savePrice({ provider: P, model: "big", input: 9, output: 9, scale: 1_000_000 });
  const got = pricesFor(P);
  assert.equal(got.provider?.input, 1);
  assert.deepEqual(got.models.map((m) => m.model), ["big"]);
  clean();
});

test("one provider's prices do not leak into another's list", () => {
  clean();
  savePrice({ provider: P, model: "big", input: 9, output: 9, scale: 1_000_000 });
  assert.equal(pricesFor("zz-other-provider").models.length, 0);
  clean();
});

test("a model id containing an underscore is not matched by a wildcard", () => {
  // `_` is a single-character wildcard in SQL LIKE. Unescaped, a lookup for one model would return
  // another model's price — and the user would never know their column was priced off the wrong row.
  clean();
  savePrice({ provider: P, model: "gpt_4", input: 7, output: 7, scale: 1_000_000 });
  const listed = pricesFor(P).models.map((m) => m.model);
  assert.deepEqual(listed, ["gpt_4"]);
  deletePrice(P, "gpt_4");
  clean();
});
