// Rows arriving from outside.
//
// The properties tested here are the ones that decide whether an unauthenticated endpoint on an app
// holding provider keys is safe to have at all — and the one that decides whether an integration is
// usable, which is that a retried delivery must not duplicate the row.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.ts";
import { setConfig } from "../dedupe.ts";
import {
  addColumn, createSheet, deleteColumn, insertRows, listColumns, readWindow, setColumnValueType,
} from "../store.ts";
import {
  createSource, deleteSource, deliver, findByToken, listDeliveries, newToken, rotateToken,
  updateSource, MAX_RECORDS,
} from "./webhook.ts";

function fixture(name: string) {
  const sheet = createSheet(name);
  const cols = ["Email", "Company", "Plan"].map((n) => addColumn(sheet.id, { name: n }));
  const source = createSource(sheet.id, "Signups");
  const map: Record<string, string> = {
    [String(cols[0]!.id)]: "user.email",
    [String(cols[1]!.id)]: "user.company.name",
    [String(cols[2]!.id)]: "plan",
  };
  return { sheet, cols, source, map };
}

const values = (sheetId: string) =>
  readWindow(sheetId, 0, 50).rows.map((r) => Object.values(r.cells).map((c: any) => c.v));

test("a retried delivery updates the row it made, rather than adding a second one", () => {
  // Almost every sender retries — on a timeout, on a 500, on a deploy. Without a key, a flaky
  // network quietly doubles the sheet, and nothing about the sheet says why.
  const f = fixture("hook-retry");
  updateSource(f.source.id, { mapping: f.map, keyPath: "user.email" });
  const src = findByToken(f.source.token)!;

  const body = { plan: "pro", user: { email: "Ada@Example.com", company: { name: "Acme Ltd" } } };
  const first = deliver(src, body, JSON.stringify(body));
  assert.deepEqual([first.inserted, first.updated], [1, 0]);

  const again = deliver(src, { ...body, plan: "enterprise" }, "{}");
  assert.deepEqual([again.inserted, again.updated], [0, 1]);

  assert.equal(values(f.sheet.id).length, 1, "still one row");
  assert.deepEqual(values(f.sheet.id)[0], ["Ada@Example.com", "Acme Ltd", "enterprise"]);
});

test("a payload cannot create a column, or land anywhere the mapping did not say", () => {
  // The sender is a stranger. If a field it invented could become a column, a chatty integration
  // would turn a sheet into a copy of its own schema — and a hostile one into whatever it liked.
  const f = fixture("hook-mapping");
  updateSource(f.source.id, { mapping: f.map });
  const src = findByToken(f.source.token)!;

  deliver(src, { plan: "x", secret: "nope", extra: { deep: 1 }, user: { email: "d@x.com" } }, "{}");

  assert.deepEqual(listColumns(f.sheet.id).map((c) => c.name), ["Email", "Company", "Plan"]);
  // And the unmapped values are nowhere in the sheet, not merely absent from a column of their own.
  const flat = JSON.stringify(values(f.sheet.id));
  assert.ok(!flat.includes("nope"), "an unmapped field is not stored");
});

test("one delivery can carry many records, but only when the source says so", () => {
  const f = fixture("hook-batch");
  updateSource(f.source.id, { mapping: f.map, keyPath: "user.email", itemsPath: "records" });
  const src = findByToken(f.source.token)!;

  const out = deliver(src, {
    records: [
      { plan: "free", user: { email: "bo@x.com", company: { name: "Bo Ltd" } } },
      { plan: "pro", user: { email: "cy@x.com", company: { name: "Cy Ltd" } } },
    ],
  }, "{}");
  assert.equal(out.inserted, 2);

  // With no items path, a bare array is ONE record rather than many. Guessing would make the shape
  // depend on the payload instead of on the configuration, so the same sender could silently switch
  // between one row and fifty.
  //
  // The count in the note is what shows it: one record was considered, not two. Without that, none
  // of the mapped paths resolve against an array and a blank ROW goes in anyway.
  const f2 = fixture("hook-batch-off");
  updateSource(f2.source.id, { mapping: f2.map });
  const src2 = findByToken(f2.source.token)!;
  const single = deliver(src2, [{ plan: "a" }, { plan: "b" }], "[]");
  assert.equal(single.inserted, 0);
  assert.match(single.note ?? "", /1 record skipped/);
  assert.equal(values(f2.sheet.id).length, 0);
});

