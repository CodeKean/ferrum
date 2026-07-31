// Reading OpenRouter's price sheet.
//
// The whole file exists for one class of failure: a price that is not a price being read as zero.
// Nothing errors when that happens — the picker ranks the model first, the estimate says $0.00, the
// Start gate that refuses an unpriced run never fires, and the per-cell cap can never trip. Every
// one of those surfaces trusts these two booleans, so they are asserted directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { blended, parseCatalog } from "./catalog.ts";

/** The shape the live catalogue returns, trimmed to the fields that are read. */
const payload = (models: Array<Record<string, unknown>>) => ({ data: models });

const model = (id: string, prompt: unknown, completion: unknown, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  pricing: { prompt, completion, ...(extra.pricing as object ?? {}) },
  context_length: 128_000,
  supported_parameters: ["tools"],
  ...extra,
});

test("per-token strings become dollars per million, once", () => {
  // The conversion nobody may get wrong by 10^6: $0.00000015/token is $0.15 per million.
  const [m] = parseCatalog(payload([model("openai/gpt-4o-mini", "0.00000015", "0.0000006")]));
  assert.equal(m!.inputPerM, 0.15);
  assert.equal(m!.outputPerM, 0.6);
  assert.equal(m!.priced, true);
  assert.equal(m!.free, false);
});

test("the -1 'price varies' sentinel is NOT a price, and is not free", () => {
  // OpenRouter publishes -1 on its auto-routers, meaning "whatever model this request lands on".
  // Read as zero it made two tool-capable paid models rank as the cheapest things on the list.
  const [m] = parseCatalog(payload([model("openrouter/auto", "-1", "-1")]));
  assert.equal(m!.priced, false, "a negative price is no price");
  assert.equal(m!.free, false, "and it is certainly not free");
});

test("an absent or unreadable price is refused the same way", () => {
  const models = parseCatalog(payload([
    model("a/missing", undefined, undefined),
    model("b/text", "cheap!", "cheap!"),
    model("c/half", "0.000001", undefined),
  ]));
  for (const m of models) {
    assert.equal(m.priced, false, `${m.id} must not claim a price`);
    assert.equal(m.free, false, `${m.id} must not claim to be free`);
  }
});

test("free means both prices are LITERALLY zero", () => {
  const [m] = parseCatalog(payload([model("meta/free-thing", "0", "0")]));
  assert.equal(m!.priced, true);
  assert.equal(m!.free, true);
});

test("unpriced models sort last, never at the top of a list headed 'cheapest'", () => {
  const models = parseCatalog(payload([
    model("z/unpriced", "-1", "-1"),
    model("y/dear", "0.000015", "0.000075"),
    model("x/cheap", "0.00000005", "0.0000002"),
  ]));
  assert.deepEqual(models.map((m) => m.id), ["x/cheap", "y/dear", "z/unpriced"]);
  // Its blended figure IS zero — which is exactly why the comparator cannot be left to decide.
  assert.equal(blended(models[2]!), 0);
});

test("the published web-search rate is kept, because it is not one flat number", () => {
  const models = parseCatalog(payload([
    model("google/gemini-flash", "0.0000001", "0.0000004", { pricing: { web_search: "0.014" } }),
    model("openai/plain", "0.0000001", "0.0000004"),
  ]));
  // $0.014 a call against the $0.005 the estimate used to hardcode — nearly three times over, on the
  // lane where a single call costs more than a thousand tokens do.
  assert.equal(models.find((m) => m.id === "google/gemini-flash")!.webSearchPerCall, 0.014);
  assert.equal(models.find((m) => m.id === "openai/plain")!.webSearchPerCall, null);
});

test("tool support is read from the parameter list, since only those models drive the agent lane", () => {
  const models = parseCatalog(payload([
    model("with/tools", "0.000001", "0.000001"),
    model("without/tools", "0.000001", "0.000001", { supported_parameters: ["temperature"] }),
  ]));
  assert.equal(models.find((m) => m.id === "with/tools")!.tools, true);
  assert.equal(models.find((m) => m.id === "without/tools")!.tools, false);
});

test("an entry with no id is dropped rather than becoming a nameless model", () => {
  assert.equal(parseCatalog(payload([{ name: "orphan", pricing: { prompt: "0.1" } }])).length, 0);
  assert.deepEqual(parseCatalog({ notData: true }), []);
});
