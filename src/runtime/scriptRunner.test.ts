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

test("the sandbox holds no host object, so no expression compiles its way back to process", async () => {
  const f = fixture("sandbox-realm", [{ Company: "X", Website: "https://x.com", Country: "US" }]);
  const out = addColumn(f.sheet.id, { name: "Realm", kind: "script" });

  // `Object.constructor` IS `Function`. When the sandbox was populated with THIS realm's built-ins,
  // that was the host `Function` — codeGeneration:{strings:false} does not apply to it — and one
  // expression got the whole Node API. The row object was the same hole by another door.
  for (const attempt of [
    `function transform(){ return String(Object.constructor("return process")().pid); }`,
    `function transform(){ return String(Object.keys(JSON.constructor.constructor("return process")().env).length); }`,
    `function transform(){ return String([].constructor.constructor("return process")().version); }`,
    `function transform(row){ return String(row.constructor.constructor("return process")().pid); }`,
  ]) {
    const res = await runScriptColumn({
      sheetId: f.sheet.id, columnId: Number(out.id), refColumnIds: [f.colIds[0]!],
      code: attempt, runtime: "js", hook: "transform", rowIds: f.rowIds,
    });
    assert.equal(res.errors, 1, `escape attempt should fail: ${attempt}`);

    const cell = db.prepare("SELECT status, value_text FROM cells WHERE column_id = ? LIMIT 1")
      .get(Number(out.id)) as any;
    assert.equal(cell.status, "error");
    assert.equal(cell.value_text, null, "nothing from the host realm may end up in a cell");
  }
});

test("URL still works inside the sandbox, built from the context's own realm", async () => {
  const f = fixture("sandbox-url", [{ Company: "X", Website: "https://a.example.com/x?q=hi+there&q=2", Country: "US" }]);
  const out = addColumn(f.sheet.id, { name: "Parsed", kind: "script" });

  const code = `
    function transform(row) {
      const u = new URL(row.website);
      return [u.hostname, u.pathname, u.searchParams.get("q"), u.searchParams.getAll("q").length].join("|");
    }`;

  const res = await runScriptColumn({
    sheetId: f.sheet.id, columnId: Number(out.id), refColumnIds: [f.colIds[1]!],
    code, runtime: "js", hook: "transform", rowIds: f.rowIds,
  });

  assert.equal(res.errors, 0);
  const cell = db.prepare("SELECT value_text FROM cells WHERE column_id = ? LIMIT 1").get(Number(out.id)) as any;
  assert.equal(cell.value_text, "a.example.com|/x|hi there|2");
});

test("a transform that returns nothing is not_found — never a `done` cell holding no value", async () => {
  const f = fixture("script-null-return", [
    { Company: "Keep", Website: "https://keep.com", Country: "US" },
    { Company: "Drop", Website: "https://drop.com", Country: "US" },
  ]);
  const out = addColumn(f.sheet.id, { name: "Maybe", kind: "script" });

  const code = `function transform(row) { return row.company === "Keep" ? "kept" : null; }`;
  const args = {
    sheetId: f.sheet.id, columnId: Number(out.id), refColumnIds: [f.colIds[0]!],
    code, runtime: "js" as const, hook: "transform" as const, rowIds: f.rowIds, skipUnchanged: true,
  };

  const first = await runScriptColumn(args);
  assert.equal(first.processed, 2);

  const rows = db.prepare("SELECT status, value_text, input_hash FROM cells WHERE column_id = ? ORDER BY row_id")
    .all(Number(out.id)) as any[];
  assert.equal(rows[0].status, "done");
  assert.equal(rows[0].value_text, "kept");
  assert.notEqual(rows[1].status, "done", "an empty answer must not wear the status a real answer wears");
  assert.equal(rows[1].status, "not_found");
  assert.equal(rows[1].value_text, null);
  assert.equal(rows[1].input_hash, null, "only a done cell records its inputs, so the retry can reach it");

  // The point of the status: the next pass must still be able to reach that row.
  const second = await runScriptColumn(args);
  assert.equal(second.skipped, 1, "the real answer is left alone");
  assert.equal(second.processed, 1, "the empty one is computed again rather than skipped forever");
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
