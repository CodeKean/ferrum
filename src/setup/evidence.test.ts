// What the model is told about the table, and what it is NOT told.
//
// These matter because the evidence is the whole input to a decision that then runs on every row. A
// proposal built from a misleading picture is not a small error — it is a million cells of it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSheet, addColumn, insertRows } from "../store.ts";
import { db } from "../db.ts";
import { gatherEvidence, describeEvidence } from "./evidence.ts";

/** `fillDomainEvery` of 0 fills nothing — `i % 999` is still true at i = 0, which is not "empty". */
function fixture(name: string, rows: number, fillDomainEvery = 1) {
  const sheet = createSheet(name);
  const company = addColumn(sheet.id, { name: "Company", kind: "static", valueType: "text" });
  const domain = addColumn(sheet.id, { name: "Domain", kind: "static", valueType: "url" });
  const ids = [Number(company.id), Number(domain.id)];

  const batch = Array.from({ length: rows }, (_, i) => ({
    values: {
      [ids[0]!]: `Company ${i}`,
      // Two shapes on purpose, and only some rows filled: both are facts one sample row cannot show.
      ...(fillDomainEvery > 0 && i % fillDomainEvery === 0
        ? { [ids[1]!]: i % 2 === 0 ? `acme-${i}.com` : `https://acme-${i}.com/about` }
        : {}),
    },
  }));
  insertRows(sheet.id, batch, 0, ids);
  return { sheet, company, domain, ids };
}

test("a half-empty column reads as half empty, which one sample row could never show", () => {
  // The defect this replaced: the setup panel was given ONE row. A column filled on 50% of rows and
  // a column filled on 100% of rows look identical through one non-empty sample, so a proposal would
  // happily reference a column that has nothing in it for half the table — and every one of those
  // rows then skips, or worse, runs and answers from nothing.
  const f = fixture("ev-half", 40, 2);
  const ev = gatherEvidence(f.sheet.id)!;
  const domain = ev.columns.find((c) => c.name === "Domain")!;

  assert.equal(ev.rowCount, 40);
  assert.equal(domain.filled, 20);
  assert.ok(Math.abs((domain.fillRate ?? 0) - 0.5) < 0.01, `expected about 50%, got ${domain.fillRate}`);
  assert.match(describeEvidence(ev), /\/Domain \(url, static\) — 50% filled/);
});

test("an empty column says EMPTY, because 'no example' and 'nothing in it' are different problems", () => {
  const f = fixture("ev-empty", 10, 0);
  const text = describeEvidence(gatherEvidence(f.sheet.id)!);
  assert.match(text, /\/Domain \(url, static\) — EMPTY — nothing in it/);
});

test("a sheet with no rows says so, rather than reporting 0% filled", () => {
  // Zero percent means "this column has never produced anything", and it leads somewhere useful:
  // propose the column that would fill it. "There are no rows" leads somewhere else entirely.
  const sheet = createSheet("ev-norows");
  addColumn(sheet.id, { name: "Company", kind: "static", valueType: "text" });
  addColumn(sheet.id, { name: "Domain", kind: "static", valueType: "url" });
  const ev = gatherEvidence(sheet.id)!;
  assert.equal(ev.columns[0]!.fillRate, null);
  assert.match(describeEvidence(ev), /no rows yet/);
});

test("samples show the VARIATION in a column, not four copies of one shape", () => {
  // `acme.com` and `https://acme.com/about` in one column mean a rule has to normalize before it can
  // match. Shown one of them, the model writes something that works on that shape and fails on the
  // rest of the table.
  const f = fixture("ev-shapes", 40);
  const domain = gatherEvidence(f.sheet.id)!.columns.find((c) => c.name === "Domain")!;
  assert.ok(domain.samples.length > 1, "more than one example, or variation is invisible");
  assert.ok(domain.samples.some((s) => s.startsWith("https://")), "the long shape is represented");
  assert.ok(domain.samples.some((s) => !s.startsWith("https://")), "the bare shape is represented");
});

