// The send path: what the match key does when it is there, when it is blank, and when there is none
// at all — plus the two things the dry run used to promise and not do.
//
// Every case here was a live duplication of somebody's destination table. The shape is always the
// same: a row lands with no key, nothing can ever match it again, and the next run adds another one.
// So these tests run the same send two and three times over and assert the row COUNT, not just the
// numbers the plan reported.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { addColumn, countRows, createSheet, insertRows, setCellValue } from "./store.ts";
import { trashTable } from "./views.ts";
import {
  applyWrite,
  buildWriteItems,
  DEFAULT_SEND,
  emptyBuildStats,
  ensureBackRefColumn,
  planWrite,
  resolveSendScope,
  targetOf,
  type SendConfig,
} from "./writeTarget.ts";

/** A source table of companies, and the row ids to send. */
function sourceSheet(name: string, rows: Array<{ company: string; email: string }>) {
  const sheet = createSheet(name);
  const company = addColumn(sheet.id, { name: "Company" });
  const email = addColumn(sheet.id, { name: "Email", valueType: "email" });
  const ids = [Number(company.id), Number(email.id)];
  insertRows(
    sheet.id,
    rows.map((r) => ({ values: { [String(ids[0])]: r.company, [String(ids[1])]: r.email } })),
    0,
    ids,
  );
  const rowIds = (db.prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY position").all(sheet.id) as any[])
    .map((r) => Number(r.id));
  return { sheet, companyId: ids[0]!, emailId: ids[1]!, rowIds };
}

function destSheet(name: string) {
  const sheet = createSheet(name);
  const company = addColumn(sheet.id, { name: "Company" });
  const email = addColumn(sheet.id, { name: "Email", valueType: "email" });
  return { sheet, companyId: Number(company.id), emailId: Number(email.id) };
}

/** A row-to-row send matching on the Email column, which is the ordinary configuration. */
function rowSend(src: ReturnType<typeof sourceSheet>, dst: ReturnType<typeof destSheet>): SendConfig {
  return {
    ...DEFAULT_SEND,
    targetSheetId: dst.sheet.id,
    method: "row",
    mapping: {
      [dst.companyId]: { from: "row", columnId: src.companyId },
      [dst.emailId]: { from: "row", columnId: src.emailId },
    },
    keySource: { from: "row", columnId: src.emailId },
    onConflict: "upsert",
    withBackRef: false,
  };
}

test("a match key taken from a COLUMN survives a re-run, the same way keyPath does", () => {
  // The existing tests all exercise `keyPath` — a key inside an item. A row-to-row send has no item,
  // so its key comes off a column, and that branch had no cover at all.
  const src = sourceSheet("send-keysource-src", [
    { company: "Acme", email: "a@acme.com" },
    { company: "Beta", email: "b@beta.io" },
  ]);
  const dst = destSheet("send-keysource-dst");
  const cfg = rowSend(src, dst);
  const target = targetOf(cfg);

  const first = applyWrite(buildWriteItems(cfg, src.rowIds), target);
  assert.equal(first.inserts, 2);
  assert.equal(countRows(dst.sheet.id), 2);

  const second = applyWrite(buildWriteItems(cfg, src.rowIds), target);
  assert.equal(second.updates, 2, "the second run must recognise its own rows");
  assert.equal(second.inserts, 0);
  assert.equal(countRows(dst.sheet.id), 2, "three runs, two rows");

  applyWrite(buildWriteItems(cfg, src.rowIds), target);
  assert.equal(countRows(dst.sheet.id), 2);
});

test("a row with nothing in the match column is skipped, not re-inserted on every run", () => {
  // The reproduction: the destination went 5 -> 6 -> 7 across three identical runs. A blank key
  // resolves to null, lands with a NULL dedupe_key, and is outside the key index forever after — so
  // no later run can match it and every one adds another copy.
  const src = sourceSheet("send-blankkey-src", [
    { company: "Acme", email: "a@acme.com" },
    { company: "Nokey", email: "" },
  ]);
  const dst = destSheet("send-blankkey-dst");
  const cfg = rowSend(src, dst);
  const target = targetOf(cfg);

  const first = applyWrite(buildWriteItems(cfg, src.rowIds), target);
  assert.equal(first.inserts, 1);
  assert.equal(first.skips, 1);
  assert.equal(countRows(dst.sheet.id), 1, "the keyless row must not land in the destination");

  // Said out loud, on the plan and on the row that caused it — a silent skip is only a slower lie.
  assert.match(first.warnings.join(" "), /nothing in the column being matched on/);
  const outcome = first.outcomes[String(src.rowIds[1])];
  assert.equal(outcome?.skipped, 1);
  assert.match(String(outcome?.reason), /matched on/);

  applyWrite(buildWriteItems(cfg, src.rowIds), target);
  applyWrite(buildWriteItems(cfg, src.rowIds), target);
  assert.equal(countRows(dst.sheet.id), 1, "and it must not creep in one copy per run");
});

test("a config with no match key states what it will do, under every conflict policy", () => {
  const src = sourceSheet("send-keyless-src", [
    { company: "Acme", email: "a@acme.com" },
    { company: "Beta", email: "b@beta.io" },
    { company: "Gamma", email: "c@gamma.dev" },
  ]);

  // The shipped default carries no key, and with no key every policy inserts. Storing "upsert" was
  // the config promising an idempotency it had no way to keep.
  assert.equal(DEFAULT_SEND.onConflict, "insert");

  for (const onConflict of ["upsert", "insert", "skip"] as const) {
    const dst = destSheet(`send-keyless-dst-${onConflict}`);
    const cfg: SendConfig = { ...rowSend(src, dst), keySource: undefined, onConflict };
    const target = targetOf(cfg);

    const plan = planWrite(buildWriteItems(cfg, src.rowIds), target);
    assert.equal(plan.inserts, 3);
    assert.match(plan.warnings.join(" "), /No match key/, `${onConflict} must warn`);
    assert.match(plan.warnings.join(" "), /3 rows over there every time it runs/);

    // And the warning is true: this really is what a keyless send does. 3 -> 6, on every policy.
    applyWrite(buildWriteItems(cfg, src.rowIds), target);
    applyWrite(buildWriteItems(cfg, src.rowIds), target);
    assert.equal(countRows(dst.sheet.id), 6, `${onConflict} with no key duplicates — say so first`);
  }
});

test("a pinned cell over there previews as a skip, because the write refuses it", () => {
  const src = sourceSheet("send-pinned-src", [{ company: "Acme", email: "a@acme.com" }]);
  const dst = destSheet("send-pinned-dst");
  const cfg = rowSend(src, dst);
  const target = targetOf(cfg);

  applyWrite(buildWriteItems(cfg, src.rowIds), target);
  const targetRowId = Number((db.prepare("SELECT id FROM rows WHERE sheet_id = ?").get(dst.sheet.id) as any).id);

  // A hand correction pins the cell, and the update statement carries `AND pinned = 0` — so an
  // upsert onto a fully pinned row changes nothing. Counting that as an update was the preview
  // promising a change the write would then refuse to make.
  setCellValue(targetRowId, dst.companyId, "Acme, corrected by hand");
  setCellValue(targetRowId, dst.emailId, "a@acme.com");

  const plan = planWrite(buildWriteItems(cfg, src.rowIds), target);
  assert.equal(plan.updates, 0);
  assert.equal(plan.skips, 1);
  assert.equal(plan.preview[0]?.action, "skip");

  const applied = applyWrite(buildWriteItems(cfg, src.rowIds), target);
  assert.equal(applied.skips, 1, "the write agrees with the preview");
  const kept = (db.prepare("SELECT value_text FROM cells WHERE row_id = ? AND column_id = ?")
    .get(targetRowId, dst.companyId) as any).value_text;
  assert.equal(kept, "Acme, corrected by hand");

  // One pinned cell out of two is still an update: the other cell really does change.
  db.prepare("UPDATE cells SET pinned = 0 WHERE row_id = ? AND column_id = ?").run(targetRowId, dst.emailId);
  const partial = planWrite(buildWriteItems(cfg, src.rowIds), targetOf(cfg));
  assert.equal(partial.updates, 1);
  assert.equal(partial.skips, 0);
});

test("the per-item cap reports what it dropped instead of truncating in silence", () => {
  const sheet = createSheet("send-cap-src");
  const list = addColumn(sheet.id, { name: "Contacts", valueType: "json" });
  const listId = Number(list.id);
  const contacts = Array.from({ length: 140 }, (_, i) => ({ email: `p${i}@x.com` }));
  insertRows(sheet.id, [{ values: { [String(listId)]: JSON.stringify(contacts) } }], 0, [listId]);
  const rowId = Number((db.prepare("SELECT id FROM rows WHERE sheet_id = ?").get(sheet.id) as any).id);

  const dst = destSheet("send-cap-dst");
  const cfg: SendConfig = {
    ...DEFAULT_SEND,
    targetSheetId: dst.sheet.id,
    method: "per_item",
    listColumnId: listId,
    mapping: { [dst.emailId]: { from: "item", path: "email" } },
    cap: 50,
  };

  const stats = emptyBuildStats();
  const items = buildWriteItems(cfg, [rowId], stats);

  assert.equal(items.length, 50, "the cap still holds — a 10,000-item list is a table, not a cell");
  // "sent 50 rows" for a row that had 140 contacts is a number nobody can tell is partial.
  assert.equal(stats.totalByRow.get(rowId), 140);
  assert.equal(stats.droppedByRow.get(rowId), 90);
  assert.equal(stats.dropped, 90);

  // Nothing was dropped when nothing exceeded the cap, so the caller can say "sent 3" plainly.
  const under = emptyBuildStats();
  buildWriteItems({ ...cfg, cap: 500 }, [rowId], under);
  assert.equal(under.dropped, 0);
});

test("a send wider than SQLite's variable ceiling reads in slices instead of throwing", () => {
  // 32,765 rows worked and 32,766 threw the raw engine error: the run failed, nothing was written,
  // and no cell recorded why. The row ids need not exist — what is being tested is the statement.
  const src = sourceSheet("send-ceiling-src", [{ company: "Acme", email: "a@acme.com" }]);
  const dst = destSheet("send-ceiling-dst");
  const cfg = rowSend(src, dst);

  const many = Array.from({ length: 33_000 }, (_, i) => i + 1);
  const items = buildWriteItems(cfg, many);
  assert.equal(items.length, 33_000, "every row is still built, in slices");
});

test("the preview describes the write it will really perform", () => {
  const src = sourceSheet("send-preview-src", [{ company: "Acme", email: "a@acme.com" }]);
  const dst = destSheet("send-preview-dst");
  const cfg: SendConfig = { ...rowSend(src, dst), withBackRef: true };
  ensureBackRefColumn(dst.sheet.id, "Leads");

  // Without the source table's name there is nothing to find the back-reference column by, so the
  // preview omits the column that links the two tables — a write it is not describing.
  const bare = planWrite(buildWriteItems(cfg, src.rowIds), targetOf(cfg));
  assert.ok(!("Leads row" in (bare.preview[0]?.values ?? {})));

  const plan = planWrite(buildWriteItems(cfg, src.rowIds), targetOf(cfg, "Leads"));
  assert.equal(plan.preview[0]?.values["Leads row"], String(src.rowIds[0]));

  applyWrite(buildWriteItems(cfg, src.rowIds), targetOf(cfg, "Leads"));
  const back = (db.prepare(
    "SELECT value_text FROM cells WHERE column_id = (SELECT id FROM columns WHERE sheet_id = ? AND name = 'Leads row')",
  ).get(dst.sheet.id) as any).value_text;
  assert.equal(back, String(src.rowIds[0]), "and the run writes exactly what the preview showed");
});

test("a destination in the trash is refused rather than written into", () => {
  const src = sourceSheet("send-trashed-src", [{ company: "Acme", email: "a@acme.com" }]);
  const dst = destSheet("send-trashed-dst");
  const cfg = rowSend(src, dst);

  trashTable(dst.sheet.id);

  // A trashed table keeps its id, its columns and its rows, so every statement in the writer
  // succeeds against it — the run reported "done" with 0 errors while writing into the trash.
  assert.throws(() => targetOf(cfg), /trash/i);

  const scope = resolveSendScope(cfg, src.rowIds);
  assert.ok(scope.errors.length > 0);
  assert.equal(scope.rowIds.length, 0, "fail closed: a caller that ignores the errors still writes nothing");
  assert.equal(countRows(dst.sheet.id), 0);
});

test("the scope helper says when a run condition will narrow what actually gets sent", () => {
  const src = sourceSheet("send-scope-src", [
    { company: "Acme", email: "a@acme.com" },
    { company: "Beta", email: "b@beta.io" },
  ]);
  const dst = destSheet("send-scope-dst");
  const cfg = rowSend(src, dst);

  const previewed = resolveSendScope(cfg, src.rowIds, { conditionScriptId: 7 });
  assert.equal(previewed.rowIds.length, 2);
  assert.match(previewed.warnings.join(" "), /run condition/);

  // Once the gate has narrowed the rows, there is nothing left to caveat.
  const ran = resolveSendScope(cfg, [src.rowIds[0]!], { conditionScriptId: 7, conditionApplied: true });
  assert.equal(ran.warnings.length, 0);
  assert.equal(ran.rowIds.length, 1);

  const unmapped = resolveSendScope({ ...cfg, mapping: {} }, src.rowIds);
  assert.ok(unmapped.errors.some((e) => /mapped/.test(e)));
});
