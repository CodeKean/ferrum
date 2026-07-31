// The destination presets.
//
// A preset is data that gets written into a user's column and then makes real calls to a real
// provider on every row. The failures worth a test are not "does the list render" — they are the
// ones that would ship a credential into a column, send a request nobody meant to send, or quietly
// invent a price that lands in the usage report as a fact.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DESTINATIONS, applyDestination } from "./destinations.ts";
import { DEFAULT_HTTP } from "./httpConfig.ts";

test("no preset carries a literal credential", () => {
  // The whole reason the saved-key mechanism exists. A token typed into a column header travels with
  // that column — into a duplicate, a template, an export — and there is no taking it back.
  const looksLikeAKey = /\b(sk-|pk_|xox[bp]-|Bearer\s+[A-Za-z0-9._-]{16,})/;
  for (const d of DESTINATIONS) {
    const blob = JSON.stringify(d.config);
    assert.ok(!looksLikeAKey.test(blob), `${d.name} appears to contain a literal key`);
    // Every credential must be a reference, and the name must match what the card tells the user to
    // create — otherwise the instruction sends them to make a key nothing will ever read.
    if (d.needsKey) {
      assert.ok(
        blob.includes(`{{secret:${d.needsKey}}}`),
        `${d.name} says it needs a key called "${d.needsKey}" but never references one by that name`,
      );
    }
  }
});

test("no preset invents a price", () => {
  // A fabricated cost is worse than none: it shows up in the usage report as a real figure, beside
  // real ones, and nobody re-checks it.
  for (const d of DESTINATIONS) {
    assert.equal(d.config.cost, undefined, `${d.name} declares a cost nobody verified`);
  }
});

test("every preset that sends a body actually has one", () => {
  // A POST with `bodyMode: "none"` left over from the defaults sends an empty request, gets a 400
  // from the provider, and reads to the user as the preset being broken rather than incomplete.
  for (const d of DESTINATIONS) {
    const c = applyDestination(DEFAULT_HTTP, d);
    if (c.method === "GET") continue;
    assert.notEqual(c.bodyMode, "none", `${d.name} is a ${c.method} with no body`);
    if (c.bodyMode === "raw") assert.ok(c.body.trim(), `${d.name} is raw-bodied but the body is empty`);
    else assert.ok(c.bodyFields.length > 0, `${d.name} has no body fields`);
  }
});

test("a preset that leaves something blank says so", () => {
  // The failure this guards: a form that looks finished, posting an empty campaign id on every row.
  for (const d of DESTINATIONS) {
    const c = applyDestination(DEFAULT_HTTP, d);
    const blanks: string[] = [];
    if (!c.url.trim()) blanks.push("URL");
    for (const f of [...c.query, ...c.headers, ...c.bodyFields]) {
      if (!f.value.trim()) blanks.push(f.name);
    }
    const placeholder = /CAMPAIGN_ID|EMAIL\b/.test(JSON.stringify(c));
    if (blanks.length > 0 || placeholder) {
      assert.ok(
        d.fillIn.length > 0,
        `${d.name} leaves ${blanks.join(", ") || "a placeholder"} to be filled in but its fillIn list is empty`,
      );
    }
  }
});

test("applying a preset leaves every unmentioned setting alone", () => {
  // A preset is a patch, not a reset. Wiping the timeout, the retry policy or the SSRF guard back to
  // defaults because a preset did not mention them would undo deliberate settings silently.
  const base = { ...DEFAULT_HTTP, timeoutMs: 90_000, maxRetries: 5, allowPrivate: true };
  const applied = applyDestination(base, DESTINATIONS.find((d) => d.id === "webhook")!);
  assert.equal(applied.timeoutMs, 90_000);
  assert.equal(applied.maxRetries, 5);
  assert.equal(applied.allowPrivate, true, "and it does not quietly re-open or re-close the SSRF guard");
});

test("ids are unique, because they key the list and the choice", () => {
  const ids = DESTINATIONS.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("every preset is dated, so a stale one can be spotted", () => {
  for (const d of DESTINATIONS) {
    assert.match(d.checked, /^\d{4}-\d{2}-\d{2}$/, `${d.name} has no date on it`);
  }
});
