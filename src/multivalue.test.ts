// JSON columns, list fan-out, and writing to another table.
//
// The two failures these guard are both silent: a preview that disagrees with the write, and a
// re-run that duplicates every row it created instead of updating it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { addColumn, countRows, createSheet, insertRows, listColumns } from "./store.ts";
import { discoverJsonFields, expandJsonColumn, refreshChildren } from "./derive.ts";
import { aggregate, discoverFields, getPath, parsePath, toList, toText } from "./jsonPath.ts";
import { applyWrite, ensureBackRefColumn, planWrite, type WriteTarget } from "./writeTarget.ts";

function sheetWithJson(name: string, payloads: unknown[]) {
  const sheet = createSheet(name);
  const company = addColumn(sheet.id, { name: "Company" });
  const blob = addColumn(sheet.id, { name: "Enriched", valueType: "json" });
  const ids = [Number(company.id), Number(blob.id)];
  insertRows(
    sheet.id,
    payloads.map((p, i) => ({
      values: { [String(ids[0])]: `Co ${i}`, [String(ids[1])]: JSON.stringify(p) },
    })),
    0,
    ids,
  );
  return { sheet, companyId: ids[0]!, blobId: ids[1]! };
}

test("a star asks the same question of every item in a list", () => {
  // The fix for "nested lists cannot be used". `contacts.0.email` is a different person on every
  // row and makes no sense as a column; `contacts.*.email` is the same question on every row and
  // makes perfect sense as one.
  const row = {
    contacts: [
      { name: "Cy Doe", email: "cy@beta.io", tags: ["dm", "vip"] },
      { name: "Ada Lee", tags: ["dm"] },                 // no email — a real, common shape
      { name: "Bo Ray", email: "bo@beta.io", tags: [] },
    ],
  };

  // Missing values are DROPPED, not left as holes. "two of the three had an email" is the useful
  // answer; a column reading "cy@beta.io, , bo@beta.io" is not.
  assert.deepEqual(getPath(row, "contacts.*.email"), ["cy@beta.io", "bo@beta.io"]);
  assert.equal(toText(getPath(row, "contacts.*.email")), "cy@beta.io, bo@beta.io");
  assert.deepEqual(getPath(row, "contacts.*.name"), ["Cy Doe", "Ada Lee", "Bo Ray"]);

  // Stars nest, which is what makes a list inside a list item reachable at all.
  assert.deepEqual(getPath(row, "contacts.*.tags.*"), [["dm", "vip"], ["dm"], []]);

  // A star over something that is not a list yields nothing FOR THAT ITEM, so a star over a string
  // field empties out rather than erroring. Under an outer star that reads as "none of them had
  // one", which is the same shape as a genuinely empty list — the distinction is only preserved at
  // the top level, where there is no surrounding list to fold it into.
  assert.deepEqual(getPath(row, "contacts.*.email.*"), []);
  assert.equal(getPath({ contacts: null }, "contacts.*.email"), undefined);
  assert.deepEqual(getPath({ contacts: [] }, "contacts.*.email"), []);
});

// ─────────────────────────────────────────────────────────────── path extraction

test("path extraction handles nesting, arrays, absence, and prototype keys", () => {
  const obj = { contact: { email: "a@b.com", tags: ["x", "y"] }, count: 3, ok: true, missing: null };

  assert.deepEqual(parsePath("contact.tags[1]"), ["contact", "tags", 1]);
  assert.equal(getPath(obj, "contact.email"), "a@b.com");
  assert.equal(getPath(obj, "contact.tags[1]"), "y");
  assert.equal(getPath(obj, "count"), 3);

  // Absent and explicitly-null are DIFFERENT answers; collapsing them makes a missing field look
  // like a real empty value.
  assert.equal(getPath(obj, "contact.phone"), undefined);
  assert.equal(getPath(obj, "missing"), null);

  // Prototype keys are never data.
  assert.equal(getPath(obj, "__proto__"), undefined);
  // A star must not open a hole in that: it walks items, and each item is stepped the same way.
  assert.deepEqual(getPath({ xs: [{ __proto__: 1 }] }, "xs.*.__proto__"), []);
  assert.equal(getPath(obj, "constructor.name"), undefined);

  // A scalar list renders readably rather than as JSON in a 180px cell.
  assert.equal(toText(["a", "b"]), "a, b");
  assert.equal(toText({ a: 1 }), '{"a":1}');
});

