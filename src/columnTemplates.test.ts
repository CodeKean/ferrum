// Columns kept to be used again.
//
// Two failures are worth pinning here and they are both silent. A template that carried column IDs
// would land on another table pointing at whatever happens to hold that id — a prompt about the
// wrong field, with no error anywhere. And a template that carried a script's APPROVAL would make
// "apply a template" a way to run code nobody here has read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { addColumn, createSheet, getColumn, listColumns, setColumnPrompt } from "./store.ts";
import {
  applyColumnTemplate, checkColumnTemplate, deleteColumnTemplate, getColumnTemplate,
  listColumnTemplates, saveColumnTemplate, updateColumnTemplate,
} from "./columnTemplates.ts";

const sheet = (n: string) => createSheet(`ZZ tpl ${n} ${Math.random().toString(36).slice(2, 7)}`);

/** A table with a Website column and an AI column whose prompt refers to it. */
function source() {
  const s = sheet("src");
  const web = addColumn(s.id, { name: "Website", kind: "static", valueType: "url" });
  const ask = addColumn(s.id, { name: "Careers page", kind: "ai", valueType: "url" });
  setColumnPrompt(Number(ask.id), `Find the careers page for {{col:${web.id}}}.`);
  return { s, web, ask: getColumn(Number(ask.id))! };
}

test("a reference is kept as a NAME, not as the id it had on the table it came from", () => {
  const { ask } = source();
  const t = saveColumnTemplate(Number(ask.id), { name: "Careers page finder" });
  assert.match(String(t.body.prompt), /\{\{Website\}\}/, `got ${t.body.prompt}`);
  assert.ok(!/col:\d/.test(String(t.body.prompt)), "no ids may survive into a template");
  assert.deepEqual(t.requires, ["Website"]);
});

test("applying it binds to the DESTINATION table's own column", () => {
  const { ask } = source();
  const t = saveColumnTemplate(Number(ask.id), { name: "Careers page finder" });

  // A different table, whose Website column has a different id.
  const dest = sheet("dest");
  addColumn(dest.id, { name: "Filler", kind: "static", valueType: "text" });
  addColumn(dest.id, { name: "Filler 2", kind: "static", valueType: "text" });
  const destWeb = addColumn(dest.id, { name: "Website", kind: "static", valueType: "url" });
  assert.notEqual(Number(destWeb.id), Number(listColumns(ask.sheetId).find((c) => c.name === "Website")!.id));

  const out = applyColumnTemplate(t.id, dest.id);
  assert.deepEqual(out.missing, []);
  assert.match(out.column.prompt ?? "", new RegExp(`\\{\\{col:${destWeb.id}\\}\\}`), `got ${out.column.prompt}`);
});

test("a name the destination does not have is REPORTED, and left legible in the prompt", () => {
  const { ask } = source();
  const t = saveColumnTemplate(Number(ask.id), { name: "Careers page finder" });
  const bare = sheet("bare");
  addColumn(bare.id, { name: "Company", kind: "static", valueType: "text" });

  // Asked before anything is created — the point of `check`.
  assert.deepEqual(checkColumnTemplate(t.id, bare.id), { missing: ["Website"], matched: [] });

  const out = applyColumnTemplate(t.id, bare.id);
  assert.deepEqual(out.missing, ["Website"]);
  // Left as written rather than dropped: a dangling name is at least visible, where a silent
  // deletion leaves an instruction that reads as complete and is about nothing.
  assert.match(out.column.prompt ?? "", /\{\{Website\}\}/);
});

test("matching a name ignores case and spacing, the same way references do", () => {
  const { ask } = source();
  const t = saveColumnTemplate(Number(ask.id), {});
  const dest = sheet("case");
  addColumn(dest.id, { name: "  WEBSITE  ", kind: "static", valueType: "url" });
  assert.deepEqual(checkColumnTemplate(t.id, dest.id).missing, []);
});