test("with nothing mapped, the first delivery lands whole in a pinned first column", () => {
  // This used to refuse, and refusing was wrong. Mapping a payload BEFORE having seen one means
  // guessing at field names, and a wrong guess produces an empty column rather than an error. So the
  // first delivery is not asked to fit a shape — it lands intact, first and pinned, and columns get
  // derived from what actually arrived.
  const f = fixture("hook-testfire");
  const src = findByToken(f.source.token)!;
  const out = deliver(src, { plan: "pro", user: { email: "ada@x.com" } }, "{}");

  assert.equal(out.ok, true);
  assert.equal(out.inserted, 1);

  const cols = listColumns(f.sheet.id);
  assert.equal(cols[0]!.name, "Signups payload", "it goes FIRST — everything else was derived from it");
  assert.equal(cols[0]!.frozen, true, "and stays on screen while the derived columns scroll");
  assert.equal(cols[0]!.valueType, "json");
  assert.deepEqual(cols.slice(1).map((c) => c.name), ["Email", "Company", "Plan"]);

  // The whole record is there, parseable — which is what the cell panel's JSON tree reads to offer
  // each field as a column.
  const row = readWindow(f.sheet.id, 0, 5).rows[0]!;
  const cell: any = row.cells[String(cols[0]!.id)];
  assert.deepEqual(JSON.parse(cell.v), { plan: "pro", user: { email: "ada@x.com" } });
});

test("the payload column is made once, and deleting it is not an instruction to make another", () => {
  const f = fixture("hook-testfire-again");
  const src = findByToken(f.source.token)!;
  deliver(src, { a: 1 }, "{}");
  deliver(findByToken(f.source.token)!, { a: 2 }, "{}");
  // Two deliveries, two rows, ONE payload column — not one column per delivery.
  assert.equal(listColumns(f.sheet.id).filter((c) => c.name.endsWith("payload")).length, 1);
  assert.equal(readWindow(f.sheet.id, 0, 10).rows.length, 2);

  // Deleting it is a legitimate way of saying "I have pulled out what I needed" — and that used to
  // be read as "so make a fresh one", from a lookup that came back empty. Every delete then made
  // ANOTHER column at position 0 and pushed the whole sheet right again, with nothing bounding it.
  // Now the fact is recorded, the delivery is refused with a reason, and the sheet is left alone.
  const payload = listColumns(f.sheet.id)[0]!;
  deleteColumn(payload.id);
  const after = deliver(findByToken(f.source.token)!, { a: 3 }, "{}");
  assert.equal(after.ok, false);
  assert.deepEqual(listColumns(f.sheet.id).map((c) => c.name), ["Email", "Company", "Plan"]);
  assert.equal(readWindow(f.sheet.id, 0, 10).rows.length, 2, "and no row was added");

  // Column delete is SOFT and undo puts it back, so the source has to come back with it — the link
  // is kept for exactly this, rather than cleared on the way past.
  db.prepare("UPDATE columns SET deleted_at = NULL WHERE id = ?").run(Number(payload.id));
  const back = deliver(findByToken(f.source.token)!, { a: 4 }, "{}");
  assert.equal(back.ok, true);
  assert.equal(back.inserted, 1);
  assert.equal(listColumns(f.sheet.id).filter((c) => c.name.endsWith("payload")).length, 1);
});

