// Writing results into ANOTHER table — the destination that turns a list into records.
//
// This is the only operation in the app that creates data somewhere the user is not looking, so two
// properties are non-negotiable:
//
//   1. DRY RUN FIRST. Every write reports inserts / updates / skips before it touches anything, and
//      the preview is produced by the same code path as the write. That claim is only true if the
//      preview models everything the write does — a PINNED cell it will refuse, the back-reference
//      it will fill in — so both are modelled here rather than discovered afterwards.
//
//   2. IDEMPOTENT BY KEY. Re-running a fan-out must UPDATE the rows it created, not duplicate them.
//      Without that, every re-run doubles the target table — and a fan-out is exactly the thing
//      people re-run after tweaking a prompt.
//
//      Idempotency is a promise the CONFIGURATION has to be able to keep. Two shapes cannot keep it,
//      and both used to duplicate the destination in silence: a config with no match key at all (a
//      warning on every plan), and a row whose key cell is blank (skipped, never inserted — see
//      `decide`). Neither is a policy the writer may quietly choose for the user.

import { db, tx } from "./db.ts";
import { markCellsDirty } from "./bus.ts";
import { cellId } from "./db.ts";
import { getPath, toList, toText } from "./jsonPath.ts";
import { backfillCells, getSheet, invalidateRowCount, listColumns, nextRowPosition } from "./store.ts";
import { bumpDataVersion } from "./store.ts";
import { markSheetDirty } from "./columnStats.ts";
import { listRelations, rebuildRelationKeys } from "./relations.ts";

export type ConflictPolicy = "upsert" | "insert" | "skip";

/**
 * How many ids go into one `IN (...)` list.
 *
 * SQLite refuses a statement carrying more than 32,766 bound variables, and every read here binds
 * one per row. A send over 32,766 rows used to throw the raw engine error: the run failed, nothing
 * was written, and no cell recorded why. Reading in slices removes the ceiling entirely. 500 is the
 * batch size the rest of the engine reads in.
 */
const ID_CHUNK = 500;

