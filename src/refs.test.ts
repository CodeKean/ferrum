// The stale cascade — the piece that was missing.
//
// Everything that READS `cells.stale` was built: the glyph in the grid, the "an upstream column
// changed after this ran" line in the cell drawer, the count on every column header, the `is_stale`
// and `is_not_stale` filter operators, and a partial index in db.ts tuned specifically for the
// count. Nothing anywhere ever WROTE the flag. So the count was permanently zero, the glyph never
// appeared, and both filters matched nothing on every table — a feature that looked finished from
// the outside and did nothing at all.
//
// These pin the properties that make the flag mean something rather than merely exist.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { addColumn, createSheet, insertRows, setCellValue, setColumnPrompt } from "./store.ts";
import { markDownstreamStale, rebuildDeps, topoDepths } from "./refs.ts";
import { saveScript } from "./scripts.ts";

/**
 * Website → Industry → Pitch, built the way the app builds a chain: prompts holding stored
 * references, with the edges derived from them rather than declared by hand.
 */
function chain(name: string, rows = 4) {
  const sheet = createSheet(name);
  const website = addColumn(sheet.id, { name: "Website", kind: "static", valueType: "url" });
  const industry = addColumn(sheet.id, { name: "Industry", kind: "ai", valueType: "text" });
  const pitch = addColumn(sheet.id, { name: "Pitch", kind: "ai", valueType: "text" });

  setColumnPrompt(industry.id, `What industry is {{col:${website.id}}} in?`);
  setColumnPrompt(pitch.id, `Write a line for a company in {{col:${industry.id}}}.`);
  rebuildDeps(sheet.id, Number(industry.id));
  rebuildDeps(sheet.id, Number(pitch.id));

  const ids = [Number(website.id), Number(industry.id), Number(pitch.id)];
  insertRows(
    sheet.id,
    Array.from({ length: rows }, (_, i) => ({ values: { [String(ids[0]!)]: `site${i}.com` } })),
    0,
    ids,
  );

  // Give the two downstream columns real answers, so there is something that CAN go out of date.
  const rowIds = (
    db.prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY position").all(sheet.id) as Array<{ id: number }>
  ).map((r) => Number(r.id));
  for (const rowId of rowIds) {
    for (const col of [Number(industry.id), Number(pitch.id)]) {
      db.prepare("UPDATE cells SET status = 'done', value_text = 'x', stale = 0 WHERE row_id = ? AND column_id = ?")
        .run(rowId, col);
    }
  }
  return { sheet, website, industry, pitch, rowIds };
}

const staleCount = (columnId: number | string) =>
  Number(
    (db.prepare("SELECT COUNT(*) AS n FROM cells WHERE column_id = ? AND stale = 1").get(Number(columnId)) as { n: number }).n,
  );

test("changing a cell marks what reads it out of date — transitively", () => {
  const f = chain("stale-chain");
  assert.equal(staleCount(f.industry.id), 0, "nothing is stale before anything changes");

  markDownstreamStale(f.sheet.id, Number(f.website.id), [f.rowIds[0]!]);

  // Industry reads Website directly; Pitch reads Industry. Both are downstream of Website, so a
  // change at the top of the chain has to reach the bottom of it — a cascade that stopped at the
  // first hop would leave Pitch quietly built on a value that had moved.
  assert.equal(staleCount(f.industry.id), 1);
  assert.equal(staleCount(f.pitch.id), 1);
});

test("only the row that changed goes stale", () => {
  // References are row-scoped, so staleness is too. Editing row 3's Website says nothing whatsoever
  // about row 4, and marking the whole column would put an out-of-date glyph on every row in the
  // table after a single edit.
  const f = chain("stale-row-scoped", 5);
  markDownstreamStale(f.sheet.id, Number(f.website.id), [f.rowIds[2]!]);

  assert.equal(staleCount(f.industry.id), 1);
  const which = db
    .prepare("SELECT row_id FROM cells WHERE column_id = ? AND stale = 1")
    .all(Number(f.industry.id)) as Array<{ row_id: number }>;
  assert.equal(Number(which[0]!.row_id), f.rowIds[2]);
});

test("a cell with no answer is not 'out of date' — it has simply never run", () => {
  // The distinction the whole flag rests on. An empty cell marked stale would put an out-of-date
  // glyph on a column nobody has run yet, which is the opposite of informative.
  const f = chain("stale-empty");
  db.prepare("UPDATE cells SET status = 'empty', value_text = NULL WHERE column_id = ?").run(Number(f.industry.id));

  markDownstreamStale(f.sheet.id, Number(f.website.id), f.rowIds);
  assert.equal(staleCount(f.industry.id), 0);
});

