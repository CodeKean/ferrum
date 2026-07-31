// Copying a workbook — and the one defect that has no symptom.
//
// Nearly every test here exists for a single failure: a copy whose columns still point at the
// ORIGINAL workbook. Nothing about that state errors. The duplicate opens, its tables are there, its
// lookups return values and its send columns write rows — into the original's tables. It is found by
// noticing the original growing, which is weeks later and by then both are wrong.
//
// So the central assertion is not "the copy has the right things in it". It is that NO id anywhere
// in the copy addresses anything outside the copy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { addColumn, createSheet, insertRows, setCellValue } from "./store.ts";
import { createRelation } from "./relations.ts";
import { setLookup } from "./lookup.ts";
import { createSchedule } from "./schedules.ts";
import { saveScript } from "./scripts.ts";
import { duplicateWorkbook, exportWorkbook, importWorkbook, templatizeWorkbook, useTemplate } from "./workbookCopy.ts";

function workbook(name: string): string {
  const id = `wb-${name}-${Math.random().toString(36).slice(2)}`;
  db.prepare("INSERT INTO workbooks (id, name) VALUES (?, ?)").run(id, name);
  return id;
}
function sheetIn(wb: string, name: string) {
  const s = createSheet(name);
  db.prepare("UPDATE sheets SET workbook_id = ? WHERE id = ?").run(wb, s.id);
  return s;
}
const sheetsOf = (wb: string): any[] =>
  db.prepare("SELECT * FROM sheets WHERE workbook_id = ? AND deleted_at IS NULL ORDER BY position").all(wb) as any[];
const colsOf = (sheetId: string): any[] =>
  db.prepare("SELECT * FROM columns WHERE sheet_id = ? AND deleted_at IS NULL ORDER BY position").all(sheetId) as any[];
const colNamed = (sheetId: string, name: string): any =>
  colsOf(sheetId).find((c) => c.name === name);

/**
 * Companies and Contacts, linked, with one of everything that can point somewhere:
 * a prompt reference, a derived column, a lookup through a relation, a send column, a script, and a
 * schedule.
 */
function scenario(tag: string) {
  const wb = workbook(tag);
  const companies = sheetIn(wb, "Companies");
  const contacts = sheetIn(wb, "Contacts");
  const out = sheetIn(wb, "Output");

  const domain = addColumn(companies.id, { name: "Domain", kind: "static", valueType: "url" });
  const industry = addColumn(companies.id, { name: "Industry", kind: "static", valueType: "text" });
  const blurb = addColumn(companies.id, { name: "Blurb", kind: "ai", valueType: "text" });
  db.prepare("UPDATE columns SET prompt = ? WHERE id = ?")
    .run(`Describe {{col:${domain.id}}} in the {{col:${industry.id}?}} sector.`, Number(blurb.id));

  const person = addColumn(contacts.id, { name: "Name", kind: "static", valueType: "text" });
  const cDomain = addColumn(contacts.id, { name: "Company Domain", kind: "static", valueType: "url" });
  const theirIndustry = addColumn(contacts.id, { name: "Their Industry", kind: "lookup", valueType: "text" });

  const outName = addColumn(out.id, { name: "Name", kind: "static", valueType: "text" });

  insertRows(companies.id, [
    { values: { [String(domain.id)]: "acme.com", [String(industry.id)]: "Software" } },
    { values: { [String(domain.id)]: "globex.com", [String(industry.id)]: "Hardware" } },
  ], 0, [Number(domain.id), Number(industry.id)]);
  insertRows(contacts.id, [
    { values: { [String(person.id)]: "Ada", [String(cDomain.id)]: "acme.com" } },
  ], 0, [Number(person.id), Number(cDomain.id)]);

  const rel = createRelation({
    fromSheetId: contacts.id, fromColumnId: Number(cDomain.id),
    toSheetId: companies.id, toColumnId: Number(domain.id),
  });
  setLookup(Number(theirIndustry.id), rel.id, Number(industry.id));

  // A send column: Contacts → Output.
  const sender = addColumn(contacts.id, { name: "Push", kind: "send", valueType: "text" });
  db.prepare("UPDATE columns SET send_config = ? WHERE id = ?").run(
    JSON.stringify({
      targetSheetId: out.id,
      method: "row",
      mapping: { [String(outName.id)]: { from: "row", columnId: Number(person.id) } },
      keySource: { from: "row", columnId: Number(person.id) },
      onConflict: "upsert",
      withBackRef: false,
      cap: 50,
    }),
    Number(sender.id),
  );

  const saved = saveScript({
    sheetId: companies.id, columnId: Number(blurb.id), hook: "condition", runtime: "js",
    intent: "only rows with a domain", code: "function condition(row) { return !!row.domain; }",
  });
  assert.deepEqual(saved.errors, [], "the fixture's script must actually save");
  const scriptId = Number(saved.script.id);
  db.prepare("UPDATE scripts SET approved_at = datetime('now') WHERE id = ?").run(scriptId);
  db.prepare("UPDATE columns SET condition_script_id = ?, auto_run = 1 WHERE id = ?")
    .run(scriptId, Number(blurb.id));

  const sched = createSchedule({ sheetId: companies.id, name: "Nightly", cadence: { kind: "daily", hour: 2, minute: 0 } });
  db.prepare("UPDATE schedules SET enabled = 1 WHERE id = ?").run(sched.id);

  return { wb, companies, contacts, out, domain, industry, blurb, person, cDomain, theirIndustry, outName, sender, rel, scriptId, sched };
}

