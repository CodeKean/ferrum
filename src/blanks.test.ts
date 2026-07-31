// Why is this column empty — and the one property that makes the answer trustworthy.
//
// A breakdown that does not add up to the total is worse than no breakdown: it looks complete, it
// gets believed, and the rows it lost are exactly the ones nobody then goes looking for. So the
// central assertion here is arithmetic — every blank row is in some group, or is counted in the
// stated overflow. Nothing vanishes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { addColumn, createSheet, insertRows, readWindow } from "./store.ts";
import { explainBlanks } from "./blanks.ts";

function scenario(tag: string) {
  const sheet = createSheet(`blanks-${tag}`);
  const domain = addColumn(sheet.id, { name: "Domain", kind: "static", valueType: "url" });
  const out = addColumn(sheet.id, { name: "Industry", kind: "ai", valueType: "text" });
  insertRows(
    sheet.id,
    Array.from({ length: 10 }, (_, i) => ({ values: { [String(domain.id)]: `c${i}.com` } })),
    0,
    [Number(domain.id)],
  );
  const rows = (db.prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY position").all(sheet.id) as any[])
    .map((r) => Number(r.id));
  return { sheet, domain, out, rows };
}

/** Write a cell outcome straight in, the way the run engine would. */
function put(rowId: number, columnId: number, patch: Record<string, string | number | null>) {
  const fields = Object.keys(patch);
  db.prepare(
    `INSERT INTO cells (row_id, column_id, ${fields.join(", ")})
     VALUES (?, ?, ${fields.map(() => "?").join(", ")})
     ON CONFLICT(row_id, column_id) DO UPDATE SET ${fields.map((f) => `${f} = excluded.${f}`).join(", ")}`,
  ).run(rowId, columnId, ...Object.values(patch));
}

test("a column nothing has run on says so, rather than reporting an unexplained blank", () => {
  const s = scenario("neverrun");
  const r = explainBlanks(Number(s.out.id));

  assert.equal(r.total, 10);
  assert.equal(r.filled, 0);
  assert.equal(r.blank, 10);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0]!.kind, "never_run");
  assert.equal(r.groups[0]!.count, 10);
  assert.equal(r.groups[0]!.fixedByRerunning, true, "this is the one case where re-running IS the fix");
  assert.equal(r.groups[0]!.sampleRows.length, 3);
});

test("the four reasons a blank is blank are kept apart, with the counts exact", () => {
  const s = scenario("kinds");
  const col = Number(s.out.id);

  // 3 filled.
  for (const id of s.rows.slice(0, 3)) put(id, col, { status: "done", value_text: "Software" });
  // 2 skipped for a missing upstream — the engine's own sentence.
  for (const id of s.rows.slice(3, 5)) {
    put(id, col, { status: "skipped", error_msg: "Nothing in /Website for this row." });
  }
  // 1 gated by a run condition. Same status, DIFFERENT cause — the distinction this exists for.
  put(s.rows[5]!, col, { status: "skipped", error_msg: "condition returned false" });
  // 2 looked and found nothing.
  for (const id of s.rows.slice(6, 8)) put(id, col, { status: "not_found" });
  // 1 broke.
  put(s.rows[8]!, col, { status: "error", error_type: "provider", error_msg: "502 from the provider" });
  // 1 never touched.

  const r = explainBlanks(col);
  assert.equal(r.filled, 3);
  assert.equal(r.blank, 7);

  const by = (k: string, msg?: string) =>
    r.groups.find((g) => g.kind === k && (msg === undefined || g.message === msg));

  assert.equal(by("skipped", "Nothing in /Website for this row.")?.count, 2);
  assert.equal(by("skipped", "condition returned false")?.count, 1,
    "a gated row and a row with no input are both 'skipped' and are not the same problem");
  assert.equal(by("not_found")?.count, 2);
  assert.equal(by("error")?.count, 1);
  assert.equal(by("never_run")?.count, 1);

  // The arithmetic. Every blank row is accounted for somewhere.
  const counted = r.groups.reduce((n, g) => n + g.count, 0) + r.moreRows;
  assert.equal(counted, r.blank, "the breakdown must add up to the number of blanks");
});

test("re-running is not offered as the fix for the reasons it does not fix", () => {
  const s = scenario("advice");
  const col = Number(s.out.id);
  put(s.rows[0]!, col, { status: "not_found" });
  put(s.rows[1]!, col, { status: "skipped", error_msg: "Nothing in /Website for this row." });
  put(s.rows[2]!, col, { status: "blocked" });
  put(s.rows[3]!, col, { status: "error", error_msg: "boom" });

  const r = explainBlanks(col);
  const kind = (k: string) => r.groups.find((g) => g.kind === k)!;

  // The three that a re-run will reproduce exactly, at exactly the same cost.
  assert.equal(kind("not_found").fixedByRerunning, false);
  assert.equal(kind("skipped").fixedByRerunning, false);
  assert.equal(kind("blocked").fixedByRerunning, false);
  // The one it genuinely might.
  assert.equal(kind("error").fixedByRerunning, true);

  for (const g of r.groups) assert.ok(g.advice.length > 0, `${g.kind} must say what to do`);
});

test("a rejected key is not advertised as fixed by re-running", () => {
  // The bug this replaced. `"error"` sat in RERUN_HELPS wholesale, so EVERY failing group — a dead
  // API key, a hit spending cap, a wrong-shaped answer — was reported as "re-running fixes this".
  // The engine's own retryPolicy refuses all three outright, so the one screen whose entire job is
  // to say whether pressing the button helps was sending people to press it, for a wait each time
  // and, on a paid lane, a bill.
  const s = scenario("classadvice");
  const col = Number(s.out.id);
  put(s.rows[0]!, col, { status: "error", error_type: "auth", error_msg: "401 unauthorized" });
  put(s.rows[1]!, col, { status: "error", error_type: "overloaded", error_msg: "503 busy" });

  const r = explainBlanks(col);
  const auth = r.groups.find((g) => g.errorType === "auth")!;
  const busy = r.groups.find((g) => g.errorType === "overloaded")!;

  assert.equal(auth.fixedByRerunning, false, "a rejected key fails identically every time");
  assert.equal(busy.fixedByRerunning, true, "a busy provider genuinely does clear");
});

