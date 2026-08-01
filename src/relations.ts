// Relations — the join between two tables.
//
// This is the piece that makes a workbook a database rather than a pile of spreadsheets. "Companies"
// holds one row per company and "Contacts" holds one row per person; a relation says which column on
// each side identifies the same thing, and from then on a Contacts column can read a Companies value
// without re-enriching it. That is not a convenience: enriching a company once and reading it from
// two thousand contacts is one unit of spend instead of two thousand.
//
// ── The two decisions that shape this file ──────────────────────────────────────────────────────
//
// MATCHING IS ON A COMPARABLE FORM OF THE VALUE, chosen per relation — see `MatchMode`. The default
// is `normalized`, built on the normalizer dedupe already uses: the same company arrives as
// "https://www.Acme.com/", "acme.com" and "ACME.com", and a relation matching raw strings matches
// almost nothing on real data and does it silently, so the column just looks empty. Reusing
// `normalizeKey` means there is exactly ONE definition in this product of "these two values are the
// same thing" rather than one for dedupe and a subtly different one here. `exact` and `fuzzy` sit
// either side of it for the cases where that judgement is wrong in one direction or the other.
//
// THE KEYS ARE MATERIALIZED. The alternative — normalize both sides at query time — is a full scan of
// one table per row of the other, which on the million-row table is not slow, it is unusable. The
// keys live in `relation_keys` with an index on (relation_id, side, key), so a match is a seek. It
// also makes the cross-sheet stale cascade expressible: when a row on one side changes, the rows
// that read it are the ones sharing its key, and that is precisely what this index answers.

import { db, tx } from "./db.ts";
import { ensureFunction, normalizeKey } from "./dedupe.ts";
import { listColumns } from "./store.ts";

export type Cardinality = "many_to_one" | "one_to_one";

/**
 * How strictly two values have to agree to be the same thing.
 *
 * One knob, three honest positions, and the difference between them is entirely in what they let
 * through — so each is described here by the mistake it makes, not by how clever it is.
 */
export type MatchMode =
  /** Character for character. Makes no mistakes and misses everything a human would have caught. */
  | "exact"
  /** Case, whitespace and the shape of a URL, email or phone number are noise. The default. */
  | "normalized"
  /** Also ignores punctuation, company-type words, and the order of words. Matches more, and can
   *  over-match: two genuinely different "Acme Group" entries become one. */
  | "fuzzy";

export const MATCH_MODES: MatchMode[] = ["exact", "normalized", "fuzzy"];

const isMode = (v: unknown): v is MatchMode => MATCH_MODES.includes(v as MatchMode);

/**
 * Words that describe what KIND of company something is rather than which company it is.
 *
 * "Acme Inc." and "Acme Limited" are the same business filed under two registrations; "Acme" and
 * "Beta" are not. Stripping these is the single highest-value step in matching company names, and
 * also the one that can over-reach — "Group" is part of the actual name for some businesses. That
 * is why it belongs to `fuzzy` and not to `normalized`: it is a judgement, and the mode is where the
 * user agrees to it.
 */
const LEGAL_WORDS = new Set([
  "inc", "incorporated", "llc", "llp", "lp", "ltd", "limited", "plc", "corp", "corporation",
  "company", "co", "gmbh", "ag", "kg", "sa", "sas", "sarl", "bv", "nv", "oy", "ab", "as", "aps",
  "pty", "srl", "spa", "holdings", "holding", "group", "international", "intl", "the",
]);

/**
 * The comparable form of a value under a given mode.
 *
 * `exact` deliberately does NOT lowercase. It exists for the case where the value is an identifier
 * whose case is meaningful — a CRM id, a SKU, a case-sensitive token — and quietly folding case
 * would make it the same as `normalized` under a name that promises otherwise.
 */
export function relationKey(raw: string | null, valueType: string, mode: MatchMode): string | null {
  if (raw == null) return null;
  if (mode === "exact") {
    const v = raw.trim();
    return v || null;
  }

  const base = normalizeKey(raw, valueType);
  if (base == null || mode === "normalized") return base;

  // Fuzzy. Punctuation out, company-type words out, then the remaining words SORTED — so
  // "Acme Software" and "Software, Acme (Inc.)" land on the same key. Sorting is what makes word
  // order stop mattering, which is the difference between this and a slightly keener normalizer.
  const words = base
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !LEGAL_WORDS.has(w));
  if (words.length === 0) {
    // Everything was a company-type word — "The Group Ltd". Falling through to an empty key would
    // make every such row match every other one, so the normalized form stands instead.
    return base;
  }
  return words.sort().join(" ");
}

