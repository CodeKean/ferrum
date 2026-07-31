// The answer cache.
//
// A cache that returns a nearly-right answer is worse than no cache at all: it is silent, it is
// fast, and it is wrong on exactly the rows nobody goes back to check. So almost every test here is
// about the key MISSING — proving that two questions which look alike are treated as different.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import {
  answerKey, cacheDays, cacheEnabled, cacheStats, clearCache, getAnswer, pruneCache, putAnswer,
  setCacheDays, setCacheEnabled, DEFAULT_DAYS,
} from "./answerCache.ts";

const base = {
  model: "openai/gpt-oss-20b",
  task: "<task>What does acme.com sell?</task>",
  system: "You fill in ONE cell.",
  valueType: "text",
  enumValues: null,
  tools: ["fetch_url"],
};

function fresh(): void {
  clearCache();
  setCacheEnabled(true);
  setCacheDays(DEFAULT_DAYS);
}

// ── the key ─────────────────────────────────────────────────────────────────

test("the same question gives the same key", () => {
  assert.equal(answerKey(base), answerKey({ ...base }));
});

test("a different MODEL is a different question", () => {
  // Two models do not answer alike, and sharing an answer between them would silently attribute one
  // model's output to a column that chose the other.
  assert.notEqual(answerKey(base), answerKey({ ...base, model: "anthropic:claude-haiku" }));
});

test("a different instruction, record or system prompt is a different question", () => {
  assert.notEqual(answerKey(base), answerKey({ ...base, task: base.task + " " }));
  assert.notEqual(answerKey(base), answerKey({ ...base, system: "Different standing instruction." }));
});

test("a different value TYPE is a different question", () => {
  // "42" as text and 42 as a number are not the same answer, and the coercion happens after.
  assert.notEqual(answerKey(base), answerKey({ ...base, valueType: "number" }));
});

test("different enum options are a different question", () => {
  assert.notEqual(
    answerKey({ ...base, valueType: "enum", enumValues: ["a", "b"] }),
    answerKey({ ...base, valueType: "enum", enumValues: ["a", "c"] }),
  );
});

test("being ABLE to search the web is a different question, even word for word", () => {
  // An agent that could look it up did not answer the same question as one that could not.
  assert.notEqual(answerKey(base), answerKey({ ...base, tools: ["fetch_url", "web_search"] }));
});

test("the order tools happen to be stored in is not part of the question", () => {
  assert.equal(
    answerKey({ ...base, tools: ["web_search", "fetch_url"] }),
    answerKey({ ...base, tools: ["fetch_url", "web_search"] }),
  );
});

test("two different questions cannot collide by running together", () => {
  // Fields are length-prefixed, so a boundary that moves cannot produce the same string. Joined by a
  // separator, these two would hash identically — and any separator can appear inside a prompt.
  assert.notEqual(
    answerKey({ ...base, model: "ab", task: "cd" }),
    answerKey({ ...base, model: "a", task: "bcd" }),
  );
});

// ── storing and reading ─────────────────────────────────────────────────────

test("an answer is stored and read back", () => {
  fresh();
  const k = answerKey(base);
  putAnswer(k, { status: "done", valueText: "Software" });
  const got = getAnswer(k);
  assert.equal(got?.valueText, "Software");
  assert.equal(got?.status, "done");
});

test("not_found is cached too, because proving an absence is expensive", () => {
  fresh();
  const k = answerKey({ ...base, task: "absent" });
  putAnswer(k, { status: "not_found", valueText: null });
  const got = getAnswer(k);
  assert.equal(got?.status, "not_found");
  assert.equal(got?.valueText, null);
});

test("an ERROR is never cached, whatever it was", () => {
  // The whole rule. A rate limit or a bad key says nothing about the question — caching one would
  // turn a five-minute outage into a permanent wrong answer on every row that asked during it.
  fresh();
  const k = answerKey({ ...base, task: "errored" });
  putAnswer(k, { status: "error", valueText: "429 rate limited" } as never);
  putAnswer(k, { status: "skipped", valueText: null } as never);
  assert.equal(getAnswer(k), null);
});

test("a hit is counted, so the setting can be judged rather than assumed", () => {
  fresh();
  const k = answerKey({ ...base, task: "counted" });
  putAnswer(k, { status: "done", valueText: "x" });
  getAnswer(k); getAnswer(k); getAnswer(k);
  assert.equal(cacheStats().hits, 3);
});

test("re-answering refreshes the date rather than keeping the first one", () => {
  // The fact was just re-derived, so it is as new as the run that produced it. Keeping the original
  // date would expire something verified seconds ago.
  fresh();
  const k = answerKey({ ...base, task: "refreshed" });
  db.prepare(
    "INSERT INTO answer_cache (key, status, value_text, created_at) VALUES (?, 'done', 'old', datetime('now','-100 days'))",
  ).run(k);
  assert.equal(getAnswer(k), null, "100 days old is past the default expiry");
  putAnswer(k, { status: "done", valueText: "new" });
  assert.equal(getAnswer(k)?.valueText, "new");
});

