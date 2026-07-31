// Derived columns: projecting a path out of a JSON column into its own column.
//
// These cost NOTHING. Extraction is deterministic, so expanding an object with six fields into six
// sibling columns is six string operations per row rather than six model calls — which is the whole
// reason a JSON-returning enrichment is the shape worth encouraging.

import { db, tx, cellId } from "./db.ts";
import { markCellsDirty } from "./bus.ts";
import { discoverFields, getPath, toText, type DiscoveredField } from "./jsonPath.ts";
import { addColumn, listColumns } from "./store.ts";
import { markColumnDirty } from "./columnStats.ts";

const BATCH = 5000;

/**
 * How many ids go into one `IN (...)` list.
 *
 * SQLite refuses a statement carrying more than 32,766 bound variables. `countListItems` binds one
 * per row and is called with the WHOLE sheet, so on the million-row table it did not return a large
 * number slowly — it threw `too many SQL variables`, and the fan-out screen could not be opened at
 * all on exactly the tables a fan-out is for. 500 is the batch size the rest of the engine reads in.
 */
const ID_CHUNK = 500;

function chunked<T>(xs: T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** Sample a JSON column's values and report the fields worth offering as columns. */
export function discoverJsonFields(sheetId: string, sourceColumnId: number, sampleSize = 50): DiscoveredField[] {
  const rows = db
    .prepare(
      `SELECT value_json, value_text FROM cells
        WHERE column_id = ? AND status = 'done' AND value_text IS NOT NULL AND value_text <> ''
        LIMIT ?`,
    )
    .all(sourceColumnId, sampleSize) as any[];

  const samples: unknown[] = [];
  for (const r of rows) {
    // value_json is the canonical form, but a JSON column populated by import holds text — parse
    // whichever is actually there rather than assuming.
    const raw = r.value_json ?? r.value_text;
    try {
      const parsed = JSON.parse(raw);
      // A JSON column storing a bare string round-trips as a string; that has no fields to expand.
      if (parsed && typeof parsed === "object") samples.push(parsed);
      else if (typeof parsed === "string" && parsed.trim().startsWith("{")) {
        samples.push(JSON.parse(parsed));
      }
    } catch { /* not JSON on this row — skip it rather than failing the whole discovery */ }
  }
  return discoverFields(samples);
}

/**
 * Sample the fields inside a LIST column's items.
 *
 * `discoverJsonFields` above deliberately skips arrays — an array has no fields of its own, its
 * ITEMS do. This is the discovery that makes a fan-out configurable: given a column holding
 * `[{name, email, title}, …]` per row, it reports name/email/title, so the mapping screen can offer
 * real field names instead of asking the user to type JSON paths from memory.
 *
 * Items are sampled across rows rather than taken from the first row alone: one company's contacts
 * may all lack a title while the next one's have them, and a field that exists on only some items is
 * exactly what coverage is for.
 */
export function discoverListItemFields(
  sourceColumnId: number,
  sampleRows = 50,
  maxItems = 200,
  /**
   * The list is not always the whole cell.
   *
   * Opened from the cell sidebar, what is being exploded is `contacts` inside a research result,
   * not the result itself. Without this the discovery reads the wrong thing and offers the wrong
   * field names — which looks like the feature being broken rather than pointed at the wrong place.
   */
  listPath = "",
): DiscoveredField[] {
  const rows = db
    .prepare(
      `SELECT value_json, value_text FROM cells
        WHERE column_id = ? AND status = 'done' AND value_text IS NOT NULL AND value_text <> ''
        LIMIT ?`,
    )
    .all(sourceColumnId, sampleRows) as any[];

  const items: unknown[] = [];
  for (const r of rows) {
    if (items.length >= maxItems) break;
    const raw = r.value_json ?? r.value_text;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { continue; }
    // A JSON column populated by import can hold the array as a string INSIDE a JSON string, so one
    // parse leaves a string that still looks like an array.
    if (typeof parsed === "string") {
      try { parsed = JSON.parse(parsed); } catch { continue; }
    }
    if (listPath) parsed = getPath(parsed, listPath);
    if (!Array.isArray(parsed)) continue;
    for (const item of parsed) {
      if (items.length >= maxItems) break;
      // Only object items have fields. A list of plain strings maps whole-value, which the UI offers
      // separately rather than pretending there are paths to pick.
      if (item && typeof item === "object" && !Array.isArray(item)) items.push(item);
    }
  }

  return discoverFields(items);
}

/** How many items a fan-out would produce, so the UI can say so before writing anything. */
export function countListItems(sourceColumnId: number, rowIds: number[], cap: number, listPath = ""): { rows: number; items: number; capped: number } {
  if (rowIds.length === 0) return { rows: 0, items: 0, capped: 0 };
  const cells: any[] = [];
  for (const slice of chunked(rowIds)) {
    cells.push(
      ...(db
        .prepare(
          `SELECT value_json, value_text FROM cells
            WHERE column_id = ? AND row_id IN (${slice.map(() => "?").join(",")})`,
        )
        .all(sourceColumnId, ...slice) as any[]),
    );
  }

  let items = 0;
  let capped = 0;
  let rows = 0;
  for (const c of cells) {
    let parsed: unknown = c.value_text;
    try { parsed = JSON.parse(c.value_json ?? c.value_text); } catch { /* keep raw */ }
    if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { /* keep */ } }
    if (listPath) parsed = getPath(parsed, listPath);
    const list = Array.isArray(parsed) ? parsed : parsed == null ? [] : [parsed];
    if (list.length === 0) continue;
    rows++;
    // Counted the same way `buildWriteItems` slices, so the preview cannot promise a number the
    // write will not produce.
    if (list.length > cap) capped++;
    items += Math.min(list.length, cap);
  }
  return { rows, items, capped };
}

