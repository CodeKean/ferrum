// Removing duplicate rows.
//
// This deletes data, so the properties worth testing are the ones whose failure is silent: a
// waterfall that quietly stops at level one, a "keep newest" that keeps the oldest, and a preview
// whose number disagrees with what the run then does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { addColumn, createSheet, insertRows, readWindow } from "./store.ts";
import { apply, autoDedupe, findDuplicates, normalizeKey, preview, setConfig } from "./dedupe.ts";

function fixture(name: string, rows: Array<[string, string, string]>) {
  const sheet = createSheet(name);
  const email = addColumn(sheet.id, { name: "Email", valueType: "email" });
  const domain = addColumn(sheet.id, { name: "Domain", valueType: "url" });
  const label = addColumn(sheet.id, { name: "Label" });
  const ids = [Number(email.id), Number(domain.id), Number(label.id)];
  insertRows(
    sheet.id,
    rows.map(([e, d, l]) => ({ values: { [ids[0]!]: e, [ids[1]!]: d, [ids[2]!]: l } })),
    0,
    ids,
  );
  return { sheet, email, domain, label, ids };
}

const labels = (sheetId: string) =>
  readWindow(sheetId, 0, 100).rows.map((r) => Object.values(r.cells).map((c: any) => c.v)[2]);

test("the waterfall falls through: rows missing the first key are matched on the second", () => {
  // The whole point. Deduping on email alone keeps every duplicate that has no email, and reports
  // success while doing it.
  const f = fixture("dd-waterfall", [
    ["ada@acme.com", "acme.com", "A1"],
    ["ADA@Acme.com ", "", "A2"],          // same email, different case and spacing
    ["", "acme.com", "B1"],               // no email at all — falls to the domain
    ["", "https://www.Acme.com/", "B2"],  // same domain, written differently
    ["zoe@other.com", "other.com", "C1"], // unique
  ]);
  setConfig(f.sheet.id, { columnIds: [Number(f.email.id), Number(f.domain.id)], keep: "oldest" });

  const groups = findDuplicates(f.sheet.id);
  assert.equal(groups.length, 2, "one group matched on email, one matched on domain");

  const report = apply(f.sheet.id);
  assert.deepEqual([report.groups, report.duplicates], [2, 2]);
  assert.deepEqual(labels(f.sheet.id), ["A1", "B1", "C1"]);
});

test("a row keyed by email is never merged with a row keyed by domain", () => {
  // Both normalize to the same string, and they are still not the same record: one was compared on
  // its email address and the other on its website. Matching them would merge two things that were
  // never shown to be equal.
  const f = fixture("dd-tagged", [
    ["acme.com", "", "AS-EMAIL"],
    ["", "acme.com", "AS-DOMAIN"],
  ]);
  setConfig(f.sheet.id, { columnIds: [Number(f.email.id), Number(f.domain.id)] });
  assert.equal(findDuplicates(f.sheet.id).length, 0);
  apply(f.sheet.id);
  assert.deepEqual(labels(f.sheet.id), ["AS-EMAIL", "AS-DOMAIN"]);
});

test("keep oldest and keep newest pick opposite ends, and both are explicit", () => {
  const rows: Array<[string, string, string]> = [
    ["ada@x.com", "", "FIRST"],
    ["ada@x.com", "", "MIDDLE"],
    ["ada@x.com", "", "LAST"],
  ];

  const oldest = fixture("dd-oldest", rows);
  setConfig(oldest.sheet.id, { columnIds: [Number(oldest.email.id)], keep: "oldest" });
  apply(oldest.sheet.id);
  assert.deepEqual(labels(oldest.sheet.id), ["FIRST"], "the row you have already worked survives");

  const newest = fixture("dd-newest", rows);
  setConfig(newest.sheet.id, { columnIds: [Number(newest.email.id)], keep: "newest" });
  apply(newest.sheet.id);
  assert.deepEqual(labels(newest.sheet.id), ["LAST"], "the freshest copy survives");
});

test("rows with no value in any key column are never touched, and are counted", () => {
  // The number that explains a disappointing result. Without it, "0 duplicates" on a list that is
  // visibly full of duplicates looks like the feature is broken rather than like the key column
  // being empty.
  const f = fixture("dd-unkeyed", [
    ["ada@x.com", "", "KEEP"],
    ["ada@x.com", "", "DROP"],
    ["", "", "NO-KEY-1"],
    ["", "", "NO-KEY-2"],
  ]);
  setConfig(f.sheet.id, { columnIds: [Number(f.email.id), Number(f.domain.id)] });

  const p = preview(f.sheet.id);
  assert.equal(p.unkeyed, 2);
  assert.equal(p.duplicates, 1);

  apply(f.sheet.id);
  assert.deepEqual(labels(f.sheet.id), ["KEEP", "NO-KEY-1", "NO-KEY-2"]);
});