test("a pinned cell is never marked out of date", () => {
  // A run never overwrites a pinned cell, so flagging one as out of date would promise a refresh
  // that is never coming.
  const f = chain("stale-pinned");
  db.prepare("UPDATE cells SET pinned = 1 WHERE column_id = ?").run(Number(f.industry.id));

  markDownstreamStale(f.sheet.id, Number(f.website.id), f.rowIds);
  assert.equal(staleCount(f.industry.id), 0);
  // ...but the rest of the chain still cascades, so pinning one column does not sever it.
  assert.equal(staleCount(f.pitch.id), f.rowIds.length);
});

test("re-running the upstream clears the flag it set", () => {
  // Otherwise the count only ever goes up and "out of date" stops meaning anything after the first
  // edit. Both cell-write paths set stale = 0 on the cell they write.
  const f = chain("stale-clears");
  markDownstreamStale(f.sheet.id, Number(f.website.id), f.rowIds);
  assert.equal(staleCount(f.industry.id), f.rowIds.length);

  db.prepare("UPDATE cells SET status = 'done', value_text = 'fresh', stale = 0 WHERE column_id = ?")
    .run(Number(f.industry.id));
  assert.equal(staleCount(f.industry.id), 0);
});

test("a column nothing reads cascades to nothing", () => {
  const f = chain("stale-leaf");
  // Pitch is the end of the chain, so there is nothing below it to invalidate.
  assert.equal(markDownstreamStale(f.sheet.id, Number(f.pitch.id), f.rowIds), 0);
});

test("null rows means every row, which is what a whole-column run is", () => {
  // The fast path: a run that filled the entire column does not need its row ids chunked 500 at a
  // time into an IN clause, and on a million-row table that difference is thousands of statements.
  const f = chain("stale-allrows", 6);
  assert.equal(markDownstreamStale(f.sheet.id, Number(f.website.id), null), 12);
  assert.equal(staleCount(f.industry.id), 6);
  assert.equal(staleCount(f.pitch.id), 6);
});

test("the cell that was edited is fresh, not stale — it IS the new value", () => {
  const f = chain("stale-edit");
  setCellValue(f.rowIds[1]!, Number(f.website.id), "changed.com");
  markDownstreamStale(f.sheet.id, Number(f.website.id), [f.rowIds[1]!]);

  assert.equal(staleCount(f.industry.id), 1);
  const edited = db
    .prepare("SELECT stale FROM cells WHERE row_id = ? AND column_id = ?")
    .get(f.rowIds[1]!, Number(f.website.id)) as { stale: number };
  assert.equal(Number(edited.stale), 0);
});

// ── a script's row accesses ARE dependencies ─────────────────────────────────────────────────────
//
// `saveScript` says so in as many words and takes the union of both parsers before validating. The
// function that writes the graph the ENGINE runs on used only the template half, so a script column
// that reads another column recorded no dependency at all.

test("a script reading row.<column> records a real dependency edge", () => {
  const sheet = createSheet("dep-rowaccess");
  const producer = addColumn(sheet.id, { name: "Producer", kind: "script", valueType: "text" });
  const consumer = addColumn(sheet.id, { name: "Consumer", kind: "script", valueType: "text" });

  saveScript({
    sheetId: sheet.id,
    columnId: Number(consumer.id),
    hook: "transform",
    runtime: "js",
    intent: "read the producer",
    // No {{col:N}} anywhere — this is how a generated script actually reads its inputs.
    code: 'function transform(row){ return "saw:" + (row.producer || "NOTHING"); }',
  });

  const edges = db
    .prepare("SELECT depends_on FROM column_deps WHERE column_id = ?")
    .all(Number(consumer.id)) as Array<{ depends_on: number }>;
  assert.deepEqual(edges.map((e) => Number(e.depends_on)), [Number(producer.id)]);
});