export interface ExpandResult {
  created: Array<{ columnId: number; name: string; path: string }>;
  rowsFilled: number;
}

/**
 * Create one sibling column per selected path, and populate them.
 *
 * Names collide often (two JSON columns both having `email`), so `addColumn` already de-duplicates
 * — the created name is returned rather than assumed.
 */
export function expandJsonColumn(
  sheetId: string,
  sourceColumnId: number,
  fields: Array<{ path: string; name?: string; valueType?: string }>,
): ExpandResult {
  const source = listColumns(sheetId).find((c) => Number(c.id) === sourceColumnId);
  if (!source) throw new Error("Source column not found.");

  const created: ExpandResult["created"] = [];

  for (const f of fields) {
    // Default name is the leaf, not the full path: "contact.email" becomes "Email", because
    // "Contact.email" as a column name reads like a formula, not a field.
    const leaf = f.path.split(".").pop() ?? f.path;
    const name = f.name ?? leaf.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

    const col = addColumn(sheetId, {
      name,
      kind: "script",
      valueType: (f.valueType as any) ?? "text",
    });
    db.prepare("UPDATE columns SET source_column_id = ?, json_path = ? WHERE id = ?")
      .run(sourceColumnId, f.path, Number(col.id));

    created.push({ columnId: Number(col.id), name: col.name, path: f.path });
  }

  let rowsFilled = 0;
  for (const c of created) rowsFilled = Math.max(rowsFilled, refreshDerivedColumn(sheetId, c.columnId));

  return { created, rowsFilled };
}

/**
 * Point an EXISTING column at a field of a JSON column, instead of creating a new one.
 *
 * The other half of "add to column". Creating a column per field is right the first time and wrong
 * the fifth: a sheet ends up with `Email`, `Email (2)` and `Email (3)` because three enrichments
 * each produced one, when what was wanted was for all three to fill the same column.
 *
 * Refused when the target is already producing its own value. Overwriting a column that runs a rule
 * or calls an API would silently replace work with a projection, and the values would look the same
 * until the next run did nothing.
 */
export function mapJsonField(
  sheetId: string,
  sourceColumnId: number,
  path: string,
  targetColumnId: number,
): { columnId: number; name: string; rowsFilled: number } {
  const cols = listColumns(sheetId);
  const source = cols.find((c) => Number(c.id) === sourceColumnId);
  const target = cols.find((c) => Number(c.id) === targetColumnId);
  if (!source) throw new Error("Source column not found.");
  if (!target) throw new Error("Target column not found.");
  if (Number(target.id) === sourceColumnId) throw new Error("A column cannot be filled from itself.");

  const existing = db
    .prepare("SELECT source_column_id, transform_script_id FROM columns WHERE id = ?")
    .get(targetColumnId) as any;
  const alreadyDerived = existing?.source_column_id != null;
  if (!alreadyDerived && (target.kind !== "static" || existing?.transform_script_id != null)) {
    throw new Error(
      `"${target.name}" already produces its own value. Pick a plain column, or add a new one.`,
    );
  }

  db.prepare(
    "UPDATE columns SET kind = 'script', source_column_id = ?, json_path = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(sourceColumnId, path, targetColumnId);

  return { columnId: targetColumnId, name: target.name, rowsFilled: refreshDerivedColumn(sheetId, targetColumnId) };
}

/**
 * Recompute a derived column from its source.
 *
 * Runs in batches inside transactions, like every other bulk write here — a million-row derived
 * column is a million cell updates, and per-statement commits would dominate.
 */
/**
 * Pull one path out of one source cell.
 *
 * Extracted so the whole-column refresh and the single-row restore cannot drift: the double parse —
 * a JSON column whose value is itself a JSON string, which is what an API that returns a quoted body
 * gives you — is fiddly enough that a second copy would eventually only get it half right.
 */
export function extractAt(raw: string | null | undefined, path: string): { text: string | null; json: string | null } {
  let extracted: unknown = undefined;
  if (raw != null) {
    try {
      let parsed = JSON.parse(raw);
      if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { /* keep the string */ } }
      extracted = getPath(parsed, path);
    } catch { /* the source is not JSON on this row — leaves the cell empty, not errored */ }
  }
  return { text: toText(extracted), json: extracted === undefined ? null : JSON.stringify(extracted) };
}

