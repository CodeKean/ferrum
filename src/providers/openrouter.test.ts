// Turning the UI's search settings into OpenRouter's plugin block.
//
// Worth testing on its own because the failure mode is silent: a misnamed or wrongly-shaped field is
// ignored by the API, the search runs unfiltered, and the results look perfectly plausible. Nothing
// errors. The user believes they restricted the search to a domain and acts on results that came
// from anywhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { webPlugin, searchCostUsd, DEFAULT_SEARCH_SETTINGS, ENGINE_SUPPORT, SEARCH_ENGINES, normalizeAgentSettings } from "./openrouter.ts";

test("defaults produce a minimal block, so OpenRouter applies its own", () => {
  assert.deepEqual(webPlugin(), { id: "web", max_results: 5 });
});

test("an unset option is OMITTED, never sent as empty", () => {
  const p = webPlugin({ includeDomains: [], excludeDomains: [], searchPrompt: "   " });
  // `include_domains: []` is ambiguous on the wire — "no restriction" and "restrict to nothing" are
  // indistinguishable, and which one a backend picks is not ours to guess.
  assert.ok(!("include_domains" in p));
  assert.ok(!("exclude_domains" in p));
  assert.ok(!("search_prompt" in p), "a whitespace-only prompt is not a prompt");
});

test("domain filters use the exact field names the API expects", () => {
  const p = webPlugin({ includeDomains: ["acme.com", "*.substack.com"], excludeDomains: ["linkedin.com"] });
  assert.deepEqual(p.include_domains, ["acme.com", "*.substack.com"]);
  assert.deepEqual(p.exclude_domains, ["linkedin.com"]);
});

test("engine 'auto' is expressed by saying nothing", () => {
  assert.ok(!("engine" in webPlugin({ engine: "auto" })));
  assert.equal(webPlugin({ engine: "exa" }).engine, "exa");
});

test("context size is nested where the API wants it, and only for native search", () => {
  // It lives under web_search_options, one level deeper than every other option.
  assert.deepEqual(webPlugin({ engine: "native", contextSize: "high" }).web_search_options, {
    search_context_size: "high",
  });
  // Sent to Exa it would be ignored, so it is not sent — a setting that travels but does nothing is
  // how a user ends up believing they configured something they did not.
  assert.ok(!("web_search_options" in webPlugin({ engine: "exa", contextSize: "high" })));
});

test("every engine has a support entry, so the UI can always say what applies", () => {
  for (const e of SEARCH_ENGINES) {
    assert.ok(ENGINE_SUPPORT[e], `${e} needs a support entry`);
  }
  // Native is the constrained one: the model provider does its own filtering and they disagree with
  // each other, so the UI warns rather than promising both filters work.
  assert.equal(ENGINE_SUPPORT.native.domains, "exclusive");
  assert.equal(ENGINE_SUPPORT.native.contextSize, true);
  assert.equal(ENGINE_SUPPORT.exa.contextSize, false);
});

test("search cost follows the published tiers", () => {
  assert.equal(searchCostUsd(5), 0.005);
  assert.equal(searchCostUsd(10), 0.005);
  assert.equal(Number(searchCostUsd(15).toFixed(3)), 0.01); // 5 extra results at $0.001
});

test("the defaults are the ones a first-time user should get", () => {
  assert.equal(DEFAULT_SEARCH_SETTINGS.engine, "auto");
  assert.equal(DEFAULT_SEARCH_SETTINGS.maxResults, 5);
  assert.equal(DEFAULT_SEARCH_SETTINGS.contextSize, null);
});

// ── the two per-cell ceilings ───────────────────────────────────────────────────────────────────
//
// These were edited in the Search tab and read by the executor, and this function sat between them
// dropping both. The save round-tripped, the form re-seeded from the answer, and the numbers you had
// just typed reverted in front of you. Every assertion below is that round trip.

test("the per-cell ceilings survive a save", () => {
  const out = normalizeAgentSettings({ search: { maxSpendUsd: 0.25, maxSearches: 6 } });
  assert.equal(out.search.maxSpendUsd, 0.25);
  assert.equal(out.search.maxSearches, 6);
});

test("absent is not zero: an untouched column keeps reaching the defaults", () => {
  // The executor reads absent as "use the default" and 0 as "the user turned the ceiling off". If
  // this emitted 0 for an absent value, every column that never opened the Search tab would silently
  // lose its ceiling.
  const out = normalizeAgentSettings({ search: {} });
  assert.ok(!("maxSpendUsd" in out.search));
  assert.ok(!("maxSearches" in out.search));
});

test("zero is carried through, because zero means the user turned the ceiling off", () => {
  const out = normalizeAgentSettings({ search: { maxSpendUsd: 0, maxSearches: 0 } });
  assert.equal(out.search.maxSpendUsd, 0);
  assert.equal(out.search.maxSearches, 0);
});

test("a nonsense ceiling is refused, not clamped", () => {
  assert.throws(() => normalizeAgentSettings({ search: { maxSpendUsd: -1 } }), /zero or more/);
  assert.throws(() => normalizeAgentSettings({ search: { maxSearches: 2.5 } }), /whole number/);
  assert.throws(() => normalizeAgentSettings({ search: { maxSearches: 99 } }), /between 0 and 16/);
});

test("the ceilings never reach OpenRouter's plugin block", () => {
  // They govern how many times we call the search, not how the search behaves once called. A field
  // OpenRouter does not know is ignored silently, which is the failure this file exists to catch.
  const p = webPlugin({ maxSpendUsd: 0.25, maxSearches: 6 });
  assert.ok(!("maxSpendUsd" in p));
  assert.ok(!("maxSearches" in p));
  assert.ok(!("max_spend_usd" in p));
});
