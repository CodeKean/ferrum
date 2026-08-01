// What survives a `.ferrum.json` round trip — and what silently did not.
//
// The file format is a HAND-WRITTEN field list on both sides. That is the opposite of the workbook
// DUPLICATE path, which reads its fields from `PRAGMA table_info` precisely so a column added to the
// schema later cannot quietly stop being copied. Nobody applied the same reasoning to the file, and
// three things drifted out of it without a single failing test:
//
//   1. the importer's private column-kind list knew NINE of the eleven kinds, so a `waterfall` or
//      `wait` column arrived as `static`;
//   2. the serializer never wrote `waterfall_json`, `mcp_config` or `wait_seconds`, so even with the
//      right kind there was no configuration to land;
//   3. the importer inserted each script row and never pointed the column at it, so an imported
//      rule column produced nothing FOREVER — and the review gate became theatre, because approving
//      a script nothing reads changes nothing.
//
// Six of the eight tests here fail against the code as it was — checked by reverting the fix and
// running them, not by assuming. The other two ("degrades to static", "auto_run stays behind") pass
// both before and after ON PURPOSE: they guard behaviour that was already correct and that this
// change could plausibly have broken, since adding carriers to a copy is exactly when something
// gets carried that should not be.
//
// They are round trips rather than unit checks on the serializer because that is the only shape that
// would have caught any of the three defects: each half looked reasonable on its own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { addColumn, createSheet } from "./store.ts";
import { exportWorkbook, importWorkbook } from "./workbookCopy.ts";

function workbookWith(build: (sheetId: string) => void): any {
  const s = createSheet("Source");
  build(s.id);
  const doc = exportWorkbook(s.workbookId!);
  const imported = importWorkbook(doc, "Landed");
  const sheet = db
    .prepare("SELECT * FROM sheets WHERE workbook_id = ? AND deleted_at IS NULL ORDER BY position")
    .get(imported.workbook.id) as any;
  return {
    doc,
    imported,
    column: (name: string) =>
      db.prepare("SELECT * FROM columns WHERE sheet_id = ? AND name = ?").get(sheet.id, name) as any,
  };
}

// ── the kind list ───────────────────────────────────────────────────────────

test("a waterfall column arrives as a waterfall, not as an empty static column", () => {
  const steps = { steps: [{ kind: "ai", prompt: "Find the CEO" }], accept: { minConfidence: "medium" } };
  const r = workbookWith((sheetId) => {
    const c = addColumn(sheetId, { name: "CEO", kind: "waterfall", valueType: "text" });
    db.prepare("UPDATE columns SET waterfall_json = ? WHERE id = ?").run(JSON.stringify(steps), Number(c.id));
  });

  const col = r.column("CEO");
  assert.equal(col.kind, "waterfall", "the kind must survive");
  assert.ok(col.waterfall_json, "the steps must survive — a waterfall with no steps is not a waterfall");
  assert.equal(JSON.parse(col.waterfall_json).steps.length, 1);
  assert.equal(JSON.parse(col.waterfall_json).steps[0].prompt, "Find the CEO");
});

test("a wait column keeps its kind and the length of its wait", () => {
  const r = workbookWith((sheetId) => {
    const c = addColumn(sheetId, { name: "Breathe", kind: "wait", valueType: "text" });
    db.prepare("UPDATE columns SET wait_seconds = 30 WHERE id = ?").run(Number(c.id));
  });
  const col = r.column("Breathe");
  assert.equal(col.kind, "wait");
  assert.equal(Number(col.wait_seconds), 30, "a wait that forgets its length is a wait of zero");
});

test("an MCP column keeps the tool it was pointed at", () => {
  const cfg = { serverId: "local-echo", tool: "search", args: [{ key: "q", value: "hello" }] };
  const r = workbookWith((sheetId) => {
    const c = addColumn(sheetId, { name: "Ask the app", kind: "mcp", valueType: "text" });
    db.prepare("UPDATE columns SET mcp_config = ? WHERE id = ?").run(JSON.stringify(cfg), Number(c.id));
  });
  const col = r.column("Ask the app");
  assert.equal(col.kind, "mcp");
  assert.ok(col.mcp_config, "an MCP column with no tool cannot run");
  assert.equal(JSON.parse(col.mcp_config).tool, "search");
});