export function refreshDerivedColumn(sheetId: string, columnId: number): number {
  const col = db.prepare("SELECT source_column_id, json_path FROM columns WHERE id = ?").get(columnId) as any;
  if (!col?.source_column_id || !col.json_path) return 0;

  const sourceId = Number(col.source_column_id);
  const path = String(col.json_path);
  let processed = 0;
  let offset = 0;

  for (;;) {
    const rows = db
      .prepare(
        `SELECT row_id, value_json, value_text FROM cells
          WHERE column_id = ? ORDER BY row_id LIMIT ? OFFSET ?`,
      )
      .all(sourceId, BATCH, offset) as any[];
    if (rows.length === 0) break;

    const dirty: string[] = [];
    tx(() => {
      const upd = db.prepare(
        `UPDATE cells SET value_text = ?, value_json = ?, status = ?, rev = rev + 1,
                          updated_at = datetime('now')
          WHERE row_id = ? AND column_id = ? AND pinned = 0`,
      );
      /**
       * What happens to a cell somebody typed over.
       *
       * The `AND pinned = 0` above STAYS. Removing it would make the pin a lie and would destroy an
       * override the user was explicitly warned would survive.
       *
       * But the bug was never the guard — it was the SILENCE. A hand-edited child was skipped here
       * forever, with nothing anywhere saying it had stopped following its source, so a cell could
       * disagree with the answer it claims to be a projection of for the rest of the table's life.
       * So the value is left alone and the cell is FLAGGED: stale when what the source now produces
       * differs from what is stored, and un-flagged when the two agree again — which they do if the
       * source later catches up with the correction, and a flag that could only ever go on would
       * eventually be on every overridden cell regardless of whether anything was wrong.
       */
      const flag = db.prepare(
        `UPDATE cells SET stale = ?, rev = rev + 1 WHERE row_id = ? AND column_id = ? AND pinned = 1`,
      );
      // Read alongside the source so the comparison is against what is actually stored here.
      const mine = new Map<number, { pinned: number; value_text: string | null }>();
      for (const m of db
        .prepare(
          `SELECT row_id, pinned, value_text FROM cells
            WHERE column_id = ? AND row_id IN (${rows.map(() => "?").join(",")})`,
        )
        .all(columnId, ...rows.map((r) => r.row_id)) as any[]) {
        mine.set(Number(m.row_id), { pinned: Number(m.pinned), value_text: m.value_text ?? null });
      }

      for (const r of rows) {
        const { text, json } = extractAt(r.value_json ?? r.value_text, path);
        const held = mine.get(Number(r.row_id));
        if (held?.pinned) {
          flag.run((held.value_text ?? null) === text ? 0 : 1, r.row_id, columnId);
          dirty.push(cellId(Number(r.row_id), columnId));
          continue;
        }
        // A path that is genuinely absent is `empty`, not `error`: the source simply did not
        // include that field for this row, which is normal and must not inflate the error count.
        upd.run(text, json, text != null ? "done" : "empty", r.row_id, columnId);
        dirty.push(cellId(Number(r.row_id), columnId));
      }
    });
    markColumnDirty(columnId);
    markCellsDirty(dirty);

    processed += rows.length;
    offset += rows.length;
  }
  return processed;
}

/**
 * Put ONE cell back to what its source says, discarding an override.
 *
 * The way back from the warning the override dialog gives. Unpins first — the value is no longer
 * one that was typed, and a cell still carrying that marker would go on being protected from runs
 * for a value nobody typed — then writes what the source produces today.
 *
 * Returns false when the column is not a projection at all, so the route can say so rather than
 * reporting a restore that restored nothing.
 */