export interface Relation {
  id: number;
  workbookId: string;
  /** The table that POINTS at the other — where a lookup column lives. */
  fromSheetId: string;
  fromColumnId: number;
  /** The table being pointed AT — where the value comes from. */
  toSheetId: string;
  toColumnId: number;
  cardinality: Cardinality;
  /** How strictly two values have to agree. See MatchMode. */
  matchMode: MatchMode;
  createdAt: string;
}

export interface RelationInput {
  fromSheetId: string;
  fromColumnId: number;
  toSheetId: string;
  toColumnId: number;
  cardinality?: Cardinality;
  matchMode?: MatchMode;
}

/** How much of the pointing table actually found something. The number that decides if it worked. */
export interface RelationHealth {
  /** Rows on the from side that have a usable key at all. A blank key is not a failed match. */
  keyed: number;
  /** Rows on the from side with no value in the key column — nothing to match with. */
  blank: number;
  matched: number;
  unmatched: number;
  /**
   * From-rows whose key hits MORE THAN ONE row on the other side.
   *
   * Reported rather than hidden, because it is the failure that looks like success: a lookup still
   * fills in, it just silently picks one of several. On a `one_to_one` relation it is a defect in
   * the data; on `many_to_one` it means the target table itself needs deduplicating.
   */
  ambiguous: number;
  /** Distinct keys on the target side, so "did I point at the right column" is answerable. */
  targetKeys: number;
}

function toRelation(r: any): Relation {
  return {
    id: Number(r.id),
    workbookId: String(r.workbook_id),
    fromSheetId: String(r.from_sheet_id),
    fromColumnId: Number(r.from_column_id),
    toSheetId: String(r.to_sheet_id),
    toColumnId: Number(r.to_column_id),
    cardinality: (r.cardinality === "one_to_one" ? "one_to_one" : "many_to_one"),
    matchMode: isMode(r.match_mode) ? r.match_mode : "normalized",
    createdAt: String(r.created_at),
  };
}

export class RelationError extends Error {}

/**
 * `relationKey` registered into SQLite, so the keys are built in one set-based statement.
 *
 * The same trick dedupe uses, and for the same reason: pulling a million values into JavaScript to
 * key them took 4.6 seconds on the engine's single thread and stopped the grid answering with it.
 * Registering the JS function means there is one definition of the key rather than one here and a
 * subtly different one in SQL.
 */
let keyFnReady = false;
function ensureKeyFunction(): void {
  if (keyFnReady) return;
  // Deterministic: identical arguments always give the identical answer, which is what lets SQLite
  // call it inside a set-based INSERT without re-evaluating per comparison.
  (db as unknown as { function: (n: string, o: object, f: (...a: any[]) => unknown) => void })
    .function("cc_relation_key", { deterministic: true }, (value: string | null, valueType: string, mode: string) =>
      relationKey(value ?? null, valueType ?? "text", isMode(mode) ? mode : "normalized"),
    );
  keyFnReady = true;
}

/**
 * The column, checked against the sheet it is claimed to be in.
 *
 * Checked rather than assumed because a relation is stored as four loose ids with no foreign key
 * tying a column to its sheet. A mismatched pair would produce a relation that builds no keys and
 * matches nothing, and the only symptom would be an empty column — a bug that looks like bad data.
 */
function columnIn(sheetId: string, columnId: number): { id: number; name: string; valueType: string } {
  const col = listColumns(sheetId).find((c) => Number(c.id) === Number(columnId));
  if (!col) throw new RelationError("That column is not in that table.");
  return { id: Number(col.id), name: col.name, valueType: String(col.valueType ?? "text") };
}

function workbookOf(sheetId: string): string {
  const r = db.prepare("SELECT workbook_id FROM sheets WHERE id = ?").get(sheetId) as any;
  if (!r) throw new RelationError("That table does not exist.");
  if (!r.workbook_id) throw new RelationError("That table is not in a workbook yet, so it cannot be linked.");
  return String(r.workbook_id);
}