test("a kind this version does not know still degrades to static rather than failing the import", () => {
  // The degrade path is deliberate and must stay: a file written by a LATER version must not take
  // a whole workbook down on one unrecognised word.
  const s = createSheet("Source");
  addColumn(s.id, { name: "Odd", valueType: "text" });
  const doc: any = exportWorkbook(s.workbookId!);
  doc.tables[0].columns[0].kind = "teleport";
  const imported = importWorkbook(doc, "Landed");
  const sheet = db.prepare("SELECT * FROM sheets WHERE workbook_id = ? LIMIT 1").get(imported.workbook.id) as any;
  const col = db.prepare("SELECT * FROM columns WHERE sheet_id = ? AND name = 'Odd'").get(sheet.id) as any;
  assert.equal(col.kind, "static");
});

// ── references inside a waterfall ───────────────────────────────────────────

test("a reference inside a waterfall step is re-pointed at the copy's own column", () => {
  // The reason the waterfall goes through the same name-to-id pass a prompt does. An id from the
  // original workbook means something else entirely in the copy — or nothing.
  const r = workbookWith((sheetId) => {
    const domain = addColumn(sheetId, { name: "Domain", valueType: "text" });
    const c = addColumn(sheetId, { name: "CEO", kind: "waterfall", valueType: "text" });
    const steps = { steps: [{ kind: "ai", prompt: `Who runs {{col:${domain.id}}}?` }], accept: {} };
    db.prepare("UPDATE columns SET waterfall_json = ? WHERE id = ?").run(JSON.stringify(steps), Number(c.id));
  });

  const domain = r.column("Domain");
  const ceo = r.column("CEO");
  const written = String(ceo.waterfall_json);
  assert.ok(
    written.includes(`{{col:${domain.id}}}`),
    `the step must point at the COPY's Domain column, got: ${written}`,
  );
  assert.ok(!/\{\{\s*Domain\s*\}\}/.test(written), "it must not be left as a name");
});

// ── scripts ─────────────────────────────────────────────────────────────────

test("an imported rule column is POINTED AT its script, not merely shipped one", () => {
  // The defect with no symptom. The script row landed, the editor showed it, the pill read "Needs
  // review" and Approve worked — and `runs.ts` returns 0 for a column whose pointer is null, so the
  // column produced nothing forever and nothing on screen said why.
  const r = workbookWith((sheetId) => {
    const c = addColumn(sheetId, { name: "Tidy", kind: "script", valueType: "text" });
    db.prepare(
      `INSERT INTO scripts (column_id, hook, runtime, intent, code, hash, approved_at, refs)
       VALUES (?, 'transform', 'js', 'trim it', 'return String(v).trim()', 'h', datetime('now'), '[]')`,
    ).run(Number(c.id));
    db.prepare("UPDATE columns SET transform_script_id = last_insert_rowid() WHERE id = ?").run(Number(c.id));
  });

  const col = r.column("Tidy");
  assert.ok(col.transform_script_id, "the column must point at the script it arrived with");

  const script = db.prepare("SELECT * FROM scripts WHERE id = ?").get(col.transform_script_id) as any;
  assert.ok(script, "and that pointer must resolve");
  assert.equal(script.column_id, col.id, "to a script belonging to this column");
  assert.equal(script.code, "return String(v).trim()");
  // The security half, unchanged: code travels, approval does not.
  assert.equal(script.approved_at, null, "an imported script must arrive unapproved");
});

test("a run condition arriving in a file is attached to its own pointer, not the transform's", () => {
  const r = workbookWith((sheetId) => {
    const c = addColumn(sheetId, { name: "Gated", kind: "ai", valueType: "text" });
    db.prepare(
      `INSERT INTO scripts (column_id, hook, runtime, intent, code, hash, approved_at, refs)
       VALUES (?, 'condition', 'js', 'only real ones', 'return true', 'h2', NULL, '[]')`,
    ).run(Number(c.id));
    db.prepare("UPDATE columns SET condition_script_id = last_insert_rowid() WHERE id = ?").run(Number(c.id));
  });

  const col = r.column("Gated");
  assert.ok(col.condition_script_id, "the condition must be attached");
  assert.equal(col.transform_script_id, null, "and must not be attached as a transform");
  const script = db.prepare("SELECT hook FROM scripts WHERE id = ?").get(col.condition_script_id) as any;
  assert.equal(script.hook, "condition");
});

// ── what must NOT travel, still ─────────────────────────────────────────────

test("the things that were always meant to stay behind still stay behind", () => {
  // A regression guard on the security half of the contract, now that this path writes more fields
  // than it used to. Adding carriers is exactly when something is carried that should not be.
  const r = workbookWith((sheetId) => {
    const c = addColumn(sheetId, { name: "Spendy", kind: "ai", valueType: "text" });
    db.prepare("UPDATE columns SET auto_run = 1 WHERE id = ?").run(Number(c.id));
  });
  assert.equal(Number(r.column("Spendy").auto_run), 0, "auto_run must never arrive switched on");
});
