import test from "node:test";
import assert from "node:assert/strict";
import { formatDisplay, normalizeFormat } from "./valueFormat.ts";

// Display only — the stored value is always a plain number; these assert what the eye sees. Locale
// is the runner's default, so the assertions avoid a specific symbol placement and check the parts
// that must be present.

test("a percent column appends %, at the number's natural precision", () => {
  assert.equal(formatDisplay("29", "percent"), "29%");
  assert.equal(formatDisplay("29.5", "percent"), "29.5%");
});

test("percent honours a fixed decimals when set", () => {
  assert.equal(formatDisplay("29", "percent", { decimals: 1 }), "29.0%");
  assert.equal(formatDisplay("29.456", "percent", { decimals: 2 }), "29.46%");
});

test("a currency column with no code shows a grouped 2-decimal number, no symbol", () => {
  // No symbol until a code is chosen — a default "$" would misrepresent a column of euros.
  // Locale-agnostic: grouping style varies by locale (Western 1,000,000 vs Indian 10,00,000), so
  // assert the parts that must hold everywhere — two decimals, a grouping separator, no symbol.
  const out = formatDisplay("1000000", "currency");
  assert.match(out, /\.00$/);        // two decimals
  assert.match(out, /[,. ]/);         // some grouping separator
  assert.doesNotMatch(out, /[$€£¥]/); // no currency symbol
  assert.notEqual(out, "1000000");    // it was formatted, not passed through
});

test("a currency column with a code shows the symbol", () => {
  const out = formatDisplay("29", "currency", { currency: "USD" });
  assert.match(out, /29\.00/);
  assert.match(out, /\$|USD/); // some rendering of the currency
});

test("an unknown currency code degrades to a plain number rather than throwing", () => {
  const out = formatDisplay("29", "currency", { currency: "ZZZ" });
  assert.match(out, /29\.00/);
});

test("an unparseable value is shown, never hidden", () => {
  assert.equal(formatDisplay("n/a", "currency"), "n/a");
  assert.equal(formatDisplay("pending", "percent"), "pending");
});

test("empty and null render as empty", () => {
  assert.equal(formatDisplay("", "currency"), "");
  assert.equal(formatDisplay(null, "percent"), "");
});

test("every non-money type is returned untouched", () => {
  assert.equal(formatDisplay("https://acme.com", "url"), "https://acme.com");
  assert.equal(formatDisplay("2024-03-15", "date"), "2024-03-15");
  assert.equal(formatDisplay("1000000", "number"), "1000000"); // plain number is left raw on purpose
  assert.equal(formatDisplay("hello", "text"), "hello");
});

test("normalizeFormat keeps a valid ISO code upper-cased and drops junk", () => {
  assert.deepEqual(normalizeFormat({ currency: "usd" }), { currency: "USD" });
  assert.deepEqual(normalizeFormat({ currency: "dollars" }), null); // not a 3-letter code
  assert.deepEqual(normalizeFormat({ currency: "" }), null);
});

test("normalizeFormat clamps decimals and drops non-numbers", () => {
  assert.deepEqual(normalizeFormat({ decimals: 2 }), { decimals: 2 });
  assert.deepEqual(normalizeFormat({ decimals: 99 }), { decimals: 10 });
  assert.deepEqual(normalizeFormat({ decimals: -3 }), { decimals: 0 });
  assert.deepEqual(normalizeFormat({ decimals: "x" }), null);
});

test("normalizeFormat returns null for nothing usable, an object for a real descriptor", () => {
  assert.equal(normalizeFormat(null), null);
  assert.equal(normalizeFormat("USD"), null);
  assert.equal(normalizeFormat({}), null);
  assert.deepEqual(normalizeFormat({ currency: "EUR", decimals: 0 }), { currency: "EUR", decimals: 0 });
});
