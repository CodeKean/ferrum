// Ranges, and the clipboard format two spreadsheets already agree on.
//
// The grid could only ever be one cell at a time: no drag-select, no Shift+arrow, and nothing bound
// to copy or paste. Moving a column of 400 values out of this app meant exporting the whole table,
// and moving one in meant typing it. That is the gap you feel first, before any missing feature.
//
// Everything here is PURE — no DOM, no fetch, no React — because the parts that get clipboard
// handling wrong are the parsing and the geometry, and those are the parts a test can pin down.
// Excel and Google Sheets both put TAB-separated text on the clipboard with CRLF between rows, and
// both quote a field containing a tab, a newline or a quote. Getting that wrong is silent: a value
// with a comma in it looks fine, a company name with a newline in it shifts every row after it.

export interface CellRef {
  /** Row POSITION in the current view, not a row id — the grid is virtual and ids are not dense. */
  row: number;
  /** Index into the visible column order. */
  col: number;
}

export interface Range {
  /** Where the selection started. Shift+arrow pivots around this, and the fill handle sources from
   *  it, so it must survive the focus moving. */
  anchor: CellRef;
  /** Where it is now — also the cell that has keyboard focus. */
  focus: CellRef;
}

export interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** The inclusive box two corners describe, in either order. */
export function rectOf(r: Range): Rect {
  return {
    top: Math.min(r.anchor.row, r.focus.row),
    bottom: Math.max(r.anchor.row, r.focus.row),
    left: Math.min(r.anchor.col, r.focus.col),
    right: Math.max(r.anchor.col, r.focus.col),
  };
}

export function rectHas(rect: Rect, row: number, col: number): boolean {
  return row >= rect.top && row <= rect.bottom && col >= rect.left && col <= rect.right;
}

export function rectSize(rect: Rect): number {
  return (rect.bottom - rect.top + 1) * (rect.right - rect.left + 1);
}

/** True when the range covers exactly one cell — the state the grid was permanently in before. */
export function isSingle(rect: Rect): boolean {
  return rect.top === rect.bottom && rect.left === rect.right;
}

// ───────────────────────────────────────────────────────────────── clipboard text

/**
 * One field, as a spreadsheet would write it.
 *
 * Quoted only when it has to be. Quoting everything is legal and both apps read it, but it also
 * means a plain value pasted into a text editor arrives wearing quotes it did not have — and this
 * clipboard goes to other places than a spreadsheet.
 */
function encodeField(v: string): string {
  return /[\t\r\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** A block of values as the clipboard text Excel and Sheets both expect. */
export function toClipboardText(grid: string[][]): string {
  // CRLF between rows, LF nowhere. Excel on Windows treats a lone LF inside unquoted text as a row
  // break in some paths and not others; CRLF is what it writes itself and is unambiguous in both.
  return grid.map((row) => row.map(encodeField).join("\t")).join("\r\n");
}

/**
 * Clipboard text back into a block.
 *
 * Written as a character scanner rather than `split("\n").map(l => l.split("\t"))`, because that
 * split is wrong the moment a single cell contains a newline — which a pasted address, a note or an
 * AI answer very often does. The naive version turns one row into three and silently shifts every
 * row beneath it, and the result looks like plausible data.
 *
 * A trailing empty row is dropped: both spreadsheets end their clipboard text with a row break, and
 * honouring it literally would paste a blank row and clear a row of the target every single time.
 */
export function fromClipboardText(text: string): string[][] {
  if (text === "") return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  const endField = () => { row.push(field); field = ""; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        // A doubled quote is one literal quote; a single one closes the field.
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === "") { quoted = true; i++; continue; }
    if (ch === "\t") { endField(); i++; continue; }
    if (ch === "\r") { endRow(); if (text[i + 1] === "\n") i += 2; else i++; continue; }
    if (ch === "\n") { endRow(); i++; continue; }
    field += ch; i++;
  }
  // Whatever is left is the last field of the last row — unless the text ended on a row break, in
  // which case there is nothing left and pushing it would invent a blank row.
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/**
 * Where a pasted block actually lands.
 *
 * Two behaviours, both taken from Excel because that is what the muscle memory expects:
 *
 *   - Pasting a 1×1 value into a selected RANGE fills the whole range with it. This is the one
 *     people use constantly — copy a status, select 300 rows, paste.
 *   - Pasting a block into a single cell (or into a selection smaller than the block) writes the
 *     block from that cell down and right, growing past the selection.
 *
 * What it deliberately does NOT do is Excel's tiling of a small block into an exact multiple of a
 * larger one. It is the rule people know least, it silently writes far more than the clipboard held,
 * and getting the multiple wrong is invisible.
 */
export function paintTargets(block: string[][], target: Rect): Array<{ row: number; col: number; value: string }> {
  const out: Array<{ row: number; col: number; value: string }> = [];
  if (block.length === 0) return out;

  const single = block.length === 1 && (block[0]?.length ?? 0) === 1;
  if (single) {
    const v = block[0]![0]!;
    for (let r = target.top; r <= target.bottom; r++) {
      for (let c = target.left; c <= target.right; c++) out.push({ row: r, col: c, value: v });
    }
    return out;
  }

  for (let r = 0; r < block.length; r++) {
    const line = block[r]!;
    for (let c = 0; c < line.length; c++) {
      out.push({ row: target.top + r, col: target.left + c, value: line[c] ?? "" });
    }
  }
  return out;
}

/**
 * The values a fill-handle drag writes.
 *
 * `source` is the range that was selected when the drag began; `to` is the row it was dragged to.
 * The source pattern REPEATS down (or up) the way a spreadsheet's fill does — dragging two rows of
 * "A"/"B" down eight rows gives A B A B A B A B, not eight copies of B.
 *
 * No number sequencing. Excel turns 1,2 into 3,4,5 and this does not, on purpose: the guess is right
 * often enough to be relied on and wrong often enough to corrupt a column quietly, and a version
 * number or a zip code that gets "continued" is data damage nobody looks for.
 */
export function fillValues(
  source: Rect,
  to: number,
  read: (row: number, col: number) => string,
): Array<{ row: number; col: number; value: string }> {
  const out: Array<{ row: number; col: number; value: string }> = [];
  const height = source.bottom - source.top + 1;
  if (to > source.bottom) {
    for (let r = source.bottom + 1; r <= to; r++) {
      const from = source.top + ((r - source.top) % height);
      for (let c = source.left; c <= source.right; c++) out.push({ row: r, col: c, value: read(from, c) });
    }
  } else if (to < source.top) {
    for (let r = source.top - 1; r >= to; r--) {
      // Modulo of a negative is negative in JS, so the distance is measured downward from the bottom
      // of the source instead. Getting this wrong reads a row outside the source and fills the
      // column with a value the user never selected.
      const from = source.bottom - ((source.bottom - r) % height);
      for (let c = source.left; c <= source.right; c++) out.push({ row: r, col: c, value: read(from, c) });
    }
  }
  return out;
}
