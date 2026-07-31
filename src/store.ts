// Sheet / column / row / cell persistence, and the grid's windowed read path.
//
// The read path is what has to hold up at a million rows: the client never receives the whole sheet,
// only a window. Two properties make that cheap —
//   1. rows are windowed by POSITION RANGE, not OFFSET (an OFFSET of 900,000 walks 900,000 index
//      entries; a range scan seeks straight to it), and
//   2. `cells` is clustered by (row_id, column_id), so a window's cells are physically contiguous.

import { createHash, randomUUID } from "node:crypto";
import { cellId, db, getKv, renumberColumns, setKv, tx } from "./db.ts";
import { markCellsDirty } from "./bus.ts";
import { parseRules } from "./validate.ts";
import { compileFilter, escapeLike, type FilterGroup } from "./filter.ts";
import { markColumnDirty, markSheetDirty } from "./columnStats.ts";
import { invalidateRedo } from "./undo.ts";
import { redactSecrets } from "./redact.ts";
import { DATE_TYPES, NUMERIC_TYPES } from "./types.ts";
import { lockReason } from "./columnLock.ts";
// A cycle — refs.ts imports normalizeKey from here — and a safe one: neither side touches the other
// at module-evaluation time, only from inside a function. See setColumnPrompt.
import { canonicalizeRefs } from "./refs.ts";
import type { Cell, CellStatus, Column, ColumnKind, Sheet, ValueType } from "./types.ts";

/** Normalized column key — what {{references}} resolve against. Must match on write and read. */
export const normalizeKey = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, " ");

// ─────────────────────────────────────────────────────────────── sheets

/**
 * A new table, and the workbook it lives in.
 *
 * The whole thing is ONE transaction. It was two bare inserts, so a failure between them — a disk
 * error, a constraint, a crash — left a workbook holding no table: a file in the browser that opens
 * onto nothing and that nothing can ever fill, because the table it was created for was never
 * written. Either both land or neither does.
 */
export function createSheet(name: string, workbookId?: string | null): Sheet {
  return tx(() => createSheetInner(name, workbookId));
}

function createSheetInner(name: string, workbookId?: string | null): Sheet {
  const id = randomUUID();

  /**
   * A table with no workbook gets one, here and now.
   *
   * The workspace model is folders hold files, files hold tables — so a "loose" table belongs
   * nowhere and, more to the point, is INVISIBLE: the browser lists folders and workbooks, and a
   * table filed under neither appears in no list at all. Boot fixed this after the fact, which
   * meant a table created from a running app stayed unreachable until the next restart. (Seen
   * live: two tables made by a script were nowhere in the file browser.)
   *
   * A fresh id rather than reusing the sheet's: they are different objects, and sharing an id would
   * make every "is this a workbook or a table" question ambiguous forever after.
   */
  let wb = workbookId ?? null;
  if (!wb) {
    wb = randomUUID();
    db.prepare("INSERT INTO workbooks (id, name) VALUES (?, ?)").run(wb, name);
  }

  // Placed after the last sheet of whichever set it joins, so the tab bar's order is the order
  // sheets were made rather than whatever the id happened to sort as.
  const row = db
    .prepare("SELECT COALESCE(MAX(position), -1) AS p FROM sheets WHERE workbook_id = ?")
    .get(wb) as any;
  const pos = Number(row.p) + 1;
  db.prepare("INSERT INTO sheets (id, name, workbook_id, position) VALUES (?, ?, ?, ?)")
    .run(id, name, wb, pos);
  return getSheet(id)!;
}

/**
 * The sheets that share a tab bar with this one.
 *
 * A sheet in a workbook sits beside the rest of that workbook. A sheet in no workbook sits beside
 * the other loose sheets — which is the honest reading of "no workbook" and means the tab bar is
 * never empty, rather than a workbook being something you have to know to create first.
 */
export function listSiblingSheets(sheetId: string): Sheet[] {
  const r = db.prepare("SELECT workbook_id FROM sheets WHERE id = ?").get(sheetId) as any;
  if (!r) return [];
  const where = r.workbook_id ? "s.workbook_id = ?" : "s.workbook_id IS NULL";
  const args = r.workbook_id ? [r.workbook_id] : [];
  return (
    db.prepare(`${sheetSelect} WHERE ${where} AND ${SHEET_VISIBLE} ORDER BY s.position, s.created_at`).all(...args) as any[]
  ).map(toSheet);
}

/** Move a sheet to a new place in its tab bar. Positions are rewritten densely, as with columns. */
export function moveSheet(sheetId: string, toIndex: number): void {
  const order = listSiblingSheets(sheetId).map((s) => s.id);
  const from = order.indexOf(sheetId);
  if (from < 0) return;
  tx(() => {
    order.splice(from, 1);
    order.splice(Math.max(0, Math.min(order.length, toIndex)), 0, sheetId);
    const set = db.prepare("UPDATE sheets SET position = ? WHERE id = ?");
    order.forEach((id, i) => set.run(i, id));
  });
}

/**
 * Copy a sheet's SHAPE, and optionally its rows.
 *
 * Structure-only is the default because it is what "duplicate this table" nearly always means in a
 * tool like this — the same columns pointed at a different set of rows. Copying a million rows on a
 * menu click, silently, is the version nobody wants and cannot undo quickly.
 */
export function duplicateSheet(sheetId: string, opts: { withRows?: boolean } = {}): Sheet | null {
  const src = getSheet(sheetId);
  if (!src) return null;
  const wb = (db.prepare("SELECT workbook_id FROM sheets WHERE id = ?").get(sheetId) as any)?.workbook_id ?? null;

  return tx(() => {
    const copy = createSheet(`${src.name} (copy)`, wb);
    const cols = listColumns(sheetId);
    const map = new Map<number, number>();
    for (const c of cols) {
      // Every definition travels: a duplicate that loses its prompts, requests and derivations is a
      // blank sheet with familiar headings.
      const next = addColumn(copy.id, { name: c.name, kind: c.kind, valueType: c.valueType, position: c.position });
      map.set(Number(c.id), Number(next.id));
      // send_config and the two script hooks travel with everything else. Left behind, a copied
      // `send` column has no destination and errors on every row, and a copied gated column loses
      // the run condition that is the only thing standing between it and spending on all of them.
      db.prepare(
        `UPDATE columns SET prompt = (SELECT prompt FROM columns WHERE id = ?),
                            model = (SELECT model FROM columns WHERE id = ?),
                            http_config = (SELECT http_config FROM columns WHERE id = ?),
                            agent_json = (SELECT agent_json FROM columns WHERE id = ?),
                            json_schema = (SELECT json_schema FROM columns WHERE id = ?),
                            enum_values = (SELECT enum_values FROM columns WHERE id = ?),
                            frozen = (SELECT frozen FROM columns WHERE id = ?),
                            auto_run = (SELECT auto_run FROM columns WHERE id = ?),
                            send_config = (SELECT send_config FROM columns WHERE id = ?),
                            condition_script_id = (SELECT condition_script_id FROM columns WHERE id = ?),
                            transform_script_id = (SELECT transform_script_id FROM columns WHERE id = ?)
          WHERE id = ?`,
      ).run(c.id, c.id, c.id, c.id, c.id, c.id, c.id, c.id, c.id, c.id, c.id, Number(next.id));
    }
    // Derivations are rewritten to point INSIDE the copy. Left alone they would point at the
    // original's columns, so editing the copy would silently rewrite the original's children.
    for (const c of cols) {
      const src2 = db.prepare("SELECT source_column_id, json_path FROM columns WHERE id = ?").get(c.id) as any;
      if (!src2?.source_column_id) continue;
      const mappedSource = map.get(Number(src2.source_column_id));
      if (mappedSource == null) continue;
      db.prepare("UPDATE columns SET source_column_id = ?, json_path = ? WHERE id = ?")
        .run(mappedSource, src2.json_path, map.get(Number(c.id))!);
    }

    if (opts.withRows) {
      const ids = [...map.values()];
      const srcCols = [...map.keys()];
      let pos = 0;
      const insRow = db.prepare("INSERT INTO rows (sheet_id, position, dedupe_key) VALUES (?, ?, ?)");
      const insCell = db.prepare(
        "INSERT INTO cells (row_id, column_id, status, value_text, value_json) VALUES (?, ?, ?, ?, ?)",
      );
      for (const r of db.prepare("SELECT id, dedupe_key FROM rows WHERE sheet_id = ? ORDER BY position").all(sheetId) as any[]) {
        const rowId = Number(insRow.run(copy.id, pos++, r.dedupe_key ?? null).lastInsertRowid);
        const cells = db.prepare("SELECT column_id, status, value_text, value_json FROM cells WHERE row_id = ?").all(r.id) as any[];
        const byCol = new Map(cells.map((c) => [Number(c.column_id), c]));
        srcCols.forEach((srcId, i) => {
          const cell = byCol.get(srcId);
          insCell.run(rowId, ids[i]!, cell?.status ?? "empty", cell?.value_text ?? null, cell?.value_json ?? null);
        });
      }
      invalidateRowCount(copy.id);
    }

    return getSheet(copy.id);
  });
}