test("an API column's references travel too, wherever in the request they sit", () => {
  const s = sheet("http");
  const dom = addColumn(s.id, { name: "Domain", kind: "static", valueType: "text" });
  const call = addColumn(s.id, { name: "Headcount", kind: "http", valueType: "number" });
  db.prepare("UPDATE columns SET http_config = ? WHERE id = ?").run(
    JSON.stringify({
      method: "GET", url: `https://api.example.com/c?d={{col:${dom.id}}}`,
      query: [{ name: "x", value: `{{col:${dom.id}}}` }], headers: [], bodyMode: "none",
      bodyFields: [], body: "", responsePath: "count",
    }),
    Number(call.id),
  );

  const t = saveColumnTemplate(Number(call.id), { name: "Headcount lookup" });
  assert.deepEqual(t.requires, ["Domain"]);
  assert.match(JSON.stringify(t.body.httpConfig), /\{\{Domain\}\}/);

  const dest = sheet("http-dest");
  const destDom = addColumn(dest.id, { name: "Domain", kind: "static", valueType: "text" });
  const out = applyColumnTemplate(t.id, dest.id);
  assert.match(JSON.stringify(out.column.httpConfig), new RegExp(`col:${destDom.id}`));
});

test("a carried script arrives UNAPPROVED", () => {
  const s = sheet("script");
  const col = addColumn(s.id, { name: "Gate", kind: "ai", valueType: "text" });
  const script = db
    .prepare(
      `INSERT INTO scripts (column_id, hook, runtime, intent, code, hash, approved_at)
       VALUES (?, 'condition', 'js', 'only qualified', 'function condition(row){return true}', 'h', datetime('now'))
       RETURNING id`,
    )
    .get(Number(col.id)) as any;
  db.prepare("UPDATE columns SET condition_script_id = ? WHERE id = ?").run(Number(script.id), Number(col.id));

  const t = saveColumnTemplate(Number(col.id), { name: "Gated" });
  assert.equal(t.scripts.length, 1);
  assert.match(t.scripts[0]!.code, /function condition/);

  const dest = sheet("script-dest");
  const out = applyColumnTemplate(t.id, dest.id);
  assert.equal(out.scriptsPending, 1);
  const copied = db
    .prepare("SELECT approved_at, code FROM scripts WHERE column_id = ?")
    .all(Number(out.column.id)) as any[];
  assert.equal(copied.length, 1);
  assert.equal(copied[0].approved_at, null, "applying a template must not be a way to run unread code");
  assert.match(copied[0].code, /function condition/, "the code itself does travel");
});

test("a template never arms a column to spend by itself", () => {
  const s = sheet("auto");
  const col = addColumn(s.id, { name: "Auto", kind: "ai", valueType: "text" });
  db.prepare("UPDATE columns SET auto_run = 1 WHERE id = ?").run(Number(col.id));
  const t = saveColumnTemplate(Number(col.id), {});
  const out = applyColumnTemplate(t.id, sheet("auto-dest").id);
  assert.equal(out.column.autoRun, false, "applying a template is setup, not a decision to spend");
});

test("a template carries no data and no run history", () => {
  const { ask } = source();
  const t = saveColumnTemplate(Number(ask.id), {});
  const keys = Object.keys(t.body);
  for (const forbidden of ["id", "sheetId", "statsJson", "stats", "position", "createdAt"]) {
    assert.ok(!keys.includes(forbidden), `${forbidden} must not be in a template`);
  }
});

test("the gallery puts what you actually use at the top", () => {
  const { ask } = source();
  const rare = saveColumnTemplate(Number(ask.id), { name: "ZZ rare one" });
  const common = saveColumnTemplate(Number(ask.id), { name: "ZZ common one" });
  const dest = sheet("order");
  applyColumnTemplate(common.id, dest.id);
  applyColumnTemplate(common.id, dest.id);
  const list = listColumnTemplates().filter((t) => t.name.startsWith("ZZ "));
  assert.equal(list[0]!.name, "ZZ common one");
  assert.equal(getColumnTemplate(common.id)!.uses, 2);
  deleteColumnTemplate(rare.id);
  deleteColumnTemplate(common.id);
  assert.equal(getColumnTemplate(common.id), null);
});

test("renaming a template leaves what it does untouched", () => {
  const { ask } = source();
  const t = saveColumnTemplate(Number(ask.id), { name: "First" });
  const after = updateColumnTemplate(t.id, { name: "Second", category: "Enrichment" });
  assert.equal(after.name, "Second");
  assert.equal(after.category, "Enrichment");
  assert.deepEqual(after.body, t.body);
  assert.deepEqual(after.requires, t.requires);
});
