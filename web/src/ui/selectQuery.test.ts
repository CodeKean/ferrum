// Filtering a long option list.
//
// The failure worth pinning: a query whose words are ALL present but not adjacent returned nothing,
// on the control whose entire reason for existing is making 300+ models findable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesQuery } from "./selectValue.ts";

test("every word must appear, in any order", () => {
  const o = { value: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "NVIDIA: Nemotron 3 Ultra (free)" };
  // The live case: this returned "Nothing matches" while the option sat in the list.
  assert.ok(matchesQuery(o, "free nemotron 3 ultra"));
  assert.ok(matchesQuery(o, "nemotron ultra"), "order does not matter");
  assert.ok(matchesQuery(o, "nvidia free"), "one word from the id, one from the label");
  assert.ok(matchesQuery(o, ""), "an empty query keeps everything");
  assert.ok(!matchesQuery(o, "nemotron llama"), "a word that is in neither still excludes it");
});
