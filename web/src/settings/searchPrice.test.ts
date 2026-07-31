// Every number on the search screen falls between $0.0001 and $0.01, so one wrong character is a
// factor of ten and every rendering still looks plausible. The first version of `price` turned
// $0.005 into "0.00" — a bug visible in a browser and invisible in a diff, which is what these are
// for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { perMillion, price } from "./searchPrice.ts";

test("a real per-search price keeps every significant digit", () => {
  assert.equal(price(0.005), "$0.005");
  assert.equal(price(0.001), "$0.001");
  // The cheapest engine on the list. Rounded to two places this would print "$0.00" — the same as
  // free, and the same as everything else on the screen.
  assert.equal(price(0.00035), "$0.00035");
  assert.equal(price(0.008), "$0.008");
});

test("trailing zeros are dropped, but never a significant digit", () => {
  assert.equal(price(0.0050), "$0.005");
  assert.equal(price(0.5), "$0.5");
  // The exact regression: strip zeros, then strip a literal dot — not "any last character".
  assert.notEqual(price(0.005), "$0.00");
});

test("a whole number is not mangled by the trimming", () => {
  assert.equal(price(1), "$1");
  assert.equal(price(2.5), "$2.5");
});

test("unset and free are different answers and read differently", () => {
  // "Free" is a fact. "Not set" means the budget cannot bound this engine at all, and showing it as
  // zero would tell someone their searches cost nothing.
  assert.equal(price(null), "price not set");
  assert.equal(price(0), "free");
});

test("the per-million figure is what makes two prices comparable", () => {
  assert.equal(perMillion(0.005), "$5,000");
  assert.equal(perMillion(0.001), "$1,000");
  assert.equal(perMillion(0.00035), "$350");
});

test("per-million distinguishes free from unpriced too", () => {
  assert.equal(perMillion(0), "nothing");
  assert.equal(perMillion(null), null);
});
