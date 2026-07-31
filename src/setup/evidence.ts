// What the model is actually told about the table it is configuring a column for.
//
// The old answer was one row. `readWindow(sheetId, 0, 5)`, take the first row with anything in it,
// send one example per column. That is the single biggest reason "build with AI" produced the wrong
// thing: one row cannot distinguish the facts that change the answer.
//
// Three of them, specifically:
//
//   HOW FULL IS THIS COLUMN. A rule referencing /Website is a good idea when Website is 96% filled
//   and a waste of a run when it is 4% filled — and one sample row shows the same non-empty string
//   in both cases. This is the fact most likely to change the proposal and it was invisible.
//
//   HOW MUCH DOES IT VARY. `acme.com` and `https://acme.com/about` in the same column mean the
//   proposal needs to normalize before it can match. One row shows one shape and the model writes a
//   rule that works on that shape and fails on the rest.
//
//   IS IT ALREADY FAILING. A column with 84 errors is context for what to propose next. It was
//   available to the chat assistant and not to the setup panel, which is backwards — the setup panel
//   is where the fix gets written.
//
// Cost: two aggregate queries, both served by ix_cells_col_status, plus one small windowed read.
// Nothing here scans a million rows of VALUES; the counts come off the index.

import { db } from "../db.ts";
import { getSheet, listColumns, readWindow } from "../store.ts";
import type { Column } from "../types.ts";

/** How many rows are read for samples. Spread across the sheet rather than taken from the top. */
const SAMPLE_ROWS = 12;
/** Distinct example values kept per column. Four is enough to show variation without paying for it. */
const SAMPLES_PER_COLUMN = 4;
/** Longest example value sent. A 4,000-character JSON blob teaches nothing a 90-character one does not. */
const SAMPLE_CHARS = 90;

export interface ColumnEvidence {
  id: number;
  name: string;
  kind: Column["kind"];
  valueType: Column["valueType"];
  description?: string;
  /** Rows with a usable value. */
  filled: number;
  /** Rows that failed. */
  errors: number;
  /** Rows never run. */
  empty: number;
  /** filled / rowCount, 0–1. Null when the sheet has no rows, which is not the same as 0%. */
  fillRate: number | null;
  /** Distinct example values, shortest first so the plainest shape leads. */
  samples: string[];
  /** The distinct error messages, with how many rows carry each. */
  failures: Array<{ message: string; rows: number }>;
  /**
   * How the failures break down by CLASS, commonest first.
   *
   * Not the same information as `failures`, and stronger. Three providers phrase a rejected key
   * three ways, so three messages can be one problem and read as three; and one message can hide two
   * problems when a timeout and a rate limit come back with the same body. The class is the engine's
   * own verdict on what went wrong, and "9 auth, 3 timeout" tells a proposal to fix the key and
   * leave the timeout alone — which the message list cannot say.
   */
  errorTypes: Array<{ type: string; rows: number }>;
}

export interface SheetEvidence {
  sheetId: string;
  sheetName: string;
  rowCount: number;
  columns: ColumnEvidence[];
}

/**
 * Sample rows spread across the sheet, not the first N.
 *
 * The first rows of an imported table are the ones most likely to be clean: they are what the person
 * who built the CSV looked at. Taking examples only from there is how a rule gets written against
 * the tidiest 12 rows of a million and then fails on row 40,000. Four evenly-spaced windows cost the
 * same as one and see four different parts of the table.
 */
function sampleRows(sheetId: string, rowCount: number): Array<Record<string, { v?: unknown }>> {
  if (rowCount <= 0) return [];
  const perWindow = 3;
  const windows = Math.min(4, Math.max(1, Math.ceil(SAMPLE_ROWS / perWindow)));
  const out: Array<Record<string, { v?: unknown }>> = [];

  for (let i = 0; i < windows; i++) {
    // Spread over the sheet: 0, 1/4, 2/4, 3/4. Clamped so a short sheet reads the same rows twice
    // rather than reading past the end, which is harmless — the values are deduped below.
    const offset = Math.min(Math.max(0, rowCount - perWindow), Math.floor((rowCount * i) / windows));
    try {
      for (const row of readWindow(sheetId, offset, perWindow).rows) out.push(row.cells as never);
    } catch {
      // A window that cannot be read is not a reason to fail the whole setup call. Fewer samples is
      // a worse proposal; no proposal is a broken feature.
      break;
    }
  }
  return out;
}