// ─────────────────────────────────────────────────────────── the one that matters

test("a duplicated workbook contains no reference to the workbook it came from", () => {
  const s = scenario("isolation");
  const copy = duplicateWorkbook(s.wb);

  const copySheets = new Set(sheetsOf(copy.workbook.id).map((x) => String(x.id)));
  const copyCols = new Set<number>();
  const copyRels = new Set<number>();
  for (const sh of copySheets) for (const c of colsOf(sh)) copyCols.add(Number(c.id));
  for (const r of db.prepare("SELECT id FROM relations WHERE workbook_id = ?").all(copy.workbook.id) as any[]) {
    copyRels.add(Number(r.id));
  }

  assert.equal(copySheets.size, 3);
  assert.ok(copyCols.size >= 7);

  for (const sh of copySheets) {
    for (const c of colsOf(sh)) {
      const where = `${c.name}`;
      for (const f of ["source_column_id", "lookup_column_id"]) {
        if (c[f] != null) assert.ok(copyCols.has(Number(c[f])), `${where}.${f} points outside the copy`);
      }
      if (c.relation_id != null) {
        assert.ok(copyRels.has(Number(c.relation_id)), `${where}.relation_id points outside the copy`);
      }
      // Every `{{col:N}}` in the copy names a column in the copy.
      for (const m of String(c.prompt ?? "").matchAll(/\{\{col:(\d+)/g)) {
        assert.ok(copyCols.has(Number(m[1])), `${where} prompt references a column outside the copy`);
      }
      if (c.send_config) {
        const cfg = JSON.parse(c.send_config);
        assert.ok(copySheets.has(String(cfg.targetSheetId)), `${where} sends into a table outside the copy`);
        for (const v of Object.values(cfg.mapping ?? {}) as any[]) {
          if (v?.from === "row") assert.ok(copyCols.has(Number(v.columnId)), `${where} mapping reads outside the copy`);
        }
        for (const k of Object.keys(cfg.mapping ?? {})) {
          assert.ok(copyCols.has(Number(k)), `${where} writes into a column outside the copy`);
        }
        if (cfg.keySource?.from === "row") {
          assert.ok(copyCols.has(Number(cfg.keySource.columnId)), `${where} keys on a column outside the copy`);
        }
      }
    }
  }

  // And the relation itself joins the copy's tables, not the original's.
  for (const r of db.prepare("SELECT * FROM relations WHERE workbook_id = ?").all(copy.workbook.id) as any[]) {
    assert.ok(copySheets.has(String(r.from_sheet_id)) && copySheets.has(String(r.to_sheet_id)));
    assert.ok(copyCols.has(Number(r.from_column_id)) && copyCols.has(Number(r.to_column_id)));
  }
});

test("the original is untouched by being duplicated", () => {
  const s = scenario("untouched");
  const before = {
    prompt: (db.prepare("SELECT prompt FROM columns WHERE id = ?").get(Number(s.blurb.id)) as any).prompt,
    rel: (db.prepare("SELECT relation_id, lookup_column_id FROM columns WHERE id = ?").get(Number(s.theirIndustry.id)) as any),
    rows: (db.prepare("SELECT COUNT(*) c FROM rows WHERE sheet_id = ?").get(s.companies.id) as any).c,
  };
  duplicateWorkbook(s.wb, { withRows: true });
  const after = {
    prompt: (db.prepare("SELECT prompt FROM columns WHERE id = ?").get(Number(s.blurb.id)) as any).prompt,
    rel: (db.prepare("SELECT relation_id, lookup_column_id FROM columns WHERE id = ?").get(Number(s.theirIndustry.id)) as any),
    rows: (db.prepare("SELECT COUNT(*) c FROM rows WHERE sheet_id = ?").get(s.companies.id) as any).c,
  };
  assert.deepEqual(after, before);
});

// ─────────────────────────────────────────────────────────── what does and does not travel

test("rows are left behind unless asked for, and come across whole when asked for", () => {
  const s = scenario("rows");
  const bare = duplicateWorkbook(s.wb);
  assert.equal(bare.rows, 0);
  assert.equal(
    Number((db.prepare("SELECT COUNT(*) c FROM rows WHERE sheet_id IN (SELECT id FROM sheets WHERE workbook_id = ?)").get(bare.workbook.id) as any).c),
    0,
  );

  const full = duplicateWorkbook(s.wb, { withRows: true });
  assert.equal(full.rows, 3, "two companies and one contact");
  const companies = sheetsOf(full.workbook.id).find((x) => x.name === "Companies");
  const domain = colNamed(companies.id, "Domain");
  const values = (db.prepare(
    "SELECT value_text FROM cells WHERE column_id = ? ORDER BY row_id",
  ).all(Number(domain.id)) as any[]).map((r) => r.value_text);
  assert.deepEqual(values, ["acme.com", "globex.com"]);
});

test("a hand-typed cell stays pinned in the copy", () => {
  const s = scenario("pins");
  const rowId = Number((db.prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY position").get(s.companies.id) as any).id);
  setCellValue(rowId, Number(s.industry.id), "Typed by hand");

  const copy = duplicateWorkbook(s.wb, { withRows: true });
  const companies = sheetsOf(copy.workbook.id).find((x) => x.name === "Companies");
  const industry = colNamed(companies.id, "Industry");
  const cell = db.prepare("SELECT value_text, pinned FROM cells WHERE column_id = ? ORDER BY row_id").get(Number(industry.id)) as any;
  assert.equal(cell.value_text, "Typed by hand");
  assert.equal(Number(cell.pinned), 1, "a pinned cell that arrives unpinned gets overwritten by the first run");
});

test("scripts come across unapproved, so a copy cannot run code nobody read here", () => {
  const s = scenario("scripts");
  const copy = duplicateWorkbook(s.wb);
  const companies = sheetsOf(copy.workbook.id).find((x) => x.name === "Companies");
  const blurb = colNamed(companies.id, "Blurb");

  const scripts = db.prepare("SELECT * FROM scripts WHERE column_id = ?").all(Number(blurb.id)) as any[];
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].approved_at, null);
  assert.equal(scripts[0].code, "function condition(row) { return !!row.domain; }", "the code travels; only the approval does not");
  assert.equal(Number(blurb.condition_script_id), Number(scripts[0].id), "and the column points at ITS copy of the script");
  assert.equal(copy.scriptsPending, 1);
});

test("schedules arrive switched off", () => {
  const s = scenario("schedules");
  const copy = duplicateWorkbook(s.wb);
  const companies = sheetsOf(copy.workbook.id).find((x) => x.name === "Companies");
  const rows = db.prepare("SELECT * FROM schedules WHERE sheet_id = ?").all(companies.id) as any[];
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].enabled), 0, "a duplicate that starts running on a timer spends money nobody asked for");
  assert.equal(rows[0].name, "Nightly");
});

