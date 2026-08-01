// Reading a path out of a JSON answer.
//
// The failure worth pinning is the silent one: a path that looks right, is refused by nothing, and
// returns nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { getPath } from "./jsonPath.ts";

test("a bare integer between dots is an array index", () => {
  // The live case: dns.google returns {Answer:[{data:"18.67.195.100"}]}, and `Answer.0.data` — the
  // form anyone copying from a JSON sample writes first — silently found nothing while
  // `Answer[0].data` worked on the identical payload.
  const dns = { Answer: [{ data: "18.67.195.100" }, { data: "1.2.3.4" }] };
  assert.equal(getPath(dns, "Answer.0.data"), "18.67.195.100");
  assert.equal(getPath(dns, "Answer[0].data"), "18.67.195.100", "the bracket form still works");
  assert.equal(getPath(dns, "Answer.1.data"), "1.2.3.4");

  // MCP results are the same shape, and this is the path the MCP spec leads you to write.
  assert.equal(getPath({ content: [{ type: "text", text: "hi" }] }, "content.0.text"), "hi");
});

test("a numeric segment still reads an object whose key really is a number", () => {
  // Teaching `a.0.b` to mean an index must not take away `{"0": …}`, which is real data: an API
  // keyed by id, a year, a rank.
  assert.equal(getPath({ byYear: { "2026": { total: 7 } } }, "byYear.2026.total"), 7);
  assert.equal(getPath({ ranks: { "0": "first" } }, "ranks.0"), "first");
});
