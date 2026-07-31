// `/Column name` in, `{{col:id}}` out — and, more importantly, web addresses left alone.
//
// The risk this file exists for: `/` is the most common character in a URL. A parser that reads
// every slash as a reference would corrupt every address in the app, and it would do it silently,
// because a mangled URL still looks like a URL. So the boundary rule gets tested against the shapes
// that actually appear in a request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fromDisplay, toDisplay, detectTrigger, findRefs, setRefOptional } from "./refs.ts";
import type { Column } from "../api.ts";

const col = (id: string, name: string): Column =>
  ({ id, sheetId: "s", name, key: name.toLowerCase(), position: 0, kind: "static", valueType: "text" }) as Column;

const COLUMNS = [col("1", "Website"), col("2", "Country"), col("3", "Country code"), col("4", "Company")];

test("a web address is never mistaken for a reference", () => {
  // Every slash here follows a letter or another slash, and none of them may be touched.
  const url = "https://api.example.com/v2/companies/find";
  assert.equal(fromDisplay(url, COLUMNS), url);

  // Even when a path segment happens to share a column's name.
  const trap = "https://api.example.com/Website/Country";
  assert.equal(fromDisplay(trap, COLUMNS), trap);
});

test("a reference is picked up exactly where one belongs", () => {
  assert.equal(
    fromDisplay("https://api.example.com/find?domain=/Website", COLUMNS),
    "https://api.example.com/find?domain={{col:1}}",
  );
  assert.equal(fromDisplay("/Website and /Company", COLUMNS), "{{col:1}} and {{col:4}}");
  assert.equal(fromDisplay("x=/Website&y=/Country", COLUMNS), "x={{col:1}}&y={{col:2}}");
});

test("the longer name wins, so a prefix cannot steal a reference", () => {
  // With both "Country" and "Country code" on the sheet, `/Country code` must not resolve to
  // "Country" and leave the word "code" behind as text.
  assert.equal(fromDisplay("/Country code", COLUMNS), "{{col:3}}");
  assert.equal(fromDisplay("/Country", COLUMNS), "{{col:2}}");
  // And the shorter one still resolves when the longer one cannot match.
  assert.equal(fromDisplay("/Country is US", COLUMNS), "{{col:2}} is US");
});

test("a doubled slash is the escape, and survives a round trip", () => {
  assert.equal(fromDisplay("=//Website", COLUMNS), "=/Website");
  // The escape must not consume the character after it.
  assert.equal(fromDisplay("=//Website/x", COLUMNS), "=/Website/x");

  // The half that was missing, and the reason the escape did not actually work. Rendering the
  // stored text back WITHOUT re-adding the escape gave "=/Website", and the next keystroke ran
  // fromDisplay over that and turned it into {{col:1}} — a deliberate literal became a live
  // reference one edit later, silently. Round-tripping twice is the real test: once could pass by
  // luck, twice catches a form that degrades every time it is touched.
  const once = toDisplay(fromDisplay("=//Website", COLUMNS), COLUMNS);
  assert.equal(once, "=//Website");
  assert.equal(toDisplay(fromDisplay(once, COLUMNS), COLUMNS), "=//Website");
});

test("an ordinary web address is not escaped on the way back out", () => {
  // The escape is only added where the text WOULD otherwise be read as a reference. A slash that
  // could never start one must come back exactly as it was typed, or every URL in the app grows a
  // second slash each time its field is rendered.
  for (const text of [
    "https://api.example.com/v2/companies/find",
    "https://api.example.com/Website/Country",
    "a/b/c",
  ]) {
    assert.equal(toDisplay(fromDisplay(text, COLUMNS), COLUMNS), text, text);
  }
});

test("stored form renders back as the name, and a deleted column says so", () => {
  assert.equal(toDisplay("{{col:1}}/x", COLUMNS), "/Website/x");
  // The name form the model emits is understood too, so a proposal reads the same as anything else.
  assert.equal(toDisplay("{{Website}}", COLUMNS), "/Website");
  // A reference to something gone is a visible complaint, not a silent blank.
  assert.equal(toDisplay("{{col:99}}", COLUMNS), "/deleted column 99");
});

test("what the user types comes back unchanged through both directions", () => {
  for (const text of [
    "https://api.example.com/v2/find?domain=/Website",
    "Take /Website, lowercase it, drop the www",
    "/Country code is US and /Company is not empty",
  ]) {
    assert.equal(toDisplay(fromDisplay(text, COLUMNS), COLUMNS), text);
  }
});

test("the picker opens on a reference and not on a path", () => {
  assert.deepEqual(detectTrigger("x=/Web", 6), { start: 2, query: "Web" });
  assert.deepEqual(detectTrigger("/Coun", 5), { start: 0, query: "Coun" });
  // Mid-word slash: a URL path being typed must not pop a menu over it.
  assert.equal(detectTrigger("https://api.example.com/loo", 27), null);
  // Escaped.
  assert.equal(detectTrigger("=//Web", 6), null);
  // One space is allowed so a two-word column name is still findable; two means they moved on.
  assert.deepEqual(detectTrigger("/Country co", 11), { start: 0, query: "Country co" });
  assert.equal(detectTrigger("/Country code is", 16), null);
});