test("the preview's number is the number the run acts on", () => {
  // One code path, because a preview that can disagree with the write is worse than no preview: it
  // is an approval for something else.
  const f = fixture("dd-preview", [
    ["a@x.com", "", "1"], ["a@x.com", "", "2"], ["b@x.com", "", "3"],
    ["b@x.com", "", "4"], ["b@x.com", "", "5"], ["c@x.com", "", "6"],
  ]);
  setConfig(f.sheet.id, { columnIds: [Number(f.email.id)] });

  const before = preview(f.sheet.id);
  const rowsBefore = labels(f.sheet.id).length;
  const applied = apply(f.sheet.id);

  assert.deepEqual([before.groups, before.duplicates], [applied.groups, applied.duplicates]);
  assert.equal(rowsBefore - labels(f.sheet.id).length, before.duplicates);
  assert.equal(before.samples[0]?.count, 3, "the biggest group is shown, so a big number is checkable");
});

test("dedupe stays off until it is switched on, and off means off", () => {
  // It deletes rows. A default that removes data on arrival is not one anyone would forgive.
  const f = fixture("dd-off", [["a@x.com", "", "1"], ["a@x.com", "", "2"]]);
  assert.equal(autoDedupe(f.sheet.id), null, "no config, no action");

  setConfig(f.sheet.id, { columnIds: [Number(f.email.id)] });
  assert.equal(autoDedupe(f.sheet.id), null, "configured but not automatic — still no action");
  assert.equal(labels(f.sheet.id).length, 2);

  setConfig(f.sheet.id, { auto: true });
  assert.equal(autoDedupe(f.sheet.id)?.duplicates, 1);
  assert.deepEqual(labels(f.sheet.id), ["1"]);
});

test("changing one setting leaves the others alone", () => {
  // A plain spread of a partial patch sets the absent keys to undefined, which wiped the key
  // columns every time the keep rule or the automatic flag changed. It showed up as the automatic
  // checkbox refusing to stay ticked, and the real cause — dedupe silently configured to match on
  // nothing — was invisible.
  const f = fixture("dd-partial", [["a@x.com", "", "1"], ["a@x.com", "", "2"]]);
  setConfig(f.sheet.id, { columnIds: [Number(f.email.id), Number(f.domain.id)], keep: "newest" });

  const afterAuto = setConfig(f.sheet.id, { auto: true });
  assert.deepEqual(afterAuto.columnIds, [Number(f.email.id), Number(f.domain.id)]);
  assert.equal(afterAuto.keep, "newest");

  const afterKeep = setConfig(f.sheet.id, { keep: "oldest" });
  assert.deepEqual(afterKeep.columnIds, [Number(f.email.id), Number(f.domain.id)]);
  assert.equal(afterKeep.auto, true);
});

test("a key column that no longer exists is dropped rather than silently changing the rule", () => {
  const f = fixture("dd-stale", [["a@x.com", "", "1"]]);
  const cfg = setConfig(f.sheet.id, { columnIds: [Number(f.email.id), 999999] });
  assert.deepEqual(cfg.columnIds, [Number(f.email.id)]);
});

test("values are compared in the form people mean, not the form they typed", () => {
  assert.equal(normalizeKey("  Ada@Example.COM ", "email"), "ada@example.com");
  assert.equal(normalizeKey("https://www.Acme.com/", "url"), "acme.com");
  assert.equal(normalizeKey("acme.com", "url"), "acme.com");
  // Two pages on one domain are two different things; a trailing slash is not.
  assert.equal(normalizeKey("acme.com/pricing/", "url"), "acme.com/pricing");
  assert.notEqual(normalizeKey("acme.com/pricing", "url"), normalizeKey("acme.com/about", "url"));
  assert.equal(normalizeKey("+1 (555) 010-9999", "phone"), "+15550109999");
  assert.equal(normalizeKey("  Acme   Ltd ", "text"), "acme ltd");
  // Empty is not a key. Treating it as one would group every blank row into a single "duplicate".
  assert.equal(normalizeKey("   ", "text"), null);
  assert.equal(normalizeKey(null, "text"), null);
});
