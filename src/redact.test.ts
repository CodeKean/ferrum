// The redactor has two ways to fail and both matter.
//
// Missing a secret puts a live credential in the database and on every SSE subscriber. Being too
// greedy destroys the error message, and an error nobody can read is why the message is stored in
// the first place. So every test here checks BOTH: that the secret is gone, and that what is left
// still says which call failed and how.

import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, wasRedacted } from "./redact.ts";

test("provider keys are stripped by prefix, and the prefix survives", () => {
  const msg = "401 from provider: invalid key sk-or-v1-05329d327361827114dfee4eb4c588478b7c1d21a9b6";
  const out = redactSecrets(msg);
  assert.ok(!out.includes("05329d"), "the key body must not survive");
  // Which PROVIDER it was is the useful half and is kept.
  assert.ok(out.includes("sk-or-v1-***"), out);
  assert.ok(out.startsWith("401 from provider:"), "the diagnosis must survive");

  assert.ok(!redactSecrets("sk-ant-api03-AAAABBBBCCCCDDDD1234").includes("AAAABBBB"));
  assert.ok(!redactSecrets("key=AIzaSyD-abcdefghijklmnop0123").includes("SyD-abc"));
});

test("a key in an HTTP column's own URL is caught by its parameter name", () => {
  // The realistic case. The user writes the URL, the provider documents `?api_key=`, the call fails,
  // and the message names the URL. The value has no recognisable prefix, so only the NAME can catch
  // it — which is exactly why matching on parameter names is in here alongside the shapes.
  const msg = "GET https://api.vendor.com/v2/find?domain=acme.com&api_key=9f2b71ce4d failed: 403";
  const out = redactSecrets(msg);
  assert.ok(!out.includes("9f2b71ce4d"), out);
  // Everything needed to understand the failure is still there.
  assert.ok(out.includes("api.vendor.com/v2/find"), out);
  assert.ok(out.includes("domain=acme.com"), "a non-secret parameter must not be touched");
  assert.ok(out.includes("403"), out);

  // The `&` must stop the match — otherwise one secret parameter eats the rest of the query string.
  const trailing = redactSecrets("?token=abcdef123456&page=2");
  assert.ok(trailing.includes("page=2"), trailing);
});

test("an Authorization header keeps its scheme and loses its value", () => {
  // Bearer-vs-Basic is a real diagnostic difference: one is a wrong token, the other is usually a
  // wrong client entirely.
  const bearer = redactSecrets("sent Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def");
  assert.ok(!bearer.includes("eyJhbGci"), bearer);
  assert.ok(/Bearer\s+\*\*\*/.test(bearer), bearer);

  const basic = redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA==");
  assert.ok(!basic.includes("dXNlcjpwYXNz"), basic);
  assert.ok(basic.includes("Basic"), basic);
});

test("a webhook token is a credential and is treated as one", () => {
  // The token IS the write capability for that sheet. A message naming the ingest URL hands it over.
  const out = redactSecrets("POST http://127.0.0.1:4317/hook/Xk3nP0qR7sT9uV2wY4zA6bC8 returned 500");
  assert.ok(!out.includes("Xk3nP0qR"), out);
  assert.ok(out.includes("/hook/***"), out);
  assert.ok(out.includes("500"), "the status is the whole point of the message");
});

test("a password in a URL's userinfo does not survive", () => {
  const out = redactSecrets("connect https://admin:hunter2@db.internal:5432/x refused");
  assert.ok(!out.includes("hunter2"), out);
  assert.ok(out.includes("admin:***@db.internal"), out);
});

test("an ordinary error is returned untouched", () => {
  // The greedy direction. None of these contain a secret and all of them must survive verbatim,
  // because a redactor that mangles normal errors gets switched off and then protects nothing.
  for (const msg of [
    "Timed out after 30000ms",
    "ECONNREFUSED 127.0.0.1:11434 — is Ollama running?",
    "That column no longer exists.",
    "Expected a number, got \"$29/mo\"",
    "GET https://api.example.com/v1/companies/find?domain=acme.com returned 404",
    "The model returned no usable JSON. Raw: {\"result\": null}",
  ]) {
    assert.equal(redactSecrets(msg), msg, `must not touch: ${msg}`);
    assert.equal(wasRedacted(msg), false, msg);
  }
});

test("null and empty pass straight through", () => {
  // It runs on every errored cell of every flush; a throw here would break the frame for every other
  // cell riding along with it.
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets(undefined), null);
  assert.equal(redactSecrets(""), "");
  assert.equal(wasRedacted(null), false);
  assert.equal(wasRedacted(""), false);
});

test("redaction is idempotent", () => {
  // Applied at the write AND at the broadcast, so it runs twice over the same text. The second pass
  // must not eat the marker the first one left, or the message degrades every time it is touched.
  const once = redactSecrets("Authorization: Bearer abcdef123456");
  assert.equal(redactSecrets(once), once);

  const url = redactSecrets("?api_key=abcdef123456&x=1");
  assert.equal(redactSecrets(url), url);
});