test("a leading ? marks a reference optional, and survives both directions", () => {
  // Required is the default and carries no marker, so an existing template means what it always did.
  assert.equal(fromDisplay("/Website", COLUMNS), "{{col:1}}");
  assert.equal(fromDisplay("/?Website", COLUMNS), "{{col:1?}}");
  assert.equal(toDisplay("{{col:1?}}", COLUMNS), "/?Website");
  assert.equal(toDisplay(fromDisplay("d=/?Website&c=/Country", COLUMNS), COLUMNS), "d=/?Website&c=/Country");
});

test("a question mark ending a sentence is a question mark", () => {
  // A marker trailing the name would make this sentence parse as an OPTIONAL reference: the "?"
  // was eaten and the empty-value skip stopped protecting Website, which meant every row with a
  // blank website ran and was billed for a question about nothing. Prose is the common case; the
  // marker had to move out of prose's way.
  assert.equal(fromDisplay("What does /Website sell?", COLUMNS), "What does {{col:1}} sell?");
  assert.equal(fromDisplay("Check /Website?", COLUMNS), "Check {{col:1}}?");
  assert.deepEqual(
    findRefs(fromDisplay("Check /Website?", COLUMNS), COLUMNS).map((r) => r.optional),
    [false],
    "a sentence-ending question mark must not make a reference optional",
  );
});

test("the references in a template can be listed and flipped one at a time", () => {
  const t = "d=/?Website&c=/Country";
  const stored = fromDisplay(t, COLUMNS);
  assert.deepEqual(findRefs(stored, COLUMNS).map((r) => [r.name, r.optional]), [["Website", true], ["Country", false]]);

  // Flipping one leaves the other alone — that is the whole point of a per-reference control.
  const flipped = setRefOptional(stored, "2", true);
  assert.deepEqual(findRefs(flipped, COLUMNS).map((r) => [r.name, r.optional]), [["Website", true], ["Country", true]]);
  assert.deepEqual(
    findRefs(setRefOptional(flipped, "1", false), COLUMNS).map((r) => [r.name, r.optional]),
    [["Website", false], ["Country", true]],
  );
});

// ── Paths ──────────────────────────────────────────────────────────────────────────────────────
//
// One enrichment returning {industry, size, hq} is ONE unit of spend, so pulling a single field out
// of it has to be free. `/Firmographics.industry` is how that is written.
//
// The whole difficulty is telling a path from a full stop. "Ask about /Company. Then check the site."
// must not read `.Then` as a field lookup — it would eat the next word of the sentence with nothing
// on screen to say so. So a path is only read on a column that can actually HOLD structure, which is
// a thing the column declares rather than something the parser guesses.

const JSON_COL = { ...col("5", "Firmographics"), valueType: "json" } as Column;
const WITH_JSON = [...COLUMNS, JSON_COL];

test("a path is read on a column that holds structure", () => {
  assert.equal(fromDisplay("/Firmographics.industry", WITH_JSON), "{{col:5.industry}}");
  assert.equal(fromDisplay("/Firmographics.hq.city", WITH_JSON), "{{col:5.hq.city}}");
  assert.equal(fromDisplay("/Firmographics.tags[0]", WITH_JSON), "{{col:5.tags[0]}}");
});

test("a full stop after a TEXT column stays a full stop", () => {
  // The sentence must survive intact — this is the case that would silently lose a word.
  assert.equal(fromDisplay("Ask about /Company. Then check.", COLUMNS), "Ask about {{col:4}}. Then check.");
});

test("a path survives the round trip back to what the user reads", () => {
  assert.equal(toDisplay("{{col:5.industry}}", WITH_JSON), "/Firmographics.industry");
  assert.equal(toDisplay("{{col:5.hq.city?}}", WITH_JSON), "/?Firmographics.hq.city");
  const written = "A /?Firmographics.industry company in /Firmographics.hq.city.";
  assert.equal(toDisplay(fromDisplay(written, WITH_JSON), WITH_JSON), written);
});

test("the editor can tell two references to the same column apart by their path", () => {
  const refs = findRefs("{{col:5.industry}} and {{col:5.size}}", WITH_JSON);
  assert.deepEqual(refs.map((r) => r.path), [".industry", ".size"]);
  assert.deepEqual(refs.map((r) => r.name), ["Firmographics", "Firmographics"]);
});

test("a path is not confused with the optional marker", () => {
  assert.equal(fromDisplay("/?Firmographics.industry", WITH_JSON), "{{col:5.industry?}}");
  const refs = findRefs("{{col:5.industry?}}", WITH_JSON);
  assert.equal(refs[0]?.optional, true);
  assert.equal(refs[0]?.path, ".industry");
});
