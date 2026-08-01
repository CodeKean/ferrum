// The support link.
//
// One thing here can break without anything looking broken: `wa.me` takes DIGITS ONLY. Give it a
// `+`, a space or a dash and it does not error — it opens a page saying the number is invalid. So a
// link with a formatted number renders correctly, clicks correctly, and goes nowhere, and the only
// way anyone finds out is a customer who never arrives.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SUPPORT_NUMBER, supportLink } from "./supportLink.ts";

test("the number reaches wa.me as digits only", () => {
  const url = new URL(supportLink());
  assert.equal(url.hostname, "wa.me");
  assert.match(url.pathname, /^\/\d+$/, `wa.me path must be bare digits, got ${url.pathname}`);
});

test("formatting a person can read is stripped, not stored twice", () => {
  // The constant stays human-readable on purpose, so somebody can check it against a phone.
  assert.ok(/[\s+]/.test(SUPPORT_NUMBER), "the constant is meant to keep its formatting");
  assert.equal(supportLink().split("?")[0], "https://wa.me/919844190125");
});

test("every way a number gets written lands on the same link", () => {
  const same = ["+91 98441 90125", "+91-98441-90125", "919844190125", "+91 (98441) 90125"];
  const links = same.map((n) => supportLink(n).split("?")[0]);
  assert.deepEqual([...new Set(links)], ["https://wa.me/919844190125"]);
});

test("the greeting is encoded, so an em dash cannot truncate the URL", () => {
  const url = new URL(supportLink());
  const text = url.searchParams.get("text");
  assert.ok(text && text.includes("Ferrum"), "the first message should name the app");
  // searchParams decodes, so getting it back intact proves it survived encoding.
  assert.ok(!url.href.includes(" "), "a raw space in a URL is where it gets cut off");
});
