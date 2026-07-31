// The cost model behind the mode picker.
//
// These are estimates, and the tests do not pin the exact dollars — they pin the things the picker's
// advice depends on. If a rule stopped reading as free, or web search stopped reading as an order of
// magnitude above a plain model call, the screen would still render and would be quietly giving the
// opposite advice from the one it is there to give.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_SEARCH_CEILING, AGENT_TYPICAL_SEARCHES, basisFor, designCost, estimateForKind, priceLabel,
  ratio, searchCostUsd, usd,
} from "./cost.ts";

// A rate has to be handed in. Hardcoding gpt-4o-mini and applying it to every
// column whatever model that column actually ran on, so the figure on screen was a real number for
// a model nobody had chosen. These are gpt-4o-mini's published rates, kept here so the ratios below
// stay the ones the picker's advice was calibrated against.
const RATE = { label: "GPT-4o mini", inputPerM: 0.15, outputPerM: 0.6 };
const basis = basisFor(5, RATE);

test("a rule and a typed-in column cost nothing per row", () => {
  for (const kind of ["static", "script", "send"]) {
    assert.equal(estimateForKind(kind, 1_000_000, basis).total, 0, `${kind} must not be priced per row`);
    assert.equal(estimateForKind(kind, 1_000_000, basis).external, false, `${kind} bills nobody`);
  }
});

test("an http or mcp column totals nothing and is still not free", () => {
  // The two are different statements and the card must make the right one. "Call an API" badged
  // badged FREE while its own detail text on the same card said "Costs whatever that service
  // charges". The run confirmation reads the server's estimate, which flags these external and
  // refuses to call them free — so the card that sells the lane was contradicting the screen that
  // approves it. Zero here means "no rate is knowable", never "no money changes hands".
  for (const kind of ["http", "mcp"]) {
    const est = estimateForKind(kind, 1_000_000, basis);
    assert.equal(est.total, 0, `${kind} must not invent a rate`);
    assert.equal(est.external, true, `${kind} bills a third party per row`);
  }
});

test("web search is an order of magnitude above reading the row", () => {
  const ai = estimateForKind("ai", 1000, basis).total;
  const agent = estimateForKind("agent", 1000, basis).total;

  assert.ok(ai > 0, "a model call is not free");
  // The whole argument the picker makes. Anything under 10x and the warning is overstating the case.
  assert.ok(agent / ai > 10, `expected >10x, got ${(agent / ai).toFixed(1)}x`);
});

test("the estimate scales linearly with the sheet", () => {
  const one = estimateForKind("agent", 1, basis).total;
  const many = estimateForKind("agent", 250_000, basis).total;
  assert.ok(Math.abs(many - one * 250_000) < 1e-6);
});

test("more results per search costs more", () => {
  // Exa charges per result beyond ten, so a column set to 30 results is not the same column.
  assert.ok(searchCostUsd(30) > searchCostUsd(5));
  assert.equal(searchCostUsd(5), searchCostUsd(10), "the first ten are included");
});

test("money reads cleanly at both ends of the range", () => {
  // A per-row figure that rounded to "$0.00" would make an expensive lane look free.
  assert.notEqual(usd(estimateForKind("ai", 1, basis).perRow), "$0.00");
  assert.equal(usd(0), "$0");
  assert.equal(usd(7123.4), "$7,123");
});

test("the ratio is stated, not divided by zero", () => {
  assert.equal(ratio(5, 0), "far more than");
  assert.equal(ratio(90, 1), "90x");
  assert.equal(ratio(1.5, 1), "1.5x");
});

test("no rate yet means no price, not a borrowed one", () => {
  // The catalogue is fetched, so the first render happens before any rate is known. The honest
  // answer there is "—", which is what `priced: false` tells the caller to draw. Filling the gap
  // with some other model's rate is the failure this guards: it reads as authoritative and is wrong
  // by multiples, which is worse than an em dash.
  const unpriced = basisFor(5, null);
  assert.equal(unpriced.priced, false);
  assert.equal(estimateForKind("ai", 1000, unpriced).total, 0);
});

