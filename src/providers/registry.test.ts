// Which provider gets the call, and what it is sent.
//
// Both halves fail quietly rather than loudly, which is why they are tested rather than eyeballed:
//
//   a misread id sends the call to the WRONG VENDOR with the wrong key — a 401 that reads like a bad
//   key rather than a routing bug, on a provider the user never chose;
//
//   a wrong Anthropic body produces a loop that runs, bills, and never calls a tool. That looks
//   exactly like a model being incapable, and the natural response is to pay for a bigger one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { LLM_PROVIDERS, llmProvider, qualifyModelId, splitModelId } from "./registry.ts";
import { toWire } from "./anthropic.ts";

// ── the id ──────────────────────────────────────────────────────────────────

test("an unprefixed id still means OpenRouter, so nothing already stored has to be rewritten", () => {
  // Every model id in every existing workbook is this shape. If it stopped meaning OpenRouter, every
  // AI column in the product would break at once on upgrade.
  assert.deepEqual(splitModelId("openai/gpt-oss-20b"), { provider: "openrouter", model: "openai/gpt-oss-20b" });
  assert.deepEqual(splitModelId("anthropic/claude-sonnet-4"), {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4",
  });
});

test("a known prefix routes direct, and the prefix is stripped before it goes on the wire", () => {
  assert.deepEqual(splitModelId("anthropic:claude-sonnet-4"), { provider: "anthropic", model: "claude-sonnet-4" });
  assert.deepEqual(splitModelId("groq:llama-3.3-70b"), { provider: "groq", model: "llama-3.3-70b" });
  // Sending `anthropic:claude-sonnet-4` as the model name is a 404 from every one of these APIs.
  assert.equal(splitModelId("mistral:mistral-large").model, "mistral-large");
});

test("an UNKNOWN prefix is part of the model name, not a routing instruction", () => {
  // The safe direction. Guessing that `foo:bar` means a provider called foo would send the call
  // nowhere; treating it as a model name sends it to OpenRouter, which answers or 404s honestly.
  assert.deepEqual(splitModelId("foo:bar"), { provider: "openrouter", model: "foo:bar" });
});

test("a local model id is not claimed by the registry", () => {
  // `local:` is handled in local.ts, which probes for the runtime and vets its address. If the
  // registry claimed the prefix, that check would be skipped on the one lane advertised as private.
  assert.equal(splitModelId("local:ollama/llama3").provider, "openrouter");
  assert.equal(llmProvider("ollama"), null);
  assert.equal(llmProvider("lmstudio"), null);
});

test("qualifying and splitting are inverses, so a round trip through storage cannot drift", () => {
  for (const p of LLM_PROVIDERS) {
    const id = qualifyModelId(p.id, "some-model");
    assert.deepEqual(splitModelId(id), { provider: p.id, model: "some-model" }, `${p.id} does not round-trip`);
  }
});

test("blank and whitespace do not become a provider", () => {
  assert.equal(splitModelId("").provider, "openrouter");
  assert.equal(splitModelId("   ").model, "");
  // A leading colon has no provider before it, so it is a model name.
  assert.deepEqual(splitModelId(":x"), { provider: "openrouter", model: ":x" });
});

// ── the table ───────────────────────────────────────────────────────────────