/**
 * `n` items taken evenly across a sorted list, always including both ends.
 *
 * The shortest value shows the plainest shape and the longest shows the messiest one, and it is the
 * gap between them that tells a rule it has to normalize before it can match.
 */
function spread<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.round((i * (xs.length - 1)) / (n - 1))]!);
  return [...new Set(out)];
}

/** The status histogram for every column of a sheet, in ONE query rather than one per column. */
function statusCounts(sheetId: string): Map<number, { filled: number; errors: number; empty: number }> {
  const rows = db
    .prepare(
      `SELECT c.id AS column_id,
              SUM(CASE WHEN ce.status IN ('done','not_found') THEN 1 ELSE 0 END) AS filled,
              SUM(CASE WHEN ce.status = 'error' THEN 1 ELSE 0 END) AS errors,
              SUM(CASE WHEN ce.status = 'empty' THEN 1 ELSE 0 END) AS empty
         FROM columns c
         LEFT JOIN cells ce ON ce.column_id = c.id
        WHERE c.sheet_id = ? AND c.deleted_at IS NULL
        GROUP BY c.id`,
    )
    .all(sheetId) as Array<{ column_id: number; filled: number; errors: number; empty: number }>;

  return new Map(
    rows.map((r) => [
      Number(r.column_id),
      { filled: Number(r.filled ?? 0), errors: Number(r.errors ?? 0), empty: Number(r.empty ?? 0) },
    ]),
  );
}

/** Distinct error messages per column, capped. 84 rows failing one way is one problem, not 84. */
function failuresFor(columnId: number): Array<{ message: string; rows: number }> {
  const rows = db
    .prepare(
      `SELECT error_msg, COUNT(*) AS n FROM cells
        WHERE column_id = ? AND status = 'error' AND error_msg IS NOT NULL
        GROUP BY error_msg ORDER BY n DESC LIMIT 3`,
    )
    .all(columnId) as Array<{ error_msg: string; n: number }>;
  return rows.map((r) => ({ message: String(r.error_msg).slice(0, 200), rows: Number(r.n) }));
}

/**
 * The same failures counted by class instead of by wording.
 *
 * Uncapped on purpose: there are eleven classes in total, so the result cannot be long, and the
 * whole point is the shape of the split. A LIMIT here would hide the small pile that is the real
 * problem behind the big one that is only noise. Runs on the same (column_id, status) index the
 * query above uses.
 */
function errorTypesFor(columnId: number): Array<{ type: string; rows: number }> {
  const rows = db
    .prepare(
      `SELECT error_type, COUNT(*) AS n FROM cells
        WHERE column_id = ? AND status = 'error' AND error_type IS NOT NULL
        GROUP BY error_type ORDER BY n DESC`,
    )
    .all(columnId) as Array<{ error_type: string; n: number }>;
  return rows.map((r) => ({ type: String(r.error_type), rows: Number(r.n) }));
}