test("a model on this machine bills nothing, search included", () => {
  // The engine prices a local model at zero. If this disagreed, the mode card would quote dollars
  // for a column the run confirmation then calls free — and the two screens are one decision.
  const local = basisFor(30, { label: "Llama 3.1 8B", inputPerM: 0.15, outputPerM: 0.6, local: true });
  assert.equal(local.local, true);
  assert.equal(local.searchPerCall, 0, "a local run does not start paying at the search");
  assert.equal(estimateForKind("ai", 1_000_000, local).total, 0);
  // Still "priced": a known-free model is an answer, not a missing one.
  assert.equal(local.priced, true);
});

// ── what a single design call costs, in words ──────────────────────────────────────────────────
//
// Its own group because the distinction it draws has been got wrong twice in one day, in two
// different components, the same way each time: a lane that bills nothing rendered as an approximate
// zero. "≈ $0.00" on the run strip, "about 0.00¢" in the setup panel. Both read as a small charge
// rounded down, and both sat beside something saying the opposite — a confirmation reading "free",
// a model whose id ends in ":free".

test("a design call that billed nothing says free, not an approximate zero", () => {
  // Measured: a proposal from nvidia/nemotron-nano-12b-v2-vl:free reported "about 0.00¢". Nothing
  // was charged, and rounding nothing to a currency amount invents a charge.
  assert.equal(designCost(0), "free");
});

test("an unknown price stays blank rather than being rounded to free", () => {
  // Null is what the engine returns for a model absent from the published list. "Free" would be the
  // reassuring answer and the wrong one — an unpriced model is exactly where a surprise comes from.
  assert.equal(designCost(null), null);
});

test("a real cost below a cent reads in cents, and never as free", () => {
  assert.equal(designCost(0.0004), "about 0.04¢");
  assert.notEqual(designCost(0.000001), "free");
});

test("a cost of a cent or more reads in dollars", () => {
  assert.equal(designCost(0.0145), "about $0.015");
  assert.equal(designCost(1.5), "about $1.500");
});

// ─────────────────────────────────────────────────────── the price a card shows
//
// The bug these pin: on a sheet with NO ROWS, every per-row lane multiplied out to exactly zero, and
// zero rendered as "free" — so the web-searching agent, the most expensive thing in the product, sat
// on screen badged free and coloured green, beside a rule that genuinely is.
//
// It is not a rounding error. An empty table is the NORMAL state of this screen: columns get set up
// first and the rows are imported afterwards. So the one screen whose purpose is to stop someone
// picking the expensive lane by accident was telling them it cost nothing, at exactly the moment
// they were deciding.

const PAID = basisFor(5, { label: "test", inputPerM: 0.03, outputPerM: 0.13 });
const cardPrice = (kind: string, rows: number, basis = PAID) =>
  priceLabel(estimateForKind(kind, rows, basis), rows, {
    billsPerRow: kind === "ai" || kind === "agent",
    priced: basis.priced,
  });

test("an empty sheet never calls a paid lane free", () => {
  for (const kind of ["ai", "agent"]) {
    const p = cardPrice(kind, 0);
    assert.equal(p.free, false, `${kind} must not be styled as free on an empty sheet`);
    assert.notEqual(p.text, "free", `${kind} must not READ as free on an empty sheet`);
    assert.notEqual(p.text, "$0");
    assert.match(p.text, /\/1k$/, `${kind} should quote a rate when there is no total to give`);
  }
});

test("the rate quoted on an empty sheet is a number a person can act on", () => {
  // Per THOUSAND, not per row: per row the model lane rounds to "$0.0000" and lands straight back
  // in the hole this came out of.
  assert.equal(cardPrice("ai", 0).text, "$0.02/1k");
  assert.equal(cardPrice("agent", 0).text, "$20.39/1k");
});

test("a lane that is genuinely free stays free at every size", () => {
  for (const rows of [0, 1, 1_000_000]) {
    for (const kind of ["static", "script", "lookup", "rollup", "send"]) {
      const p = cardPrice(kind, rows);
      assert.equal(p.text, "free", `${kind} at ${rows} rows`);
      assert.equal(p.free, true);
    }
  }
});