test("a duplicate keeps auto_run; a template and an import clear it", () => {
  const s = scenario("autorun");

  const dup = duplicateWorkbook(s.wb);
  const dupBlurb = colNamed(sheetsOf(dup.workbook.id).find((x) => x.name === "Companies").id, "Blurb");
  assert.equal(Number(dupBlurb.auto_run), 1, "your own copy of your own workbook keeps the settings you chose");

  const tpl = templatizeWorkbook(s.wb, "Template");
  const tplBlurb = colNamed(sheetsOf(tpl.workbook.id).find((x) => x.name === "Companies").id, "Blurb");
  assert.equal(Number(tplBlurb.auto_run), 0);

  const imported = importWorkbook(exportWorkbook(s.wb), "From a file");
  const impBlurb = colNamed(sheetsOf(imported.workbook.id).find((x) => x.name === "Companies").id, "Blurb");
  assert.equal(Number(impBlurb.auto_run), 0);
});

test("views travel with their column ids re-pointed at the copy", () => {
  const s = scenario("views");
  db.prepare(
    "INSERT INTO views (sheet_id, name, position, filter_json, sorts_json, columns_json, group_by) VALUES (?, ?, 0, ?, ?, ?, ?)",
  ).run(
    s.companies.id, "Software only",
    JSON.stringify({ conj: "and", children: [{ columnId: Number(s.industry.id), op: "eq", value: "Software" }] }),
    JSON.stringify([{ columnId: Number(s.domain.id), dir: "asc" }]),
    JSON.stringify({ order: [Number(s.domain.id), Number(s.industry.id)], hidden: [Number(s.blurb.id)], widths: { [String(s.domain.id)]: 240 } }),
    Number(s.industry.id),
  );

  const copy = duplicateWorkbook(s.wb);
  const companies = sheetsOf(copy.workbook.id).find((x) => x.name === "Companies");
  const ids = new Set(colsOf(companies.id).map((c) => Number(c.id)));
  const v = db.prepare("SELECT * FROM views WHERE sheet_id = ? AND name = ?").get(companies.id, "Software only") as any;
  assert.ok(v, "the view came across");

  assert.ok(ids.has(Number(JSON.parse(v.filter_json).children[0].columnId)), "the filter would otherwise match on a foreign column");
  assert.ok(ids.has(Number(JSON.parse(v.sorts_json)[0].columnId)));
  for (const id of JSON.parse(v.columns_json).order) assert.ok(ids.has(Number(id)));
  for (const id of JSON.parse(v.columns_json).hidden) assert.ok(ids.has(Number(id)));
  for (const k of Object.keys(JSON.parse(v.columns_json).widths)) assert.ok(ids.has(Number(k)));
  assert.ok(ids.has(Number(v.group_by)));
});

