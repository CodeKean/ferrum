// Overriding a field pulled out of another column's answer, and taking it back.
//
// This is the sharpest edge in the product. A derived cell is a projection: it exists to agree with
// its source. Typing over one makes it stop agreeing, permanently and invisibly — the value is
// pinned, the refresh skips pinned cells, and nothing anywhere said so. A cell could disagree with
// the answer it claims to be a projection of for the rest of the table's life.
//
// The fix is NOT to let the refresh win. That would make the pin a lie and would destroy a
// correction the user was told would survive. It is to keep the value and say plainly that it has
// drifted, and to offer the way back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { addColumn, createSheet, insertRows, setCellValue } from "./store.ts";
import { expandJsonColumn, refreshDerivedCell, refreshDerivedColumn, extractAt, discoverListPaths } from "./derive.ts";

/** A sheet whose JSON column has been expanded into one child. */
function fixture(name: string, payloads: unknown[]) {
  const sheet = createSheet(name);
  const blob = addColumn(sheet.id, { name: "Enriched", valueType: "json" });
  insertRows(
    sheet.id,
    payloads.map((p) => ({ values: { [String(blob.id)]: JSON.stringify(p) } })),
    0,
    [Number(blob.id)],
  );
  const { created } = expandJsonColumn(sheet.id, Number(blob.id), [{ path: "industry" }]);
  const child = Number(created[0]!.columnId);
  const rowIds = (db.prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY position").all(sheet.id) as any[])
    .map((r) => Number(r.id));
  return { sheet, blobId: Number(blob.id), child, rowIds };
}

const cellOf = (rowId: number, columnId: number) =>
  db.prepare("SELECT value_text, pinned, stale, status FROM cells WHERE row_id = ? AND column_id = ?")
    .get(rowId, columnId) as any;

/** Change what the source says, without going near the child. */
function setSource(rowId: number, blobId: number, payload: unknown) {
  db.prepare("UPDATE cells SET value_text = ?, value_json = NULL WHERE row_id = ? AND column_id = ?")
    .run(JSON.stringify(payload), rowId, blobId);
}

// ── the extraction, in one place ────────────────────────────────────────────

test("a source whose value is itself a quoted JSON string is still read", () => {
  // The double parse. An API that returns a quoted body puts a STRING in the cell whose contents are
  // JSON, and a second copy of this logic would eventually only get one of the two cases right —
  // which is why the whole-column refresh and the single-cell restore share this function.
  assert.equal(extractAt(JSON.stringify({ a: "x" }), "a").text, "x");
  assert.equal(extractAt(JSON.stringify(JSON.stringify({ a: "x" })), "a").text, "x");
  assert.equal(extractAt("not json at all", "a").text, null, "and unparseable is empty, not an error");
  assert.equal(extractAt(null, "a").text, null);
});

// ── the override survives ───────────────────────────────────────────────────

test("an overridden child keeps its value when the whole column refreshes", () => {
  // The promise the override dialog makes. If a refresh could quietly win, the warning shown before
  // the override — "your value stays here" — would be false, and the correction would vanish on the
  // next run of the parent with nothing to show it ever existed.
  const f = fixture("derive-keeps", [{ industry: "Software" }]);
  setCellValue(f.rowIds[0]!, f.child, "Fintech");

  refreshDerivedColumn(f.sheet.id, f.child);

  const c = cellOf(f.rowIds[0]!, f.child);
  assert.equal(c.value_text, "Fintech");
  assert.equal(Number(c.pinned), 1);
});

// ── and is flagged when it drifts ───────────────────────────────────────────

test("an overridden child that disagrees with its source is flagged, not silently orphaned", () => {
  // The bug this replaced. The cell was skipped forever with nothing anywhere saying it had stopped
  // following its source.
  const f = fixture("derive-flag", [{ industry: "Software" }]);
  setCellValue(f.rowIds[0]!, f.child, "Fintech");

  refreshDerivedColumn(f.sheet.id, f.child);
  assert.equal(Number(cellOf(f.rowIds[0]!, f.child).stale), 1, "it no longer matches, and says so");
});

test("the flag comes OFF again when the source catches up with the correction", () => {
  // A flag that could only ever go on would end up on every overridden cell regardless of whether
  // anything was still wrong, and a warning that is always on stops being read.
  const f = fixture("derive-unflag", [{ industry: "Software" }]);
  setCellValue(f.rowIds[0]!, f.child, "Fintech");
  refreshDerivedColumn(f.sheet.id, f.child);
  assert.equal(Number(cellOf(f.rowIds[0]!, f.child).stale), 1);

  // The enrichment is re-run and now agrees with what was typed.
  setSource(f.rowIds[0]!, f.blobId, { industry: "Fintech" });
  refreshDerivedColumn(f.sheet.id, f.child);

  const c = cellOf(f.rowIds[0]!, f.child);
  assert.equal(Number(c.stale), 0, "nothing disagrees any more");
  assert.equal(Number(c.pinned), 1, "and it is still yours");
});

test("a child nobody touched is refilled as before, and never flagged", () => {
  // The ordinary path has to be untouched by all of this. Flagging a cell that simply followed its
  // source would put a warning on the majority of the table.
  const f = fixture("derive-plain", [{ industry: "Software" }, { industry: "Retail" }]);
  setSource(f.rowIds[0]!, f.blobId, { industry: "Biotech" });
  refreshDerivedColumn(f.sheet.id, f.child);

  const c = cellOf(f.rowIds[0]!, f.child);
  assert.equal(c.value_text, "Biotech");
  assert.equal(Number(c.stale), 0);
  assert.equal(Number(c.pinned), 0);
});

// ── the way back ────────────────────────────────────────────────────────────

test("restoring one cell takes the source's answer and drops the override", () => {
  const f = fixture("derive-restore", [{ industry: "Software" }, { industry: "Retail" }]);
  setCellValue(f.rowIds[0]!, f.child, "Fintech");

  assert.equal(refreshDerivedCell(f.sheet.id, f.child, f.rowIds[0]!), true);

  const c = cellOf(f.rowIds[0]!, f.child);
  assert.equal(c.value_text, "Software", "back to what the source says");
  assert.equal(Number(c.pinned), 0, "and no longer marked as typed in — nobody typed this");
  assert.equal(Number(c.stale), 0, "and nothing left to flag");
});

test("restoring one cell does not touch its neighbours", () => {
  // It is a per-CELL action offered from a per-cell panel. Quietly restoring the column would throw
  // away every other correction on the sheet, from a button that named one row.
  const f = fixture("derive-restore-one", [{ industry: "Software" }, { industry: "Retail" }]);
  setCellValue(f.rowIds[0]!, f.child, "Fintech");
  setCellValue(f.rowIds[1]!, f.child, "Grocery");

  refreshDerivedCell(f.sheet.id, f.child, f.rowIds[0]!);

  const other = cellOf(f.rowIds[1]!, f.child);
  assert.equal(other.value_text, "Grocery", "the row nobody asked about is untouched");
  assert.equal(Number(other.pinned), 1);
});

test("restoring a column that is not a projection reports that, rather than pretending", () => {
  // The route branches on this: a derived cell can be restored exactly and for free, and any other
  // lane has to RUN to find out what belongs there — which spends, and is the user's call.
  const sheet = createSheet("derive-not-derived");
  const ai = addColumn(sheet.id, { name: "Summary", kind: "ai" });
  insertRows(sheet.id, [{ values: {} }], 0, [Number(ai.id)]);
  const rowId = Number((db.prepare("SELECT id FROM rows WHERE sheet_id = ?").get(sheet.id) as any).id);

  assert.equal(refreshDerivedCell(sheet.id, Number(ai.id), rowId), false);
});

test("the list inside a JSON column is found, not assumed to be the whole cell", () => {
  // `SendConfig.listPath` was read by the fan-out writer from the day it shipped and could not be set
  // from anywhere. So a column holding {company, contacts:[...]} could only be pointed at whole — and
  // a whole object is not a list, so the fan-out wrote one row containing the object and read as
  // broken. This is the discovery that closes it.
  const sheet = createSheet(`ZZ listpaths ${Math.random().toString(36).slice(2)}`);
  const col = addColumn(sheet.id, { name: "Research", kind: "ai", valueType: "json" });
  insertRows(sheet.id, Array.from({ length: 4 }, () => ({ values: {} })), 0, [Number(col.id)]);
  const rows = (db.prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY position").all(sheet.id) as any[]).map((r) => Number(r.id));

  const put = (rowId: number, o: unknown) =>
    db.prepare("UPDATE cells SET status='done', value_json=?, value_text=? WHERE row_id=? AND column_id=?")
      .run(JSON.stringify(o), JSON.stringify(o), rowId, Number(col.id));

  put(rows[0]!, { company: "Acme", contacts: [{ name: "A" }, { name: "B" }], sources: ["x"] });
  put(rows[1]!, { company: "Beta", contacts: [{ name: "C" }] });
  put(rows[2]!, { company: "Gamma", contacts: [{ name: "D" }, { name: "E" }, { name: "F" }] });
  put(rows[3]!, { company: "Delta", contacts: [] });

  const paths = discoverListPaths(Number(col.id));
  const contacts = paths.find((p) => p.path === "contacts");
  assert.ok(contacts, "the nested list must be offered");
  assert.equal(contacts!.rows, 3, "an empty array on one row is not a list found there");
  assert.equal(contacts!.items, 6);
  assert.equal(contacts!.objects, true, "items with fields are mappable; plain values are not");

  // Ordered by how many rows have one: "contacts" is on three rows and "sources" on one, and burying
  // the obvious answer under the rare one wastes the time this screen exists to save.
  assert.equal(paths[0]!.path, "contacts");
  const sources = paths.find((p) => p.path === "sources");
  assert.equal(sources?.objects, false, "a list of strings is reported as plain values");
});

test("a column that IS a list reports the whole cell, with no path", () => {
  const sheet = createSheet(`ZZ listpaths2 ${Math.random().toString(36).slice(2)}`);
  const col = addColumn(sheet.id, { name: "People", kind: "ai", valueType: "json" });
  insertRows(sheet.id, [{ values: {} }], 0, [Number(col.id)]);
  const rowId = Number((db.prepare("SELECT id FROM rows WHERE sheet_id = ?").get(sheet.id) as any).id);
  const o = [{ name: "A" }, { name: "B" }];
  db.prepare("UPDATE cells SET status='done', value_json=?, value_text=? WHERE row_id=? AND column_id=?")
    .run(JSON.stringify(o), JSON.stringify(o), rowId, Number(col.id));

  const paths = discoverListPaths(Number(col.id));
  assert.equal(paths.length, 1);
  assert.equal(paths[0]!.path, "", "an empty path means the cell itself, which is what the writer already assumed");
  assert.equal(paths[0]!.label, "the whole cell");
});
