// The clipboard round trip, and the geometry a fill drag depends on.
//
// These are the parts of grid interaction that fail SILENTLY. A range that is off by one writes the
// wrong row; a parser that splits on "\n" turns one address into three rows and shifts everything
// beneath it; a fill that reads outside its source column writes a value nobody selected. Every one
// of those produces a table that looks entirely normal and is wrong.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fillValues, fromClipboardText, paintTargets, rectHas, rectOf, rectSize, toClipboardText } from "./selection.ts";

test("a range is the same box whichever corner it was dragged from", () => {
  const forward = rectOf({ anchor: { row: 2, col: 1 }, focus: { row: 5, col: 3 } });
  const backward = rectOf({ anchor: { row: 5, col: 3 }, focus: { row: 2, col: 1 } });
  assert.deepEqual(forward, backward);
  assert.deepEqual(forward, { top: 2, bottom: 5, left: 1, right: 3 });
  assert.equal(rectSize(forward), 12);
  assert.ok(rectHas(forward, 5, 3), "the far corner is INSIDE — the box is inclusive");
  assert.ok(!rectHas(forward, 6, 3));
});

test("a value with a tab, a newline or a quote survives the clipboard", () => {
  // The whole reason this is not `join("\t")` and `split("\n")`. An address with a line break in it
  // is ordinary data, and the naive version turns one row into two and shifts the rest of the block.
  const block = [
    ["Acme", "12 Main St\nSuite 4"],
    ['He said "hi"', "a\tb"],
  ];
  const text = toClipboardText(block);
  assert.deepEqual(fromClipboardText(text), block);
});

test("a plain value is not dressed in quotes it did not have", () => {
  assert.equal(toClipboardText([["Acme", "US"]]), "Acme\tUS");
});

test("the trailing row break a spreadsheet appends does not become a blank row", () => {
  // Excel and Sheets both end their clipboard text with CRLF. Honouring it literally pastes an empty
  // row, which CLEARS a row of the target — a silent delete on every single paste.
  assert.deepEqual(fromClipboardText("a\tb\r\nc\td\r\n"), [["a", "b"], ["c", "d"]]);
});

test("an empty clipboard is an empty block, not a block containing nothing", () => {
  assert.deepEqual(fromClipboardText(""), []);
});

test("one value pasted into a selected range fills the range", () => {
  // The most-used paste there is: copy a status, select 300 rows, paste.
  const targets = paintTargets([["sent"]], { top: 0, bottom: 2, left: 1, right: 1 });
  assert.deepEqual(targets, [
    { row: 0, col: 1, value: "sent" },
    { row: 1, col: 1, value: "sent" },
    { row: 2, col: 1, value: "sent" },
  ]);
});

test("a block pasted into one cell grows past the selection instead of being clipped", () => {
  const targets = paintTargets([["a", "b"], ["c", "d"]], { top: 5, bottom: 5, left: 0, right: 0 });
  assert.deepEqual(targets.map((t) => `${t.row}:${t.col}=${t.value}`), ["5:0=a", "5:1=b", "6:0=c", "6:1=d"]);
});

test("a fill drag repeats the source pattern rather than the last row", () => {
  const read = (row: number) => (row === 0 ? "A" : "B");
  const filled = fillValues({ top: 0, bottom: 1, left: 0, right: 0 }, 5, read);
  assert.deepEqual(filled.map((f) => f.value), ["A", "B", "A", "B"]);
  assert.deepEqual(filled.map((f) => f.row), [2, 3, 4, 5]);
});

test("dragging the handle upward reads inside the source, not outside it", () => {
  // JS modulo of a negative number is negative, so the upward case is the one that silently reads a
  // row the user never selected and fills the column with it.
  const read = (row: number) => ["A", "B"][row - 4] ?? "OUTSIDE";
  const filled = fillValues({ top: 4, bottom: 5, left: 0, right: 0 }, 1, read);
  assert.deepEqual(filled.map((f) => f.row), [3, 2, 1]);
  assert.ok(!filled.some((f) => f.value === "OUTSIDE"), "every filled value came from the source range");
  assert.deepEqual(filled.map((f) => f.value), ["B", "A", "B"]);
});

test("a fill that was not dragged anywhere writes nothing", () => {
  assert.deepEqual(fillValues({ top: 2, bottom: 3, left: 0, right: 0 }, 3, () => "x"), []);
});