export function gatherEvidence(sheetId: string): SheetEvidence | null {
  // Through the store, not a query of my own: `sheets` has no row_count column — the count is
  // derived — so reading it directly was a SQL error rather than a wrong number.
  const sheet = getSheet(sheetId);
  if (!sheet) return null;

  const columns = listColumns(sheetId);
  const rowCount = Number(sheet.rowCount ?? 0);
  const counts = statusCounts(sheetId);
  const rows = sampleRows(sheetId, rowCount);

  const evidence: ColumnEvidence[] = columns.map((c) => {
    const id = Number(c.id);
    const n = counts.get(id) ?? { filled: 0, errors: 0, empty: 0 };

    // Deduped and length-capped. Four copies of the same value is not four examples, and it was the
    // usual outcome on a status or country column — the model saw "US, US, US, US" and had no idea
    // whether the column varied at all.
    const seen = new Set<string>();
    for (const cells of rows) {
      const raw = (cells as Record<string, { v?: unknown }>)[String(id)]?.v;
      if (raw == null || raw === "") continue;
      const s = String(raw).replace(/\s+/g, " ").trim().slice(0, SAMPLE_CHARS);
      if (s) seen.add(s);
      if (seen.size >= SAMPLES_PER_COLUMN * 2) break;
    }
    // Spread across the length range, not the four shortest.
    //
    // Sorting shortest-first and slicing was the obvious thing and it was wrong in exactly the way
    // this whole module exists to prevent: in a column holding both `acme.com` and
    // `https://acme.com/about`, every bare domain is shorter than every full URL, so the four
    // shortest are four of the same shape and the variation is hidden as reliably as it was by
    // sending one row. Taking from both ends guarantees the extremes are represented.
    const samples = spread([...seen].sort((a, b) => a.length - b.length), SAMPLES_PER_COLUMN);

    return {
      id,
      name: c.name,
      kind: c.kind,
      valueType: c.valueType,
      description: c.description,
      filled: n.filled,
      errors: n.errors,
      empty: n.empty,
      // Null rather than 0 on an empty sheet. "Nothing is filled in because there are no rows" and
      // "nothing is filled in because the column has never run" lead to different proposals.
      fillRate: rowCount > 0 ? Math.min(1, n.filled / rowCount) : null,
      samples,
      failures: n.errors > 0 ? failuresFor(id) : [],
      errorTypes: n.errors > 0 ? errorTypesFor(id) : [],
    };
  });

  return { sheetId, sheetName: sheet.name, rowCount, columns: evidence };
}

/** A percentage a non-technical reader can act on, or an honest blank. */
function fillLabel(c: ColumnEvidence): string {
  if (c.fillRate == null) return "no rows yet";
  const pct = c.fillRate * 100;
  if (c.fillRate === 0) return "EMPTY — nothing in it";
  if (pct < 1) return `under 1% filled — nearly empty`;
  return `${Math.round(pct)}% filled`;
}

/**
 * The evidence as the text a model is given.
 *
 * `selfId` is excluded: a column must never be offered a reference to itself, and the old builder
 * relied on the caller remembering to filter. Doing it here means every caller gets it right.
 */
export function describeEvidence(ev: SheetEvidence, selfId?: number | string): string {
  const self = selfId == null ? null : String(selfId);
  const others = ev.columns.filter((c) => String(c.id) !== self);

  const lines: string[] = [
    `Table "${ev.sheetName}": ${ev.rowCount.toLocaleString()} rows, ${ev.columns.length} columns.`,
    "",
    others.length
      ? "The other columns. Read the fill rate before referencing one — a column that is nearly empty will make most rows skip or produce nothing:"
      : "This table has no other columns yet, so there is nothing to reference.",
  ];

  for (const c of others) {
    const bits = [`- /${c.name} (${c.valueType}, ${c.kind}) — ${fillLabel(c)}`];
    if (c.description) bits.push(`purpose: ${c.description.slice(0, 120)}`);
    if (c.samples.length) bits.push(`examples: ${c.samples.map((s) => JSON.stringify(s)).join(", ")}`);
    else if (c.fillRate !== 0) bits.push("no example values available");
    lines.push(bits.join(" · "));

    // The split first, then the wording. Twelve rows failing "schema" is a fact about the column;
    // twelve paraphrases of one provider's complaint is the same fact told twelve times, and reading
    // the messages first is how a proposal ends up fixing the loudest failure instead of the biggest.
    // Optional-chained even though the type says it is always there. This function is also handed
    // evidence built by callers rather than by gatherEvidence, and the compiler did not catch one of
    // them missing the new field — so the promise the type makes is not one this line can rely on,
    // and an undefined here would fail the whole proposal over a cosmetic list.
    if (c.errorTypes?.length) {
      lines.push(`    failures by kind: ${c.errorTypes.map((e) => `${e.rows.toLocaleString()} ${e.type}`).join(", ")}`);
    }
    for (const f of c.failures) lines.push(`    failing on ${f.rows.toLocaleString()} rows: ${f.message}`);
  }

  return lines.join("\n");
}