function chunked<T>(xs: T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/**
 * Where one target column's value comes from.
 *
 * Two sources, and the second is the one this was missing. A list of contacts exploded into a
 * Contacts table is nearly useless if every row only carries what was inside the contact object —
 * the name and the email but not the COMPANY they belong to, because that lives on the parent row,
 * not inside the item. A back-reference id linked them, but an id is not something you can read,
 * group by, filter on, or send in an email.
 *
 * A plain string is still accepted and still means "a path into the item", so every mapping saved
 * before this keeps working.
 */
export type FieldSource =
  | { from: "item"; path: string }
  | { from: "row"; columnId: number };

export type MappingValue = string | FieldSource;

export interface WriteTarget {
  targetSheetId: string;
  /** targetColumnId -> where its value comes from. */
  mapping: Record<string, MappingValue>;
  /** Path within the item that forms the match key. Empty means always insert. */
  keyPath?: string;
  /**
   * The match key, when it does not live inside the item.
   *
   * Sending whole ROWS rather than list items is the ordinary case — one row over here becomes one
   * row over there — and there is no "item" to take a key out of. The thing that says two rows are
   * the same is a COLUMN: an email, a domain, an id. `keyPath` could not express that, so a
   * row-to-row send had no way to be idempotent and every re-run duplicated the destination.
   *
   * Takes precedence over `keyPath` when both are set.
   */
  keySource?: FieldSource;
  onConflict: ConflictPolicy;
  /**
   * Column on the TARGET table that records which source row produced this one. Written
   * automatically so an exploded contact knows its parent company, and the relation exists in both
   * directions rather than only forwards.
   */
  backRefColumnId?: number;
}

export interface WriteItem {
  /** The row in the SOURCE table that produced this item. */
  sourceRowId: number;
  value: unknown;
  /**
   * That row's other columns, keyed by column id.
   *
   * Carried alongside the item rather than looked up per mapping, because a fan-out of 50,000 items
   * would otherwise be 50,000 round trips to read values the caller already had in hand.
   */
  rowValues?: Record<string, string | null>;
}

export interface WritePlan {
  inserts: number;
  updates: number;
  skips: number;
  /** First few resolved rows, so a dry run shows real values rather than a count. */
  preview: Array<{ action: "insert" | "update" | "skip"; key: string | null; values: Record<string, string | null> }>;
  /** Reasons NOTHING will be written. A non-empty list stops the write dead. */
  errors: string[];
  /**
   * Things the write will really do that the user almost certainly did not mean.
   *
   * Separate from `errors` on purpose: an error refuses the whole send, and refusing 50,000 good
   * rows because three of them have a blank cell is a worse outcome than saying so. A warning is
   * how the dry run tells the truth about a config that works and will keep adding rows forever.
   */
  warnings: string[];
}

/** What happened to ONE source row. A row can produce several items, so these are counts. */
export interface RowOutcome {
  inserted: number;
  updated: number;
  skipped: number;
  /** Why it was skipped, in the words the source cell should show. */
  reason?: string;
}

/** A mapping entry, old shape or new, as one thing. */
function asSource(v: MappingValue): FieldSource {
  return typeof v === "string" ? { from: "item", path: v } : v;
}

/** Does this target say how to recognise a row it has already written? */
function isKeyed(target: WriteTarget): boolean {
  return Boolean(target.keySource || target.keyPath);
}

function resolveItem(item: WriteItem, target: WriteTarget): { values: Map<number, string | null>; key: string | null } {
  const values = new Map<number, string | null>();
  for (const [colId, entry] of Object.entries(target.mapping)) {
    const src = asSource(entry);
    if (src.from === "row") {
      // Straight off the parent row. This is what lets an exploded contact carry the company it
      // belongs to, rather than only the fields that happened to be inside the contact object.
      values.set(Number(colId), item.rowValues?.[String(src.columnId)] ?? null);
      continue;
    }
    const raw = src.path ? getPath(item.value, src.path) : item.value;
    values.set(Number(colId), toText(raw));
  }
  // The key is resolved through the same two-source rule as any other value, so "match on the
  // Email column of the row" and "match on the email field inside the item" are one mechanism.
  const keyRaw = target.keySource
    ? target.keySource.from === "row"
      ? item.rowValues?.[String(target.keySource.columnId)] ?? null
      : getPath(item.value, target.keySource.path)
    : target.keyPath
      ? getPath(item.value, target.keyPath)
      : null;
  const key = keyRaw == null ? null : String(toText(keyRaw) ?? "").trim().toLowerCase();
  return { values, key: key || null };
}

/**
 * Everything both entry points need, read ONCE.
 *
 * `applyWrite` takes the plan's work rather than calling `planWrite` and rebuilding the key index
 * and the destination's column list a second time. That would be two full scans of the target table
 * per send for answers it already holds, and the cost is the smaller half of it: two reads are two
 * snapshots, so what the plan decided and what the write did would be free to disagree about a table
 * someone else is editing.
 */
export interface WriteContext {
  /** Every column on the destination, so an inserted row is created whole rather than with holes. */
  targetColumnIds: number[];
  names: Map<number, string>;
  /** The destination columns the mapping writes into. */
  mappedIds: number[];
  /** dedupe key -> the target row already holding it. */
  existing: Map<string, number>;
  /** Pinned cells on the rows this write matched: rowId -> the columns that refuse a write. */
  pinned: Map<number, Set<number>>;
  /** Whether a match key is configured at all. */
  keyed: boolean;
  /** One resolution per item, in item order, shared by the plan and the write. */
  resolved: Array<{ values: Map<number, string | null>; key: string | null }>;
  errors: string[];
}

function prepareWrite(items: WriteItem[], target: WriteTarget): WriteContext {
  const cols = listColumns(target.targetSheetId);
  const ctx: WriteContext = {
    targetColumnIds: cols.map((c) => Number(c.id)),
    names: new Map(cols.map((c) => [Number(c.id), c.name])),
    mappedIds: Object.keys(target.mapping).map(Number),
    existing: new Map(),
    pinned: new Map(),
    keyed: isKeyed(target),
    resolved: [],
    errors: [],
  };

  const known = new Set(ctx.targetColumnIds);
  for (const colId of ctx.mappedIds) {
    if (!known.has(colId)) ctx.errors.push(`Mapped column ${colId} does not exist on the target table.`);
  }
  if (ctx.errors.length > 0) return ctx;

  if (ctx.keyed) ctx.existing = loadKeyIndex(target.targetSheetId);
  ctx.resolved = items.map((item) => resolveItem(item, target));

  // Pinned cells are read for the rows this write MATCHED and no others: `pinned` has no index of
  // its own, so asking the whole destination costs more than the write it is describing.
  if (target.onConflict === "upsert" && ctx.mappedIds.length > 0) {
    const matched = new Set<number>();
    for (const r of ctx.resolved) {
      const hit = r.key != null ? ctx.existing.get(r.key) : undefined;
      if (hit != null) matched.add(hit);
    }
    ctx.pinned = loadPinnedIndex([...matched], ctx.mappedIds);
  }
  return ctx;
}

/**
 * The single decision both the preview and the write take.
 *
 * One function, called from both loops, because "the preview is produced by the same code path as
 * the write" cannot be a claim in a comment — it has to be a fact about where the branch lives.
 */
function decide(
  ctx: WriteContext,
  target: WriteTarget,
  key: string | null,
  seen: Set<string>,
): { action: "insert" | "update" | "skip"; rowId: number | null; reason: string | null } {
  // A configured match key with nothing in it is the one case that cannot be written safely at all.
  // Inserted, the row lands with a NULL dedupe_key — outside the key index by construction — so no
  // later run can ever match it, and every re-run adds another copy. Refuse it: a skipped row is
  // recoverable by filling the cell in, a stream of untrackable duplicates is not.
  if (ctx.keyed && key == null) {
    return { action: "skip", rowId: null, reason: "nothing in the column being matched on" };
  }

  const hit = key != null ? ctx.existing.get(key) ?? null : null;
  const inBatch = key != null && seen.has(key);
  if (hit == null && !inBatch) {
    // Track keys seen within THIS batch too: two items sharing a key must not both count as inserts.
    if (key != null) seen.add(key);
    return { action: "insert", rowId: null, reason: null };
  }

  if (target.onConflict === "insert") return { action: "insert", rowId: null, reason: null };
  if (target.onConflict === "skip") return { action: "skip", rowId: hit, reason: "a row over there already matches" };

  // An upsert onto a row whose every mapped cell is PINNED writes nothing — the update statement
  // carries `AND pinned = 0`. Counting that as an update was the preview promising a change the
  // write would then refuse to make.
  if (hit != null) {
    const pins = ctx.pinned.get(hit);
    if (pins && ctx.mappedIds.length > 0 && ctx.mappedIds.every((id) => pins.has(id))) {
      return { action: "skip", rowId: hit, reason: "every cell it would change over there is pinned" };
    }
  }
  return { action: "update", rowId: hit, reason: null };
}

/**
 * Plan a write without performing it.
 *
 * `apply` runs the identical resolution, so the preview cannot disagree with the outcome — the
 * classic failure being a dialog that promises 400 inserts and then performs 40,000.
 *
 * `prepared` is how `applyWrite` hands over the reads it already made; nothing else passes it.
 */
export function planWrite(items: WriteItem[], target: WriteTarget, prepared?: WriteContext): WritePlan {
  const ctx = prepared ?? prepareWrite(items, target);
  const plan: WritePlan = { inserts: 0, updates: 0, skips: 0, preview: [], errors: [...ctx.errors], warnings: [] };
  if (plan.errors.length > 0) return plan;

  const seen = new Set<string>();
  let blank = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const { values, key } = ctx.resolved[i]!;
    const d = decide(ctx, target, key, seen);

    if (d.action === "insert") plan.inserts++;
    else if (d.action === "update") plan.updates++;
    else {
      plan.skips++;
      if (ctx.keyed && key == null) blank++;
    }

    if (plan.preview.length < 5) {
      const shown = new Map(values);
      // The back-reference is written by the run and is not part of the mapping, so a preview built
      // from the mapping alone omits the very column that links the two tables. Only on an insert:
      // an upsert never rewrites it, and showing it there would be a fresh lie.
      if (d.action === "insert" && target.backRefColumnId != null) {
        shown.set(target.backRefColumnId, String(item.sourceRowId));
      }
      plan.preview.push({
        action: d.action,
        key,
        values: Object.fromEntries([...shown].map(([id, v]) => [ctx.names.get(id) ?? String(id), v])),
      });
    }
  }

  // The two ways a send silently grows its destination on every run, said before the first run
  // rather than discovered on the third.
  if (!ctx.keyed && items.length > 0) {
    plan.warnings.push(
      `No match key: this adds ${items.length.toLocaleString()} row${items.length === 1 ? "" : "s"} over there every ` +
      "time it runs, because nothing here can be matched to a row that is already in the destination. " +
      "Pick something to match on — an email, a domain, an id.",
    );
  }
  if (blank > 0) {
    plan.warnings.push(
      `${blank.toLocaleString()} row${blank === 1 ? " has" : "s have"} nothing in the column being matched on, so ` +
      `${blank === 1 ? "it is" : "they are"} skipped rather than added. A row written with no key can never be ` +
      "found again, so the next run would add it a second time.",
    );
  }
  return plan;
}

