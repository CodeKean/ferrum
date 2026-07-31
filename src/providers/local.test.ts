// Local runtimes: parsing, and the properties that keep the free lane reachable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isLocalModel, parseLocalModel, LOCAL_PREFIX } from "./local.ts";

test("a local model id round-trips, including the awkward names", () => {
  const p = parseLocalModel("local:ollama/llama3.1:8b");
  assert.equal(p?.runtime.id, "ollama");
  // Ollama names carry colons and slashes. Splitting on every separator would mangle them into
  // something the runtime does not have, and the failure would be a 404 per row.
  assert.equal(p?.model, "llama3.1:8b");

  assert.equal(parseLocalModel("local:ollama/library/qwen2.5:7b")?.model, "library/qwen2.5:7b");
  assert.equal(parseLocalModel("local:lmstudio/TheBloke/Mistral-7B-GGUF")?.runtime.id, "lmstudio");
});

test("hosted model ids are never mistaken for local ones", () => {
  for (const id of ["openai/gpt-oss-20b", "anthropic/claude-3", "auto", ""]) {
    assert.equal(isLocalModel(id), false, `${id} must not look local`);
    assert.equal(parseLocalModel(id), null);
  }
  assert.equal(isLocalModel(`${LOCAL_PREFIX}ollama/x`), true);
});

test("a malformed local id is rejected rather than half-parsed", () => {
  // No runtime segment, and an unknown runtime. Both would otherwise produce a provider pointed at
  // nothing, failing once per row instead of once at save time.
  assert.equal(parseLocalModel("local:llama3.1"), null);
  assert.equal(parseLocalModel("local:notarealruntime/x"), null);
});