test("every provider has an id, an address, a key name and a reason to exist", () => {
  for (const p of LLM_PROVIDERS) {
    assert.ok(p.label.trim(), `${p.id} needs a name`);
    assert.ok(p.note.trim(), `${p.id} needs a line saying what it is FOR — twenty names is not a choice`);
    assert.ok(p.secretName.trim(), `${p.id} needs somewhere to keep its key`);
    assert.ok(p.signupUrl.startsWith("https://"), `${p.id} needs somewhere to get a key`);
    assert.match(p.baseUrl, /^https:\/\//, `${p.id} must be reached over https`);
    // The adapter appends `/chat/completions` or `/messages` directly.
    assert.doesNotMatch(p.baseUrl, /\/$/, `${p.id} base url must not end in a slash`);
  }
});

test("ids, labels and key names are unique, so one cannot shadow another", () => {
  const ids = LLM_PROVIDERS.map((p) => p.id);
  const secrets = LLM_PROVIDERS.map((p) => p.secretName);
  assert.equal(new Set(ids).size, ids.length);
  // Two providers sharing a secret name means saving one key silently overwrites the other's.
  assert.equal(new Set(secrets).size, secrets.length);
});

test("only Anthropic needs its own adapter", () => {
  // The claim the whole design rests on: everything else is a base URL away from the shared adapter.
  // If a second `anthropic` kind appears without an adapter, the calls fail at runtime.
  const odd = LLM_PROVIDERS.filter((p) => p.kind !== "openai-compatible");
  assert.deepEqual(odd.map((p) => p.id), ["anthropic"]);
});

// ── the Anthropic body ──────────────────────────────────────────────────────

test("the system prompt is hoisted out of the messages, because a system ROLE is rejected", () => {
  const { system, msgs } = toWire([
    { role: "system", content: "Be terse." },
    { role: "user", content: "hello" },
  ]);
  assert.equal(system, "Be terse.");
  assert.deepEqual(msgs, [{ role: "user", content: "hello" }]);
  assert.ok(!msgs.some((m: any) => m.role === "system"), "a system message on the wire is a 400");
});

test("several system messages are joined rather than the last one winning", () => {
  const { system } = toWire([
    { role: "system", content: "Rule one." },
    { role: "system", content: "Rule two." },
    { role: "user", content: "hi" },
  ]);
  assert.equal(system, "Rule one.\n\nRule two.");
});

test("a tool call becomes a content block, not a sibling field", () => {
  const { msgs } = toWire([
    { role: "user", content: "look it up" },
    { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "web_search", args: { query: "acme" } }] },
  ]);
  const a = msgs[1];
  assert.equal(a.role, "assistant");
  assert.deepEqual(a.content, [{ type: "tool_use", id: "t1", name: "web_search", input: { query: "acme" } }]);
  assert.equal(a.tool_calls, undefined, "the OpenAI field here is read by nothing and confuses the API");
});

test("a tool RESULT goes back as a user turn, which is the difference between a working loop and a silent one", () => {
  const { msgs } = toWire([
    { role: "user", content: "look it up" },
    { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "web_search", args: {} }] },
    { role: "tool", toolCallId: "t1", name: "web_search", content: "results" },
  ]);
  assert.equal(msgs[2].role, "user");
  assert.deepEqual(msgs[2].content, [{ type: "tool_result", tool_use_id: "t1", content: "results" }]);
});

test("two results in a row are merged into ONE user turn, because two user turns in a row are rejected", () => {
  // A model that calls two tools in one turn is normal, and the results come back as two messages.
  const { msgs } = toWire([
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "t1", name: "a", args: {} }, { id: "t2", name: "b", args: {} }],
    },
    { role: "tool", toolCallId: "t1", name: "a", content: "one" },
    { role: "tool", toolCallId: "t2", name: "b", content: "two" },
  ]);
  assert.equal(msgs.length, 3, "the two results must not become two separate user turns");
  assert.equal(msgs[2].content.length, 2);
  assert.deepEqual(msgs[2].content.map((c: any) => c.tool_use_id), ["t1", "t2"]);
});

test("text and a tool call in the same assistant turn both survive", () => {
  const { msgs } = toWire([
    { role: "user", content: "go" },
    { role: "assistant", content: "Let me check.", toolCalls: [{ id: "t1", name: "a", args: {} }] },
  ]);
  assert.deepEqual(msgs[1].content.map((c: any) => c.type), ["text", "tool_use"]);
});

test("an empty assistant turn is dropped rather than sent, because it rejects the whole conversation", () => {
  // Providers do return empty turns. One of them must not poison every later turn of the loop.
  const { msgs } = toWire([
    { role: "user", content: "go" },
    { role: "assistant", content: "" },
    { role: "user", content: "still there?" },
  ]);
  assert.equal(msgs.length, 2);
  assert.ok(msgs.every((m: any) => m.role !== "assistant" || m.content.length > 0));
});
