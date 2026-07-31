// The two halves of safeFetch that are not the address check.
//
// Both are tested as pure functions rather than through a live fetch, deliberately: the address
// guard refuses private addresses, so a test server on 127.0.0.1 could not be reached past the first
// hop anyway — and a security property that can only be demonstrated by reaching the public internet
// is one that stops being demonstrated the moment the network is unavailable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { headersTravel, readCapped } from "./safeFetch.ts";

// ── credentials on a redirect ───────────────────────────────────────────────

test("the caller's headers do not follow a redirect off the host they were written for", () => {
  // The failure this prevents: an HTTP column carrying `Authorization: Bearer <third-party key>` is
  // answered with a 302, and the hop loop rebuilt the identical headers for the new host — one
  // redirect, and the key belongs to whoever sent it. The POST body was already withheld after the
  // first hop for exactly this reason; the headers were not.
  const from = new URL("https://api.acme.com/v1/lookup");
  assert.equal(headersTravel(from, new URL("https://evil.example/collect")), false);
  // A different port is a different service, even on the same machine.
  assert.equal(headersTravel(from, new URL("https://api.acme.com:8443/v1/lookup")), false);
  // Same owner, but the credential would cross the wire in the clear.
  assert.equal(headersTravel(from, new URL("http://api.acme.com/v1/lookup")), false);
});

test("an ordinary redirect keeps them, or the guard would break working columns", () => {
  // A path change and an http→https upgrade are what a redirect on an address the user typed
  // actually looks like. Stripping there costs a 401 on every row and prevents nothing.
  assert.equal(
    headersTravel(new URL("https://api.acme.com/v1"), new URL("https://api.acme.com/v2/lookup?x=1")),
    true,
  );
  assert.equal(
    headersTravel(new URL("http://api.acme.com/v1"), new URL("https://api.acme.com/v1")),
    true,
  );
});

// ── the byte cap ────────────────────────────────────────────────────────────

/** A body delivered in chunks, the way a real response arrives. */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

const filler = (n: number) => new Uint8Array(n).fill(0x61);
const encode = (s: string) => new TextEncoder().encode(s);

test("a body under the cap is returned whole and is not reported as truncated", async () => {
  const res = await readCapped(streamOf([encode("hello "), encode("world")]), 1024);
  assert.equal(res.body, "hello world");
  assert.equal(res.truncated, false);
});

test("a body exactly at the cap is kept in full and is not called truncated", async () => {
  const res = await readCapped(streamOf([filler(100)]), 100);
  assert.equal(res.body.length, 100);
  assert.equal(res.truncated, false);
});

test("reading STOPS at the cap rather than buffering the whole body first", async () => {
  // The defect: `arrayBuffer()` resolves only once everything is in memory, so the cap described the
  // slice that was KEPT and not the transfer that was made — an endpoint returning gigabytes was
  // allocated in full and then trimmed to 512KB, once per row on an HTTP column, on a
  // single-threaded engine.
  //
  // This stream never ends. Reaching the assertions at all is the result: the old shape would sit
  // here until the process died.
  let delivered = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      delivered += 64 * 1024;
      controller.enqueue(filler(64 * 1024));
    },
  });

  const res = await readCapped(endless, 100 * 1024);
  assert.equal(res.body.length, 100 * 1024, "exactly the cap is kept");
  assert.equal(res.truncated, true);
  // Bounded by the cap and the stream's own read-ahead, not by what the endpoint wanted to send.
  assert.ok(delivered < 1024 * 1024, `read ${delivered} bytes to fill a 100KB cap`);
});

test("a body split across chunks is truncated at the cap, not at a chunk boundary", async () => {
  const res = await readCapped(streamOf([filler(60), filler(60), filler(60)]), 100);
  assert.equal(res.body.length, 100);
  assert.equal(res.truncated, true);
});

test("an empty body is not an error", async () => {
  assert.deepEqual(await readCapped(null, 1024), { body: "", truncated: false });
  assert.deepEqual(await readCapped(streamOf([]), 1024), { body: "", truncated: false });
});