test("and that edge puts the consumer AFTER the producer, whatever order they were created in", () => {
  // The consumer is created FIRST here, so it sits to the left and sorts first on position. Without
  // the edge both columns land at depth 0 and position decides — measured live, the consumer ran
  // first and wrote "saw:NOTHING" while reporting success. A wrong answer, silently, no error.
  const sheet = createSheet("dep-order");
  const consumer = addColumn(sheet.id, { name: "Consumer", kind: "script", valueType: "text" });
  const producer = addColumn(sheet.id, { name: "Producer", kind: "script", valueType: "text" });

  saveScript({
    sheetId: sheet.id, columnId: Number(consumer.id), hook: "transform", runtime: "js",
    intent: "read the producer",
    code: 'function transform(row){ return "saw:" + (row.producer || "NOTHING"); }',
  });

  const depths = topoDepths(sheet.id);
  assert.equal(depths.get(Number(producer.id)), 0, "the producer has no inputs");
  assert.ok(
    (depths.get(Number(consumer.id)) ?? 0) > (depths.get(Number(producer.id)) ?? 0),
    "the consumer must sort strictly after the column it reads",
  );
});

test("a cycle between two script columns is caught, now that the edges exist", () => {
  // Cycle detection reads the same graph, so it was equally blind to script columns.
  const sheet = createSheet("dep-cycle");
  const a = addColumn(sheet.id, { name: "Alpha", kind: "script", valueType: "text" });
  const b = addColumn(sheet.id, { name: "Beta", kind: "script", valueType: "text" });

  saveScript({
    sheetId: sheet.id, columnId: Number(b.id), hook: "transform", runtime: "js",
    intent: "b reads a", code: "function transform(row){ return row.alpha; }",
  });
  const out = saveScript({
    sheetId: sheet.id, columnId: Number(a.id), hook: "transform", runtime: "js",
    intent: "a reads b", code: "function transform(row){ return row.beta; }",
  });
  assert.ok(out.errors.some((e) => /Circular reference/i.test(e)), `expected a cycle error, got ${JSON.stringify(out.errors)}`);
});

// ── Optional and path references are still dependencies ────────────────────────────────────────
//
// The pattern this graph is built from matched `col:` + digits + `}}` and nothing else, so BOTH
// `{{col:12?}}` and `{{col:12.industry}}` matched nothing at all. Not an error, not an unknown name:
// invisible. An invisible reference is a missing edge, and a missing edge means the column is ranked
// at depth 0 and runs BEFORE the column it reads is filled — a whole sheet of confident answers about
// blanks, on a lane that charges per row.

test("an OPTIONAL reference still orders the column after the one it reads", () => {
  const sheet = createSheet("dep-optional");
  const website = addColumn(sheet.id, { name: "Website", kind: "static", valueType: "url" });
  const industry = addColumn(sheet.id, { name: "Industry", kind: "ai", valueType: "text" });

  // "may be blank" is not "may be stale" — optional changes what happens on an empty value, not the
  // order the two columns have to run in.
  setColumnPrompt(industry.id, `What industry is {{col:${website.id}?}} in?`);
  rebuildDeps(sheet.id, Number(industry.id));

  const depths = topoDepths(sheet.id);
  assert.ok(
    (depths.get(Number(industry.id)) ?? 0) > (depths.get(Number(website.id)) ?? 0),
    "an optional reference is still a dependency",
  );
});

test("a PATH reference orders the column after the one it reads into", () => {
  const sheet = createSheet("dep-path");
  const firmo = addColumn(sheet.id, { name: "Firmographics", kind: "http", valueType: "json" });
  const pitch = addColumn(sheet.id, { name: "Pitch", kind: "ai", valueType: "text" });

  setColumnPrompt(pitch.id, `Write a line for a {{col:${firmo.id}.industry}} company.`);
  rebuildDeps(sheet.id, Number(pitch.id));

  const depths = topoDepths(sheet.id);
  assert.ok(
    (depths.get(Number(pitch.id)) ?? 0) > (depths.get(Number(firmo.id)) ?? 0),
    "reading one field is still reading the column",
  );
});

test("saving does not quietly drop the optional marker or the path", () => {
  // canonicalizeRefs runs on save. It used to rewrite every id reference to a bare `{{col:N}}`, so
  // the moment these forms started matching, a save would have turned an optional reference back
  // into a required one and widened a field to the whole JSON blob — no error, no warning.
  const sheet = createSheet("dep-preserve");
  const src = addColumn(sheet.id, { name: "Firmographics", kind: "http", valueType: "json" });
  const out = addColumn(sheet.id, { name: "Pitch", kind: "ai", valueType: "text" });

  const written = `A {{col:${src.id}.industry?}} company in {{col:${src.id}.hq.city}}.`;
  setColumnPrompt(out.id, written);

  const saved = db.prepare("SELECT prompt FROM columns WHERE id = ?").get(Number(out.id)) as any;
  assert.equal(saved.prompt, written, "the reference is stored exactly as it was written");
});