test("field discovery skips arrays, ranks by coverage, and drops noise", () => {
  // 20 samples: `name` everywhere, `contact.email` on most, `sparse` on a quarter, `oddball` once.
  const samples = Array.from({ length: 20 }, (_, i) => ({
    name: `Co ${i}`,
    tags: ["x"],
    ...(i < 15 ? { contact: { email: `c${i}@x.com` } } : {}),
    ...(i < 5 ? { sparse: "present on a quarter" } : {}),
    ...(i === 0 ? { oddball: "only here" } : {}),
  }));

  const fields = discoverFields(samples);
  const paths = fields.map((f) => f.path);

  assert.ok(paths.includes("name"));
  assert.ok(paths.includes("contact.email"), "should descend into nested objects");
  assert.ok(!paths.some((p) => p.includes("[")), "must not explode array indices into columns");

  // A field on a quarter of rows is SPARSE, not noise — a quarter of companies genuinely having a
  // field is worth offering. Dropping it would silently hide real data.
  assert.ok(paths.includes("sparse"), "25% coverage is a real field, not noise");

  // One occurrence in twenty is below the floor: offering it produces a column that is empty for
  // 95% of rows.
  assert.ok(!paths.includes("oddball"), "5% coverage is below the noise floor");

  assert.equal(fields.find((f) => f.path === "contact.email")?.valueType, "email");
  assert.equal(fields.find((f) => f.path === "name")?.coverage, 1);
  // Ranked by coverage, so the most useful fields are offered first.
  assert.ok(paths.indexOf("name") < paths.indexOf("sparse"));
});

// ─────────────────────────────────────────────────────────────── expanding a JSON column

test("expanding a JSON column creates free derived columns that track the source", () => {
  const f = sheetWithJson("expand", [
    { title: "CEO", contact: { email: "a@x.com" }, employees: 10 },
    { title: "CTO", contact: { email: "b@x.com" }, employees: 20 },
    { title: "COO", employees: 30 },   // no contact — must be empty, NOT an error
  ]);

  const discovered = discoverJsonFields(f.sheet.id, f.blobId);
  assert.ok(discovered.some((d) => d.path === "contact.email"));

  const out = expandJsonColumn(f.sheet.id, f.blobId, [
    { path: "title" },
    { path: "contact.email", valueType: "email" },
  ]);
  assert.equal(out.created.length, 2);
  assert.equal(out.created[0]!.name, "Title");
  assert.equal(out.created[1]!.name, "Email", "the leaf is the name, not the whole path");

  const emailCol = out.created[1]!.columnId;
  const cells = db.prepare("SELECT value_text, status FROM cells WHERE column_id = ? ORDER BY row_id").all(emailCol) as any[];
  assert.equal(cells[0].value_text, "a@x.com");
  assert.equal(cells[1].value_text, "b@x.com");
  assert.equal(cells[2].status, "empty", "an absent path is empty, never an error");

  // Re-running the source must update its children, or the expansion silently goes stale.
  db.prepare("UPDATE cells SET value_json = ?, value_text = ? WHERE column_id = ? AND row_id = (SELECT MIN(row_id) FROM cells WHERE column_id = ?)")
    .run(JSON.stringify({ title: "CEO", contact: { email: "CHANGED@x.com" } }), "x", f.blobId, f.blobId);
  refreshChildren(f.sheet.id, f.blobId);

  const after = db.prepare("SELECT value_text FROM cells WHERE column_id = ? ORDER BY row_id").all(emailCol) as any[];
  assert.equal(after[0].value_text, "CHANGED@x.com");
});

// ─────────────────────────────────────────────────────────────── lists

test("list coercion accepts JSON arrays and the delimited strings models actually return", () => {
  assert.deepEqual(toList(["a", "b"]), ["a", "b"]);
  assert.deepEqual(toList('["a","b"]'), ["a", "b"]);
  assert.deepEqual(toList("a\nb\nc"), ["a", "b", "c"]);
  assert.deepEqual(toList("a; b"), ["a", "b"]);
  assert.deepEqual(toList("a, b"), ["a", "b"]);
  // Newlines win over commas: a listed line may itself contain a comma.
  assert.deepEqual(toList("VP, Sales\nHead of Growth"), ["VP, Sales", "Head of Growth"]);
  assert.deepEqual(toList(null), []);
  assert.deepEqual(toList(""), []);

  assert.equal(aggregate(["a", "b"], "join"), "a, b");
  assert.equal(aggregate([1, 2, 3], "count"), 3);
  assert.equal(aggregate([1, 2, 3], "sum"), 6);
  assert.equal(aggregate(["a", "b"], "first"), "a");
  // No aggregate specified keeps everything rather than silently dropping data.
  assert.deepEqual(aggregate(["a", "b"], null), ["a", "b"]);
});

// ─────────────────────────────────────────────────────────────── writing to another table

function targetSheet(name: string) {
  const sheet = createSheet(name);
  const nameCol = addColumn(sheet.id, { name: "Full name" });
  const emailCol = addColumn(sheet.id, { name: "Email", valueType: "email" });
  return { sheet, nameCol: Number(nameCol.id), emailCol: Number(emailCol.id) };
}

