// The design model, and the promise that designing cannot cost money when you say it must not.
//
// The free-only guard is the only thing in the product that makes "pressing this button cannot
// produce a charge" a fact rather than an intention, so it is tested as a guard: what it lets
// through, what it refuses, and — the case that matters most — what it does when it cannot tell.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCatalog, seedCatalog } from "../providers/catalog.ts";
import { getSetupSettings, setSetupSettings, resolveSetupProvider, NotFreeError, estimateSetupCost } from "./setupModel.ts";
import { saveProviderKey, deleteProviderKey } from "../providers/keys.ts";
import { setDefaultModelSetting } from "../providers/resolve.ts";
import { saveSecret } from "../secrets.ts";

/**
 * A key of the shape the store insists on. Not a real credential and never sent anywhere — these
 * tests never reach a provider; they stop at the decision about whether one may be reached.
 */
const FAKE_KEY = `sk-or-v1-${"0".repeat(64)}`;

/**
 * Seed the price cache the guard reads.
 *
 * Seeded rather than fetched so that whether these tests pass never depends on a network call, and
 * so the unpriced case can be exercised at all — OpenRouter's real list has no permanently unpriced
 * entry to point at.
 */
function primeCatalog() {
  const models = parseCatalog({
    data: [
      { id: "free/model", name: "Free", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
      { id: "paid/model", name: "Paid", pricing: { prompt: "0.0000005", completion: "0.0000015" }, supported_parameters: ["tools"] },
      // OpenRouter's "price varies" sentinel. Read as zero, it would rank as the cheapest thing
      // on the list — which is why an unpriced model is refused rather than assumed free.
      { id: "auto/router", name: "Router", pricing: { prompt: "-1", completion: "-1" } },
    ],
  });
  assert.equal(models.length, 3);
  seedCatalog(models);
}

test("free-only lets a genuinely free model through", async () => {
  primeCatalog();
  saveProviderKey("openrouter", FAKE_KEY);
  setSetupSettings({ model: "free/model", freeOnly: true });
  const out = await resolveSetupProvider();
  assert.equal(out.model, "free/model");
  assert.equal(out.free, true);
  deleteProviderKey("openrouter");
});

test("free-only refuses a paid model BEFORE the request is sent", async () => {
  saveProviderKey("openrouter", FAKE_KEY);
  setSetupSettings({ model: "paid/model", freeOnly: true });
  // The point of the guard is that it fires here rather than after a charge exists. A check that ran
  // on the response would be a receipt, not a guard.
  await assert.rejects(() => resolveSetupProvider(), (e: unknown) => {
    assert.ok(e instanceof NotFreeError);
    assert.match((e as Error).message, /is not a free model/);
    return true;
  });
  deleteProviderKey("openrouter");
});

test("a model whose price is unknown is refused, and says that is why", async () => {
  // "It costs money" and "we cannot tell whether it costs money" get different sentences, because
  // the second one looks like a bug until you are told the price list is the reason — and an
  // unpriced model is exactly where an unexpected charge would come from.
  saveProviderKey("openrouter", FAKE_KEY);
  setSetupSettings({ model: "not/in-the-list", freeOnly: true });
  await assert.rejects(() => resolveSetupProvider(), (e: unknown) => {
    assert.match((e as Error).message, /not in the model list/);
    return true;
  });
  deleteProviderKey("openrouter");
});

test("with the guard off, a paid model resolves and is honestly labelled not-free", async () => {
  saveProviderKey("openrouter", FAKE_KEY);
  setSetupSettings({ model: "paid/model", freeOnly: false });
  const out = await resolveSetupProvider();
  assert.equal(out.free, false);
  deleteProviderKey("openrouter");
});

test("a local model is free without needing the price list to say so", async () => {
  // It bills nothing by construction, so requiring a published price would make the one lane that is
  // free by definition unreachable whenever the catalogue is cold or unavailable.
  setSetupSettings({ model: "local:ollama/llama3", freeOnly: true });
  const out = await resolveSetupProvider();
  assert.equal(out.isLocal, true);
  assert.equal(out.free, true);
});

test("'auto' follows the workspace's chosen model, including a local one", async () => {
  // The case every other test in this file skipped, and the one everybody actually runs: setup.model
  // left at its default of "auto".
  //
  // "auto" has to mean the same thing here that it means on a column — follow whatever the workspace
  // was told to use. Resolving it to the hardcoded constant instead sends every design call to
  // OpenRouter, so somebody who set up a local AI, or saved a key for OpenAI or Anthropic directly,
  // is asked for an OpenRouter key by the assistant and has no idea why: they configured an AI, and
  // the app agrees they did, and still refuses.
  deleteProviderKey("openrouter");
  setDefaultModelSetting("local:ollama/llama3");
  setSetupSettings({ model: "auto", freeOnly: false });

  const out = await resolveSetupProvider();
  assert.equal(out.isLocal, true, "a local default must not be overridden by the hardcoded one");
  assert.equal(out.providerId, "local");
  assert.equal(out.free, true);

  setDefaultModelSetting("auto");
});

test("'auto' follows a chosen model on a directly-keyed provider", async () => {
  // Same fault, the hosted half: a key saved for Anthropic is a configured AI, and "auto" pointing
  // at an OpenRouter id asks for a second key that has nothing to do with it.
  primeCatalog();
  deleteProviderKey("openrouter");
  // "Anthropic" is the spec's secretName, which is how providerKeyFor finds it.
  saveSecret({ name: "Anthropic", value: "sk-ant-api03-" + "0".repeat(24) });
  setDefaultModelSetting("anthropic:claude-sonnet-4-5");
  setSetupSettings({ model: "auto", freeOnly: false });

  const out = await resolveSetupProvider();
  assert.equal(out.providerId, "anthropic");
  assert.equal(out.model, "claude-sonnet-4-5");

  setDefaultModelSetting("auto");
});

test("the setting survives a read, so what Settings shows is what runs", () => {
  setSetupSettings({ model: "free/model", freeOnly: true });
  assert.deepEqual(getSetupSettings(), { model: "free/model", freeOnly: true });
  setSetupSettings({ freeOnly: false });
  // A partial write leaves the other half alone rather than resetting it to a default.
  assert.deepEqual(getSetupSettings(), { model: "free/model", freeOnly: false });
});

test("an unpriced model is estimated as unknown, never as zero", () => {
  assert.equal(estimateSetupCost("not/in-the-list"), null);
  assert.equal(estimateSetupCost("free/model"), 0);
  const paid = estimateSetupCost("paid/model");
  assert.ok(paid != null && paid > 0, "a paid model has to quote something above zero");
});