// No correlated COUNT(*) over `rows` here.
//
// It cost ~22ms per sheet on a million-row table, uncached, on a statement the app runs constantly —
// every sheet read, every list, every tab bar. `countRows` maintains the authoritative number in
// memory (this process is the single writer) and every path that changes row cardinality already
// invalidates it, so paying for the count again in SQL was buying a number the process already had.
const sheetSelect = `
  SELECT s.id, s.name, s.workbook_id, s.created_at, s.updated_at, s.budget_usd
    FROM sheets s`;

/**
 * A sheet is hidden if it is archived OR trashed. Two flags, because they mean different things —
 * `archived` is "put away", `deleted_at` is "sent to the trash and recoverable" — but every list the
 * user sees has to exclude both. This existed as `archived = 0` alone, so a trashed table kept
 * appearing in the sheet list as though `trashTable` had done nothing.
 */
const SHEET_VISIBLE = "s.archived = 0 AND s.deleted_at IS NULL";

function toSheet(r: any): Sheet {
  return {
    id: r.id, name: r.name, rowCount: countRows(String(r.id)),
    workbookId: r.workbook_id ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at,
    budgetUsd: r.budget_usd ?? null,
  };
}

export function getSheet(id: string): Sheet | null {
  const r = db.prepare(`${sheetSelect} WHERE s.id = ? AND ${SHEET_VISIBLE}`).get(id) as any;
  return r ? toSheet(r) : null;
}

export function listSheets(): Sheet[] {
  return (db.prepare(`${sheetSelect} WHERE ${SHEET_VISIBLE} ORDER BY s.updated_at DESC`).all() as any[]).map(toSheet);
}