test("a switched-off source stores nothing, and the attempt is still recorded", () => {
  const f = fixture("hook-off");
  updateSource(f.source.id, { mapping: f.map, enabled: false });
  const src = findByToken(f.source.token)!;

  const out = deliver(src, { plan: "x", user: { email: "e@x.com" } }, "{}");
  assert.equal(out.ok, false);
  assert.equal(values(f.sheet.id).length, 0);
  // Recorded, because "we turned it off and they kept sending" is a thing worth being able to see.
  assert.equal(listDeliveries(f.source.id).length, 1);
});

test("a token is long, unguessable, and rotatable", () => {
  const f = fixture("hook-token");
  assert.ok(f.source.token.length >= 32, "a short token is a guessable token");
  assert.notEqual(newToken(), newToken());

  const rotated = rotateToken(f.source.id)!;
  assert.notEqual(rotated.token, f.source.token);
  // The old one stops working the moment it is rotated — that is what makes a leak recoverable.
  assert.equal(findByToken(f.source.token), null);
  assert.equal(findByToken(rotated.token)?.id, f.source.id);
});

test("failures are recorded with the body, because that is the only way to debug one", () => {
  const f = fixture("hook-deliveries");
  updateSource(f.source.id, { enabled: false });
  const src = findByToken(f.source.token)!;
  deliver(src, { a: 1 }, '{"a":1}');

  const [d] = listDeliveries(f.source.id);
  assert.equal(d!.ok, false);
  assert.equal(d!.body, '{"a":1}', "what actually arrived, verbatim");

  // And the counters move, so a source that is being called and rejecting everything looks
  // different from one nobody has called.
  const after = db.prepare("SELECT received, rejected FROM webhook_sources WHERE id = ?").get(f.source.id) as any;
  assert.deepEqual([after.received, after.rejected], [0, 1]);
});

test("a retry that omits a field leaves that cell alone, rather than nulling it", () => {
  // `values` was built from every mapping entry unconditionally, so a field the second delivery did
  // not carry resolved to null and was written OVER what the first delivery had stored — and marked
  // done, which the insert path never does for a null. A row holding email + name + company came
  // back as email + null + null across two posts of the same record, with nothing on the sheet
  // saying it had ever held anything else.
  const f = fixture("hook-partial");
  updateSource(f.source.id, { mapping: f.map, keyPath: "user.email" });

  deliver(findByToken(f.source.token)!, { plan: "pro", user: { email: "ada@x.com", company: { name: "Acme Ltd" } } }, "{}");
  const again = deliver(findByToken(f.source.token)!, { user: { email: "ada@x.com" } }, "{}");

  assert.equal(again.updated, 1);
  assert.deepEqual(values(f.sheet.id)[0], ["ada@x.com", "Acme Ltd", "pro"]);

  // An explicit null is a different statement from an absent field — the sender is saying the value
  // is gone — so it still lands. As EMPTY, which is what the insert path writes, so no cell is ever
  // left marked done while holding nothing.
  deliver(findByToken(f.source.token)!, { plan: null, user: { email: "ada@x.com" } }, "{}");
  const cell: any = readWindow(f.sheet.id, 0, 5).rows[0]!.cells[String(f.cols[2]!.id)];
  assert.equal(cell.v, null);
  assert.equal(cell.s, "empty");
});

test("a mapped column that was deleted fails the delivery loudly, instead of dropping the field", () => {
  // Dropping it silently wrote the row with a hole in it — the exact thing the mapping guarantee
  // exists to prevent — and when the deleted column was one of the table's dedupe keys it also
  // stopped the sheet matching duplicates at all. The sender is a stranger: if it is not told, the
  // data is gone and nobody finds out.
  const f = fixture("hook-deleted-col");
  updateSource(f.source.id, { mapping: f.map, keyPath: "user.email" });
  deleteColumn(f.cols[1]!.id);

  const body = { plan: "pro", user: { email: "a@x.com", company: { name: "Acme" } } };
  const out = deliver(findByToken(f.source.token)!, body, "{}");
  assert.equal(out.ok, false);
  assert.match(out.note ?? "", /Company/, "it names the column, so the mapping can be put right");
  assert.equal(values(f.sheet.id).length, 0, "and nothing landed with a hole in it");
  assert.equal(listDeliveries(f.source.id)[0]!.ok, false, "recorded — an unseen failure is no failure");

  // Put the column back and the sender's own retry is what recovers the delivery.
  db.prepare("UPDATE columns SET deleted_at = NULL WHERE id = ?").run(Number(f.cols[1]!.id));
  const retry = deliver(findByToken(f.source.token)!, body, "{}");
  assert.equal(retry.inserted, 1);
  assert.deepEqual(values(f.sheet.id)[0], ["a@x.com", "Acme", "pro"]);
});