/**
 * Build key -> rowId for the target table, using the stored dedupe key.
 *
 * Rows with no key are absent by construction, which is exactly why one may never be written under a
 * keyed config: it would be invisible here forever after.
 */
function loadKeyIndex(sheetId: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of db
    .prepare("SELECT id, dedupe_key FROM rows WHERE sheet_id = ? AND dedupe_key IS NOT NULL")
    .all(sheetId) as any[]) {
    m.set(String(r.dedupe_key), Number(r.id));
  }
  return m;
}

/**
 * Which of these rows' cells are pinned, per column.
 *
 * A pinned cell is a value the user protected by hand, and the update statement has always carried
 * `AND pinned = 0`. Reading it here is what lets the plan say "skip" about a row the write is going
 * to leave alone.
 */
function loadPinnedIndex(rowIds: number[], columnIds: number[]): Map<number, Set<number>> {
  const m = new Map<number, Set<number>>();
  if (rowIds.length === 0 || columnIds.length === 0) return m;
  for (const slice of chunked(rowIds)) {
    for (const r of db
      .prepare(
        `SELECT row_id, column_id FROM cells
          WHERE pinned = 1
            AND row_id IN (${slice.map(() => "?").join(",")})
            AND column_id IN (${columnIds.map(() => "?").join(",")})`,
      )
      .all(...slice, ...columnIds) as any[]) {
      const set = m.get(Number(r.row_id)) ?? new Set<number>();
      set.add(Number(r.column_id));
      m.set(Number(r.row_id), set);
    }
  }
  return m;
}