test("a lane billed by somebody else is never free and never a total", () => {
  for (const rows of [0, 3, 1_000_000]) {
    for (const kind of ["http", "mcp"]) {
      assert.equal(cardPrice(kind, rows).text, "their rate");
      assert.equal(cardPrice(kind, rows).free, false);
    }
  }
});

test("with rows, the card goes back to quoting the total for this sheet", () => {
  assert.equal(cardPrice("agent", 3).text, "$0.06");
  assert.equal(cardPrice("agent", 3).free, false);
});

test("an uncosted model reads as unknown, not as free", () => {
  // No rate supplied at all. "Free" is the reassuring answer and the wrong one — an unpriced model
  // is exactly where a surprise comes from, which is the same rule `designCost(null)` follows.
  const none = basisFor(5, null);
  assert.equal(cardPrice("ai", 0, none).text, "—");
  assert.equal(cardPrice("ai", 1000, none).text, "—");
  assert.equal(cardPrice("ai", 1000, none).free, false);
});

test("a local model is free at any size, because it truly bills nothing", () => {
  const local = basisFor(5, { label: "llama", inputPerM: 0, outputPerM: 0, local: true });
  assert.equal(cardPrice("ai", 0, local).text, "free");
  assert.equal(cardPrice("ai", 1_000_000, local).text, "free");
  assert.equal(cardPrice("ai", 1_000_000, local).free, true);
});

// ─────────────────────────────────────────────────────── the card must agree with the engine
//
// Two estimators price the same agent row: this card, before the column exists, and
// `src/estimate.ts`, on the run confirmation that actually gates the spend. They are allowed to
// differ in ONE direction and for one reason — the engine measures how much of each row the prompt
// carries, so it reads higher on a wide sheet. Anything else is the two screens contradicting each
// other about the same column, which is how someone ends up arguing with a number.
//
// The engine's rule for a search-enabled agent column is `min(turnsFor(col), MAX_TOOL_CALLS)`, and
// turns default to the schema's `max_turns` of 4. This card priced a flat 16 — four times the
// engine's figure for a column nobody had configured — and, separately, contradicted its own token
// shape, which is annotated for three turns.

test("the searches priced per agent row match what the engine would quote by default", () => {
  // Mirrors src/estimate.ts: min(turnsFor(col), MAX_TOOL_CALLS) with max_turns defaulting to 4.
  const ENGINE_DEFAULT_TURNS = 4;
  assert.equal(AGENT_TYPICAL_SEARCHES, Math.min(ENGINE_DEFAULT_TURNS, AGENT_SEARCH_CEILING));
});

test("the agent row is priced at the same number of turns its token shape assumes", () => {
  // The bug in one assertion: the searches were counted at the ceiling while the tokens were counted
  // at a handful of turns, so one hypothetical row was costed two different ways at once.
  assert.ok(AGENT_TYPICAL_SEARCHES < AGENT_SEARCH_CEILING, "the ceiling is not the typical case");
  assert.ok(AGENT_TYPICAL_SEARCHES >= 1);
});

test("web search still reads as the expensive lane, by a wide margin", () => {
  // The correction must not swing so far that it stops doing its job. The whole point of this
  // screen is that the gap between reading the row and searching the web is enormous.
  const ai = estimateForKind("ai", 1000, PAID).total;
  const agent = estimateForKind("agent", 1000, PAID).total;
  assert.ok(agent / ai > 100, `web search should still be orders of magnitude dearer, got ${agent / ai}x`);
});

test("almost all of the agent figure is searches, not words", () => {
  // Worth pinning because it decides which control someone should reach for. Tuning a prompt saves
  // hundredths of a cent here; turning the search tool off, or lowering the turn limit, is what
  // actually moves the number — and the footer says so.
  const withSearch = estimateForKind("agent", 1000, PAID).total;
  const wordsOnly = estimateForKind("agent", 1000, { ...PAID, searchPerCall: 0 }).total;
  assert.ok(wordsOnly / withSearch < 0.05, "the words are a rounding error next to the searches");
});