test("the evidence does not grow with the table", () => {
  // The bound that makes this safe to send at all: a million-row sheet must not become a million-row
  // prompt. Four values per column whatever the size.
  const small = gatherEvidence(fixture("ev-small", 6).sheet.id)!;
  const big = gatherEvidence(fixture("ev-big", 500).sheet.id)!;
  for (const c of [...small.columns, ...big.columns]) {
    assert.ok(c.samples.length <= 4, `${c.name} shipped ${c.samples.length} samples`);
  }
  // And each value is length-capped, so one enormous JSON cell cannot blow up the prompt either.
  assert.ok(big.columns.every((c) => c.samples.every((s) => s.length <= 90)));
});

test("samples come from across the sheet, not only from the top", () => {
  // The first rows of an imported table are the ones the person who built the CSV looked at, so they
  // are the cleanest. Sampling only there is how a rule gets written against the tidiest twelve rows
  // of a million and then fails at row 40,000.
  const f = fixture("ev-spread", 400);
  const domain = gatherEvidence(f.sheet.id)!.columns.find((c) => c.name === "Domain")!;
  const indexes = domain.samples.map((s) => Number(/(\d+)/.exec(s)?.[1] ?? -1));
  assert.ok(Math.max(...indexes) > 50, `all samples came from the first rows: ${domain.samples.join(", ")}`);
});

test("errors already on a column are part of the picture", () => {
  // The setup panel is where a broken column gets fixed, so it is the surface that most needs to
  // know the column is broken. It had no access to this at all — only the chat did.
  const f = fixture("ev-errors", 12);
  db.prepare("UPDATE cells SET status = 'error', error_msg = 'No API key in the Authorization header' WHERE column_id = ?")
    .run(Number(f.domain.id));
  const text = describeEvidence(gatherEvidence(f.sheet.id)!);
  assert.match(text, /failing on 12 rows: No API key/);
});

test("three wordings of one problem are counted as one problem", () => {
  // The reason the class histogram exists. Every provider phrases a rejected key differently, so the
  // message list shows three failures where there is one — and it caps at three messages, so a
  // column failing four ways loses the fourth entirely. The class is the engine's own verdict, and
  // it does not care how the provider phrased it.
  const f = fixture("ev-classes", 12);
  const col = Number(f.domain.id);
  const set = (n: number, offset: number, type: string, msg: string) =>
    db.prepare(
      `UPDATE cells SET status = 'error', error_type = ?, error_msg = ?
        WHERE column_id = ? AND row_id IN (
          SELECT row_id FROM cells WHERE column_id = ? ORDER BY row_id LIMIT ? OFFSET ?)`,
    ).run(type, msg, col, col, n, offset);

  set(3, 0, "auth", "No API key in the Authorization header");
  set(3, 3, "auth", "401 Unauthorized");
  set(3, 6, "auth", "invalid_api_key: the supplied credential was rejected");
  set(3, 9, "timeout", "socket hang up after 30000ms");

  const ev = gatherEvidence(f.sheet.id)!;
  const domain = ev.columns.find((c) => c.name === "Domain")!;
  assert.deepEqual(domain.errorTypes, [{ type: "auth", rows: 9 }, { type: "timeout", rows: 3 }]);

  const text = describeEvidence(ev);
  assert.match(text, /failures by kind: 9 auth, 3 timeout/);
  // Meanwhile the message list, from the same 12 cells: four distinct wordings, capped at three, so
  // one is dropped outright and the three that survive read as three separate problems when nine of
  // those rows share a single cause and a single fix. Which one is dropped depends on how SQLite
  // breaks a tie, so this asserts the count and not the contents — the point is that the wording
  // list cannot answer "how many things are wrong here" and the class list can.
  assert.equal(domain.failures.length, 3);
  assert.equal(domain.errorTypes.length, 2, "two causes, however many ways they were phrased");
});

test("a clean column carries no failure lines at all", () => {
  // An empty array, not an absent field: a consumer that spreads this into a prompt must be able to
  // ask its length without a guard, and "no errors" must never read as "errors unknown".
  const f = fixture("ev-clean", 6);
  const ev = gatherEvidence(f.sheet.id)!;
  for (const c of ev.columns) assert.deepEqual(c.errorTypes, []);
  assert.doesNotMatch(describeEvidence(ev), /failures by kind/);
});

test("a column is never shown a reference to itself", () => {
  const f = fixture("ev-self", 5);
  const text = describeEvidence(gatherEvidence(f.sheet.id)!, f.domain.id);
  assert.ok(!text.includes("/Domain"), "the column being configured must not appear in its own options");
  assert.ok(text.includes("/Company"));
});