export function refreshDerivedCell(sheetId: string, columnId: number, rowId: number): boolean {
  const col = db.prepare("SELECT source_column_id, json_path FROM columns WHERE id = ?").get(columnId) as any;
  if (!col?.source_column_id || !col.json_path) return false;

  const src = db
    .prepare("SELECT value_json, value_text FROM cells WHERE row_id = ? AND column_id = ?")
    .get(rowId, Number(col.source_column_id)) as any;
  const { text, json } = extractAt(src?.value_json ?? src?.value_text, String(col.json_path));

  tx(() => {
    db.prepare(
      `UPDATE cells SET value_text = ?, value_json = ?, status = ?, pinned = 0, stale = 0,
                        error_type = NULL, error_msg = NULL, rev = rev + 1, updated_at = datetime('now')
        WHERE row_id = ? AND column_id = ?`,
    ).run(text, json, text != null ? "done" : "empty", rowId, columnId);
  });
  markColumnDirty(columnId);
  markCellsDirty([cellId(rowId, columnId)]);
  return true;
}

/** Every derived column that projects out of `sourceColumnId`. */
export function derivedChildren(sheetId: string, sourceColumnId: number): number[] {
  return (
    db.prepare("SELECT id FROM columns WHERE sheet_id = ? AND source_column_id = ? AND deleted_at IS NULL").all(sheetId, sourceColumnId) as any[]
  ).map((r) => Number(r.id));
}

/**
 * Refresh every child of a source column. Called after the source is re-run, so expanding a JSON
 * object does not create six columns that silently go stale the moment the source changes.
 */
export function refreshChildren(sheetId: string, sourceColumnId: number): number {
  let n = 0;
  for (const childId of derivedChildren(sheetId, sourceColumnId)) {
    n += refreshDerivedColumn(sheetId, childId);
  }
  return n;
}

/** A place inside a JSON column where a list actually lives. */
export interface ListLocation {
  /** The path, dotted. Empty means the cell IS the list. */
  path: string;
  /** What to call it on screen: "the whole cell", or "contacts". */
  label: string;
  /** Rows sampled in which a list was found here. */
  rows: number;
  /** Total items across those rows, so a path holding one item per row reads differently from one holding forty. */
  items: number;
  /** Whether the items are objects with fields, rather than bare strings or numbers. */
  objects: boolean;
}

/**
 * WHERE is the list inside this column?
 *
 * The fan-out already supported a nested list — `SendConfig.listPath` was read by the writer and
 * threaded through field discovery — and there was no way to SET it. So a column holding
 * `{company: …, contacts: [ … ]}` could only be exploded by pointing at the whole cell, which is not
 * a list, so the fan-out produced one row containing the object and looked broken.
 *
 * Discovery rather than a text box, for the same reason the field mapping is discovered: asking
 * somebody to type a JSON path from memory means asking them to already know the shape of a payload
 * they are looking at this screen precisely because they have not seen.
 *
 * Only ONE level down, plus the cell itself. A recursive walk finds paths like
 * `results.0.people.0.emails` that are real and useless — a list nested inside a list item is not
 * something the fan-out can write, because there is no row for it to belong to.
 */
export function discoverListPaths(sourceColumnId: number, sampleRows = 50): ListLocation[] {
  const rows = db
    .prepare(
      `SELECT value_json, value_text FROM cells
        WHERE column_id = ? AND status = 'done' AND value_text IS NOT NULL AND value_text <> ''
        LIMIT ?`,
    )
    .all(sourceColumnId, sampleRows) as any[];

  // path -> tally. The empty key is the cell itself.
  const found = new Map<string, { rows: number; items: number; objects: number }>();
  const note = (path: string, list: unknown[]) => {
    const t = found.get(path) ?? { rows: 0, items: 0, objects: 0 };
    t.rows++;
    t.items += list.length;
    if (list.some((x) => x && typeof x === "object" && !Array.isArray(x))) t.objects++;
    found.set(path, t);
  };

  for (const r of rows) {
    let parsed: unknown;
    try { parsed = JSON.parse(r.value_json ?? r.value_text); } catch { continue; }
    // A JSON column populated by import can hold the JSON double-encoded as a string.
    if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { continue; } }

    if (Array.isArray(parsed)) { note("", parsed); continue; }
    if (!parsed || typeof parsed !== "object") continue;

    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value) && value.length > 0) note(key, value);
    }
  }

  return [...found.entries()]
    .map(([path, t]) => ({
      path,
      label: path === "" ? "the whole cell" : path,
      rows: t.rows,
      items: t.items,
      // A majority call rather than "any": one row where the list happens to hold an object does not
      // make a list of strings into a list of records, and the mapping screen behaves differently
      // for the two.
      objects: t.objects * 2 >= t.rows,
    }))
    // Most rows first, then most items. The path present on every row is almost always the one
    // meant, and burying it under a field that appeared twice is how a discovery screen wastes the
    // time it exists to save.
    .sort((a, b) => b.rows - a.rows || b.items - a.items)
    .slice(0, 12);
}