test("an empty list is a delivery that succeeded with nothing to do", () => {
  // A poller with nothing to send posts an empty list. Answering "failed" makes it retry a payload
  // that was never wrong, and shows its owner a rejected count for a healthy integration.
  const f = fixture("hook-empty-batch");
  updateSource(f.source.id, { mapping: f.map, itemsPath: "records" });

  const empty = deliver(findByToken(f.source.token)!, { records: [] }, "{}");
  assert.equal(empty.ok, true);
  assert.equal(empty.inserted, 0);
  assert.equal(values(f.sheet.id).length, 0);

  // A path that is not there at all is still a failure — that one is a misconfigured source rather
  // than a quiet hour, and collapsing the two made both undiagnosable.
  const missing = deliver(findByToken(f.source.token)!, { other: [1] }, "{}");
  assert.equal(missing.ok, false);
  assert.match(missing.note ?? "", /records/);

  const counts = db.prepare("SELECT received, rejected FROM webhook_sources WHERE id = ?").get(f.source.id) as any;
  assert.deepEqual([counts.received, counts.rejected], [1, 1]);
});

test("a record matching nothing is skipped, not stored as a blank row", () => {
  const f = fixture("hook-no-match");
  updateSource(f.source.id, { mapping: f.map, keyPath: "user.email", itemsPath: "items" });

  const out = deliver(findByToken(f.source.token)!, { items: ["a", "b"] }, "{}");
  assert.equal(out.inserted, 0);
  assert.equal(out.ok, false, "a delivery that stored nothing is not a success");
  assert.match(out.note ?? "", /2 records skipped/);
  assert.equal(values(f.sheet.id).length, 0);

  // And a retry cannot accumulate them: a blank row's key is null, which escapes the very
  // idempotency the key path exists to provide, so every retry used to add another one.
  deliver(findByToken(f.source.token)!, { items: ["a", "b"] }, "{}");
  assert.equal(values(f.sheet.id).length, 0);
});