export interface WriteResult extends WritePlan {
  /** Row ids touched in the target table, so the caller can link them back. */
  targetRowIds: number[];
  /**
   * What happened to each SOURCE row, keyed by its id.
   *
   * The caller writes one cell per source row saying what became of it, and it had no way to know:
   * it counted the items it BUILT, so an insert, an update and a no-op skip all rendered as "sent".
   * The branch is known here and nowhere else, so it is reported from here.
   */
  outcomes: Record<string, RowOutcome>;
}

export function applyWrite(items: WriteItem[], target: WriteTarget): WriteResult {
  const ctx = prepareWrite(items, target);
  const plan = planWrite(items, target, ctx);
  const result: WriteResult = { ...plan, targetRowIds: [], outcomes: {} };
  if (plan.errors.length > 0) return result;

  let position = nextRowPosition(target.targetSheetId);
  const dirty: string[] = [];
  const seen = new Set<string>();

  const note = (sourceRowId: number, field: "inserted" | "updated" | "skipped", reason: string | null): void => {
    const k = String(sourceRowId);
    const o = result.outcomes[k] ?? (result.outcomes[k] = { inserted: 0, updated: 0, skipped: 0 });
    o[field]++;
    if (reason && !o.reason) o.reason = reason;
  };

  tx(() => {
    const insRow = db.prepare("INSERT INTO rows (sheet_id, position, dedupe_key) VALUES (?, ?, ?)");
    const insCell = db.prepare(
      "INSERT INTO cells (row_id, column_id, status, value_text, value_json) VALUES (?, ?, ?, ?, ?)",
    );
    const updCell = db.prepare(
      `UPDATE cells SET value_text = ?, value_json = ?, status = 'done', rev = rev + 1,
                        updated_at = datetime('now')
        WHERE row_id = ? AND column_id = ? AND pinned = 0`,
    );

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const { values, key } = ctx.resolved[i]!;
      const d = decide(ctx, target, key, seen);

      if (d.action === "skip") {
        note(item.sourceRowId, "skipped", d.reason);
        continue;
      }

      if (d.action === "update" && d.rowId != null) {
        const pins = ctx.pinned.get(d.rowId);
        for (const [colId, v] of values) {
          // The statement refuses a pinned cell anyway; stepping over it here keeps the live-update
          // bus from repainting a cell that did not change.
          if (pins?.has(colId)) continue;
          // value_json stays NULL. `values` is Map<number, string | null>, so JSON.stringify(v) was
          // writing a quoted second copy of the text and nothing more — measured at 113% of
          // value_text on the real database, i.e. the fan-out destination grew at roughly twice the
          // size it needed to. Every reader does `value_json ?? value_text` and parses with a text
          // fallback, so the column is only worth writing when it holds something the text does not.
          updCell.run(v, null, d.rowId, colId);
          dirty.push(cellId(d.rowId, colId));
        }
        result.targetRowIds.push(d.rowId);
        note(item.sourceRowId, "updated", null);
        continue;
      }

      // "insert" — either a genuinely new key, or the deliberate second row the insert policy asks
      // for when one already matches.
      const rowId = Number(insRow.run(target.targetSheetId, position++, key).lastInsertRowid);
      // Create every cell, not just the mapped ones — a row with holes breaks the grid's read path
      // and leaves nothing for a later run to target.
      for (const colId of ctx.targetColumnIds) {
        const v = values.get(colId);
        const isBackRef = target.backRefColumnId != null && colId === target.backRefColumnId;
        const text = isBackRef ? String(item.sourceRowId) : (v ?? null);
        // NULL value_json, for the same reason as the update above: `text` is already a string, so
        // stringifying it stored the same characters twice with quotes around one of them.
        insCell.run(rowId, colId, text != null ? "done" : "empty", text, null);
      }
      if (key != null) ctx.existing.set(key, rowId);
      result.targetRowIds.push(rowId);
      note(item.sourceRowId, "inserted", null);
    }
  });

  invalidateRowCount(target.targetSheetId);
  bumpDataVersion(target.targetSheetId);
  markSheetDirty(target.targetSheetId);
  /**
   * The rows are new, so every link that touches this table has a stale index.
   *
   * Without this, a send that fans a list out into another table left `relation_keys` describing the
   * table as it was BEFORE the send — and the two lanes that read a relation answered from it
   * without complaint. Measured: a per-item send wrote six committee rows, then `rollup` returned 0
   * for all five accounts and `lookup` returned empty for all six rows, both with `err=0`. Nothing
   * failed and nothing warned, because zero is a perfectly plausible count. A manual rebuild
   * reported `matched: 6, unmatched: 0` and the identical columns then answered correctly.
   *
   * That is the worst shape a defect can take here: a confident wrong number in front of somebody
   * deciding who to contact.
   *
   * Once per send rather than once per row, and only for links that actually involve this table.
   * It is a full reindex of those links, which is the honest cost of the rows having changed —
   * the same work `setMatchMode` already does for the same reason.
   */
  for (const rel of listRelations(target.targetSheetId)) rebuildRelationKeys(rel.id);
  markCellsDirty(dirty);
  return result;
}