test("the primary column points at the copy's own column", () => {
  const s = scenario("primary");
  db.prepare("UPDATE sheets SET primary_column_id = ? WHERE id = ?").run(Number(s.domain.id), s.companies.id);
  const copy = duplicateWorkbook(s.wb);
  const companies = sheetsOf(copy.workbook.id).find((x) => x.name === "Companies");
  const ids = new Set(colsOf(companies.id).map((c) => Number(c.id)));
  assert.ok(ids.has(Number(companies.primary_column_id)));
});

// ─────────────────────────────────────────────────────────── templates

test("a template holds structure only, and using it makes a real workbook", () => {
  const s = scenario("template");
  const tpl = templatizeWorkbook(s.wb, "Outreach starter");
  assert.equal(tpl.workbook.isTemplate, true);
  assert.equal(tpl.rows, 0);

  const made = useTemplate(tpl.workbook.id, "January outreach");
  assert.equal(made.workbook.isTemplate, false);
  assert.equal(made.workbook.name, "January outreach");
  assert.equal(made.tables, 3);

  // And the template itself was not consumed.
  const still = db.prepare("SELECT is_template, archived FROM workbooks WHERE id = ?").get(tpl.workbook.id) as any;
  assert.equal(Number(still.is_template), 1);
  assert.equal(Number(still.archived), 0);
});

