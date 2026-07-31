// What a run will cost, before it starts.
//
// The number this produces is the one a person approves a run on, so the failure that matters is
// the one that reports LESS than the truth. A declared third-party rate going missing here was
// exactly that: an HTTP column that had been told "2 credits a call, 1,000 credits for $49"
// estimated at $0, and the dialog whose whole job is to say what a run will spend said nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateRun } from "./estimate.ts";
import { createSheet } from "./store.ts";
import { addColumn, setColumnHttpConfig } from "./store.ts";
import { normalizeHttpConfig, DEFAULT_HTTP } from "./http/httpColumn.ts";
import { getColumn } from "./store.ts";

function httpColumn(cost: unknown) {
  const s = createSheet(`ZZ est ${Math.random().toString(36).slice(2, 7)}`);
  const c = addColumn(s.id, { name: "ZZ call", kind: "http", valueType: "text" });
  setColumnHttpConfig(
    Number(c.id),
    normalizeHttpConfig({ ...DEFAULT_HTTP, url: "https://api.example.com/x", cost }) as never,
  );
  return getColumn(Number(c.id))!;
}

test("a declared rate reaches the estimate", async () => {
  const col = httpColumn({ unit: "credits", perCall: 2, packUnits: 1000, packUsd: 49 });
  const est = await estimateRun([col], 1000);
  // 2 credits a call at $0.049 per credit-pair → $0.098 a row, $98 over a thousand rows.
  assert.ok(Math.abs(est.total - 98) < 0.001, `got ${est.total}`);
  assert.equal(est.free, false);
  assert.equal(est.external, true, "the money still leaves through someone else's account");
});

test("an undeclared API column is still not called free", async () => {
  const col = httpColumn(undefined);
  const est = await estimateRun([col], 1000);
  assert.equal(est.total, 0, "nothing is invented");
  assert.equal(est.free, false, "but 'we cannot price this' is not 'this is free'");
  assert.equal(est.external, true);
});