/**
 * The back-reference column on a destination, if it is already there.
 *
 * Found, never created — a dry run that makes a column is not a dry run.
 */
export function findBackRefColumn(targetSheetId: string, sourceTableName: string): number | null {
  const name = `${sourceTableName} row`;
  const hit = listColumns(targetSheetId).find((c) => c.name === name);
  return hit ? Number(hit.id) : null;
}

/**
 * Ensure the target table has a back-reference column, creating it if needed.
 *
 * Called before a fan-out write so the relation exists in both directions from the first run —
 * retrofitting it later means the rows already written have no parent.
 *
 * The link is a plain text column holding the source row's id, not a database relation: deleting a
 * source row leaves the pointer behind, pointing at nothing. Making it a real relation needs a
 * column kind the schema does not have yet.
 */
export function ensureBackRefColumn(targetSheetId: string, sourceTableName: string): number {
  const existing = findBackRefColumn(targetSheetId, sourceTableName);
  if (existing != null) return existing;

  const name = `${sourceTableName} row`;

  const pos = Number(
    (db.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM columns WHERE sheet_id = ?").get(targetSheetId) as any).p,
  ) + 1;
  const id = Number(
    db
      .prepare("INSERT INTO columns (sheet_id, name, key, position, kind, value_type) VALUES (?, ?, ?, ?, 'static', 'text')")
      .run(targetSheetId, name, name.toLowerCase(), pos).lastInsertRowid,
  );
  backfillCells(targetSheetId, id);
  return id;
}

// ─────────────────────────────────────────────────────────── the send configuration

/**
 * A "send to another table" column, as stored.
 *
 * This started as a modal — pick a destination, press Send, done — and that shape was wrong for the
 * job. Sending rows somewhere is not a one-off command, it is a thing a column DOES: it belongs in
 * the dependency graph, it should re-send when the rows it reads change, and above all it should be
 * gateable by a run condition, so "send the qualified leads to the CRM table" is one setting rather
 * than a filter you have to remember to apply by hand every time. As a mode it inherits all of that
 * from the machinery every other column already uses, and costs nothing to run.
 */
export interface SendConfig {
  targetSheetId: string;
  /** One row there per row here, or one per item in a list column. */
  method: "row" | "per_item";
  /** For `per_item`: the column holding the list, and a path inside it when the list is nested. */
  listColumnId?: number;
  listPath?: string;
  /** targetColumnId -> where its value comes from. */
  mapping: Record<string, FieldSource>;
  keySource?: FieldSource;
  onConflict: ConflictPolicy;
  /** Write a column over there recording which row of this table each one came from. */
  withBackRef: boolean;
  /** Ceiling on what ONE row's list may produce. A 10,000-element array is a table, not a cell. */
  cap: number;
}

/**
 * The shipped default.
 *
 * `onConflict` is "insert" rather than "upsert" because the default carries NO match key, and with
 * no key every policy inserts — there is nothing to compare a row against. Storing "upsert" made the
 * config claim an idempotency it could not deliver, and the destination grew by the full row count
 * on every run while the settings screen said re-running would update in place. A default has to
 * describe what actually happens; the moment a match key is picked, "upsert" is the honest value and
 * the settings screen is where that choice belongs.
 */
export const DEFAULT_SEND: SendConfig = {
  targetSheetId: "",
  method: "row",
  mapping: {},
  onConflict: "insert",
  withBackRef: true,
  cap: 50,
};

/**
 * Refuse to write into a destination that is not there any more.
 *
 * A trashed table keeps its id, its columns and its rows, so every statement in this file succeeds
 * against it: the send reports "done" with no errors, creates a back-reference column inside the
 * trash, and puts the user's records somewhere they will never look. The preview route has always
 * checked this and the run did not, which is also half of why the two could disagree.
 *
 * Fail closed — a missing destination is a refusal, never a default.
 */
export function assertTargetExists(cfg: Pick<SendConfig, "targetSheetId">): void {
  if (!cfg.targetSheetId) {
    throw new Error("This column has no destination table set, so there is nothing to send to.");
  }
  if (!getSheet(cfg.targetSheetId)) {
    throw new Error(
      "The destination table this column sends to is in the trash, archived, or gone. Nothing was sent — " +
      "restore it, or pick a destination that is still there.",
    );
  }
}

/**
 * The rows a send is really allowed to write, and everything the caller must say about them.
 *
 * One helper for both entry points, because the preview and the run were answering the same question
 * in two places and getting different answers: the preview ignored the run condition and reported
 * four rows for a send that wrote two, and it checked the destination while the run did not.
 *
 * The run condition itself is a generated script, so it can only be evaluated by the runner. This
 * says so out loud rather than pretending: pass `conditionApplied` once the gate has narrowed the
 * rows, and leave it false to have the plan carry the caveat.
 */
export interface SendScope {
  /** The rows the write may be given. Empty whenever `errors` is non-empty. */
  rowIds: number[];
  /** Reasons not to write at all. */
  errors: string[];
  /** Reasons the numbers below are not the whole story. */
  warnings: string[];
}

export function resolveSendScope(
  cfg: SendConfig,
  rowIds: number[],
  opts: { conditionScriptId?: number | string | null; conditionApplied?: boolean } = {},
): SendScope {
  const scope: SendScope = { rowIds, errors: [], warnings: [] };

  try {
    assertTargetExists(cfg);
  } catch (e) {
    scope.errors.push(e instanceof Error ? e.message : String(e));
  }
  if (Object.keys(cfg.mapping ?? {}).length === 0) {
    scope.errors.push("Nothing is mapped, so this column would create empty rows over there.");
  }
  if (opts.conditionScriptId && !opts.conditionApplied) {
    scope.warnings.push(
      "This column has a run condition. It is not evaluated here, so the send itself may write fewer rows than this.",
    );
  }

  // Fail closed: a caller that renders the errors and writes anyway still writes nothing.
  if (scope.errors.length > 0) scope.rowIds = [];
  return scope;
}

/** What the per-row cap refused, so the caller can say "sent 50 of 140" instead of "sent 50". */
export interface BuildStats {
  /** Items the cap dropped, across every row. */
  dropped: number;
  /** Items the cap dropped, per source row. */
  droppedByRow: Map<number, number>;
  /** How many items each source row actually held, before the cap. */
  totalByRow: Map<number, number>;
}

export function emptyBuildStats(): BuildStats {
  return { dropped: 0, droppedByRow: new Map(), totalByRow: new Map() };
}

/**
 * Turn a set of source rows into write items.
 *
 * One implementation, used by both the column runner and the preview route — a preview produced by
 * different code than the write is a preview that can disagree with it, which is the exact failure
 * the whole dry-run design exists to prevent.
 *
 * Only the columns the mapping actually asks for are read. Reading every column of every row would
 * be the easy version and the wrong one: sending a wide sheet would pull thirty values per row to
 * use two of them, on a path whose whole job is to stay usable at fifty thousand rows.
 *
 * Pass `stats` to learn what the per-row cap threw away. Optional so the existing callers are
 * untouched, but a caller that reports a count to the user wants it: `.slice(0, cap)` drops the tail
 * in silence, and a cell reading "sent 50 rows" for a row that held 140 contacts is a number nobody
 * can tell is partial.
 */
export function buildWriteItems(cfg: SendConfig, rowIds: number[], stats?: BuildStats): WriteItem[] {
  if (rowIds.length === 0) return [];

  const wanted = new Set<number>();
  for (const src of Object.values(cfg.mapping)) {
    if (src && src.from === "row") wanted.add(Number(src.columnId));
  }
  // The match key is a value like any other. Not reading it here resolves it to null for every row,
  // which turns a careful upsert into a silent full duplication of the destination.
  if (cfg.keySource?.from === "row") wanted.add(Number(cfg.keySource.columnId));

  const rowValues = new Map<number, Record<string, string | null>>();
  if (wanted.size > 0) {
    const ids = [...wanted];
    // Read in slices and merge: one placeholder per row hits SQLite's 32,766-variable ceiling at
    // 32,766 rows, and a send is exactly the operation people point at a whole table.
    for (const slice of chunked(rowIds)) {
      for (const r of db
        .prepare(
          `SELECT row_id, column_id, value_text FROM cells
            WHERE row_id IN (${slice.map(() => "?").join(",")})
              AND column_id IN (${ids.map(() => "?").join(",")})`,
        )
        .all(...slice, ...ids) as any[]) {
        const bag = rowValues.get(Number(r.row_id)) ?? {};
        bag[String(r.column_id)] = r.value_text ?? null;
        rowValues.set(Number(r.row_id), bag);
      }
    }
  }

  // Row mode has no cell to explode: the row IS the item, and every mapped value comes off it.
  if (cfg.method === "row" || !cfg.listColumnId) {
    return rowIds.map((rowId) => ({ sourceRowId: rowId, value: null, rowValues: rowValues.get(rowId) }));
  }

  const cells: any[] = [];
  for (const slice of chunked(rowIds)) {
    cells.push(
      ...(db
        .prepare(
          `SELECT row_id, value_json, value_text FROM cells
            WHERE column_id = ? AND row_id IN (${slice.map(() => "?").join(",")})`,
        )
        .all(Number(cfg.listColumnId), ...slice) as any[]),
    );
  }

  const cap = Math.max(1, cfg.cap || 50);
  const items: WriteItem[] = [];
  for (const c of cells) {
    let parsed: unknown = c.value_text;
    try { parsed = JSON.parse(c.value_json ?? c.value_text); } catch { /* keep the raw text */ }
    if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { /* keep */ } }
    // The list is not always the whole cell. Resolved with the SAME path the field discovery used,
    // so what gets written cannot be a different list than the one whose fields were mapped.
    if (cfg.listPath) parsed = getPath(parsed, cfg.listPath);
    const rowId = Number(c.row_id);
    const bag = rowValues.get(rowId);
    const all = toList(parsed);
    const kept = all.slice(0, cap);
    if (stats) {
      stats.totalByRow.set(rowId, (stats.totalByRow.get(rowId) ?? 0) + all.length);
      const missed = all.length - kept.length;
      if (missed > 0) {
        stats.dropped += missed;
        stats.droppedByRow.set(rowId, (stats.droppedByRow.get(rowId) ?? 0) + missed);
      }
    }
    for (const item of kept) {
      // Every item from one row shares that row's values — which is the point: five contacts
      // exploded out of one company all carry that company.
      items.push({ sourceRowId: rowId, value: item, rowValues: bag });
    }
  }
  return items;
}

/**
 * The `WriteTarget` a config describes. Kept in one place so the runner and the preview agree.
 *
 * Guarded rather than trusting: this is the one chokepoint both entry points pass through, so the
 * destination check belongs here where neither can forget it.
 *
 * `sourceTableName` is what lets the plan include the back-reference column. Leave it out and the
 * preview describes a write with no link back — which is not the write the run performs.
 */
export function targetOf(cfg: SendConfig, sourceTableName?: string): WriteTarget {
  assertTargetExists(cfg);
  const target: WriteTarget = {
    targetSheetId: cfg.targetSheetId,
    mapping: cfg.mapping,
    keySource: cfg.keySource,
    onConflict: cfg.onConflict,
  };
  if (cfg.withBackRef && sourceTableName) {
    const id = findBackRefColumn(cfg.targetSheetId, sourceTableName);
    if (id != null) target.backRefColumnId = id;
  }
  return target;
}
