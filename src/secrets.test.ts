// Named keys.
//
// Everything here is about a value not going somewhere. A key that works but also ends up in an
// error message, a template, or a route response is worse than no key store at all, because the
// store is the reason the user stopped being careful about where they typed it.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A throwaway data directory, so this never reads or writes the real key file.
const DIR = mkdtempSync(join(tmpdir(), "ferrum-secrets-"));
process.env.CLAYCODE_DATA_DIR = DIR;

const {
  deleteSecret, hasSecretRef, listCategories, listSecrets, mask, noteSecretsUsed,
  primeSecrets, resolveSecrets, saveSecret, secretNamesIn,
} = await import("./secrets.ts");
const { redactSecrets } = await import("./redact.ts");

const KEY = "pk_live_9f3c2a71b0e84d5fa6c1";

before(() => { saveSecret({ name: "Prospeo", value: KEY, category: "Enrichment" }); });
after(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

test("a stored key is never handed back — only enough to recognise it", () => {
  const [s] = listSecrets().filter((x) => x.name === "Prospeo");
  assert.ok(s);
  assert.equal((s as any).value, undefined, "no route may return a value, so no shape may carry one");
  assert.match(s!.masked, /^pk_l…/);
  assert.ok(!s!.masked.includes(KEY));
  // And the whole serialised record must not contain it either — a nested field is still a leak.
  assert.ok(!JSON.stringify(listSecrets()).includes(KEY));
});

test("a reference is replaced only where it is meant to be", () => {
  const r = resolveSecrets("Bearer {{secret:Prospeo}}");
  assert.equal(r.text, `Bearer ${KEY}`);
  assert.deepEqual(r.used, ["Prospeo"]);
  assert.deepEqual(r.missing, []);
});

test("the name is matched however it was typed", () => {
  assert.equal(resolveSecrets("{{secret:prospeo}}").text, KEY);
  assert.equal(resolveSecrets("{{secret:  Prospeo  }}").text, KEY);
});

test("an unknown name is REPORTED and left alone, never blanked", () => {
  const r = resolveSecrets("key={{secret:Nope}}");
  assert.deepEqual(r.missing, ["Nope"]);
  // Substituting empty would send a request with a blank credential and earn a 401 that reads as
  // "your key is wrong" rather than "there is no key".
  assert.equal(r.text, "key={{secret:Nope}}");
});

test("a column reference is NOT a secret reference", () => {
  // The two grammars must not overlap: everything that renders a column reference would otherwise
  // be a place a key could be expanded into text that gets shown, stored or sent to a model.
  const r = resolveSecrets("{{col:12}} and {{Website}}");
  assert.equal(r.text, "{{col:12}} and {{Website}}");
  assert.deepEqual(r.used, []);
  assert.equal(hasSecretRef("{{col:12}}"), false);
  assert.equal(hasSecretRef("{{secret:Prospeo}}"), true);
});

test("a stored value is scrubbed out of anything that gets written down", () => {
  primeSecrets();
  // The realistic path: a provider echoes the key back in its own error body, and that string
  // becomes cells.error_msg and goes out on the live stream.
  const msg = `401 from api.prospeo.io: {"error":"invalid token ${KEY}"}`;
  const out = redactSecrets(msg);
  assert.ok(!out.includes(KEY), out);
  assert.match(out, /401 from api\.prospeo\.io/, "and the message stays diagnosable");
});

test("redaction survives a key with regex characters in it", () => {
  const weird = "abc(def)+ghi[jkl].*mno";
  saveSecret({ name: "ZZ weird", value: weird });
  primeSecrets();
  assert.ok(!redactSecrets(`failed with ${weird}`).includes(weird));
  deleteSecret("ZZ weird");
});

test("a longer key containing a shorter one is not left half-redacted", () => {
  const short = "abcdefgh1234";
  const long = `${short}5678extra`;
  saveSecret({ name: "ZZ short", value: short });
  saveSecret({ name: "ZZ long", value: long });
  primeSecrets();
  const out = redactSecrets(`used ${long} here`);
  assert.ok(!out.includes(short), out);
  assert.ok(!out.includes(long), out);
  deleteSecret("ZZ short");
  deleteSecret("ZZ long");
});

test("saving without a value is a rename, not a wipe", () => {
  // The screen cannot show the value back, so an empty field HAS to mean "leave it alone" — or
  // fixing a typo in the category would silently destroy the credential.
  saveSecret({ name: "Prospeo", category: "Data" });
  assert.equal(resolveSecrets("{{secret:Prospeo}}").text, KEY);
  assert.equal(listSecrets().find((s) => s.name === "Prospeo")!.category, "Data");
  saveSecret({ name: "Prospeo", category: "Enrichment" });
});

test("a new key with no value is refused rather than stored empty", () => {
  assert.throws(() => saveSecret({ name: "ZZ empty" }), /paste the key/i);
});

test("a name that would break the reference syntax is refused at the door", () => {
  for (const bad of ["has:colon", "has{brace", "has}brace"]) {
    assert.throws(() => saveSecret({ name: bad, value: "0123456789abcdef" }), /cannot contain/i);
  }
  assert.throws(() => saveSecret({ name: "  ", value: "0123456789abcdef" }), /needs a name/i);
});

test("which names a request refers to can be listed without resolving them", () => {
  const cfg = JSON.stringify({ headers: [{ name: "Authorization", value: "Bearer {{secret:Prospeo}}" }], url: "https://x/{{secret:Other}}" });
  assert.deepEqual(secretNamesIn(cfg).sort(), ["Other", "Prospeo"]);
});

test("use is counted once and dated, so a key nobody needs can be found", () => {
  const before = listSecrets().find((s) => s.name === "Prospeo")!.uses;
  noteSecretsUsed(["Prospeo", "Prospeo"]);
  const after = listSecrets().find((s) => s.name === "Prospeo")!;
  assert.equal(after.uses, before + 2, "two calls are two uses");
  assert.ok(after.lastUsedAt);
});

test("categories come from what is actually stored", () => {
  assert.ok(listCategories().includes("Enrichment"));
});

test("deleting removes it, and the reference then reports missing rather than sending blank", () => {
  saveSecret({ name: "ZZ gone", value: "0123456789abcdef" });
  deleteSecret("ZZ gone");
  assert.equal(listSecrets().some((s) => s.name === "ZZ gone"), false);
  assert.deepEqual(resolveSecrets("{{secret:ZZ gone}}").missing, ["ZZ gone"]);
});

test("the key file is written into the data directory, not the repository", () => {
  assert.ok(existsSync(join(DIR, "secrets.json")));
});

test("mask never reveals a short value", () => {
  assert.equal(mask("short"), "…");
  assert.ok(!mask("0123456789abcdef").includes("456789ab"));
});
