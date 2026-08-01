// What a Select trigger claims is set.
//
// The failure worth pinning is not a blank trigger — it is a trigger that confidently names a
// DIFFERENT valid setting, because nobody double-checks a control that looks answered.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSelected } from "./selectValue.ts";

const RUN_MODELS = [
  { value: "auto", label: "Let the engine choose" },
  { value: "openai/gpt-oss-20b", label: "OpenAI: gpt-oss-20b" },
] as const;

test("a value the option list has not loaded yet is shown, not the first option", () => {
  // Exactly the live case: the workspace is pinned to a local model, the engine has just booted, and
  // nothing has probed the local runtimes yet, so the catalogue does not carry it.
  const got = resolveSelected([...RUN_MODELS], "local:lmstudio/google/gemma-3-4b" as any);

  assert.equal(got?.label, "local:lmstudio/google/gemma-3-4b");
  // The regression: "Let the engine choose" is not a placeholder, it is a real and different
  // setting. Naming it here told the user their pinned model had reverted to automatic while the
  // hint directly beneath said the opposite.
  assert.notEqual(got?.label, "Let the engine choose");
});

test("a value that is in the list resolves to its option, label and all", () => {
  const got = resolveSelected([...RUN_MODELS], "openai/gpt-oss-20b");
  assert.equal(got?.label, "OpenAI: gpt-oss-20b");
});

test("an empty value still falls back to the first option", () => {
  // "" is how a picker spells "nothing chosen", and an empty trigger says less than the first
  // option does. Only a value that is set and unmatched is worth surfacing raw.
  assert.equal(resolveSelected([...RUN_MODELS], "" as any)?.label, "Let the engine choose");
});