test("a sheet-wide duplicate sweep is reported as the table's doing, not the delivery's", () => {
  // One brand-new unique record must not be reported as "1 added, 0 updated. 5 duplicate rows
  // removed." — rows that predated the integration entirely, deleted on a stranger's POST and
  // described as its result.
  const f = fixture("hook-dedupe-note");
  updateSource(f.source.id, { mapping: f.map, keyPath: "user.email" });
  setConfig(f.sheet.id, { columnIds: [Number(f.cols[0]!.id)], auto: true });

  const columnIds = f.cols.map((c) => Number(c.id));
  insertRows(
    f.sheet.id,
    [
      { values: { [String(f.cols[0]!.id)]: "old@x.com" } },
      { values: { [String(f.cols[0]!.id)]: "old@x.com" } },
    ],
    0,
    columnIds,
  );

  const out = deliver(
    findByToken(f.source.token)!,
    { plan: "pro", user: { email: "new@x.com", company: { name: "N" } } },
    "{}",
  );

  assert.equal(out.inserted, 1);
  assert.equal(out.dedupedAfter, 1, "its own field, the way an import reports it");
  assert.match(out.note ?? "", /1 added, 0 updated\./);
  assert.match(out.note ?? "", /table's own duplicate rule/, "attributed to the table, not to this POST");
  assert.equal(values(f.sheet.id).length, 2);
});

test("a row whose mapped cells are all pinned is not counted as updated", () => {
  const f = fixture("hook-pinned");
  updateSource(f.source.id, { mapping: f.map, keyPath: "user.email" });
  const body = { plan: "pro", user: { email: "ada@x.com", company: { name: "Acme" } } };
  deliver(findByToken(f.source.token)!, body, "{}");

  db.prepare("UPDATE cells SET pinned = 1 WHERE row_id IN (SELECT id FROM rows WHERE sheet_id = ?)").run(f.sheet.id);
  const again = deliver(findByToken(f.source.token)!, { ...body, plan: "enterprise" }, "{}");

  // The count came from rows attempted rather than cells written, so a delivery that was refused
  // every single cell still reported "1 updated".
  assert.equal(again.updated, 0);
  assert.match(again.note ?? "", /pinned/);
  assert.deepEqual(values(f.sheet.id)[0], ["ada@x.com", "Acme", "pro"]);
});

test("a batch over the record limit is refused whole, and the refusal is recorded", () => {
  // The body limit bounds the bytes, not the work: 256KB of tiny objects is thousands of rows of
  // synchronous writes on the only thread there is, asked for by anyone who can reach the address.
  const f = fixture("hook-too-big");
  updateSource(f.source.id, { mapping: f.map, keyPath: "user.email", itemsPath: "items" });
  const items = Array.from({ length: MAX_RECORDS + 1 }, (_, i) => ({ user: { email: `p${i}@x.com` } }));

  const out = deliver(findByToken(f.source.token)!, { items }, "{}");
  assert.equal(out.ok, false);
  assert.equal(values(f.sheet.id).length, 0, "refused whole — half a batch is worse than none of it");
  assert.match(listDeliveries(f.source.id)[0]!.note ?? "", new RegExp(String(MAX_RECORDS)));
});

test("an arriving value is stored once, not as a quoted duplicate beside itself", () => {
  // The insert wrote `value_json = JSON.stringify(value_text)` for values that are already strings —
  // a full second copy of every cell a webhook has ever delivered, measured at 124% of the text
  // column. Worse, the UPDATE path beside it sets `value_json = NULL`, so one record read back down
  // a different branch of the reader depending only on whether it had ever been retried.
  const f = fixture("hook-value-json");
  updateSource(f.source.id, { mapping: f.map, keyPath: "user.email" });

  deliver(findByToken(f.source.token)!, { plan: "pro", user: { email: "ada@x.com" } }, "{}");
  const blobs = db
    .prepare(
      `SELECT COUNT(*) n FROM cells
        WHERE value_json IS NOT NULL AND row_id IN (SELECT id FROM rows WHERE sheet_id = ?)`,
    )
    .get(f.sheet.id) as any;
  assert.equal(blobs.n, 0, "the text is the value; there is nothing to duplicate it with");
  assert.deepEqual(values(f.sheet.id)[0], ["ada@x.com", null, "pro"], "and the value still reads back");

  // The pinned payload column is the one at risk of being double-encoded — a JSON document quoted a
  // second time — so it is worth saying explicitly that it lands as itself.
  const g = fixture("hook-value-json-payload");
  deliver(findByToken(g.source.token)!, { a: 1 }, "{}");
  const payloadCol = listColumns(g.sheet.id)[0]!;
  const cell: any = readWindow(g.sheet.id, 0, 5).rows[0]!.cells[String(payloadCol.id)];
  assert.deepEqual(JSON.parse(cell.v), { a: 1 });
});

test("a delivery is still recorded when the duplicate sweep behind it fails", () => {
  // The sweep runs AFTER the rows are committed and BEFORE the delivery is recorded, and it was the
  // one whole-table operation in here with nothing around it — so a failure took the delivery down
  // having already written it: rows in the sheet, nothing in the delivery list, neither counter
  // moved, and a 500 back to a sender that will now retry a payload which actually landed.
  //
  // Forced with a trigger rather than a stub, so what is being proven is a real aborted DELETE
  // coming back out of SQLite, not a mock. Scoped to this sheet so no other test can feel it.
  const f = fixture("hook-dedupe-throws");
  updateSource(f.source.id, { mapping: f.map, keyPath: "user.email" });
  setConfig(f.sheet.id, { columnIds: [Number(f.cols[0]!.id)], auto: true });

  // Two rows the sweep will want to collapse, so it gets as far as the DELETE the trigger blocks.
  insertRows(
    f.sheet.id,
    [
      { values: { [String(f.cols[0]!.id)]: "old@x.com" } },
      { values: { [String(f.cols[0]!.id)]: "old@x.com" } },
    ],
    0,
    f.cols.map((c) => Number(c.id)),
  );
  db.exec(
    `CREATE TRIGGER hook_dedupe_boom BEFORE DELETE ON rows WHEN OLD.sheet_id = '${f.sheet.id}'
     BEGIN SELECT RAISE(ABORT, 'sweep refused'); END`,
  );

  try {
    const out = deliver(
      findByToken(f.source.token)!,
      { plan: "pro", user: { email: "new@x.com", company: { name: "N" } } },
      "{}",
    );

    assert.equal(out.ok, true, "the rows landed, so the delivery succeeded");
    assert.equal(out.inserted, 1);
    assert.equal(out.dedupedAfter, 0, "nothing was measured — which is what 0 has always meant here");
    assert.equal(values(f.sheet.id).length, 3, "and the failed sweep removed nothing");

    const [d] = listDeliveries(f.source.id);
    assert.equal(d!.ok, true, "recorded — an unrecorded delivery is the failure this file exists against");
    assert.equal(d!.rowsWritten, 1);
    const counts = db.prepare("SELECT received, rejected FROM webhook_sources WHERE id = ?").get(f.source.id) as any;
    assert.deepEqual([counts.received, counts.rejected], [1, 0]);
  } finally {
    db.exec("DROP TRIGGER hook_dedupe_boom");
  }
});

test("deleting a source takes the note about its payload column with it", () => {
  // The note lives in `kv` keyed by source id, which is not a place a foreign key reaches, so it
  // used to survive the source forever — one orphan per source ever set up, used and removed. Only
  // AUTOINCREMENT stopped that becoming a wrong answer: reissue the id and the next source starts
  // life refusing every delivery over a column it never had.
  const f = fixture("hook-source-delete");
  const key = `webhook.${f.source.id}.payload_column_dropped`;
  const noteRow = () => db.prepare("SELECT v FROM kv WHERE k = ?").get(key) as any;

  deliver(findByToken(f.source.token)!, { a: 1 }, "{}");
  deleteColumn(listColumns(f.sheet.id)[0]!.id);
  // The refusal is what writes the note down.
  assert.equal(deliver(findByToken(f.source.token)!, { a: 2 }, "{}").ok, false);
  assert.equal(noteRow()?.v, "1");

  deleteSource(f.source.id);
  assert.equal(noteRow(), undefined, "nothing of the source is left behind");
  assert.equal(findByToken(f.source.token), null);
});

test("the value stored is normalized the same way the key it is stored under is", () => {
  // The key was trimmed and lower-cased and the value beside it was not, so the same record showed a
  // different literal after every retry while the row insisted both were the same record.
  const f = fixture("hook-normalize");
  setColumnValueType(f.cols[0]!.id, "email");
  updateSource(f.source.id, { mapping: f.map, keyPath: "user.email" });

  deliver(findByToken(f.source.token)!, { user: { email: " Ada@Example.com " } }, "{}");
  assert.equal(values(f.sheet.id)[0]![0], "ada@example.com");

  deliver(findByToken(f.source.token)!, { user: { email: "ADA@example.com" } }, "{}");
  assert.equal(values(f.sheet.id).length, 1, "still the same record");
  assert.equal(values(f.sheet.id)[0]![0], "ada@example.com");
});