export function renameSheet(id: string, name: string): void {
  db.prepare("UPDATE sheets SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name, id);
}

export function deleteSheet(id: string): void {
  db.prepare("DELETE FROM sheets WHERE id = ?").run(id);
  invalidateRowCount(id);
}

// ─────────────────────────────────────────────────────────────── columns

export interface NewColumn {
  name: string;
  kind?: ColumnKind;
  valueType?: ValueType;
  position?: number;
}

export function addColumn(sheetId: string, input: NewColumn): Column {
  return tx(() => {
    // A key collision would make {{Name}} ambiguous, so resolve it at creation rather than letting a
    // reference silently bind to the wrong column later.
    //
    // Deleted columns count. They are soft-deleted — undo restores them with their key intact — and
    // the UNIQUE(sheet_id, key) index covers them like any other row. Reading only the live ones
    // meant the dedupe skipped past a live "Industry" to "Industry (3)", collided with a deleted
    // column nobody could see, and the whole insert failed with a constraint error surfaced raw to
    // whoever clicked "Create".
    const taken = new Set(
      (db.prepare("SELECT key FROM columns WHERE sheet_id = ?").all(sheetId) as any[]).map((r) => r.key),
    );
    let finalName = input.name;
    let n = 2;
    while (taken.has(normalizeKey(finalName))) {
      finalName = `${input.name} (${n})`;
      n++;
    }

    const pos =
      input.position ??
      Number((db.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM columns WHERE sheet_id = ?").get(sheetId) as any).p) + 1;

    const res = db
      .prepare(
        `INSERT INTO columns (sheet_id, name, key, position, kind, value_type)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sheetId, finalName, normalizeKey(finalName), pos, input.kind ?? "static", input.valueType ?? "text");

    const id = Number(res.lastInsertRowid);
    // Every existing row needs a cell for the new column, or the grid has holes and a run has
    // nothing to target.
    backfillCells(sheetId, id);
    return getColumn(id)!;
  });
}

/** A malformed blob must not take the whole column down — it degrades to defaults. */
function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return undefined; }
}

function toColumn(r: any): Column {
  return {
    id: String(r.id), sheetId: r.sheet_id, name: r.name, key: r.key, position: r.position,
    kind: r.kind, valueType: r.value_type,
    enumValues: r.enum_values ? JSON.parse(r.enum_values) : undefined,
    jsonSchema: r.json_schema ? JSON.parse(r.json_schema) : undefined,
    description: r.description ?? undefined,
    prompt: r.prompt ?? undefined,
    promptVersion: r.prompt_version,
    model: r.model, firstModel: r.first_model || undefined, maxTurns: r.max_turns, maxBudgetUsd: r.max_budget_usd, timeoutMs: r.timeout_ms,
    allowedTools: JSON.parse(r.allowed_tools ?? "[]"),
    mcpServers: JSON.parse(r.mcp_servers ?? "[]"),
    agent: r.agent_json ? safeJson(r.agent_json) : undefined,
    httpConfig: r.http_config ? safeJson(r.http_config) : undefined,
    mcpConfig: r.mcp_config ? safeJson(r.mcp_config) : undefined,
    sendConfig: r.send_config ? safeJson(r.send_config) : undefined,
    waterfall: r.waterfall_json ?? null,
    rateLimitPerMin: Number(r.rate_limit_per_min ?? 0),
    // Parsed here rather than at each of the three enforcement points, so a corrupt blob degrades to
    // "no rules" once instead of throwing in whichever of them happens to read it first.
    validation: parseRules(r.validation) ?? undefined,
    waitSeconds: Number(r.wait_seconds ?? 0),
    conditionScriptId: r.condition_script_id != null ? String(r.condition_script_id) : undefined,
    transformScriptId: r.transform_script_id != null ? String(r.transform_script_id) : undefined,
    onUpstreamEmpty: r.on_upstream_empty, onUpstreamError: r.on_upstream_error,
    autoRecompute: !!r.auto_recompute,
    autoRun: !!r.auto_run,
    autoRunBudgetUsd: r.auto_run_budget_usd == null ? null : Number(r.auto_run_budget_usd),
    frozen: !!r.frozen,
    width: r.width == null ? null : Number(r.width),
    color: r.color ?? null,
    // How a lookup or rollup column reads across a link. Without these the editor cannot show which
    // link is selected — it would open on "nothing chosen" for a column that is fully configured.
    relationId: r.relation_id == null ? null : Number(r.relation_id),
    lookupColumnId: r.lookup_column_id == null ? null : Number(r.lookup_column_id),
    rollup: r.rollup ? safeJson(r.rollup) : undefined,
    /**
     * What this column is a projection OF, when it is one.
     *
     * Read off the row since the first version of expand-into-columns and never handed to the
     * client, so the grid had no way to know a column was derived — which is why it happily opened
     * an editor over one, and why a typed value there vanished from its source forever with nothing
     * on screen to say it had.
     */
    sourceColumnId: r.source_column_id == null ? null : Number(r.source_column_id),
    jsonPath: r.json_path ?? null,
    /**
     * Whether this column takes typed-in values, and the sentence to show when it does not.
     *
     * Computed HERE rather than re-derived in the browser, and that is the point: the server is what
     * enforces it. A client with its own copy of the rule eventually disagrees with this one, and
     * the failure mode is precisely the phantom edit — a cell that accepts a keystroke, shows the
     * value, and is refused on the way to the database. It also needs the source column's NAME,
     * which the browser would have to go and look up.
     */
    editable: lockReason(lockable(r)) === null,
    lockedReason: lockReason(lockable(r), sourceColumnName(r)),
  } as Column;
}

/** The shape `lockReason` wants, from a raw database row. */
function lockable(r: any) {
  return {
    kind: r.kind,
    sourceColumnId: r.source_column_id ?? null,
    jsonPath: r.json_path ?? null,
    transformScriptId: r.transform_script_id ?? null,
  };
}

/**
 * The name of the column this one is derived from, for the reason sentence.
 *
 * One extra read, and only on a derived column — the `if` is what keeps this off the hot path, since
 * `toColumn` runs for every column of every sheet listing. Falls back to no name rather than
 * throwing: a source column that has since been deleted leaves a child that is still a projection,
 * and "pulled out of another column" is a worse sentence than a named one but a much better one than
 * a crash.
 */
function sourceColumnName(r: any): string | null {
  if (r.source_column_id == null) return null;
  const src = db.prepare("SELECT name FROM columns WHERE id = ?").get(Number(r.source_column_id)) as any;
  return src?.name ?? null;
}

/**
 * Copy a column, definition and all, and put the copy directly to its right.
 *
 * "Duplicate" has to mean the whole column, not its name: a research column carries an instruction,
 * a model, a request, search settings and a run condition, and a copy missing any of those is a
 * column that looks the same and behaves differently — which is worse than no copy at all.
 *
 * No NEW generated code is minted here. A script is approved by the hash of its exact bytes, and
 * writing a fresh copy of one would either carry an approval nobody granted the copy or leave it
 * unapproved and silently inert. So the hooks travel as POINTERS to the same reviewed script: the
 * bytes a human read are the bytes that run, and the copy is gated exactly as the original is.
 * Dropping the pointers — which is what this did — meant a duplicated gated column ran with no
 * condition at all and spent on every row, which is the failure the gate exists to prevent.
 *
 * Values are not copied either — the copy is a definition, and it runs to fill itself.
 */
export function duplicateColumn(id: number | string): Column | null {
  const src = getColumn(id);
  if (!src) return null;
  return tx(() => {
    const made = addColumn(src.sheetId, {
      name: `${src.name} copy`,
      kind: src.kind,
      valueType: src.valueType,
    });
    db.prepare(
      `UPDATE columns
          SET prompt = ?, model = ?, max_turns = ?, max_budget_usd = ?, timeout_ms = ?,
              allowed_tools = ?, mcp_servers = ?, agent_json = ?, http_config = ?, mcp_config = ?,
              enum_values = ?, json_schema = ?, description = ?, format = ?, width = ?,
              on_upstream_empty = ?, on_upstream_error = ?, auto_recompute = ?,
              send_config = ?, condition_script_id = ?, transform_script_id = ?,
              auto_run = ?, auto_run_budget_usd = ?, frozen = ?
        WHERE id = ?`,
    ).run(
      src.prompt ?? null,
      src.model,
      src.maxTurns,
      src.maxBudgetUsd,
      src.timeoutMs,
      JSON.stringify(src.allowedTools ?? []),
      JSON.stringify(src.mcpServers ?? []),
      src.agent ? JSON.stringify(src.agent) : null,
      src.httpConfig ? JSON.stringify(src.httpConfig) : null,
      // Without this a duplicated MCP column keeps its lane and loses the tool it called, so it
      // looks identical and skips every row.
      src.mcpConfig ? JSON.stringify(src.mcpConfig) : null,
      src.enumValues ? JSON.stringify(src.enumValues) : null,
      src.jsonSchema ? JSON.stringify(src.jsonSchema) : null,
      src.description ?? null,
      null,
      null,
      src.onUpstreamEmpty,
      src.onUpstreamError,
      src.autoRecompute ? 1 : 0,
      // The destination, the cost gate and the transform. A copy missing the first errors on every
      // row; a copy missing the second spends on every row.
      src.sendConfig ? JSON.stringify(src.sendConfig) : null,
      src.conditionScriptId != null ? Number(src.conditionScriptId) : null,
      src.transformScriptId != null ? Number(src.transformScriptId) : null,
      // All three are part of "this column behaves the same": an auto-run column whose copy does not
      // auto-run looks identical and quietly never fills itself, and a copy that kept the switch but
      // dropped the ceiling looks identical and quietly spends without one.
      src.autoRun ? 1 : 0,
      src.autoRunBudgetUsd ?? null,
      src.frozen ? 1 : 0,
      Number(made.id),
    );
    // Beside the original, not at the far right of a thirty-column sheet where you would have to go
    // looking for it.
    const order = listColumns(src.sheetId).map((c) => Number(c.id));
    moveColumn(made.id, Math.min(order.indexOf(Number(src.id)) + 1, order.length - 1));
    return getColumn(made.id);
  });
}

export function setColumnDescription(id: number | string, description: string | null): void {
  db.prepare("UPDATE columns SET description = ?, updated_at = datetime('now') WHERE id = ?")
    .run(description && description.trim() ? description.trim() : null, Number(id));
}

export function getColumn(id: number | string): Column | null {
  const r = db.prepare("SELECT * FROM columns WHERE id = ?").get(Number(id)) as any;
  return r ? toColumn(r) : null;
}

export function listColumns(sheetId: string): Column[] {
  return (db.prepare("SELECT * FROM columns WHERE sheet_id = ? AND deleted_at IS NULL ORDER BY position").all(sheetId) as any[]).map(toColumn);
}

/** Renaming is safe for references because prompts store column IDs, never names. */
export function renameColumn(id: number | string, name: string): void {
  const col = getColumn(id);
  if (!col) return;
  const key = normalizeKey(name);
  // Deleted columns are included on purpose: the delete is SOFT and UNIQUE(sheet_id, key) covers
  // them like any other row, so skipping them here would only move the failure to a raw constraint
  // error. What it must not do is name a column the user cannot see — "A column named X already
  // exists" over an empty sheet reads as a bug in the app rather than as something to act on.
  const clash = db
    .prepare("SELECT deleted_at FROM columns WHERE sheet_id = ? AND key = ? AND id <> ?")
    .get(col.sheetId, key, Number(id)) as { deleted_at?: string | null } | undefined;
  if (clash) {
    throw new Error(
      clash.deleted_at
        ? `A deleted column is still using the name "${name}". Undo its deletion to see it, or pick another name.`
        : `A column named "${name}" already exists in this sheet.`,
    );
  }
  db.prepare("UPDATE columns SET name = ?, key = ?, updated_at = datetime('now') WHERE id = ?")
    .run(name, key, Number(id));
}

/**
 * Change a column's declared data type.
 *
 * This bumps `prompt_version`, which is part of every cell's input hash — so the values already in
 * the column are correctly treated as produced under a different contract rather than silently
 * re-used. Changing a column from text to number does not re-coerce what is already there; it means
 * the NEXT run validates against the new type.
 */
export function setColumnValueType(id: number | string, valueType: ValueType): void {
  db.prepare(
    "UPDATE columns SET value_type = ?, prompt_version = prompt_version + 1, updated_at = datetime('now') WHERE id = ?",
  ).run(valueType, Number(id));
}

/**
 * Change how a column gets its value — the lane it runs on.
 *
 * `prompt_version` is bumped because the lane is part of what produces a value: the same rule run as
 * a plain model call and as a web-searching agent are different work with different answers, and a
 * cached "unchanged input" check that ignored the lane would skip the re-run entirely.
 */
export function setColumnKind(id: number | string, kind: ColumnKind): void {
  db.prepare(
    "UPDATE columns SET kind = ?, prompt_version = prompt_version + 1, updated_at = datetime('now') WHERE id = ?",
  ).run(kind, Number(id));
}

/**
 * Set the model a column runs on. "auto" follows the engine default.
 *
 * Bumps `prompt_version` for the same reason the lane does: the same prompt on a different model is
 * different work with a different answer and a different price, so an "inputs unchanged" check that
 * ignored the model would skip the re-run after you deliberately switched.
 */
/**
 * The cheap model tried before the column's own, or empty to turn that off.
 *
 * Bumps prompt_version like the model does, and for the same reason: the answer a row would get has
 * changed, so a cell computed under the old setting is no longer 'unchanged' and must not be skipped
 * by the freshness check on the next run.
 */
export function setColumnFirstModel(id: number | string, model: string): void {
  db.prepare(
    "UPDATE columns SET first_model = ?, prompt_version = prompt_version + 1, updated_at = datetime('now') WHERE id = ?",
  ).run(model.trim() || null, Number(id));
}

export function setColumnModel(id: number | string, model: string): void {
  db.prepare(
    "UPDATE columns SET model = ?, prompt_version = prompt_version + 1, updated_at = datetime('now') WHERE id = ?",
  ).run(model, Number(id));
}

/**
 * Set the instruction an `ai` or `agent` column runs on every row.
 *
 * This had no writer at all: the executor read `prompt`, skipped the cell when it was empty, and
 * nothing in the app could ever fill it — so every model column reported "This column has no prompt
 * yet" forever. The lane was finished and the one field it needs was unreachable.
 *
 * Bumps `prompt_version` for the same reason the lane and the model do: it is the largest single
 * input to what a cell produces, so an "inputs unchanged" check that ignored it would skip the
 * re-run right after the instruction was rewritten.
 */
/**
 * Save an instruction, with its references turned into real ones.
 *
 * refs.ts opens by saying a hand-typed `{{Column Name}}` is "still accepted on save and rewritten to
 * the id form, so a pasted prompt from elsewhere works". It was not, on this path: the only caller
 * of `canonicalizeRefs` in the whole engine was the template importer, so an ordinary prompt was
 * stored exactly as typed and sent exactly as typed. `{{Website}}` and `/Website` both reached the
 * model as those literal characters, on every row, with nothing on screen saying so — the comment
 * described a protection that existed for one code path and not for the one people use.
 *
 * refs.ts imports `normalizeKey` from this module, so the two form a cycle. It is a safe one: each
 * side only reaches the other from inside a function, never while the module is being evaluated.
 */
export function setColumnPrompt(id: number | string, prompt: string): void {
  const col = db.prepare("SELECT sheet_id FROM columns WHERE id = ?").get(Number(id)) as
    | { sheet_id: string }
    | undefined;
  const text = col && prompt.trim() ? canonicalizeRefs(prompt, col.sheet_id) : prompt;
  db.prepare(
    "UPDATE columns SET prompt = ?, prompt_version = prompt_version + 1, updated_at = datetime('now') WHERE id = ?",
  ).run(text.trim() ? text : null, Number(id));
}

/**
 * Which tools this column's agent may call, by EXACT name.
 *
 * Bumps prompt_version, like the model and the instruction do: an agent that can suddenly search the
 * web answers a different question than one that could not, so cells computed before the change are
 * not 'unchanged' and must not be skipped by the freshness check on the next run.
 *
 * Never a wildcard. The list is the whole permission, and 'everything this build happens to ship'
 * would silently widen every existing column the day a tool is added.
 */
export function setColumnAllowedTools(id: number | string, tools: string[]): void {
  db.prepare(
    "UPDATE columns SET allowed_tools = ?, prompt_version = prompt_version + 1, updated_at = datetime('now') WHERE id = ?",
  ).run(JSON.stringify(tools), Number(id));
}

/**
 * Which connected apps this column's agent may reach.
 *
 * The companion to `allowedTools`, and the same reasoning applies twice over: an agent handed a
 * lookup app answers a different question than one working from memory, so the bump is not optional.
 *
 * This field existed on every column from the first migration — stored, duplicated, carried through
 * templates and workbook exports — and nothing ever wrote it or read it. It was dead plumbing until
 * there was a client behind it.
 */
export function setColumnMcpServers(id: number | string, serverIds: string[]): void {
  db.prepare(
    "UPDATE columns SET mcp_servers = ?, prompt_version = prompt_version + 1, updated_at = datetime('now') WHERE id = ?",
  ).run(JSON.stringify(serverIds), Number(id));
}

/**
 * Whether this column runs itself when a row's upstream values change.
 *
 * Off by default, and available to any column including one that bills per row. Refusing it
 * outright on a paid lane is the wrong shape of protection: importing a list and watching the
 * enrichment fill itself is the whole reason anyone turns this on, and a tool that cannot do it is
 * worse than the ones it replaces at the one job people came for.
 *
 * What bounds the bill instead is `setColumnAutoRunBudget` below. The switch is per column and
 * flipped by hand, which is the deliberate act; the ceiling is what keeps the deliberate act from
 * becoming an open-ended one months later, when an import lands and the person who flipped it is
 * not in the room.
 */
export function setColumnAutoRun(id: number | string, on: boolean): void {
  db.prepare("UPDATE columns SET auto_run = ?, updated_at = datetime('now') WHERE id = ?")
    .run(on ? 1 : 0, Number(id));
}

/**
 * The ceiling on ONE CELL of this column, in dollars.
 *
 * Bumps nothing. Unlike the model or the instruction, a spending limit does not change the answer a
 * cell would produce, so cells computed under the old limit are still current and must not be
 * re-run by the freshness check. Raising a limit to unblock a refused cell would otherwise re-bill
 * every cell that was already fine.
 *
 * `0` means no cap. That is `agent/executor.ts`'s existing reading of the field and this function
 * does not get to disagree with it.
 */
export function setColumnMaxBudget(id: number | string, usd: number): void {
  db.prepare("UPDATE columns SET max_budget_usd = ?, updated_at = datetime('now') WHERE id = ?")
    .run(usd, Number(id));
}

/**
 * The ceiling on one auto-run firing, in dollars. Null removes it.
 *
 * Deliberately NOT validated here — the route rejects a negative or non-numeric value before it
 * arrives, and a store function that silently repaired a bad number would hide the bug that sent it.
 *
 * Null is a real choice, not an oversight, so it is stored as one. A column set to fill itself with
 * no ceiling is a thing a person can mean; what matters is that they were shown the consequence when
 * they chose it.
 */
export function setColumnAutoRunBudget(id: number | string, usd: number | null): void {
  db.prepare("UPDATE columns SET auto_run_budget_usd = ?, updated_at = datetime('now') WHERE id = ?")
    .run(usd, Number(id));
}

/**
 * Move a column to a new place in the order.
 *
 * Positions are rewritten densely for the whole sheet rather than nudged, because they do not start
 * dense: a column created at position 0 by a webhook shifts everything else, deletes leave gaps, and
 * an insert-between scheme built on gaps eventually runs out of room between two neighbours and
 * silently stops moving. A sheet has tens of columns, so rewriting all of them is one cheap
 * statement per column and cannot drift.
 *
 * `toIndex` is a position in the VISIBLE order, which is what the drag reports.
 */
export function moveColumn(id: number | string, toIndex: number): void {
  const col = getColumn(id);
  if (!col) return;
  tx(() => {
    const order = listColumns(col.sheetId).map((c) => Number(c.id));
    const from = order.indexOf(Number(id));
    if (from < 0) return;
    order.splice(from, 1);
    order.splice(Math.max(0, Math.min(order.length, toIndex)), 0, Number(id));
    // Through renumberColumns, not a direct loop: the positions being written overlap the ones
    // being read, and `ux_columns_sheet_pos` rejects the collision that creates. Moving the last
    // column to the front assigns it 0 while the current first column is still there.
    renumberColumns(order.map((cid, i) => [cid, i] as const));
    // ONLY the column that moved. Bumping every column of the sheet was the obvious reading of "the
    // order changed, so they all changed", and it is expensive in a way that is not obvious:
    // `updated_at` is part of the per-cell input fingerprint the run engine hashes to decide whether
    // a row still needs paying for, so reordering one column threw away the skip for every cell on
    // the table. The direction was safe — it recomputes rather than wrongly skipping — but it
    // quietly undid the saving on the operation people do most casually.
    db.prepare(`UPDATE columns SET updated_at = datetime('now') WHERE id = ?`).run(Number(id));
  });
}

/** Pin a column to the left of the grid, or unpin it. */
/**
 * How wide this column is drawn.
 *
 * Presentation, but PERSISTED presentation. Width lived only in React state: widening a column held
 * until the next reload and then silently went back, which from the outside is indistinguishable
 * from the control not working. `columns.width` has been in the schema since the first phase and
 * nothing ever wrote it.
 *
 * Clamped here rather than trusted, because this is reachable from a route: a width of 0 hides a
 * column with no way to find it again, and one of 90,000 pushes every other column off screen.
 */
export function setColumnWidth(id: number | string, width: number | null): void {
  const w = width == null ? null : Math.max(72, Math.min(1200, Math.round(Number(width) || 0)));
  db.prepare("UPDATE columns SET width = ?, updated_at = datetime('now') WHERE id = ?").run(w, Number(id));
}

/** A colour for this column — a token NAME, never a hex value. See the note on Column.color. */
export function setColumnColor(id: number | string, color: string | null): void {
  const v = color && String(color).trim() ? String(color).trim().slice(0, 24) : null;
  db.prepare("UPDATE columns SET color = ?, updated_at = datetime('now') WHERE id = ?").run(v, Number(id));
}

export function setColumnFrozen(id: number | string, frozen: boolean): void {
  db.prepare("UPDATE columns SET frozen = ?, updated_at = datetime('now') WHERE id = ?").run(frozen ? 1 : 0, Number(id));
}

/** Replace a column's HTTP request definition. */
export function setColumnHttpConfig(id: number | string, cfg: Record<string, unknown> | null): void {
  db.prepare("UPDATE columns SET http_config = ?, prompt_version = prompt_version + 1, updated_at = datetime('now') WHERE id = ?")
    .run(cfg ? JSON.stringify(cfg) : null, Number(id));
}

/**
 * Replace a column's MCP call definition.
 *
 * Bumps `prompt_version` like the HTTP one: pointing a column at a different tool, or mapping a
 * different column into an argument, changes the question being asked — so cells answered under the
 * old definition are not "unchanged" and must not be skipped as such.
 */
export function setColumnMcpConfig(id: number | string, cfg: Record<string, unknown> | null): void {
  db.prepare("UPDATE columns SET mcp_config = ?, prompt_version = prompt_version + 1, updated_at = datetime('now') WHERE id = ?")
    .run(cfg ? JSON.stringify(cfg) : null, Number(id));
}

/**
 * Replace a `send` column's destination.
 *
 * Bumps `prompt_version` like the request definition does, because it changes what a run of this
 * column WRITES — cells produced under the old destination are no longer a description of what
 * would happen now, and the input hash has to say so.
 */
export function setColumnSendConfig(id: number | string, cfg: Record<string, unknown> | null): void {
  db.prepare("UPDATE columns SET send_config = ?, prompt_version = prompt_version + 1, updated_at = datetime('now') WHERE id = ?")
    .run(cfg ? JSON.stringify(cfg) : null, Number(id));
}

/**
 * Replace a column's waterfall. Passing null clears it.
 *
 * `prompt_version` is bumped for the same reason `send_config` bumps it: the steps ARE the rule this
 * column's values were produced from, so changing them has to invalidate every cell's input hash.
 * Without the bump, adding a provider to a waterfall and re-running would skip every row as
 * unchanged — the column would look re-run and nothing would have moved.
 */
export function setColumnWaterfall(id: number | string, json: string | null): void {
  db.prepare("UPDATE columns SET waterfall_json = ?, prompt_version = prompt_version + 1, updated_at = datetime('now') WHERE id = ?")
    .run(json, Number(id));
}

/**
 * Replace a column's agent settings. Passing null clears them back to the defaults.
 *
 * Bumps `prompt_version` for the same reason `setColumnAllowedTools` does. A column allowed one
 * search per cell did not answer the same question as one allowed six, and narrowing the domain list
 * changes what it was allowed to read — so cells computed under the old settings are not "unchanged"
 * and must not be skipped as such on the next run.
 */
export function setColumnAgent(id: number | string, agent: Record<string, unknown> | null): void {
  db.prepare("UPDATE columns SET agent_json = ?, prompt_version = prompt_version + 1, updated_at = datetime('now') WHERE id = ?")
    .run(agent ? JSON.stringify(agent) : null, Number(id));
}

/**
 * Delete a column — SOFT, so it can come back.
 *
 * This was a hard DELETE, which on a million-row sheet destroyed a million values behind a single
 * confirm dialog with no way back. The flag makes the reverse one UPDATE, at any scale, because the
 * cells are never touched: every read that enumerates a sheet's columns already excludes deleted
 * ones, so the column is gone everywhere it matters — including run scopes, which is the one that
 * would otherwise keep spending on a column the user removed.
 */
export function deleteColumn(id: number | string): void {
  const col = getColumn(id);
  if (!col) return;
  db.prepare("UPDATE columns SET deleted_at = datetime('now') WHERE id = ?").run(Number(id));
  // A free-text search matches over the sheet's LIVE columns, so removing one changes which rows a
  // view contains. Without this the materialized index goes on answering from before the delete.
  bumpDataVersion(col.sheetId);
}

/** Permanently remove soft-deleted columns and their cells. Nothing calls this on a user path yet. */
export function purgeDeletedColumns(sheetId: string): number {
  const ids = (db
    .prepare("SELECT id FROM columns WHERE sheet_id = ? AND deleted_at IS NOT NULL")
    .all(sheetId) as any[]).map((r) => Number(r.id));
  if (ids.length === 0) return 0;
  const holes = ids.map(() => "?").join(",");
  tx(() => {
    db.prepare(`DELETE FROM cells WHERE column_id IN (${holes})`).run(...ids);
    db.prepare(`DELETE FROM columns WHERE id IN (${holes})`).run(...ids);
  });
  return ids.length;
}

/** Create the missing cells for one column across every row of its sheet. */
export function backfillCells(sheetId: string, columnId: number): number {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO cells (row_id, column_id, status)
       SELECT r.id, ?, 'empty' FROM rows r WHERE r.sheet_id = ?`,
    )
    .run(columnId, sheetId);
  markColumnDirty(columnId);
  return Number(res.changes ?? 0);
}

// ─────────────────────────────────────────────────────────────── rows

/**
 * Bulk row insert, called by CSV import in batches inside one transaction.
 *
 * `values` maps columnId -> raw text. Row ids are assigned by SQLite (INTEGER PK), so the cells for
 * a row are written immediately after it and land contiguously in the clustered cells table.
 *
 * It wraps ITSELF, rather than trusting every caller to. The import does open a transaction of its
 * own, but the "add rows" route called this bare — so a hundred rows times thirty columns was 3,100
 * separate commits, and a failure part way through left a partial batch behind. `tx` nests, so the
 * import's outer transaction is unaffected: the inner block simply becomes a savepoint.
 */
export function insertRows(
  sheetId: string,
  batch: Array<{ values: Record<string, string>; dedupeKey?: string }>,
  startPosition: number,
  columnIds: number[],
): number {
  const insRow = db.prepare("INSERT INTO rows (sheet_id, position, dedupe_key) VALUES (?, ?, ?)");
  const insCell = db.prepare(
    "INSERT INTO cells (row_id, column_id, status, value_text, value_json) VALUES (?, ?, ?, ?, ?)",
  );

  tx(() => {
    let pos = startPosition;
    for (const item of batch) {
      const res = insRow.run(sheetId, pos++, item.dedupeKey ?? null);
      const rowId = Number(res.lastInsertRowid);
      for (const colId of columnIds) {
        const raw = item.values[String(colId)];
        const has = raw != null && raw !== "";
        // `value_json` is deliberately NOT written here.
        //
        // Every value arriving on this path is already a STRING, so `JSON.stringify(raw)` stored a
        // quoted copy of `value_text` and nothing else — measured at 107% of the text column on a
        // synthetic import and 113% on the real database, which means SQLite was carrying a full
        // second copy of every imported cell forever.
        //
        // Nothing is lost. Every reader takes `value_json ?? value_text` and parses whichever is
        // there, so the parsed form is still recoverable — and a JSON column imported from a file
        // now yields its object on the FIRST parse instead of the double-encoded string the old
        // write produced. The blob is for values whose parsed form genuinely differs from their
        // text, which is what a run, a derivation or a fan-out produces; those writers set it.
        insCell.run(rowId, colId, has ? "done" : "empty", has ? raw : null, null);
      }
    }
  });

  invalidateRowCount(sheetId);
  bumpDataVersion(sheetId);
  markSheetDirty(sheetId);
  // New rows mean any pending redo describes a table that no longer exists. Replaying it would write
  // a snapshot taken before the import back over what just arrived.
  invalidateRedo(sheetId);
  return batch.length;
}

/**
 * Delete one row and everything hanging off it. Returns the sheet it belonged to, or null if the
 * row was already gone.
 *
 * Positions of the surviving rows are deliberately NOT compacted. Renumbering would rewrite every
 * later row — up to a million UPDATEs to remove one line — and nothing depends on positions being
 * contiguous: the grid reads a materialized view index, and new rows take MAX(position)+1.
 */
export function deleteRow(rowId: number | string): string | null {
  const row = db.prepare("SELECT sheet_id FROM rows WHERE id = ?").get(Number(rowId)) as { sheet_id?: string } | undefined;
  if (!row?.sheet_id) return null;

  const sheetId = String(row.sheet_id);
  // Cells and attempts carry ON DELETE CASCADE, but foreign keys are only enforced when the pragma
  // is on, so the child rows are removed explicitly rather than trusted to disappear.
  db.prepare("DELETE FROM cells WHERE row_id = ?").run(Number(rowId));
  db.prepare("DELETE FROM rows WHERE id = ?").run(Number(rowId));

  invalidateRowCount(sheetId);
  bumpDataVersion(sheetId);
  markSheetDirty(sheetId);
  invalidateRedo(sheetId);
  return sheetId;
}

/** Highest position in the sheet, or -1 when empty. An index seek on (sheet_id, position). */
export function maxRowPosition(sheetId: string): number {
  const r = db.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM rows WHERE sheet_id = ?").get(sheetId) as any;
  return Number(r.p);
}

export function nextRowPosition(sheetId: string): number {
  return maxRowPosition(sheetId) + 1;
}

/**
 * Row counts are cached in memory.
 *
 * Measured on a 1M-row sheet: the window's own queries cost 1.4ms combined, while `COUNT(*)` cost
 * 70ms — so an uncached count was 98% of every scroll's latency. This process is the single writer,
 * so an in-memory count is authoritative; it is invalidated on any write that changes row cardinality.
 */
const rowCountCache = new Map<string, number>();

export function countRows(sheetId: string): number {
  const hit = rowCountCache.get(sheetId);
  if (hit != null) return hit;
  const n = Number((db.prepare("SELECT COUNT(*) AS c FROM rows WHERE sheet_id = ?").get(sheetId) as any).c);
  rowCountCache.set(sheetId, n);
  return n;
}

export function invalidateRowCount(sheetId: string): void {
  rowCountCache.delete(sheetId);
}

// ─────────────────────────────────────────────────────────────── the grid read path

export interface GridCell {
  id: string;
  s: CellStatus;
  v: string | null;
  stale?: 1;
  pinned?: 1;
  /** Error class. */
  e?: string;
  /** Error message. Carried on the FIRST load too, not only on live deltas — otherwise a cell that
   *  errored or was stopped before the page opened has no explanation until it changes again. */
  m?: string;
}

export interface RowWindow {
  rows: Array<{ id: string; position: number; cells: Record<string, GridCell> }>;
  total: number;
  offset: number;
}

const winRowsStmt = db.prepare(
  `SELECT id, position FROM rows
    WHERE sheet_id = ? AND position >= ? AND position < ?
    ORDER BY position`,
);

/**
 * Filtered windowing, via a materialized index.
 *
 * The unfiltered path seeks by position range. A filter makes matching rows sparse, so there is no
 * position arithmetic to exploit — and LIMIT/OFFSET re-evaluates the predicate for every row it
 * skips. Measured on a filter matching 147,900 of 1,000,000 rows, a window at offset 140,000 took
 * **1,106ms**, against 9ms unfiltered.
 *
 * So the matching row ids are materialized once into `view_index` with a dense sequence, and every
 * window after that is an indexed seek again. The index is stamped with the sheet's data version and
 * transparently rebuilt when the data moves underneath it.
 */

/**
 * Bumped on any write that changes which rows exist or what they contain.
 *
 * PERSISTED, not merely held in memory. The index's freshness stamp lives on disk and outlives the
 * process, so a counter that restarted at 0 every boot eventually collided with a stamp written by
 * an earlier boot — and a matching stamp means "serve this index without checking anything". Seen
 * live: a sorted read returned `total: 3` for a table holding 2 rows, from an index built the
 * previous day. A stale count is not a display glitch; it is the number the grid sizes itself to and
 * the number a confirm dialog quotes.
 *
 * The Map stays as a read cache — this process is the single writer, so it cannot go behind disk.
 */
const dataVersion = new Map<string, number>();

const dvKey = (sheetId: string): string => `dv:${sheetId}`;

export function bumpDataVersion(sheetId: string): void {
  const next = currentDataVersion(sheetId) + 1;
  dataVersion.set(sheetId, next);
  setKv(dvKey(sheetId), String(next));
}

function currentDataVersion(sheetId: string): number {
  const hit = dataVersion.get(sheetId);
  if (hit != null) return hit;
  const stored = Number(getKv(dvKey(sheetId)) ?? 0);
  const v = Number.isFinite(stored) ? stored : 0;
  dataVersion.set(sheetId, v);
  return v;
}

/** How the grid is being looked at: what is shown, in what order. */
export interface ReadOptions {
  filter?: FilterGroup | null;
  /** Free text matched against every column of the row. */
  search?: string | null;
  sort?: { columnId: number; dir: "asc" | "desc" } | null;
}

/**
 * Free-text search, as ONE predicate shared with run scoping.
 *
 * Exported rather than written out in both places. The grid and a scoped run must narrow to the same
 * rows — viewScope.test.ts asserts exactly that — and two copies of a predicate is how that quietly
 * stops being true. It binds `r` to the row and takes a single parameter: the escaped LIKE pattern.
 *
 * The join onto `columns` is what keeps a DELETED column's cells out of the answer. The delete is
 * soft, so its values are still sitting in the cells table; without the join a search matched them
 * and returned rows with nothing visible in them — and a run scoped by that search then spent on
 * every one of those rows.
 */
export const SEARCH_PREDICATE = `EXISTS (
        SELECT 1 FROM cells c JOIN columns col ON col.id = c.column_id
         WHERE c.row_id = r.id AND col.deleted_at IS NULL
           AND jslower(c.value_text) LIKE jslower(?) ESCAPE '\\')`;

/**
 * Stable key for a (sheet, filter, search, sort) view.
 *
 * All four go in. A key covering only the filter would hand a sorted request the index built for the
 * unsorted one — same rows, wrong order, and no way to tell from the result that it was wrong.
 */
function viewKey(sheetId: string, opts: ReadOptions): string {
  const shape = JSON.stringify({ f: opts.filter ?? null, q: opts.search ?? "", s: opts.sort ?? null });
  return sheetId + "|" + createHash("sha1").update(shape).digest("hex").slice(0, 16);
}

/**
 * ORDER BY for the materialized index.
 *
 * Two things worth stating. Empty cells sort LAST in both directions — a descending sort that leads
 * with every blank row is just showing you the rows with no data. And text folds through `jslower`
 * rather than SQLite's LOWER, which only folds ASCII, so "Ärzte" would otherwise sort away from
 * "arzte" instead of beside it.
 */
function orderClause(sheetId: string, sort: ReadOptions["sort"]): string {
  if (!sort) return "r.position ASC";
  const col = Number(sort.columnId);
  if (!Number.isInteger(col)) return "r.position ASC";

  // Resolved against THIS sheet's live columns, not merely checked for being a number. A stale id
  // from a reopened tab, or one belonging to another table, produced a correlated subquery that
  // returned NULL for every row — so the sort silently did nothing while the caret said it had, and
  // the whole sheet paid for a per-row lookup that could never match.
  const column = listColumns(sheetId).find((c) => Number(c.id) === col);
  if (!column) return "r.position ASC";

  const dir = sort.dir === "desc" ? "DESC" : "ASC";
  const valueType = column.valueType;
  const v = `(SELECT c.value_text FROM cells c WHERE c.row_id = r.id AND c.column_id = ${col})`;

  const key =
    valueType && NUMERIC_TYPES.has(valueType) ? `CAST(${v} AS REAL)`
    : valueType && DATE_TYPES.has(valueType)  ? v          // ISO-8601 sorts chronologically as text
    : `jslower(${v})`;

  // r.position last, so rows with equal values keep a stable, repeatable order across pages —
  // without it a window at offset 400 could re-order rows it already showed at offset 200.
  return `(${v} IS NULL OR ${v} = '') ASC, ${key} ${dir}, r.position ASC`;
}

/**
 * How many materialized view indexes ONE sheet may keep.
 *
 * A plain GET on the read path writes permanent rows into `view_index`, and nothing ever removed
 * them: every filter, search and sort combination anyone tried once left its index behind forever.
 * Measured on the real database — 337 MB across 52 view keys, 41% the size of all the cell data and
 * 21% of the whole 1.58 GB file, for views nobody had opened in weeks.
 *
 * Eight is generous for what it bounds. A person alternates between a handful of saved views and a
 * search box, and the key currently being built is never a candidate. Evicting one costs a single
 * rebuild if the user comes back to it — which is exactly the work the first request already paid.
 */
const MAX_VIEW_INDEXES_PER_SHEET = 8;

/**
 * Drop this sheet's least-recently-built indexes beyond the cap.
 *
 * The meta row and its index rows go TOGETHER, from one key list, inside the caller's transaction.
 * Removing the index while leaving the meta behind is the one outcome that must not happen: the
 * freshness check would pass and the grid would render an empty sheet from a full one.
 *
 * `keepKey` is excluded rather than trusted to sort first. `built_at` has one-second granularity, so
 * several keys rebuilt in the same second tie, and the upsert does not move a row's rowid — the key
 * just built could have lost the tiebreak and been deleted by the statement that follows building it.
 */
function trimViewIndexes(sheetId: string, keepKey: string): void {
  const stale = (
    db
      .prepare(
        `SELECT view_key FROM view_index_meta
          WHERE sheet_id = ? AND view_key <> ?
          ORDER BY built_at DESC, rowid DESC
          LIMIT -1 OFFSET ?`,
      )
      .all(sheetId, keepKey, MAX_VIEW_INDEXES_PER_SHEET - 1) as any[]
  ).map((r) => String(r.view_key));
  if (stale.length === 0) return;

  const holes = stale.map(() => "?").join(",");
  db.prepare(`DELETE FROM view_index WHERE view_key IN (${holes})`).run(...stale);
  db.prepare(`DELETE FROM view_index_meta WHERE view_key IN (${holes})`).run(...stale);
}

/** Build or rebuild the materialized index for a view. Returns the matching row count. */
function ensureViewIndex(
  sheetId: string,
  opts: ReadOptions,
  compiled: { sql: string; params: Array<string | number> },
): { key: string; count: number } {
  const key = viewKey(sheetId, opts);
  const version = currentDataVersion(sheetId);

  const meta = db.prepare("SELECT row_count, data_version FROM view_index_meta WHERE view_key = ?").get(key) as any;
  if (meta && Number(meta.data_version) === version) {
    return { key, count: Number(meta.row_count) };
  }

  return tx(() => {
    db.prepare("DELETE FROM view_index WHERE view_key = ?").run(key);
    // One INSERT..SELECT: the predicate is evaluated exactly once for the whole view, not once per
    // scroll. ROW_NUMBER gives the dense sequence the window seeks on.
    db.prepare(
      `INSERT INTO view_index (view_key, seq, row_id)
       SELECT ?, ROW_NUMBER() OVER (ORDER BY ${orderClause(sheetId, opts.sort)}) - 1, r.id
         FROM rows r
        WHERE r.sheet_id = ? AND (${compiled.sql})`,
    ).run(key, sheetId, ...compiled.params);

    const count = Number((db.prepare("SELECT COUNT(*) AS c FROM view_index WHERE view_key = ?").get(key) as any).c);
    db.prepare(
      `INSERT INTO view_index_meta (view_key, sheet_id, row_count, data_version, built_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(view_key) DO UPDATE SET row_count = excluded.row_count,
                                           data_version = excluded.data_version,
                                           built_at = excluded.built_at`,
    ).run(key, sheetId, count, version);
    // Bounded here, on the only statement that can grow the table, and inside the same transaction —
    // so the file can never carry an index for a view nobody is looking at any more.
    trimViewIndexes(sheetId, key);
    return { key, count };
  });
}

/**
 * Fetch a window of rows with their cells.
 *
 * Two queries regardless of window size — one for the row slice, one for that slice's cells — and
 * both are index range scans. Deliberately not one query per row: that is the shape that dies at
 * scale.
 *
 * `offset` is a POSITION, not a SQL OFFSET. Positions are dense on import; a gap left by a deletion
 * simply yields a shorter window, which the client already handles because it renders by position.
 */
export function readWindow(
  sheetId: string,
  offset: number,
  limit: number,
  opts: ReadOptions = {},
): RowWindow {
  const types = new Map<number, ValueType>();
  let compiled: { sql: string | null; params: Array<string | number> } = { sql: null, params: [] };
  if (opts.filter) {
    for (const c of listColumns(sheetId)) types.set(Number(c.id), c.valueType);
    compiled = compileFilter(opts.filter, types);
  }

  // Search is a predicate over EVERY LIVE column, ANDed with any filter. Escaped, because an
  // unescaped "100%" is a LIKE wildcard and would match every row in the sheet.
  const search = (opts.search ?? "").trim();
  if (search) {
    compiled = compiled.sql
      ? { sql: `(${compiled.sql}) AND ${SEARCH_PREDICATE}`, params: [...compiled.params, `%${escapeLike(search)}%`] }
      : { sql: SEARCH_PREDICATE, params: [`%${escapeLike(search)}%`] };
  }

  // A sort with no filter and no search still needs the index: the fast path below is ordered by
  // position, which is precisely the order a sort is asking to change. Without this the caret would
  // move and the rows would not.
  // Deleting a row leaves a HOLE in the position space, and the fast path below addresses rows by
  // position while reporting `total` as a COUNT. Once those two disagree the grid sizes itself for
  // N rows, asks for positions 0..N-1, and never reaches the rows that got pushed past N — they are
  // in the sheet, they are in the count, and they are unreachable.
  //
  // Compacting positions on delete would fix it too, at the cost of rewriting every later row: up to
  // a million UPDATEs to remove one line. Falling through to the view index instead costs one index
  // seek to detect, and the index's `seq` is dense by construction.
  const positionsDense = maxRowPosition(sheetId) + 1 === countRows(sheetId);
  const needsIndex = !!compiled.sql || !!opts.sort || !positionsDense;

  let total: number;
  let rows: Array<{ id: number; position: number }>;

  if (needsIndex) {
    const idx = ensureViewIndex(sheetId, opts, { sql: compiled.sql ?? "1", params: compiled.params });
    total = idx.count;
    // A seek on (view_key, seq), not an OFFSET scan.
    //
    // `seq` is returned AS the position, not the row's own `position`. The grid renders by index
    // within the view it is showing, so a filtered sheet's first row is index 0 whatever its
    // position in the sheet happens to be. Returning the sheet position instead meant a search that
    // matched row 400,000 was delivered under key 400,000 while the grid was asking for key 0 — the
    // count updated, the row was there, and every cell stayed a skeleton forever.
    rows = db
      .prepare(
        `SELECT r.id, vi.seq AS position
           FROM view_index vi JOIN rows r ON r.id = vi.row_id
          WHERE vi.view_key = ? AND vi.seq >= ? AND vi.seq < ?
          ORDER BY vi.seq`,
      )
      .all(idx.key, offset, offset + limit) as any[];
  } else {
    total = countRows(sheetId);
    rows = winRowsStmt.all(sheetId, offset, offset + limit) as Array<{ id: number; position: number }>;
  }

  if (rows.length === 0) return { rows: [], total, offset };

  // Two ways to fetch the window's cells, chosen by how dense the row ids are:
  //
  //   BETWEEN — one contiguous scan of the clustered primary key. Ideal, but only valid when the
  //             window's rows are actually adjacent.
  //   IN      — required once a filter makes the rows sparse. A filtered window can span row 12 to
  //             row 998,004, and BETWEEN over that range would read MILLIONS of cells to return 200
  //             rows' worth.
  //
  // Picking the wrong one here is silent: the result is still correct, it is just catastrophically
  // slow, so the density check is the guard.
  //
  // min/max are computed across the WHOLE window, not read off the first and last row. Those two are
  // only the extremes when the window is ordered by id, which stopped being true the moment sorting
  // by a column arrived: a descending sort routinely puts a high id first, so `rows[0].id` was the
  // MAXIMUM, `BETWEEN max AND min` matched nothing, and the resulting negative span also satisfied
  // the density test — so it took the empty path and every cell in the window came back blank.
  let minId = rows[0]!.id;
  let maxId = rows[0]!.id;
  for (const r of rows) {
    if (r.id < minId) minId = r.id;
    if (r.id > maxId) maxId = r.id;
  }
  const span = maxId - minId + 1;
  const dense = span <= rows.length * 2;

  const cells = dense
    ? (db
        .prepare(
          `SELECT row_id, column_id, status, value_text, stale, pinned, error_type, error_msg
             FROM cells WHERE row_id BETWEEN ? AND ?`,
        )
        .all(minId, maxId) as any[])
    : (db
        .prepare(
          `SELECT row_id, column_id, status, value_text, stale, pinned, error_type, error_msg
             FROM cells WHERE row_id IN (${rows.map(() => "?").join(",")})`,
        )
        .all(...rows.map((r) => r.id)) as any[]);

  const byRow = new Map<number, Record<string, GridCell>>();
  for (const r of rows) byRow.set(r.id, {});
  for (const c of cells) {
    const bucket = byRow.get(c.row_id);
    if (!bucket) continue; // a row inside the id range but outside the position window
    const cell: GridCell = { id: cellId(c.row_id, c.column_id), s: c.status, v: c.value_text };
    if (c.stale) cell.stale = 1;
    if (c.pinned) cell.pinned = 1;
    if (c.error_type) cell.e = c.error_type;
    // Redacted on the way out as well as on the way in.
    //
    // Every writer redacts now, but this read serves rows written before that was true, and it is
    // the widest exposure in the app: the grid window returns a message per cell for a whole screen
    // of rows at a time. The SSE path (`bus.ts`) has always redacted here and this one did not, so
    // the same value was scrubbed when it was pushed and not when it was fetched.
    if (c.error_msg) cell.m = redactSecrets(String(c.error_msg)).slice(0, 160);
    bucket[String(c.column_id)] = cell;
  }

  return {
    rows: rows.map((r) => ({ id: String(r.id), position: r.position, cells: byRow.get(r.id)! })),
    total,
    offset,
  };
}

// ─────────────────────────────────────────────────────────────── cell reads / writes

/**
 * A cell's value in its parsed form.
 *
 * `value_json` is only present when the parsed value differs from the text — an imported or
 * hand-typed string is stored ONCE, in `value_text`, rather than twice. So an absent blob means the
 * text IS the value, and returning null there (which is what this did) made every imported cell read
 * as empty to anything that trusts this field.
 *
 * A malformed blob degrades to the text rather than throwing, for the same reason `safeJson` exists:
 * one unparseable cell must not fail the read of the cell around it.
 */
function parsedCellValue(valueJson: string | null, valueText: string | null): unknown {
  if (valueJson == null) return valueText ?? null;
  const parsed = safeJson(valueJson);
  return parsed === undefined ? valueText ?? null : parsed;
}

export function getCell(rowId: number, columnId: number): Cell | null {
  // `sheet_id` is joined in rather than left blank. It was returned as "" — a declared field filled
  // with a value that is not merely missing but WRONG, which is the kind a caller trusts once and
  // then routes on.
  const r = db
    .prepare(
      `SELECT c.*, r.sheet_id
         FROM cells c JOIN rows r ON r.id = c.row_id
        WHERE c.row_id = ? AND c.column_id = ?`,
    )
    .get(rowId, columnId) as any;
  if (!r) return null;
  return {
    id: cellId(rowId, columnId),
    sheetId: r.sheet_id, rowId: String(rowId), columnId: String(columnId),
    status: r.status,
    value: parsedCellValue(r.value_json ?? null, r.value_text ?? null),
    valueText: r.value_text,
    confidence: r.confidence ?? undefined,
    sourceUrl: r.source_url ?? undefined,
    note: r.note ?? undefined,
    errorType: r.error_type ?? undefined,
    // Redacted on the way OUT, like the live broadcast and the grid window.
    //
    // A provider's error body is quoted into this column verbatim, and a rejected request often
    // echoes the credential that was rejected. The SSE path has always scrubbed it; this one is what
    // the cell details panel reads, and it was handing back the raw string — the same value, the same
    // screen, one path cleaned and the other not.
    errorMsg: r.error_msg ? redactSecrets(String(r.error_msg)) : undefined,
    stale: !!r.stale, pinned: !!r.pinned,
    inputHash: r.input_hash ?? undefined,
    rev: r.rev, runId: r.run_id ?? undefined, attempt: r.attempt,
    costUsd: r.cost_usd ?? undefined, durationMs: r.duration_ms ?? undefined,
  };
}

/** Manual edit. Pins the cell so a later column run cannot silently overwrite the correction. */
export function setCellValue(rowId: number, columnId: number, text: string | null): void {
  const sheetId = (db.prepare("SELECT sheet_id FROM rows WHERE id = ?").get(rowId) as any)?.sheet_id;
  // `value_json` is CLEARED rather than filled with a quoted copy of the text — see the note in
  // insertRows. What arrives here is always a string, so the blob only ever duplicated `value_text`,
  // and on a JSON column it duplicated it in the double-encoded form every reader then had to undo.
  db.prepare(
    `UPDATE cells
        SET value_text = ?, value_json = NULL, status = ?, pinned = 1, stale = 0,
            error_type = NULL, error_msg = NULL, rev = rev + 1, updated_at = datetime('now')
      WHERE row_id = ? AND column_id = ?`,
  ).run(text, text ? "done" : "empty", rowId, columnId);
  markColumnDirty(columnId);
  markCellsDirty([cellId(rowId, columnId)]);
  // The stale cascade is NOT run here. refs.ts imports this module, so calling into it from here
  // would close an import cycle — and doing it lazily would make the cascade land after this
  // function returned, outside the caller's transaction. The route calls `markDownstreamStale`
  // itself, the same way it already calls `rebuildDeps` after writing a prompt.
  // The caller records its own undo entry, which discards the redo branch anyway — but only when the
  // value actually changed. This write clears the error class and the stale flag regardless, so the
  // branch is stale either way and a redo replayed over it would put the old value back.
  if (sheetId) invalidateRedo(String(sheetId));
}

export function unpinCell(rowId: number, columnId: number): void {
  db.prepare("UPDATE cells SET pinned = 0, rev = rev + 1 WHERE row_id = ? AND column_id = ?").run(rowId, columnId);
  markColumnDirty(columnId);
  markCellsDirty([cellId(rowId, columnId)]);
}