/**
 * Links that would end up spanning two workbooks if this table moved to `toWorkbookId`.
 *
 * `createRelation` refuses a pair whose tables sit in different workbooks, and then nothing enforced
 * that rule ever again: moving one end afterwards produced exactly the state the product declines to
 * build. It has no symptom — the link goes on matching, because `lookupConfig` resolves from sheet
 * ids and never re-checks the workbook — but the copy drops it, the export dropped it silently, and
 * `relations.workbook_id` is what `scopeOf` authorizes the link against, so it would be checked
 * against a workbook one of its tables had left.
 *
 * Returned rather than deleted. A link is configuration somebody built, and the fix for "I want to
 * move this table" is theirs to choose: unlink first, or move both tables.
 */
export function relationsSpanning(
  sheetId: string,
  toWorkbookId: string,
): Array<{ id: number; fromTable: string; toTable: string }> {
  return (
    db
      .prepare(
        `SELECT r.id,
                r.from_sheet_id, r.to_sheet_id,
                f.name AS from_name, t.name AS to_name,
                f.workbook_id AS from_wb, t.workbook_id AS to_wb
           FROM relations r
           JOIN sheets f ON f.id = r.from_sheet_id
           JOIN sheets t ON t.id = r.to_sheet_id
          WHERE (r.from_sheet_id = ? OR r.to_sheet_id = ?)
            AND f.deleted_at IS NULL AND t.deleted_at IS NULL`,
      )
      .all(sheetId, sheetId) as any[]
  )
    .filter((r) => {
      // Where the OTHER end sits. The moving table lands in `toWorkbookId` by definition, so the
      // link spans exactly when the end that is staying put is somewhere else.
      const otherWorkbook =
        String(r.from_sheet_id) === sheetId ? String(r.to_wb ?? "") : String(r.from_wb ?? "");
      return otherWorkbook !== String(toWorkbookId);
    })
    .map((r) => ({ id: Number(r.id), fromTable: String(r.from_name), toTable: String(r.to_name) }));
}