// ── expiry ──────────────────────────────────────────────────────────────────

test("an answer past its expiry is not served", () => {
  // Most of what this tool asks is a fact about the world on the day it was asked. An answer with no
  // expiry is not a cache, it is a slowly rotting copy of the internet.
  fresh();
  const k = answerKey({ ...base, task: "stale" });
  db.prepare(
    "INSERT INTO answer_cache (key, status, value_text, created_at) VALUES (?, 'done', 'ancient', datetime('now','-90 days'))",
  ).run(k);
  assert.equal(getAnswer(k), null);
  // Still on disk and counted as stale, rather than vanishing without trace.
  assert.ok(cacheStats().stale >= 1);
});

test("a shorter expiry takes effect immediately, on answers already stored", () => {
  fresh();
  const k = answerKey({ ...base, task: "shrinking" });
  db.prepare(
    "INSERT INTO answer_cache (key, status, value_text, created_at) VALUES (?, 'done', 'v', datetime('now','-10 days'))",
  ).run(k);
  assert.ok(getAnswer(k), "ten days old is fine at the default");
  setCacheDays(5);
  assert.equal(getAnswer(k), null, "and gone the moment the window is five");
  setCacheDays(DEFAULT_DAYS);
});

test("an expiry of zero is refused, because it is the off switch under another name", () => {
  // Two ways to turn something off is how one of them stops being tested.
  assert.throws(() => setCacheDays(0), /at least one day|switch/i);
  assert.throws(() => setCacheDays(-3), /at least one day|switch/i);
  assert.equal(cacheDays(), DEFAULT_DAYS);
});

test("pruning removes the expired and keeps the rest", () => {
  fresh();
  const good = answerKey({ ...base, task: "keep" });
  const old = answerKey({ ...base, task: "drop" });
  putAnswer(good, { status: "done", valueText: "keep" });
  db.prepare(
    "INSERT INTO answer_cache (key, status, value_text, created_at) VALUES (?, 'done', 'drop', datetime('now','-400 days'))",
  ).run(old);
  assert.equal(pruneCache(), 1);
  assert.ok(getAnswer(good));
});

test("an expired entry is eventually removed, not just skipped forever", async () => {
  // `pruneCache` had no caller anywhere in the engine, so an entry past its expiry could never be
  // served again and was never deleted either — dead rows, counted as stale and carried for the life
  // of the file. Storing an answer is what grows the table, so it is what sweeps it.
  fresh();
  const old = answerKey({ ...base, task: "swept" });
  db.prepare(
    "INSERT INTO answer_cache (key, status, value_text, created_at) VALUES (?, 'done', 'ancient', datetime('now','-400 days'))",
  ).run(old);
  // The sweep runs at most once a day; clearing the stamp is what makes this write the due one.
  db.prepare("DELETE FROM kv WHERE k = 'cache.answers.pruned_at'").run();

  const live = answerKey({ ...base, task: "sweep-trigger" });
  putAnswer(live, { status: "done", valueText: "kept" });
  // Deferred to a later tick on purpose, so the delete never sits in front of a waiting run.
  await new Promise((r) => setTimeout(r, 20));

  const left = Number((db.prepare("SELECT COUNT(*) AS c FROM answer_cache WHERE key = ?").get(old) as any).c);
  assert.equal(left, 0, "the expired entry is off disk, not merely unreadable");
  assert.equal(getAnswer(live)?.valueText, "kept", "and a live answer is untouched by the sweep");
});

// ── the switch ──────────────────────────────────────────────────────────────

test("switched off, nothing is read and nothing is written", () => {
  fresh();
  const k = answerKey({ ...base, task: "off" });
  putAnswer(k, { status: "done", valueText: "stored" });

  setCacheEnabled(false);
  assert.equal(cacheEnabled(), false);
  assert.equal(getAnswer(k), null, "an existing answer is not served");

  putAnswer(answerKey({ ...base, task: "while-off" }), { status: "done", valueText: "no" });
  setCacheEnabled(true);
  assert.equal(getAnswer(answerKey({ ...base, task: "while-off" })), null, "and nothing was written");
  // The original survived being switched off — it was not deleted, only ignored.
  assert.equal(getAnswer(k)?.valueText, "stored");
});

test("clearing reports how many it threw away", () => {
  fresh();
  putAnswer(answerKey({ ...base, task: "a" }), { status: "done", valueText: "1" });
  putAnswer(answerKey({ ...base, task: "b" }), { status: "done", valueText: "2" });
  assert.equal(clearCache(), 2);
  assert.equal(cacheStats().entries, 0);
});
