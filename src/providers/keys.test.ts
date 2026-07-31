// Provider key storage.
//
// The properties worth asserting are the ones whose failure is invisible: a key that reaches a
// response body, or a mask that shows too much. Neither throws, and neither is noticed until the
// value is somewhere it should not be.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../paths.ts";
import { saveProviderKey, getProviderKey, deleteProviderKey, providerKeyStatus, maskKey } from "./keys.ts";

const FAKE = "sk-or-v1-" + "a".repeat(64);

test("a stored key round-trips, and the status carries only the mask", () => {
  saveProviderKey("openrouter", FAKE);

  assert.equal(getProviderKey("openrouter"), FAKE, "the server can still read the real key");

  const status = providerKeyStatus("openrouter");
  assert.equal(status.present, true);
  // Everything in the status object is a candidate for a response body, so nothing in it may
  // contain the key.
  assert.ok(!JSON.stringify(status).includes(FAKE), "the status must never carry the key itself");
  assert.ok(status.label && status.label.length < 24, "the label is a mask, not the key");

  deleteProviderKey("openrouter");
  assert.equal(getProviderKey("openrouter"), null);
  assert.equal(providerKeyStatus("openrouter").present, false);
});

test("the mask shows enough to tell two keys apart and not enough to use one", () => {
  const a = maskKey("sk-or-v1-" + "1".repeat(64));
  const b = maskKey("sk-or-v1-" + "2".repeat(64));

  assert.notEqual(a, b, "two different keys must be distinguishable");
  // A mask that keeps most of the key is not a mask. Ten leading and four trailing characters is
  // recognisable to the person who pasted it and useless to anyone else.
  assert.ok(a.length <= 20, `mask is too long: ${a}`);
  assert.ok(!a.includes("1".repeat(20)), "the body of the key must not survive masking");
});

test("a key of the wrong shape is refused at save time", () => {
  // Rejected here rather than at first use: a truncated paste otherwise produces a 401 on every
  // row of a run, which reads like the provider being down rather than the key being wrong.
  assert.throws(() => saveProviderKey("openrouter", "sk-ant-api03-something"), /OpenRouter key/);
  assert.throws(() => saveProviderKey("openrouter", "not-a-key"), /OpenRouter key/);
  assert.throws(() => saveProviderKey("openrouter", "   "), /Empty/);
});

test("the key file lives in the data directory, outside the repository", () => {
  saveProviderKey("openrouter", FAKE);
  const path = join(DATA_DIR, "provider-keys.json");

  assert.ok(existsSync(path));
  // It genuinely holds the key — which is exactly why the directory it sits in is gitignored and
  // separate from the database that gets copied around.
  assert.ok(readFileSync(path, "utf8").includes(FAKE));
  deleteProviderKey("openrouter");
});

test("a corrupt key file reads as 'no key' rather than wedging the app", () => {
  const path = join(DATA_DIR, "provider-keys.json");
  writeFileSync(path, "{ this is not json");
  assert.equal(getProviderKey("openrouter"), null);
  assert.equal(providerKeyStatus("openrouter").present, false);
  // And saving over it recovers.
  saveProviderKey("openrouter", FAKE);
  assert.equal(getProviderKey("openrouter"), FAKE);
  deleteProviderKey("openrouter");
});
