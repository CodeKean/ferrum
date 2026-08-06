import test from "node:test";
import assert from "node:assert/strict";
import { findTrigger } from "./trigger.ts";

// The rule that decides whether the "/" menu opens, and — the part that used to be a second copy of
// this regex — exactly which characters a picked column replaces. When those two disagreed the menu
// opened and the pick did nothing, so `start` is tested as carefully as the match itself.

test("a slash at the start of the text triggers", () => {
  assert.deepEqual(findTrigger("/"), { start: 0, query: "" });
  assert.deepEqual(findTrigger("/Comp"), { start: 0, query: "Comp" });
});

test("a slash after a space triggers, and start points at the slash", () => {
  const t = findTrigger("Ask about /Comp");
  assert.deepEqual(t, { start: 10, query: "Comp" });
  // The replacement must cover "/Comp" and nothing else — not the space before it.
  assert.equal("Ask about /Comp".slice(t!.start), "/Comp");
});

test("a slash mid-word does not trigger", () => {
  assert.equal(findTrigger("and/or"), null);
  assert.equal(findTrigger("a/b"), null);
});

test("a URL does not open the menu", () => {
  // The failure this rule exists for: every https:// in a prompt popping the column list.
  assert.equal(findTrigger("see https://acme.com"), null);
  assert.equal(findTrigger("see https:/"), null);
});

test("a second slash ends the query", () => {
  assert.equal(findTrigger("/Company/x"), null);
});

test("whitespace after the slash ends the trigger", () => {
  assert.equal(findTrigger("/Company "), null);
  assert.equal(findTrigger("/Company name"), null);
});

test("a newline counts as a word boundary", () => {
  const t = findTrigger("first line\n/Web");
  assert.deepEqual(t, { start: 11, query: "Web" });
  assert.equal("first line\n/Web".slice(t!.start), "/Web");
});

test("only the trigger nearest the caret is returned", () => {
  const text = "/Company and /Web";
  const t = findTrigger(text);
  assert.deepEqual(t, { start: 13, query: "Web" });
  assert.equal(text.slice(t!.start), "/Web");
});

test("text with no slash at all", () => {
  assert.equal(findTrigger(""), null);
  assert.equal(findTrigger("plain words"), null);
});