test("a dry run's numbers are produced by the same code path as the write", () => {
  const t = targetSheet("write-preview");
  const target: WriteTarget = {
    targetSheetId: t.sheet.id,
    mapping: { [t.nameCol]: "name", [t.emailCol]: "email" },
    keyPath: "email",
    onConflict: "upsert",
  };
  const items = [
    { sourceRowId: 1, value: { name: "Ann", email: "ann@x.com" } },
    { sourceRowId: 1, value: { name: "Bob", email: "bob@x.com" } },
  ];

  const plan = planWrite(items, target);
  assert.equal(plan.inserts, 2);
  assert.equal(plan.updates, 0);
  assert.equal(countRows(t.sheet.id), 0, "a dry run must not create anything");

  const applied = applyWrite(items, target);
  assert.equal(applied.inserts, plan.inserts, "preview and write must agree");
  assert.equal(countRows(t.sheet.id), 2);
});

test("re-running a fan-out updates its rows instead of duplicating the table", () => {
  const t = targetSheet("write-idempotent");
  const target: WriteTarget = {
    targetSheetId: t.sheet.id,
    mapping: { [t.nameCol]: "name", [t.emailCol]: "email" },
    keyPath: "email",
    onConflict: "upsert",
  };
  const items = [
    { sourceRowId: 1, value: { name: "Ann", email: "ann@x.com" } },
    { sourceRowId: 1, value: { name: "Bob", email: "bob@x.com" } },
  ];

  applyWrite(items, target);
  assert.equal(countRows(t.sheet.id), 2);

  // The same run again, with one value corrected — the classic "tweak the prompt and re-run".
  const second = applyWrite(
    [
      { sourceRowId: 1, value: { name: "Ann Smith", email: "ann@x.com" } },
      { sourceRowId: 1, value: { name: "Bob", email: "bob@x.com" } },
    ],
    target,
  );

  assert.equal(countRows(t.sheet.id), 2, "re-running must NOT double the target table");
  assert.equal(second.updates, 2);
  assert.equal(second.inserts, 0);

  const names = (db.prepare("SELECT value_text FROM cells WHERE column_id = ? ORDER BY row_id").all(t.nameCol) as any[])
    .map((r) => r.value_text);
  assert.deepEqual(names, ["Ann Smith", "Bob"]);
});

test("two items sharing a key in one batch do not both count as inserts", () => {
  const t = targetSheet("write-batch-dupe");
  const target: WriteTarget = {
    targetSheetId: t.sheet.id,
    mapping: { [t.emailCol]: "email" },
    keyPath: "email",
    onConflict: "upsert",
  };
  const plan = planWrite(
    [
      { sourceRowId: 1, value: { email: "dupe@x.com" } },
      { sourceRowId: 2, value: { email: "dupe@x.com" } },
    ],
    target,
  );
  assert.equal(plan.inserts, 1);
  assert.equal(plan.updates, 1);
});

test("skip policy leaves existing rows untouched", () => {
  const t = targetSheet("write-skip");
  const upsert: WriteTarget = {
    targetSheetId: t.sheet.id,
    mapping: { [t.nameCol]: "name", [t.emailCol]: "email" },
    keyPath: "email", onConflict: "upsert",
  };
  applyWrite([{ sourceRowId: 1, value: { name: "Original", email: "a@x.com" } }], upsert);

  const skip: WriteTarget = { ...upsert, onConflict: "skip" };
  const res = applyWrite([{ sourceRowId: 1, value: { name: "Replacement", email: "a@x.com" } }], skip);

  assert.equal(res.skips, 1);
  assert.equal(countRows(t.sheet.id), 1);
  const name = (db.prepare("SELECT value_text FROM cells WHERE column_id = ?").get(t.nameCol) as any).value_text;
  assert.equal(name, "Original");
});

test("fan-out writes a back-reference so the child knows its parent row", () => {
  const t = targetSheet("write-backref");
  const backRefId = ensureBackRefColumn(t.sheet.id, "Companies");

  const target: WriteTarget = {
    targetSheetId: t.sheet.id,
    mapping: { [t.emailCol]: "email" },
    keyPath: "email",
    onConflict: "upsert",
    backRefColumnId: backRefId,
  };
  applyWrite([{ sourceRowId: 4242, value: { email: "kid@x.com" } }], target);

  const back = (db.prepare("SELECT value_text FROM cells WHERE column_id = ?").get(backRefId) as any).value_text;
  assert.equal(back, "4242", "an exploded row must know which source row produced it");

  // Calling it twice must not create a second back-ref column.
  assert.equal(ensureBackRefColumn(t.sheet.id, "Companies"), backRefId);
});

test("a mapping naming a column on the wrong table is rejected before anything is written", () => {
  const t = targetSheet("write-bad-mapping");
  const other = targetSheet("write-other");
  const plan = planWrite(
    [{ sourceRowId: 1, value: { email: "a@x.com" } }],
    { targetSheetId: t.sheet.id, mapping: { [other.emailCol]: "email" }, onConflict: "insert" },
  );
  assert.ok(plan.errors.length > 0);
  assert.equal(plan.inserts, 0);
});
