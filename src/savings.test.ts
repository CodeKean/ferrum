// The ledger of what was NOT spent.
//
// A "money saved" figure is the easiest number in any product to inflate, and an inflated one is
// worse than none: it is quoted, it is believed, and every later number is measured against it. So
// most of these check what the ledger REFUSES to count.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { addColumn, createSheet, insertRows, setColumnKind, setColumnModel, setColumnPrompt } from "./store.ts";
import { seedCatalog, parseCatalog } from "./providers/catalog.ts";
import { recordSaving, savingsFor } from "./savings.ts";

/** A priced, tool-capable model, so a paid column has a rate to be measured against. */
function seedPrices(): void {
  seedCatalog(parseCatalog({
    data: [{
      id: "test/priced",
      pricing: { prompt: "0.000001", completion: "0.000002" },
      context_length: 8000,
      supported_parameters: ["tools"],
    }],
  }));
}

function sheetWith(kind: "ai" | "script" | "static", model?: string) {
  seedPrices();
  const sheet = createSheet(`ZZ savings ${kind} ${Math.random().toString(36).slice(2, 8)}`);
  const col = addColumn(sheet.id, { name: "Answer" });
  const columnId = Number(col.id);
  insertRows(sheet.id, [{ values: {} }], 0, [columnId]);
  if (kind !== "static") setColumnKind(columnId, kind);
  if (kind === "ai") {
    setColumnPrompt(columnId, "What does this company do?");
    setColumnModel(columnId, model ?? "test/priced");
  }
  return { sheetId: sheet.id, columnId };
}

const rowsFor = (sheetId: string) =>
  db.prepare("SELECT reason, cells, cells_unpriced, usd FROM savings WHERE sheet_id = ?").all(sheetId) as any[];

test("a paid column that skipped unchanged rows records what they would have cost", () => {
  const { sheetId, columnId } = sheetWith("ai");
  recordSaving({ sheetId, columnId, reason: "unchanged", cells: 1000 });

  const t = savingsFor(sheetId);
  assert.equal(t.cells, 1000);
  assert.ok(t.usd > 0, "a priced paid column must produce a figure");
  assert.equal(t.cellsUnpriced, 0);
  assert.deepEqual(t.byReason.map((r) => r.reason), ["unchanged"]);
});

test("a script column records NOTHING, because it never cost anything to begin with", () => {
  // This is the difference between a ledger and a vanity metric. A free lane skipping work is not a
  // saving, and counting it would make the headline number grow fastest on the columns that cost
  // least.
  const { sheetId, columnId } = sheetWith("script");
  recordSaving({ sheetId, columnId, reason: "unchanged", cells: 5000 });
  assert.equal(rowsFor(sheetId).length, 0);
  assert.equal(savingsFor(sheetId).usd, 0);
});

test("a static column records nothing either", () => {
  const { sheetId, columnId } = sheetWith("static");
  recordSaving({ sheetId, columnId, reason: "unchanged", cells: 500 });
  assert.equal(rowsFor(sheetId).length, 0);
});

test("a local model saves no money, so it is not counted as money", () => {
  // Not running a local model saves time, not dollars. Recording it would turn the ledger into a
  // count of rows wearing a currency symbol.
  const { sheetId, columnId } = sheetWith("ai", "local:ollama/llama3");
  recordSaving({ sheetId, columnId, reason: "unchanged", cells: 900 });
  assert.equal(savingsFor(sheetId).usd, 0);
  assert.equal(savingsFor(sheetId).cells, 0);
});

test("a paid column with no known price is counted as CELLS, never as zero dollars", () => {
  // The honest middle case. Something real was avoided, and we cannot say what it was worth —
  // pricing it at zero would misstate the total, and dropping it would understate the work.
  const { sheetId, columnId } = sheetWith("ai", "some/unlisted-model");
  recordSaving({ sheetId, columnId, reason: "unchanged", cells: 700 });

  const t = savingsFor(sheetId);
  assert.equal(t.usd, 0);
  assert.equal(t.cells, 0, "unpriced cells must not inflate the priced count");
  assert.equal(t.cellsUnpriced, 700, "but they must still be reported");
});

test("zero cells writes no row at all", () => {
  const { sheetId, columnId } = sheetWith("ai");
  recordSaving({ sheetId, columnId, reason: "unchanged", cells: 0 });
  recordSaving({ sheetId, columnId, reason: "unchanged", cells: -5 });
  assert.equal(rowsFor(sheetId).length, 0);
});

test("reasons are kept apart, and the total is their sum", () => {
  const { sheetId, columnId } = sheetWith("ai");
  recordSaving({ sheetId, columnId, reason: "unchanged", cells: 100 });
  recordSaving({ sheetId, columnId, reason: "condition", cells: 300 });

  const t = savingsFor(sheetId);
  assert.deepEqual(new Set(t.byReason.map((r) => r.reason)), new Set(["unchanged", "condition"]));
  assert.equal(t.cells, 400);
  assert.equal(
    Number(t.usd.toFixed(10)),
    Number(t.byReason.reduce((n, r) => n + r.usd, 0).toFixed(10)),
  );
  // Ordered by what was actually saved, so the biggest reason leads.
  assert.equal(t.byReason[0]!.reason, "condition");
});

test("one table's savings do not leak into another's", () => {
  const a = sheetWith("ai");
  const b = sheetWith("ai");
  recordSaving({ sheetId: a.sheetId, columnId: a.columnId, reason: "unchanged", cells: 100 });
  assert.ok(savingsFor(a.sheetId).cells > 0);
  assert.equal(savingsFor(b.sheetId).cells, 0);
});

test("the workspace total includes every table", () => {
  const a = sheetWith("ai");
  recordSaving({ sheetId: a.sheetId, columnId: a.columnId, reason: "unchanged", cells: 42 });
  assert.ok(savingsFor(null).cells >= 42);
});

test("an unrecognised reason is dropped rather than shown as a blank row", () => {
  const { sheetId, columnId } = sheetWith("ai");
  db.prepare(
    "INSERT INTO savings (sheet_id, column_id, reason, cells, usd) VALUES (?, ?, 'wormhole', 10, 9.99)",
  ).run(sheetId, columnId);
  const t = savingsFor(sheetId);
  // A reason with no words to put on screen has no business in a total the user is asked to believe.
  assert.equal(t.usd, 0);
  assert.equal(t.byReason.length, 0);
});

test("recording never throws, whatever it is handed", () => {
  // The ledger describes the run; it is not part of it. A failure here must not fail the work.
  assert.doesNotThrow(() => recordSaving({ sheetId: "no-such-sheet", columnId: 999999, reason: "cache", cells: 10 }));
  assert.doesNotThrow(() => recordSaving({ sheetId: "", columnId: 0, reason: "cache", cells: 1 }));
});