test("two kinds of failure get two kinds of advice, not one shrug", () => {
  // `ADVICE.error` was "It ran and broke. The message says what happened." for every class alike.
  // 400 cells failing on a rejected key and 400 on a wrong-shaped answer are two different
  // afternoons, and the class that distinguishes them was already stored and read by nothing.
  const s = scenario("classadvice2");
  const col = Number(s.out.id);
  put(s.rows[0]!, col, { status: "error", error_type: "auth", error_msg: "401" });
  put(s.rows[1]!, col, { status: "error", error_type: "schema", error_msg: "bad shape" });

  const r = explainBlanks(col);
  const auth = r.groups.find((g) => g.errorType === "auth")!;
  const schema = r.groups.find((g) => g.errorType === "schema")!;

  assert.notEqual(auth.advice, schema.advice);
  assert.match(auth.advice, /key/i);
  assert.doesNotMatch(auth.advice, /message says what happened/i);
});

test("a skip caused by a condition and a skip caused by no input do not share one hedged sentence", () => {
  const s = scenario("skipkinds");
  const col = Number(s.out.id);
  put(s.rows[0]!, col, { status: "skipped", error_msg: "condition returned false" });
  put(s.rows[1]!, col, { status: "skipped", error_msg: "Nothing in /Website for this row." });

  const r = explainBlanks(col);
  const gated = r.groups.find((g) => g.message === "condition returned false")!;
  const noInput = r.groups.find((g) => g.message === "Nothing in /Website for this row.")!;

  // Both are "skipped" to the engine and they are opposite situations: one is the user's rule
  // working, the other is a problem. Offering "either A or B" next to a message that already says
  // which makes a correct gate read as a fault.
  assert.notEqual(gated.advice, noInput.advice);
  assert.match(gated.advice, /nothing is wrong/i);
  assert.match(noInput.advice, /optional|fill/i);
});

test("a cell that succeeded and returned nothing is blank, and is not filed as 'nothing found'", () => {
  const s = scenario("doneempty");
  const col = Number(s.out.id);
  put(s.rows[0]!, col, { status: "done", value_text: "Software" });
  put(s.rows[1]!, col, { status: "done", value_text: "" });
  put(s.rows[2]!, col, { status: "done", value_text: null });

  const r = explainBlanks(col);
  assert.equal(r.filled, 1, "two 'done' cells hold nothing and must not be counted as filled");
  const g = r.groups.find((x) => x.kind === "done")!;
  assert.equal(g.count, 2);
  assert.match(g.message ?? "", /returned nothing/);
  assert.ok(!r.groups.some((x) => x.kind === "not_found"),
    "'it looked and there is no answer' is a different claim and must not absorb this");
});

test("a long tail of one-off errors is truncated LOUDLY, so the numbers still add up", () => {
  const s = scenario("tail");
  const col = Number(s.out.id);
  // Ten distinct messages, one row each, against a variant limit of 3.
  s.rows.forEach((id, i) => put(id, col, { status: "error", error_type: "provider", error_msg: `failure ${i}` }));

  const r = explainBlanks(col, 3);
  assert.equal(r.groups.length, 3);
  assert.equal(r.moreReasons, 7, "the reasons not shown are stated, not dropped");
  assert.equal(r.moreRows, 7);
  const counted = r.groups.reduce((n, g) => n + g.count, 0) + r.moreRows;
  assert.equal(counted, r.blank, "a truncated breakdown must still account for every blank row");
});

test("a secret echoed into an error message is not handed back by this route", () => {
  const s = scenario("redact");
  const col = Number(s.out.id);
  // Written straight in, deliberately unredacted, standing in for a row stored before the write-side
  // redaction was in place. This reader must not be the thing that surfaces it.
  put(s.rows[0]!, col, { status: "error", error_msg: "401 for key sk-ant-api03-AAAABBBBCCCCDDDD" });

  const r = explainBlanks(col);
  const g = r.groups.find((x) => x.kind === "error")!;
  assert.ok(!/sk-ant-api03-AAAABBBBCCCCDDDD/.test(g.message ?? ""), "the key must not come back out");
});

test("the grid window redacts a stored secret, like the push path always has", () => {
  const s = scenario("windowredact");
  put(s.rows[0]!, Number(s.out.id), { status: "error", error_msg: "401 for key sk-ant-api03-EEEEFFFFGGGGHHHH" });

  const w = readWindow(s.sheet.id, 0, 5);
  const cell = w.rows[0]!.cells[String(s.out.id)]!;
  assert.ok(cell.m, "the message still comes through — this is not about hiding the error");
  assert.ok(!/sk-ant-api03-EEEEFFFFGGGGHHHH/.test(cell.m!),
    "the same value was scrubbed when pushed over SSE and not when fetched by the grid");
});

test("the explanation does not count another column's cells", () => {
  const s = scenario("scoped");
  put(s.rows[0]!, Number(s.out.id), { status: "error", error_msg: "mine" });
  put(s.rows[1]!, Number(s.domain.id), { status: "error", error_msg: "not mine" });

  const r = explainBlanks(Number(s.out.id));
  assert.equal(r.groups.find((g) => g.kind === "error")?.count, 1);
});
