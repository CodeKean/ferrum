// How fast a column is allowed to go.
//
// Driven by an injected clock rather than by sleeping, so these run in milliseconds and assert exact
// behaviour instead of "about right". A pacing test that really waits is a pacing test nobody runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Pacer } from "./pace.ts";

/** A clock the test moves by hand, and a sleep that moves it. */
function fake() {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
    sleep: async (ms: number) => { t += ms; },
  };
}

test("a rate limit halves the ceiling rather than stepping it down one", () => {
  // A provider refusing at twelve will usually also refuse at eleven, so stepping down spends a
  // dozen more refusals arriving where halving arrives at once.
  const p = new Pacer({ max: 16 });
  assert.equal(p.concurrency, 16);
  p.done("rate_limit");
  assert.equal(p.concurrency, 8);
  p.done("rate_limit");
  assert.equal(p.concurrency, 4);
});

test("the ceiling never falls below one", () => {
  // A column may end up serial. Serial is slow and is still running; zero is a run that has silently
  // stopped while reporting itself active.
  const p = new Pacer({ max: 4 });
  for (let i = 0; i < 10; i++) p.done("rate_limit");
  assert.equal(p.concurrency, 1);
});

test("recovery needs a sustained good run, not one lucky cell", () => {
  // Recovering on a single success turns one lucky call into a doubling and the run oscillates
  // between hammering and backing off — worse than either, because the provider sees bursts.
  const p = new Pacer({ max: 8 });
  p.done("rate_limit");
  assert.equal(p.concurrency, 4);
  for (let i = 0; i < 11; i++) p.done(null);
  assert.equal(p.concurrency, 4, "eleven good cells is not yet enough");
  p.done(null);
  assert.equal(p.concurrency, 5, "the twelfth earns one back");
});

test("recovery stops at the ceiling it started with", () => {
  const p = new Pacer({ max: 3 });
  for (let i = 0; i < 100; i++) p.done(null);
  assert.equal(p.concurrency, 3, "the engine never decides it knows better than the configured max");
});

test("a failure that is not about pace neither slows nor speeds anything", () => {
  // An auth or schema failure says nothing about how fast the provider wants to be called. Counting
  // one as a success would let a column failing on every row accelerate.
  const p = new Pacer({ max: 8 });
  p.done("rate_limit");
  assert.equal(p.concurrency, 4);
  for (let i = 0; i < 50; i++) p.done("schema");
  assert.equal(p.concurrency, 4, "a broken column must not earn its concurrency back by failing");
});

test("take() refuses on an aborted signal instead of allowing one more call", async () => {
  // A pacer that resolved true on an aborted signal would let a stopped run make one more paid call
  // per worker — exactly what the abort plumbing exists to prevent.
  const p = new Pacer({ max: 4 });
  const ac = new AbortController();
  ac.abort();
  assert.equal(await p.take(ac.signal), false);
  assert.equal(p.active, 0);
});

test("in-flight work is bounded by the live ceiling", async () => {
  const clock = fake();
  const p = new Pacer({ max: 2, now: clock.now, sleep: clock.sleep });
  assert.equal(await p.take(), true);
  assert.equal(await p.take(), true);
  assert.equal(p.active, 2);

  // A third would block. Cancelling is how the test gets control back without waiting for real time.
  const ac = new AbortController();
  const third = p.take(ac.signal);
  ac.abort();
  assert.equal(await third, false);

  p.done(null);
  assert.equal(p.active, 1);
  assert.equal(await p.take(), true);
});

test("a per-minute cap bounds the RATE, which concurrency does not", async () => {
  // Six workers against a provider answering in 50ms is 120 calls a second: inside every concurrency
  // limit and outside most rate limits.
  const clock = fake();
  const p = new Pacer({ max: 10, perMinute: 3, now: clock.now, sleep: clock.sleep });

  for (let i = 0; i < 3; i++) { assert.equal(await p.take(), true); p.done(null); }

  const before = clock.now();
  assert.equal(await p.take(), true);
  const waited = clock.now() - before;
  assert.ok(waited >= 59_000, `the fourth call had to wait for the window, waited ${waited}ms`);
});

test("no per-minute cap means no waiting", async () => {
  const clock = fake();
  const p = new Pacer({ max: 10, now: clock.now, sleep: clock.sleep });
  const before = clock.now();
  for (let i = 0; i < 50; i++) { assert.equal(await p.take(), true); p.done(null); }
  assert.equal(clock.now(), before, "an unset limit must not cost a single millisecond");
});

test("the rate window rolls rather than resetting", async () => {
  // A fixed window lets 2N calls through across its boundary — N at the end of one and N at the start
  // of the next — which is the burst the provider's own limiter is watching for.
  const clock = fake();
  const p = new Pacer({ max: 10, perMinute: 2, now: clock.now, sleep: clock.sleep });
  assert.equal(await p.take(), true); p.done(null);
  clock.advance(30_000);
  assert.equal(await p.take(), true); p.done(null);

  // 30s later the first has aged out and the second has not, so exactly one slot is free.
  clock.advance(30_100);
  const before = clock.now();
  assert.equal(await p.take(), true);
  assert.equal(clock.now(), before, "one slot was genuinely free");

  const t2 = clock.now();
  assert.equal(await p.take(), true);
  assert.ok(clock.now() - t2 >= 29_000, "and the next one waits for the second to age out");
});