export function createRelation(input: RelationInput): Relation {
  const { fromSheetId, toSheetId } = input;
  if (fromSheetId === toSheetId) {
    // Not a limitation worth working around: a table that reads itself by a key is a rollup over its
    // own rows, which is a different feature with different semantics. Allowing it here would give
    // two ways to express one idea and one of them would be subtly wrong.
    throw new RelationError("A table cannot be linked to itself. Use a rollup for that.");
  }
  const wb = workbookOf(fromSheetId);
  if (workbookOf(toSheetId) !== wb) {
    throw new RelationError("Both tables have to be in the same workbook.");
  }
  columnIn(fromSheetId, input.fromColumnId);
  columnIn(toSheetId, input.toColumnId);

  // One relation per pair of columns. Two identical relations would each build their own key index
  // over the same million rows and every lookup would have to pick one arbitrarily.
  const dupe = db
    .prepare(
      `SELECT id FROM relations
        WHERE from_sheet_id = ? AND from_column_id = ? AND to_sheet_id = ? AND to_column_id = ?`,
    )
    .get(fromSheetId, input.fromColumnId, toSheetId, input.toColumnId) as any;
  if (dupe) throw new RelationError("Those two columns are already linked.");

  const id = tx(() => {
    const res = db
      .prepare(
        `INSERT INTO relations (workbook_id, from_sheet_id, from_column_id, to_sheet_id, to_column_id, cardinality, match_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(wb, fromSheetId, input.fromColumnId, toSheetId, input.toColumnId, input.cardinality ?? "many_to_one", isMode(input.matchMode) ? input.matchMode : "normalized");
    return Number(res.lastInsertRowid);
  });

  // Built immediately. A relation with no keys is indistinguishable from a relation that matches
  // nothing, and the screen that created it is the only place anyone will look for the difference.
  rebuildRelationKeys(id);
  return getRelation(id)!;
}

export function getRelation(id: number): Relation | null {
  const r = db.prepare("SELECT * FROM relations WHERE id = ?").get(Number(id)) as any;
  return r ? toRelation(r) : null;
}

/** Every relation this table takes part in, on either side. */
export function listRelations(sheetId: string): Relation[] {
  return (
    db
      .prepare("SELECT * FROM relations WHERE from_sheet_id = ? OR to_sheet_id = ? ORDER BY id")
      .all(sheetId, sheetId) as any[]
  ).map(toRelation);
}

/**
 * Change how strictly a link matches, and rebuild the index in the same breath.
 *
 * The rebuild is not optional and is not left to the caller. Every key in `relation_keys` was
 * computed under the OLD mode, so a mode change without one leaves an index that describes a rule
 * nobody selected — and the symptom is a match rate that does not move when you change the setting
 * meant to move it, which reads as the control being broken.
 */
export function setMatchMode(id: number, mode: MatchMode): Relation {
  const rel = getRelation(Number(id));
  if (!rel) throw new RelationError("That link no longer exists.");
  if (!isMode(mode)) throw new RelationError("That is not a matching mode.");
  if (rel.matchMode === mode) return rel;

  db.prepare("UPDATE relations SET match_mode = ? WHERE id = ?").run(mode, Number(id));
  rebuildRelationKeys(Number(id));
  return getRelation(Number(id))!;
}

export function deleteRelation(id: number): void {
  // relation_keys cascades on the foreign key, so the index goes with it.
  db.prepare("DELETE FROM relations WHERE id = ?").run(Number(id));
}

/**
 * Recompute both sides' keys from scratch.
 *
 * Done entirely in SQL. The first version of dedupe pulled a million values into JavaScript to group
 * them and took 4.6 seconds on the engine's single thread, which stops the grid answering too — the
 * same mistake here would be worse, because a relation is rebuilt whenever either key column is
 * re-run rather than only when someone opens a settings panel.
 *
 * Rows with a blank or unnormalizable key are simply absent from the index. That is deliberate: an
 * empty key is not a key, and letting blanks in would make every blank row on one side "match" every
 * blank row on the other — which is the single most destructive thing a join can do quietly.
 */
export function rebuildRelationKeys(relationId: number): { from: number; to: number } {
  const rel = getRelation(relationId);
  if (!rel) throw new RelationError("That link no longer exists.");
  ensureFunction(); ensureKeyFunction();

  const fromCol = columnIn(rel.fromSheetId, rel.fromColumnId);
  const toCol = columnIn(rel.toSheetId, rel.toColumnId);

  return tx(() => {
    db.prepare("DELETE FROM relation_keys WHERE relation_id = ?").run(rel.id);
    const fill = db.prepare(
      `INSERT OR REPLACE INTO relation_keys (relation_id, side, row_id, key)
       SELECT ?, ?, c.row_id, cc_relation_key(c.value_text, ?, ?)
         FROM cells c
        WHERE c.column_id = ?
          AND c.value_text IS NOT NULL
          AND cc_relation_key(c.value_text, ?, ?) IS NOT NULL`,
    );
    const f = fill.run(rel.id, "from", fromCol.valueType, rel.matchMode, fromCol.id, fromCol.valueType, rel.matchMode);
    const t = fill.run(rel.id, "to", toCol.valueType, rel.matchMode, toCol.id, toCol.valueType, rel.matchMode);
    return { from: Number(f.changes ?? 0), to: Number(t.changes ?? 0) };
  });
}

/**
 * Re-key ONE side for specific rows, after their key cells were written.
 *
 * The incremental counterpart to the rebuild, for the run path: re-indexing a million rows because
 * six of them changed is the kind of cost that turns a correct feature into an unusable one. The
 * delete-then-insert pair matters — a row whose key was cleared has to LEAVE the index, and an
 * insert alone would leave its old key behind, matching forever on a value that is no longer there.
 */
export function rekeyRows(relationId: number, side: "from" | "to", rowIds: number[]): void {
  if (rowIds.length === 0) return;
  const rel = getRelation(relationId);
  if (!rel) return;
  ensureFunction(); ensureKeyFunction();

  const col = side === "from"
    ? columnIn(rel.fromSheetId, rel.fromColumnId)
    : columnIn(rel.toSheetId, rel.toColumnId);

  // 500 at a time: SQLite refuses a statement carrying more than 32,766 bound variables, and this is
  // called with whatever a run just finished — which can be the whole sheet.
  for (let i = 0; i < rowIds.length; i += 500) {
    const chunk = rowIds.slice(i, i + 500);
    const marks = chunk.map(() => "?").join(",");
    tx(() => {
      db.prepare(`DELETE FROM relation_keys WHERE relation_id = ? AND side = ? AND row_id IN (${marks})`)
        .run(rel.id, side, ...chunk);
      db.prepare(
        `INSERT OR REPLACE INTO relation_keys (relation_id, side, row_id, key)
         SELECT ?, ?, c.row_id, cc_relation_key(c.value_text, ?, ?)
           FROM cells c
          WHERE c.column_id = ?
            AND c.row_id IN (${marks})
            AND c.value_text IS NOT NULL
            AND cc_relation_key(c.value_text, ?, ?) IS NOT NULL`,
      ).run(rel.id, side, col.valueType, rel.matchMode, col.id, ...chunk, col.valueType, rel.matchMode);
    });
  }
}

/** Every relation whose key column is `columnId`, and which side that is. */
export function relationsKeyedOn(columnId: number): Array<{ relation: Relation; side: "from" | "to" }> {
  const out: Array<{ relation: Relation; side: "from" | "to" }> = [];
  for (const r of db.prepare("SELECT * FROM relations WHERE from_column_id = ? OR to_column_id = ?")
    .all(Number(columnId), Number(columnId)) as any[]) {
    const rel = toRelation(r);
    if (rel.fromColumnId === Number(columnId)) out.push({ relation: rel, side: "from" });
    if (rel.toColumnId === Number(columnId)) out.push({ relation: rel, side: "to" });
  }
  return out;
}

/**
 * Did this link actually work?
 *
 * The question every join needs answered before anything is built on it, and the one a UI that only
 * says "linked" leaves you to discover a column at a time. `blank` is separated from `unmatched`
 * because they have different fixes: blank means the key column needs filling, unmatched means the
 * two sides disagree about what the value looks like.
 */
export function relationHealth(relationId: number): RelationHealth {
  const rel = getRelation(relationId);
  if (!rel) throw new RelationError("That link no longer exists.");

  const one = (sql: string, ...params: unknown[]): number =>
    Number((db.prepare(sql).get(...(params as any[])) as any)?.n ?? 0);

  const totalRows = one("SELECT COUNT(*) AS n FROM rows WHERE sheet_id = ?", rel.fromSheetId);
  const keyed = one("SELECT COUNT(*) AS n FROM relation_keys WHERE relation_id = ? AND side = 'from'", rel.id);

  // Grouped once and read twice, so "matched" and "ambiguous" cannot disagree about the same row.
  const agg = db
    .prepare(
      `SELECT
         SUM(CASE WHEN hits >= 1 THEN 1 ELSE 0 END) AS matched,
         SUM(CASE WHEN hits >  1 THEN 1 ELSE 0 END) AS ambiguous
       FROM (
         SELECT f.row_id,
                (SELECT COUNT(*) FROM relation_keys t
                   WHERE t.relation_id = f.relation_id AND t.side = 'to' AND t.key = f.key) AS hits
           FROM relation_keys f
          WHERE f.relation_id = ? AND f.side = 'from'
       )`,
    )
    .get(rel.id) as any;

  const matched = Number(agg?.matched ?? 0);
  return {
    keyed,
    blank: Math.max(0, totalRows - keyed),
    matched,
    unmatched: Math.max(0, keyed - matched),
    ambiguous: Number(agg?.ambiguous ?? 0),
    targetKeys: one(
      "SELECT COUNT(DISTINCT key) AS n FROM relation_keys WHERE relation_id = ? AND side = 'to'",
      rel.id,
    ),
  };
}

/**
 * The matching row on the other side, for one row. Used by the cell panel, not by a run.
 *
 * A run never calls this — it would be one query per row. Runs go through the set-based path in
 * `lookup.ts`.
 */
export function matchedRow(relationId: number, fromRowId: number): number | null {
  const r = db
    .prepare(
      `SELECT t.row_id AS id
         FROM relation_keys f
         JOIN relation_keys t
           ON t.relation_id = f.relation_id AND t.side = 'to' AND t.key = f.key
        WHERE f.relation_id = ? AND f.side = 'from' AND f.row_id = ?
        ORDER BY t.row_id
        LIMIT 1`,
    )
    .get(Number(relationId), Number(fromRowId)) as any;
  return r ? Number(r.id) : null;
}

/** Exposed for tests and for the UI's "why did this not match?" explanation. */
export function keyFor(value: string | null, valueType: string): string | null {
  return normalizeKey(value, valueType);
}