// ── a slash-name is a reference, not text ───────────────────────────────────

test("a typed or pasted /Column becomes a real reference when it is saved", () => {
  // The `/` menu inserts a chip, so nobody clicking through the UI produces this. Everybody else
  // does: a prompt pasted from a document, a column configured over the API, or anyone who typed the
  // name instead of picking it from the list — which the field's own hint invites.
  //
  // Before this, `What industry is /Company in?` was stored and SENT with those literal characters,
  // on every row, with no pill in the editor and no warning anywhere.
  const sheet = createSheet("slash-refs");
  const company = addColumn(sheet.id, { name: "Company", kind: "static", valueType: "text" });
  const out = addColumn(sheet.id, { name: "Industry", kind: "ai", valueType: "text" });

  setColumnPrompt(out.id, "What industry is /Company in?");
  const saved = db.prepare("SELECT prompt FROM columns WHERE id = ?").get(Number(out.id)) as any;
  assert.equal(saved.prompt, `What industry is {{col:${company.id}}} in?`);
});

test("the longer column name wins, so one name cannot swallow another's tail", () => {
  // A sheet with both "Company" and "Company Size" is ordinary. Matching the short one first would
  // turn "/Company Size" into a reference to Company followed by the stray word "Size".
  const sheet = createSheet("slash-longest");
  addColumn(sheet.id, { name: "Company", kind: "static", valueType: "text" });
  const size = addColumn(sheet.id, { name: "Company Size", kind: "static", valueType: "number" });
  const out = addColumn(sheet.id, { name: "Blurb", kind: "ai", valueType: "text" });

  setColumnPrompt(out.id, "Headcount is /Company Size today.");
  const saved = db.prepare("SELECT prompt FROM columns WHERE id = ?").get(Number(out.id)) as any;
  assert.equal(saved.prompt, `Headcount is {{col:${size.id}}} today.`);
});

test("an ordinary slash is left alone, which is most of them", () => {
  // The reason only an EXACT match against a live column converts. Rewriting every slash would
  // mangle dates, URLs and "and/or" — a fix that damages more prompts than it repairs.
  const sheet = createSheet("slash-innocent");
  addColumn(sheet.id, { name: "Company", kind: "static", valueType: "text" });
  const out = addColumn(sheet.id, { name: "Blurb", kind: "ai", valueType: "text" });

  const text = "Due 03/04/2026. See https://Company.example.com and/or the deck. Not /Companies.";
  setColumnPrompt(out.id, text);
  const saved = db.prepare("SELECT prompt FROM columns WHERE id = ?").get(Number(out.id)) as any;
  assert.equal(saved.prompt, text, "no column is called any of those, and the URL is not a reference");
});

test("a reference that already exists is not chewed up by the slash pass", () => {
  // A path can contain characters the second pattern would otherwise walk into. The existing
  // {{...}} is matched first and passed through whole.
  const sheet = createSheet("slash-existing");
  const src = addColumn(sheet.id, { name: "Firmographics", kind: "http", valueType: "json" });
  addColumn(sheet.id, { name: "Company", kind: "static", valueType: "text" });
  const out = addColumn(sheet.id, { name: "Blurb", kind: "ai", valueType: "text" });

  const written = `A {{col:${src.id}.hq.city}} company.`;
  setColumnPrompt(out.id, written);
  const saved = db.prepare("SELECT prompt FROM columns WHERE id = ?").get(Number(out.id)) as any;
  assert.equal(saved.prompt, written);
});

test("a hand-typed {{Column Name}} is rewritten too, which the header always claimed and the save never did", () => {
  // refs.ts opens by saying a by-name reference is "still accepted on save and rewritten to the id
  // form, so a pasted prompt from elsewhere works". The only caller of canonicalizeRefs in the whole
  // engine was the template importer, so on the path people actually use it was never true.
  const sheet = createSheet("byname-save");
  const company = addColumn(sheet.id, { name: "Company", kind: "static", valueType: "text" });
  const out = addColumn(sheet.id, { name: "Industry", kind: "ai", valueType: "text" });

  setColumnPrompt(out.id, "Classify {{Company}} please.");
  const saved = db.prepare("SELECT prompt FROM columns WHERE id = ?").get(Number(out.id)) as any;
  assert.equal(saved.prompt, `Classify {{col:${company.id}}} please.`);
});
