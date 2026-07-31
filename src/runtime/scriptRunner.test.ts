// Tests for the claims the script lane rests on. Each of these guards a failure that is silent —
// the wrong behaviour still produces correct-looking output, just catastrophically slowly or
// dangerously.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.ts";
import { addColumn, createSheet, insertRows, listColumns } from "../store.ts";
import { runScriptColumn } from "./scriptRunner.ts";
import { approveScript, assertRunnable, hashCode, saveScript } from "../scripts.ts";

function fixture(name: string, rows: Array<Record<string, string>>) {
  const sheet = createSheet(name);
  const cols = ["Company", "Website", "Country"].map((n) => addColumn(sheet.id, { name: n }));
  const colIds = cols.map((c) => Number(c.id));
  const batch = rows.map((r) => ({
    values: Object.fromEntries(cols.map((c, i) => [String(colIds[i]), r[c.name] ?? ""])),
  }));
  insertRows(sheet.id, batch, 0, colIds);
  const rowIds = (db.prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY position").all(sheet.id) as any[])
    .map((r) => Number(r.id));
  return { sheet, cols, colIds, rowIds };
}

test("js transform runs the whole column in one worker, with zero process spawns", async () => {
  const f = fixture("js-transform", [
    { Company: "Acme", Website: "https://www.acme.com/pricing", Country: "US" },
    { Company: "Beta", Website: "http://beta.io", Country: "UK" },
    { Company: "Gamma", Website: "", Country: "DE" },
  ]);
  const out = addColumn(f.sheet.id, { name: "Domain", kind: "script" });

  const code = `
    function transform(row) {
      if (!row.website) return null;
      try { return new URL(row.website).hostname.replace(/^www\\./, "").toLowerCase(); }
      catch { return null; }
    }`;

  const res = await runScriptColumn({
    sheetId: f.sheet.id,
    columnId: Number(out.id),
    refColumnIds: [f.colIds[1]!],
    code,
    runtime: "js",
    hook: "transform",
    rowIds: f.rowIds,
  });

  assert.equal(res.processed, 3);
  assert.equal(res.errors, 0);
  assert.equal(res.spawns, 0, "the JS runtime must not spawn a process");

  const values = (db.prepare("SELECT value_text, status FROM cells WHERE column_id = ? ORDER BY row_id")
    .all(Number(out.id)) as any[]);
  assert.equal(values[0].value_text, "acme.com");
  assert.equal(values[1].value_text, "beta.io");
  assert.equal(values[2].value_text, null);
});

test("one bad row fails only itself — the rest of the column still completes", async () => {
  const f = fixture("js-partial-failure", [
    { Company: "Good", Website: "https://good.com", Country: "US" },
    { Company: "Bad", Website: "https://bad.com", Country: "US" },
    { Company: "Also good", Website: "https://ok.com", Country: "US" },
  ]);
  const out = addColumn(f.sheet.id, { name: "Flag", kind: "script" });

  const code = `
    function transform(row) {
      if (row.company === "Bad") throw new Error("boom");
      return row.company.toUpperCase();
    }`;

  const res = await runScriptColumn({
    sheetId: f.sheet.id, columnId: Number(out.id), refColumnIds: [f.colIds[0]!],
    code, runtime: "js", hook: "transform", rowIds: f.rowIds,
  });

  assert.equal(res.processed, 3);
  assert.equal(res.errors, 1);
  const rows = db.prepare("SELECT status, value_text FROM cells WHERE column_id = ? ORDER BY row_id").all(Number(out.id)) as any[];
  assert.equal(rows[0].status, "done");
  assert.equal(rows[1].status, "error");
  assert.equal(rows[2].status, "done", "a failure must not abort the rows after it");
});

test("condition hook gates rows: false becomes skipped, so nothing downstream spends on them", async () => {
  const f = fixture("condition-gate", [
    { Company: "A", Website: "https://a.com", Country: "US" },
    { Company: "B", Website: "https://b.com", Country: "FR" },
    { Company: "C", Website: "https://c.com", Country: "CA" },
  ]);
  const gate = addColumn(f.sheet.id, { name: "Qualifies", kind: "script" });

  const code = `function condition(row) { return row.country === "US" || row.country === "CA"; }`;

  await runScriptColumn({
    sheetId: f.sheet.id, columnId: Number(gate.id), refColumnIds: [f.colIds[2]!],
    code, runtime: "js", hook: "condition", rowIds: f.rowIds,
  });

  const rows = db.prepare("SELECT status, note FROM cells WHERE column_id = ? ORDER BY row_id").all(Number(gate.id)) as any[];
  assert.equal(rows[0].status, "done");
  assert.equal(rows[1].status, "skipped");
  assert.equal(rows[1].note, "condition returned false");
  assert.equal(rows[2].status, "done");
});

test("the vm context denies filesystem and network reach-out", async () => {
  const f = fixture("sandbox", [{ Company: "X", Website: "https://x.com", Country: "US" }]);
  const out = addColumn(f.sheet.id, { name: "Escape", kind: "script" });

  // Each of these is a plausible thing a compromised or careless script would try.
  for (const attempt of [
    `function transform(){ return require("fs").readFileSync("C:/Windows/win.ini","utf8"); }`,
    `function transform(){ return typeof process.env.ANTHROPIC_API_KEY; }`,
    `function transform(){ return fetch("http://example.com"); }`,
    `function transform(){ return new Function("return 1")(); }`,
  ]) {
    const res = await runScriptColumn({
      sheetId: f.sheet.id, columnId: Number(out.id), refColumnIds: [f.colIds[0]!],
      code: attempt, runtime: "js", hook: "transform", rowIds: f.rowIds,
    });
    assert.equal(res.errors, 1, `escape attempt should fail: ${attempt}`);
  }
});

test("approval is pinned to the exact bytes — editing the code voids it", () => {
  const f = fixture("approval", [{ Company: "A", Website: "https://a.com", Country: "US" }]);
  const col = addColumn(f.sheet.id, { name: "Slug", kind: "script" });

  const saved = saveScript({
    sheetId: f.sheet.id, columnId: Number(col.id), hook: "transform", runtime: "js",
    intent: "lowercase the company name",
    code: `function transform(row){ return (row.company||"").toLowerCase(); }`,
  });
  assert.deepEqual(saved.errors, []);

  // Unapproved code must not run.
  assert.throws(() => assertRunnable(saved.script.id), /not been approved/);

  // Approving with the wrong hash is refused — you cannot approve bytes you did not read.
  assert.equal(approveScript(Number(saved.script.id), "wronghash").ok, false);

  assert.equal(approveScript(Number(saved.script.id), saved.script.hash).ok, true);
  assert.ok(assertRunnable(saved.script.id));

  // Swap the stored code behind the approval — the hash check must catch it and revoke.
  const tampered = `function transform(row){ return "pwned"; }`;
  db.prepare("UPDATE scripts SET code = ? WHERE id = ?").run(tampered, Number(saved.script.id));
  assert.notEqual(hashCode(tampered), saved.script.hash);
  assert.throws(() => assertRunnable(saved.script.id), /does not match its approved hash/);
});

test("a shell script that does not stream is rejected at save time", () => {
  const f = fixture("stream-shape", [{ Company: "A", Website: "https://a.com", Country: "US" }]);
  const col = addColumn(f.sheet.id, { name: "Sh", kind: "script" });

  // Handles one value — would become one process per row.
  const perRow = saveScript({
    sheetId: f.sheet.id, columnId: Number(col.id), hook: "transform", runtime: "powershell",
    intent: "uppercase", code: `Write-Output $args[0].ToUpper()`,
  });
  assert.ok(perRow.errors.some((e) => /stream|NDJSON|per row/i.test(e)));

  // Reads the whole stream — accepted.
  const streamed = saveScript({
    sheetId: f.sheet.id, columnId: Number(col.id), hook: "transform", runtime: "powershell",
    intent: "uppercase",
    code: `$input | ForEach-Object { $r = $_ | ConvertFrom-Json; [pscustomobject]@{rowId=$r.rowId; value=$r.values.company.ToUpper()} | ConvertTo-Json -Compress }`,
  });
  assert.deepEqual(streamed.errors, []);
});