test("a template asked for rows does not get them", () => {
  const s = scenario("templaterows");
  // Even though the caller asks. `asTemplate` wins, because a "template" carrying a million rows of
  // someone's data is the one thing the word promises it is not.
  const tpl = duplicateWorkbook(s.wb, { asTemplate: true, withRows: true });
  assert.equal(tpl.rows, 0);
});

// ─────────────────────────────────────────────────────────── the file

test("a file addresses everything by name, and carries nothing that can run or spend", () => {
  const s = scenario("export");
  const doc = exportWorkbook(s.wb);

  assert.equal(doc.format, "ferrum.workbook");
  assert.equal(doc.tables.length, 3);

  const text = JSON.stringify(doc);
  assert.ok(!/\{\{col:\d+\}\}/.test(text), "an id in a file is meaningless on any other machine");
  assert.ok(!text.includes(s.companies.id), "no sheet id travels");
  assert.ok(!/"autoRun"/.test(text), "nothing arrives armed");
  assert.ok(!/"sendConfig"|"send_config"/.test(text), "a send destination cannot be expressed portably, so it is not claimed");

  const companies = doc.tables.find((t) => t.name === "Companies")!;
  const blurb = companies.columns.find((c: any) => c.name === "Blurb")! as any;
  assert.equal(blurb.prompt, "Describe {{Domain}} in the {{Industry?}} sector.");
  assert.equal(blurb.scripts.length, 1);

  assert.equal(doc.relations.length, 1);
  assert.deepEqual(
    { ...doc.relations[0]!, cardinality: undefined, matchMode: undefined },
    { fromTable: "Contacts", fromColumn: "Company Domain", toTable: "Companies", toColumn: "Domain", cardinality: undefined, matchMode: undefined },
  );
});

test("a file round-trips: names become ids again on the machine that opens it", () => {
  const s = scenario("roundtrip");
  const doc = exportWorkbook(s.wb);
  const back = importWorkbook(doc, "Reimported");

  assert.equal(back.workbook.name, "Reimported");
  assert.equal(back.tables, 3);

  const sheets = sheetsOf(back.workbook.id);
  const companies = sheets.find((x) => x.name === "Companies")!;
  const contacts = sheets.find((x) => x.name === "Contacts")!;
  const domain = colNamed(companies.id, "Domain");
  const industry = colNamed(companies.id, "Industry");
  const blurb = colNamed(companies.id, "Blurb");

  assert.equal(blurb.prompt, `Describe {{col:${domain.id}}} in the {{col:${industry.id}?}} sector.`);
  assert.equal(Number(blurb.auto_run), 0, "a file from elsewhere never arrives armed");

  // The link was rebuilt, and the lookup re-points at the imported Industry.
  const rel = db.prepare("SELECT * FROM relations WHERE workbook_id = ?").get(back.workbook.id) as any;
  assert.ok(rel);
  assert.equal(String(rel.from_sheet_id), contacts.id);
  assert.equal(String(rel.to_sheet_id), companies.id);

  const theirs = colNamed(contacts.id, "Their Industry");
  assert.equal(Number(theirs.relation_id), Number(rel.id));
  assert.equal(Number(theirs.lookup_column_id), Number(industry.id));

  // Scripts arrived, unapproved.
  const scripts = db.prepare("SELECT * FROM scripts WHERE column_id = ?").all(Number(blurb.id)) as any[];
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].approved_at, null);
});

