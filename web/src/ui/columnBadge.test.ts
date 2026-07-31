// Which badge a column header gets.
//
// The tests are about the ORDER of the checks and about the titles being true, because both failures
// are silent: a wrong badge still renders, and a wrong title is only read by the person who was
// already confused enough to hover.

import { test } from "node:test";
import assert from "node:assert/strict";
import { badgeForKind, columnBadge, PAID_KINDS, sourceNameOf } from "./columnBadge.ts";
import type { Column } from "../api.ts";

const col = (over: Partial<Column>): Column => ({
  id: "1", sheetId: "s", name: "Industry", key: "industry", position: 0,
  kind: "static", valueType: "text", ...over,
} as Column);

/** Every lane the engine has — `COLUMN_KINDS` in src/types.ts. Kept in step by the test below. */
const ALL_KINDS = [
  "static", "script", "http", "mcp", "ai", "agent", "send", "lookup", "rollup", "waterfall", "wait",
] as const;

test("each lane gets its own badge, so no two kinds of column look alike", () => {
  const seen = new Set(ALL_KINDS.map((k) => columnBadge(col({ kind: k })).kind));
  assert.equal(seen.size, ALL_KINDS.length, "every kind is distinguishable from every other");
});

test("a new lane cannot quietly inherit the rule badge", () => {
  // How waterfall and wait shipped wearing the `{}` of a formula column: `LANE` has no entry, the
  // lookup falls back to "rule", and nothing fails — the header just tells the reader that a column
  // costing money on every row is a free local calculation.
  for (const kind of ALL_KINDS) {
    if (kind === "script") continue;
    const badge = columnBadge(col({ kind }));
    assert.notEqual(badge.kind, "rule", `"${kind}" is falling through to the rule badge`);
    assert.ok(badge.title.length > 20, `"${kind}" has no title of its own`);
  }
});

test("the two lanes that spend on every row are marked as paid", () => {
  // The one distinction worth colour. Everything else on this list can be re-run without thinking
  // about it; these cannot.
  for (const k of ["http", "mcp", "ai", "agent"] as const) {
    assert.equal(columnBadge(col({ kind: k })).paid, true, `${k} bills per row`);
  }
  for (const k of ["static", "script", "send", "lookup", "rollup"] as const) {
    assert.equal(columnBadge(col({ kind: k })).paid, false, `${k} does not`);
  }
});

test("a field pulled out of an enrichment says so, and names what it came from", () => {
  // The ordering test. A derived child is STORED as kind "script", so checking the kind first would
  // label six expanded fields "a rule over the other columns" — true of how it is saved, and not the
  // thing anyone needs to know about a sheet where one answer was expanded into six columns.
  const child = col({ kind: "script", sourceColumnId: 9, jsonPath: "contact.email" });
  const badge = columnBadge(child, "Company JSON");

  assert.equal(badge.kind, "derived");
  assert.match(badge.title, /Company JSON/);
  assert.match(badge.title, /contact\.email/);
  assert.doesNotMatch(badge.title, /rule/i);
  assert.equal(badge.paid, false, "re-reading an answer already paid for costs nothing");
});

test("a child whose parent was deleted still reads as a child", () => {
  const badge = columnBadge(col({ kind: "script", sourceColumnId: 9, jsonPath: "email" }), null);
  assert.equal(badge.kind, "derived");
  assert.match(badge.title, /another column/i);
});

test("a source id without a path is not a child", () => {
  // Half the pair is not the pattern, and falling into the derived branch would produce a title
  // naming a path that does not exist.
  assert.equal(columnBadge(col({ kind: "ai", sourceColumnId: 9 })).kind, "model");
});

test("every badge says what the column does, in words worth hovering for", () => {
  for (const k of ["static", "script", "http", "mcp", "ai", "agent", "send", "lookup", "rollup"] as const) {
    const t = columnBadge(col({ kind: k })).title;
    assert.ok(t.length > 25, `${k} needs a real sentence, not a label`);
  }
});

test("the mark the mode picker shows for a lane is the one the grid will show", () => {
  // The whole reason the icons are worth having. Picking "The model reads the row" and then seeing a
  // different mark on the resulting column teaches nobody anything — it teaches that the marks are
  // decoration. The picker has no column to read, so it asks by kind; both answers must agree.
  for (const kind of ["static", "script", "http", "mcp", "ai", "agent", "send", "lookup", "rollup"] as const) {
    assert.equal(
      badgeForKind(kind),
      columnBadge(col({ kind })).kind,
      `the picker and the grid disagree about ${kind}`,
    );
  }
});

test("the paid set and the badges agree about which lanes spend", () => {
  // Two ways to ask the same question — a badge carries `paid`, and the icon component asks the set,
  // because the mode picker names a lane no column has been set to yet. They must not drift.
  for (const kind of ["static", "script", "http", "mcp", "ai", "agent", "send", "lookup", "rollup"] as const) {
    const badge = columnBadge(col({ kind }));
    assert.equal(PAID_KINDS.has(badge.kind), badge.paid, `${kind} disagrees with itself about cost`);
  }
});

test("a derived field is never offered as a lane, because it is not one", () => {
  // You cannot SET a column to "derived" — it becomes derived by being pointed at another column's
  // field. So it has a badge and no card, and `badgeForKind` must not invent one.
  assert.notEqual(badgeForKind("derived"), "derived");
});

test("the parent's name comes from the columns already on screen", () => {
  // Not a fetch: a header renders for every column on every frame of a scroll.
  const parent = col({ id: "9", name: "Company JSON" });
  const child = col({ id: "10", sourceColumnId: 9 });
  assert.equal(sourceNameOf(child, [parent, child]), "Company JSON");
  assert.equal(sourceNameOf(child, [child]), null, "a missing parent is null, not a crash");
  assert.equal(sourceNameOf(parent, [parent]), null, "a column with no parent has no name to find");
});