test("an import refuses a file it does not understand rather than guessing", () => {
  assert.throws(() => importWorkbook({ hello: "world" }), /not a Ferrum workbook/);
  assert.throws(() => importWorkbook(null), /not a Ferrum workbook/);
  assert.throws(
    () => importWorkbook({ format: "ferrum.workbook", version: 99, tables: [{ name: "A", columns: [] }] }),
    /newer version/,
  );
  assert.throws(() => importWorkbook({ format: "ferrum.workbook", version: 1, tables: [] }), /no tables/);
});

test("an import survives a hand-edited file with two columns sharing a name", () => {
  // A UNIQUE(sheet_id, key) violation would otherwise fail the whole import on a file someone tidied
  // by hand — and the error a user would see is a raw SQLite constraint message.
  const made = importWorkbook({
    format: "ferrum.workbook", version: 1,
    name: "Hand edited",
    tables: [{ name: "T", columns: [{ name: "Email" }, { name: "Email" }, { name: "email" }] }],
    relations: [],
  });
  const sheet = sheetsOf(made.workbook.id)[0]!;
  const keys = colsOf(sheet.id).map((c) => c.key);
  assert.equal(keys.length, 3);
  assert.equal(new Set(keys).size, 3, "the keys were made unique rather than the import failing");
});

test("an import ignores a kind it does not recognise instead of storing it", () => {
  const made = importWorkbook({
    format: "ferrum.workbook", version: 1, name: "Odd",
    tables: [{ name: "T", kind: "spaceship", columns: [{ name: "A", kind: "exec_shell" }] }],
    relations: [],
  });
  const sheet = sheetsOf(made.workbook.id)[0]!;
  assert.equal(sheet.kind, "generic");
  assert.equal(colsOf(sheet.id)[0]!.kind, "static");
});

test("an imported web request is normalised, and cannot bring permission to reach this machine", () => {
  // The defect: this was the one writer that stored the file's `httpConfig` verbatim. `allowPrivate`
  // on a FIXED host survives every later check — the later checks ask whether the host was authored
  // rather than interpolated, and a hand-written file answers yes — so a workbook sent by email
  // could arrive with a column pointed at the cloud metadata address or at this engine's own port.
  // The timeout came in unbounded by the same route.
  const made = importWorkbook({
    format: "ferrum.workbook", version: 1, name: "Hostile",
    tables: [{
      name: "T",
      columns: [{
        name: "Peek",
        kind: "http",
        httpConfig: {
          method: "GET",
          url: "http://169.254.169.254/latest/meta-data/",
          allowPrivate: true,
          timeoutMs: 86_400_000,
          maxRetries: 500,
          somethingUnknown: "kept?",
        },
      }],
      views: [],
    }],
    relations: [],
  });

  const cfg = JSON.parse(colsOf(sheetsOf(made.workbook.id)[0]!.id)[0]!.http_config);
  assert.equal(cfg.allowPrivate, false, "a file cannot decide this machine may be contacted");
  assert.equal(cfg.timeoutMs, 120_000, "clamped to the same ceiling a saved column has");
  assert.equal(cfg.maxRetries, 5);
  assert.equal(cfg.somethingUnknown, undefined, "unknown fields are dropped, not stored");
});

test("an imported column's connected apps are ids and nothing else", () => {
  // A workbook must never be able to describe an app — the command it would run lives in this
  // machine's own registry, and a file naming one would be a file that runs code.
  const made = importWorkbook({
    format: "ferrum.workbook", version: 1, name: "Apps",
    tables: [{
      name: "T",
      columns: [{ name: "A", kind: "agent", mcpServers: [{ command: "rm", args: ["-rf", "/"] }, "srv-1", "srv-1"] }],
      views: [],
    }],
    relations: [],
  });

  const stored = JSON.parse(colsOf(sheetsOf(made.workbook.id)[0]!.id)[0]!.mcp_servers);
  assert.deepEqual(stored, ["srv-1"], "anything that is not an id is dropped, and duplicates collapse");
});
