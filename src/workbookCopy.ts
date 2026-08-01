// Copying a whole workbook — duplicate, templatize, export to a file, import one back.
//
// Duplicating a TABLE was already built (`duplicateSheet`). Duplicating a WORKBOOK is not the same
// job done more times, and that is the entire reason this file exists rather than a loop over the
// other one.
//
// ── What makes a workbook different from a table ────────────────────────────────────────────────
//
// A table's references all point inside itself, so a copy is self-consistent as soon as its own
// column ids are remapped. A workbook's do not. Its tables point at EACH OTHER:
//
//   - a relation names two sheets and a column on each,
//   - a lookup or rollup column names a relation and a column on the far table,
//   - a `send` column names the destination sheet and every column it writes into over there.
//
// Copy the tables one at a time and every one of those still points at the ORIGINAL. The copy then
// looks complete and behaves as a set of remote controls for the workbook it was copied from: a run
// in the duplicate writes rows into the original's tables, and a lookup in the duplicate reads the
// original's values. Nothing errors. That is what makes it dangerous — there is no symptom until
// someone notices the original growing.
//
// So the copy happens in ONE pass over the whole workbook, building a complete id map first and
// rewriting every cross-reference against it second. A reference that cannot be mapped is CLEARED
// and reported in `notes`, never left pointing outside the copy.
//
// ── What deliberately does NOT travel ───────────────────────────────────────────────────────────
//
// Data, unless asked for. Run history, usage and cost — those are a record of what the original did,
// and attributing them to a copy that has never run is simply false. Approval on scripts, for the
// reason `columnTemplates.ts` sets out at length: a copy is a way for code to arrive from elsewhere,
// and carrying the approval across would make "import this file" a way to run code nobody here has
// read. API keys, which do not live in the database at all.
//
// Schedules travel but arrive SWITCHED OFF, and `auto_run` is cleared on anything that arrived from
// outside this machine. Both are the same rule: opening a copy must not start spending money.

import { createHash, randomUUID } from "node:crypto";
import { db, tx } from "./db.ts";
import { normalizeHttpConfig } from "./http/httpColumn.ts";
import { wasRedacted } from "./redact.ts";
import { scriptPointerColumn } from "./scripts.ts";
import { isColumnKind, isSheetKind } from "./types.ts";
import { getWorkbook, type Workbook } from "./views.ts";
import { invalidateRowCount } from "./store.ts";

// ─────────────────────────────────────────────────────────────── field lists, read from the schema
//
// Read from `PRAGMA table_info` rather than written out here.
//
// A hand-written field list is the exact shape of the bug this codebase keeps producing: someone
// adds a column to the schema, every writer that enumerates fields silently stops carrying it, and
// the feature "works" while quietly losing one setting per copy. Asking the database what its own
// columns are cannot fall behind it.

const fieldCache = new Map<string, string[]>();

function fieldsOf(table: string, skip: Set<string>): string[] {
  const key = `${table}:${[...skip].sort().join(",")}`;
  const hit = fieldCache.get(key);
  if (hit) return hit;
  const all = (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((r) => String(r.name));
  const out = all.filter((n) => !skip.has(n));
  fieldCache.set(key, out);
  return out;
}

/**
 * Copy one row of `table`, overriding some fields, and return the new rowid.
 *
 * An overridden field is REMOVED from the carried set rather than appended after it. Appending built
 * an INSERT naming the same column twice, and the value that won was the source's — so `auto_run: 0`
 * on a template was written and then silently overruled by the original's `1`. The override has to
 * be the only mention of the field it names.
 */
function copyRow(table: string, id: string | number, skip: Set<string>, override: Record<string, unknown>): number {
  const fields = fieldsOf(table, skip).filter((f) => !(f in override));
  const src = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as any;
  if (!src) throw new Error(`No ${table} row ${id} to copy.`);

  const names = [...fields, ...Object.keys(override)];
  const values = [
    ...fields.map((f) => src[f] ?? null),
    ...Object.values(override).map((v) => (v === undefined ? null : (v as any))),
  ];
  const res = db
    .prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
    .run(...(values as any[]));
  return Number(res.lastInsertRowid);
}

// ─────────────────────────────────────────────────────────────── reference rewriting

/** The stored reference grammar, matching `refs.ts`. Kept identical so the two cannot disagree. */
const REF_RE = /\{\{\s*col:(\d+)((?:\.[A-Za-z0-9_$-]+|\[\d+\])*)(\?)?\s*\}\}/g;

/**
 * `{{col:12}}` → `{{col:87}}`, against an exact id map.
 *
 * By id rather than by name, unlike a column template. A template lands on a table it has never seen
 * and has to match by name; a copy knows precisely which new column each old one became, so mapping
 * by id is both exact and immune to two columns sharing a name.
 *
 * An id with no mapping is left EXACTLY as written. It is already broken — it names a column outside
 * this workbook — and rewriting it to something plausible would hide that; leaving it legible means
 * the reference can be found and fixed. It is reported in `notes`.
 */
function remapRefs(text: string | null, cols: Map<number, number>, unmapped: Set<number>): string | null {
  if (!text) return text;
  return text.replace(REF_RE, (whole, id, path, opt) => {
    const to = cols.get(Number(id));
    if (to == null) { unmapped.add(Number(id)); return whole; }
    return `{{col:${to}${path ?? ""}${opt ?? ""}}}`;
  });
}

/**
 * A `send` column's destination, rewritten to point inside the copy.
 *
 * Field by field rather than by walking the JSON for anything that looks like an id. A blind numeric
 * remap would happily rewrite `cap: 50` into a column id, and the result — a send that writes a
 * different number of rows than it says — is the kind of defect that is found months later by
 * counting.
 *
 * If the destination sheet is not part of this copy, the whole config is dropped rather than
 * half-mapped. A send column pointed at a table outside the copy writes into that table on every
 * run, which is the single worst outcome this file exists to prevent.
 */
function remapSend(
  raw: string | null,
  sheets: Map<string, string>,
  cols: Map<number, number>,
  notes: string[],
  columnName: string,
): string | null {
  if (!raw) return null;
  let cfg: any;
  try { cfg = JSON.parse(raw); } catch { return null; }
  if (!cfg || typeof cfg !== "object") return null;

  const target = sheets.get(String(cfg.targetSheetId ?? ""));
  if (!target) {
    notes.push(
      `"${columnName}" wrote its results into a table outside this workbook, so the copy has no ` +
      `destination set. Pick one before running it.`,
    );
    return null;
  }
  cfg.targetSheetId = target;

  if (cfg.listColumnId != null) cfg.listColumnId = cols.get(Number(cfg.listColumnId)) ?? null;

  const mapField = (v: any): any =>
    v && typeof v === "object" && v.from === "row" && v.columnId != null
      ? { ...v, columnId: cols.get(Number(v.columnId)) ?? null }
      : v;

  if (cfg.mapping && typeof cfg.mapping === "object") {
    const next: Record<string, unknown> = {};
    for (const [targetCol, source] of Object.entries(cfg.mapping)) {
      const to = cols.get(Number(targetCol));
      // A mapping whose DESTINATION column did not come along has nowhere to write. Dropping the
      // one entry keeps the rest of the send working.
      if (to == null) continue;
      next[String(to)] = mapField(source);
    }
    cfg.mapping = next;
  }
  if (cfg.keySource) cfg.keySource = mapField(cfg.keySource);

  return JSON.stringify(cfg);
}

/** Every column id inside a saved view — the filter tree, the sorts, the order, the widths. */
function remapView(raw: any, cols: Map<number, number>): any {
  const map = (id: unknown): number | null => cols.get(Number(id)) ?? null;

  const filter = (node: any): any => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node.children)) return { ...node, children: node.children.map(filter).filter(Boolean) };
    const to = map(node.columnId);
    // A condition on a column that is not in the copy cannot be evaluated. Dropping it WIDENS the
    // view, so it is dropped loudly — the caller records it — rather than silently kept as a
    // condition against a foreign id, which `compileFilter` would drop anyway with no explanation.
    return to == null ? null : { ...node, columnId: to };
  };

  const columns = { ...(raw.columns ?? {}) };
  if (Array.isArray(columns.order)) columns.order = columns.order.map(map).filter((n: any) => n != null);
  if (Array.isArray(columns.hidden)) columns.hidden = columns.hidden.map(map).filter((n: any) => n != null);
  if (columns.widths && typeof columns.widths === "object") {
    const w: Record<string, number> = {};
    for (const [k, v] of Object.entries(columns.widths)) {
      const to = map(k);
      if (to != null) w[String(to)] = Number(v);
    }
    columns.widths = w;
  }
  if (columns.frozen != null) columns.frozen = Number(columns.frozen);

  return {
    filter: filter(raw.filter) ?? { conj: "and", children: [] },
    sorts: (raw.sorts ?? []).map((s: any) => ({ ...s, columnId: map(s.columnId) })).filter((s: any) => s.columnId != null),
    columns,
    groupBy: map(raw.groupBy),
  };
}

// ─────────────────────────────────────────────────────────────── the copy

export interface CopyOptions {
  name?: string;
  /** Copy the rows and their values too. Off by default — see the note on `duplicateSheet`. */
  withRows?: boolean;
  /** Mark the result as a template: structure only, listed in the gallery rather than the sidebar. */
  asTemplate?: boolean;
  /**
   * The copy came from outside this machine (an imported file).
   *
   * Everything that can start work by itself is cleared when this is set. A duplicate the user just
   * made of their own workbook is a different situation from a file that arrived by email, and the
   * difference is entirely about whether the settings inside it were chosen by the person now
   * holding it.
   */
  foreign?: boolean;
}

export interface CopyResult {
  workbook: Workbook;
  tables: number;
  columns: number;
  rows: number;
  /** Scripts carried across, all unapproved and unable to run until read here. */
  scriptsPending: number;
  /** Anything the copy could not carry faithfully, in plain words, for the screen. */
  notes: string[];
}

const SHEET_SKIP = new Set(["id", "workbook_id", "created_at", "updated_at", "primary_column_id", "default_view_id"]);
const COLUMN_SKIP = new Set(["id", "sheet_id", "created_at", "updated_at", "stats_json"]);
const VIEW_SKIP = new Set(["id", "sheet_id", "created_at", "updated_at", "filter_json", "sorts_json", "columns_json", "group_by"]);
const SCRIPT_SKIP = new Set(["id", "column_id", "created_at", "approved_at"]);
const SCHEDULE_SKIP = new Set([
  "id", "sheet_id", "created_at", "enabled", "scope_json",
  "last_at", "last_run_id", "last_status", "runs",
]);
const RELATION_SKIP = new Set(["id", "workbook_id", "from_sheet_id", "from_column_id", "to_sheet_id", "to_column_id", "created_at"]);

/**
 * Copy a workbook whole.
 *
 * One transaction. A workbook half-copied is worse than none: its tables would be real, its links
 * would not, and the half that exists would point at the original.
 */
export function duplicateWorkbook(workbookId: string, opts: CopyOptions = {}): CopyResult {
  const src = getWorkbook(workbookId);
  if (!src) throw new Error("That workbook no longer exists.");

  return tx(() => {
    const notes: string[] = [];
    const newId = randomUUID();
    db.prepare(
      "INSERT INTO workbooks (id, name, description, is_template, budget_usd, settings_json) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      newId,
      String(opts.name ?? `${src.name} (copy)`).trim().slice(0, 200) || src.name,
      src.description ?? null,
      opts.asTemplate ? 1 : 0,
      // A budget is a ceiling on real spend that someone set for a specific piece of work. Carried
      // onto a template it becomes a limit nobody chose, applied to work nobody has described yet.
      opts.asTemplate ? null : (db.prepare("SELECT budget_usd FROM workbooks WHERE id = ?").get(workbookId) as any)?.budget_usd ?? null,
      (db.prepare("SELECT settings_json FROM workbooks WHERE id = ?").get(workbookId) as any)?.settings_json ?? "{}",
    );

    const sheetMap = new Map<string, string>();
    const colMap = new Map<number, number>();
    const scriptMap = new Map<number, number>();
    const relMap = new Map<number, number>();
    let columnCount = 0;
    let scriptsPending = 0;

    const srcSheets = db
      .prepare("SELECT id FROM sheets WHERE workbook_id = ? AND deleted_at IS NULL ORDER BY position, created_at")
      .all(workbookId) as any[];

    // ── pass 1: the shapes, with every cross-reference still pointing at the original ───────────
    for (const s of srcSheets) {
      const sheetId = randomUUID();
      copyRow("sheets", s.id, SHEET_SKIP, { id: sheetId, workbook_id: newId });
      sheetMap.set(String(s.id), sheetId);

      for (const c of db
        .prepare("SELECT id FROM columns WHERE sheet_id = ? AND deleted_at IS NULL ORDER BY position")
        .all(s.id) as any[]) {
        const overrides: Record<string, unknown> = { sheet_id: sheetId };
        // A template, or anything that arrived from elsewhere, never arms itself. Same rule as
        // applying a column template, and for the same reason.
        if (opts.asTemplate || opts.foreign) overrides.auto_run = 0;
        const newCol = copyRow("columns", c.id, COLUMN_SKIP, overrides);
        colMap.set(Number(c.id), newCol);
        columnCount++;

        for (const scr of db.prepare("SELECT id FROM scripts WHERE column_id = ?").all(c.id) as any[]) {
          // approved_at is in SCRIPT_SKIP, so it defaults to NULL. Code travels; approval does not.
          scriptMap.set(Number(scr.id), copyRow("scripts", scr.id, SCRIPT_SKIP, { column_id: newCol }));
          scriptsPending++;
        }
      }
    }

    // ── pass 2: the relations, now that both of their sheets and columns exist ──────────────────
    for (const r of db.prepare("SELECT * FROM relations WHERE workbook_id = ?").all(workbookId) as any[]) {
      const fromSheet = sheetMap.get(String(r.from_sheet_id));
      const toSheet = sheetMap.get(String(r.to_sheet_id));
      const fromCol = colMap.get(Number(r.from_column_id));
      const toCol = colMap.get(Number(r.to_column_id));
      if (!fromSheet || !toSheet || fromCol == null || toCol == null) {
        // A relation to a table outside this workbook should not exist — relations are workbook
        // scoped — but if one does, it is dropped rather than recreated pointing outward.
        notes.push("A link between tables could not be copied because one of its tables is missing.");
        continue;
      }
      relMap.set(
        Number(r.id),
        copyRow("relations", r.id, RELATION_SKIP, {
          workbook_id: newId,
          from_sheet_id: fromSheet, from_column_id: fromCol,
          to_sheet_id: toSheet, to_column_id: toCol,
        }),
      );
    }

    // ── pass 3: rewrite every reference in the copy to point INSIDE the copy ────────────────────
    const unmappedRefs = new Set<number>();
    const droppedLinks: string[] = [];

    for (const [oldCol, newCol] of colMap) {
      const c = db.prepare("SELECT * FROM columns WHERE id = ?").get(newCol) as any;
      const name = String(c.name);

      const relation = c.relation_id == null ? null : relMap.get(Number(c.relation_id)) ?? null;
      if (c.relation_id != null && relation == null) droppedLinks.push(name);

      // The far-side field a lookup reads, or a rollup adds up. Mapped through the SAME column map:
      // it names a column on the other table, which is in this copy too.
      const lookupCol = c.lookup_column_id == null ? null : colMap.get(Number(c.lookup_column_id)) ?? null;

      db.prepare(
        `UPDATE columns
            SET prompt = ?, description = ?, http_config = ?, send_config = ?,
                source_column_id = ?, relation_id = ?, lookup_column_id = ?,
                condition_script_id = ?, transform_script_id = ?,
                accept_script_id = ?, map_script_id = ?
          WHERE id = ?`,
      ).run(
        remapRefs(c.prompt, colMap, unmappedRefs),
        remapRefs(c.description, colMap, unmappedRefs),
        remapRefs(c.http_config, colMap, unmappedRefs),
        remapSend(c.send_config, sheetMap, colMap, notes, name),
        c.source_column_id == null ? null : colMap.get(Number(c.source_column_id)) ?? null,
        // A lookup whose link did not survive is left with no link rather than the original's. It
        // refuses to run and says why — `lookupConfig` already has that message.
        relation,
        relation == null ? null : lookupCol,
        c.condition_script_id == null ? null : scriptMap.get(Number(c.condition_script_id)) ?? null,
        c.transform_script_id == null ? null : scriptMap.get(Number(c.transform_script_id)) ?? null,
        c.accept_script_id == null ? null : scriptMap.get(Number(c.accept_script_id)) ?? null,
        c.map_script_id == null ? null : scriptMap.get(Number(c.map_script_id)) ?? null,
        newCol,
      );
      void oldCol;
    }

    if (unmappedRefs.size > 0) {
      notes.push(
        `${unmappedRefs.size} reference${unmappedRefs.size === 1 ? "" : "s"} in the original pointed at a ` +
        `column that is not in this workbook. They were left as written so you can find them.`,
      );
    }
    if (droppedLinks.length > 0) {
      notes.push(`These columns lost the link they read through: ${droppedLinks.join(", ")}.`);
    }

    // ── pass 4: views, the sheet's own pointers, and schedules ──────────────────────────────────
    for (const [oldSheet, newSheet] of sheetMap) {
      const viewMap = new Map<number, number>();
      for (const v of db.prepare("SELECT * FROM views WHERE sheet_id = ? ORDER BY position, id").all(oldSheet) as any[]) {
        const parsed = remapView(
          {
            filter: safeJson(v.filter_json, { conj: "and", children: [] }),
            sorts: safeJson(v.sorts_json, []),
            columns: safeJson(v.columns_json, {}),
            groupBy: v.group_by,
          },
          colMap,
        );
        viewMap.set(
          Number(v.id),
          copyRow("views", v.id, VIEW_SKIP, {
            sheet_id: newSheet,
            filter_json: JSON.stringify(parsed.filter),
            sorts_json: JSON.stringify(parsed.sorts),
            columns_json: JSON.stringify(parsed.columns),
            group_by: parsed.groupBy,
          }),
        );
      }

      const s = db.prepare("SELECT primary_column_id, default_view_id FROM sheets WHERE id = ?").get(oldSheet) as any;
      db.prepare("UPDATE sheets SET primary_column_id = ?, default_view_id = ? WHERE id = ?").run(
        s?.primary_column_id == null ? null : colMap.get(Number(s.primary_column_id)) ?? null,
        s?.default_view_id == null ? null : viewMap.get(Number(s.default_view_id)) ?? null,
        newSheet,
      );

      // Schedules travel, switched OFF, and with their run scope cleared — a scope names columns and
      // a saved view, and one that half-resolves would run a different set of rows than it reads as.
      // `enabled` and `scope_json` are in SCHEDULE_SKIP, so both take their safe defaults.
      let schedules = 0;
      for (const sc of db.prepare("SELECT id FROM schedules WHERE sheet_id = ?").all(oldSheet) as any[]) {
        copyRow("schedules", sc.id, SCHEDULE_SKIP, { sheet_id: newSheet });
        schedules++;
      }
      if (schedules > 0) {
        notes.push(
          `${schedules} schedule${schedules === 1 ? "" : "s"} came across switched off, covering the whole ` +
          `table. Check what each one runs before turning it on.`,
        );
      }
    }

    // ── pass 5: the rows, only if asked ─────────────────────────────────────────────────────────
    let rowCount = 0;
    if (opts.withRows && !opts.asTemplate) {
      const insRow = db.prepare("INSERT INTO rows (sheet_id, position, dedupe_key) VALUES (?, ?, ?)");
      const insCell = db.prepare(
        "INSERT INTO cells (row_id, column_id, status, value_text, value_json, pinned) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const [oldSheet, newSheet] of sheetMap) {
        let pos = 0;
        for (const r of db.prepare("SELECT id, dedupe_key FROM rows WHERE sheet_id = ? ORDER BY position").all(oldSheet) as any[]) {
          const rowId = Number(insRow.run(newSheet, pos++, r.dedupe_key ?? null).lastInsertRowid);
          for (const cell of db
            .prepare("SELECT column_id, status, value_text, value_json, pinned FROM cells WHERE row_id = ?")
            .all(r.id) as any[]) {
            const to = colMap.get(Number(cell.column_id));
            if (to == null) continue;
            insCell.run(rowId, to, cell.status, cell.value_text ?? null, cell.value_json ?? null, cell.pinned ?? 0);
          }
          rowCount++;
        }
        invalidateRowCount(newSheet);
      }
    }

    if (scriptsPending > 0) {
      notes.push(
        `${scriptsPending} script${scriptsPending === 1 ? "" : "s"} came across unapproved. Read each one and ` +
        `approve it before the column that uses it can run.`,
      );
    }

    return {
      workbook: getWorkbook(newId)!,
      tables: sheetMap.size,
      columns: columnCount,
      rows: rowCount,
      scriptsPending,
      notes,
    };
  });
}

function safeJson<T>(raw: unknown, fallback: T): T {
  try { return JSON.parse(String(raw)) as T; } catch { return fallback; }
}

/**
 * Keep a workbook as a template: a structure-only copy, listed in the gallery rather than the
 * sidebar.
 *
 * The same copy, with data and `auto_run` withheld. A separate function only because "save as a
 * template" is a different sentence from "duplicate", and the option set that makes it safe should
 * not be something each caller assembles for itself.
 */
export function templatizeWorkbook(workbookId: string, name?: string): CopyResult {
  const src = getWorkbook(workbookId);
  if (!src) throw new Error("That workbook no longer exists.");
  return duplicateWorkbook(workbookId, {
    name: name ?? src.name,
    asTemplate: true,
    withRows: false,
  });
}

/** Create a working workbook from a template. The template itself is left alone. */
export function useTemplate(templateId: string, name?: string): CopyResult {
  const t = getWorkbook(templateId);
  if (!t) throw new Error("That template no longer exists.");
  if (!t.isTemplate) throw new Error("That is not a template.");
  return duplicateWorkbook(templateId, { name: name ?? t.name, asTemplate: false });
}

// Removing a template is the ordinary workbook trash — a template IS a workbook, and `listTemplates`
// already excludes archived ones. A dedicated delete would be a second way to do the same thing.

// ─────────────────────────────────────────────────────────────── a file you can send someone
//
// This engine listens on 127.0.0.1 only, so a "share link" would be a link that resolves for nobody
// but the person who generated it. `workbooks.public_token` exists in the schema for a hosted
// version that does not exist yet; wiring a route to it today would produce a Copy Link button whose
// link is dead everywhere it could usefully be pasted.
//
// A FILE is the honest mechanism for a local tool. It is portable, it is inspectable before it is
// imported, and it carries exactly what a template carries and nothing else.

/** The version of the file format. Bumped when a reader would need to behave differently. */
export const DOC_VERSION = 1;

export interface WorkbookDoc {
  format: "ferrum.workbook";
  version: number;
  exportedAt: string;
  name: string;
  description: string | null;
  tables: Array<{
    name: string;
    kind: string;
    position: number;
    /** The column's own name, used to re-point references on import. */
    primaryColumn: string | null;
    columns: Array<Record<string, unknown>>;
    views: Array<Record<string, unknown>>;
  }>;
  relations: Array<{
    fromTable: string; fromColumn: string;
    toTable: string; toColumn: string;
    cardinality: string; matchMode: string;
  }>;
}

/**
 * Everything in the document is addressed BY NAME.
 *
 * A file that carried ids would be a file that only re-imports onto this machine — the ids mean
 * nothing anywhere else, and worse, they would land on whatever columns happen to hold those ids on
 * the machine that opens it. Names are the only addressing that survives leaving here, which is the
 * same conclusion `columnTemplates.ts` reached for the same reason.
 */
export function exportWorkbook(workbookId: string): WorkbookDoc {
  const wb = getWorkbook(workbookId);
  if (!wb) throw new Error("That workbook no longer exists.");

  const sheets = db
    .prepare("SELECT id, name, kind, position, primary_column_id FROM sheets WHERE workbook_id = ? AND deleted_at IS NULL ORDER BY position")
    .all(workbookId) as any[];

  const colName = new Map<number, string>();
  const sheetName = new Map<string, string>();
  for (const s of sheets) {
    sheetName.set(String(s.id), String(s.name));
    for (const c of db.prepare("SELECT id, name FROM columns WHERE sheet_id = ? AND deleted_at IS NULL").all(s.id) as any[]) {
      colName.set(Number(c.id), String(c.name));
    }
  }

  /** `{{col:12}}` → `{{Website}}`. An id outside this workbook is left visible, not invented. */
  const toNames = (text: string | null): string | null =>
    text == null ? null : text.replace(REF_RE, (whole, id, path, opt) => {
      const n = colName.get(Number(id));
      return n ? `{{${n}${path ?? ""}${opt ?? ""}}}` : whole;
    });

  const tables = sheets.map((s) => {
    const cols = db
      .prepare("SELECT * FROM columns WHERE sheet_id = ? AND deleted_at IS NULL ORDER BY position")
      .all(s.id) as any[];

    return {
      name: String(s.name),
      kind: String(s.kind),
      position: Number(s.position),
      primaryColumn: s.primary_column_id == null ? null : colName.get(Number(s.primary_column_id)) ?? null,
      columns: cols.map((c) => ({
        name: c.name,
        kind: c.kind,
        valueType: c.value_type,
        position: c.position,
        prompt: toNames(c.prompt),
        description: toNames(c.description),
        model: c.model,
        maxTurns: c.max_turns,
        maxBudgetUsd: c.max_budget_usd,
        timeoutMs: c.timeout_ms,
        allowedTools: safeJson(c.allowed_tools, []),
        mcpServers: safeJson(c.mcp_servers, []),
        httpConfig: c.http_config ? safeJson(toNames(c.http_config), null) : null,
        enumValues: c.enum_values ? safeJson(c.enum_values, null) : null,
        jsonSchema: c.json_schema ? safeJson(c.json_schema, null) : null,
        format: c.format ?? null,
        width: c.width ?? null,
        frozen: !!c.frozen,
        rollup: c.rollup ? safeJson(c.rollup, null) : null,
        // The three that were missing. A workbook holding a waterfall, an MCP or a wait column
        // exported and re-imported as an EMPTY static column, silently — the kind was degraded by a
        // short list and the configuration was never written at all. `toNames` on the waterfall for
        // the same reason it runs on a prompt: its steps carry `{{col:N}}` references, and an id
        // means nothing in the file the copy lands in.
        waterfall: c.waterfall_json ? safeJson(toNames(c.waterfall_json), null) : null,
        mcpConfig: c.mcp_config ? safeJson(toNames(c.mcp_config), null) : null,
        waitSeconds: c.wait_seconds == null ? null : Number(c.wait_seconds),
        /** By name, so a lookup or rollup re-points onto the imported copy's own columns. */
        lookupColumn: c.lookup_column_id == null ? null : colName.get(Number(c.lookup_column_id)) ?? null,
        sourceColumn: c.source_column_id == null ? null : colName.get(Number(c.source_column_id)) ?? null,
        jsonPath: c.json_path ?? null,
        onUpstreamEmpty: c.on_upstream_empty,
        onUpstreamError: c.on_upstream_error,
        autoRecompute: !!c.auto_recompute,
        // auto_run, send_config, budgets and every id are deliberately absent. See the file header.
        scripts: (db.prepare("SELECT hook, runtime, intent, code FROM scripts WHERE column_id = ?").all(c.id) as any[])
          .map((x) => ({ hook: x.hook, runtime: x.runtime, intent: x.intent, code: x.code })),
      })),
      views: (db.prepare("SELECT * FROM views WHERE sheet_id = ? ORDER BY position").all(s.id) as any[]).map((v) => ({
        name: v.name,
        position: v.position,
        rowHeight: v.row_height,
        search: v.search ?? null,
        // Views address columns by id; converting the whole tree to names is more machinery than a
        // view is worth on the way out, so only the presentation travels. Recorded here rather than
        // silently: an imported view arrives unfiltered.
        filtersDropped: (safeJson<any>(v.filter_json, { children: [] }).children ?? []).length > 0,
      })),
    };
  });

  const relations = (db.prepare("SELECT * FROM relations WHERE workbook_id = ?").all(workbookId) as any[])
    .map((r) => ({
      fromTable: sheetName.get(String(r.from_sheet_id)) ?? "",
      fromColumn: colName.get(Number(r.from_column_id)) ?? "",
      toTable: sheetName.get(String(r.to_sheet_id)) ?? "",
      toColumn: colName.get(Number(r.to_column_id)) ?? "",
      cardinality: String(r.cardinality ?? "many_to_one"),
      matchMode: String(r.match_mode ?? "normalized"),
    }))
    // A link with an end outside this workbook cannot be described by name in a file that does not
    // contain that table. It is dropped — but see `droppedRelationsIn`: the drop used to be entirely
    // silent, which made an exported workbook quietly less than the one it was exported from.
    .filter((r) => r.fromTable && r.toTable && r.fromColumn && r.toColumn);

  return {
    format: "ferrum.workbook",
    version: DOC_VERSION,
    exportedAt: new Date().toISOString(),
    name: wb.name,
    description: wb.description,
    tables,
    relations,
  };
}

export interface ImportResult extends CopyResult {}

/**
 * Read a document back into a real workbook.
 *
 * Nothing in the file is trusted: it may have been written by a different version, hand-edited, or
 * sent by someone else. Every value is taken through the same normalization a fresh column goes
 * through, unknown fields are ignored rather than written, scripts arrive unapproved, and nothing
 * arrives armed to run.
 */
export function importWorkbook(doc: unknown, name?: string): ImportResult {
  const d = doc as WorkbookDoc;
  if (!d || typeof d !== "object" || d.format !== "ferrum.workbook") {
    throw new Error("That file is not a Ferrum workbook.");
  }
  if (Number(d.version) > DOC_VERSION) {
    throw new Error(
      `That file was written by a newer version of Ferrum (format ${d.version}, this one reads ${DOC_VERSION}).`,
    );
  }
  if (!Array.isArray(d.tables) || d.tables.length === 0) throw new Error("That file has no tables in it.");

  return tx(() => {
    const notes: string[] = [];
    const newId = randomUUID();
    db.prepare("INSERT INTO workbooks (id, name, description) VALUES (?, ?, ?)").run(
      newId,
      String(name ?? d.name ?? "Imported workbook").trim().slice(0, 200) || "Imported workbook",
      typeof d.description === "string" ? d.description : null,
    );

    // name → id, per table, so references and relations can be re-pointed.
    const sheetIds = new Map<string, string>();
    const colIds = new Map<string, Map<string, number>>();
    let columnCount = 0;
    let scriptsPending = 0;

    for (const [i, t] of d.tables.entries()) {
      const sheetId = randomUUID();
      const tableName = String(t.name ?? `Table ${i + 1}`).slice(0, 200);
      db.prepare("INSERT INTO sheets (id, workbook_id, name, position, kind) VALUES (?, ?, ?, ?, ?)").run(
        sheetId, newId, tableName, i, isSheetKind(t.kind) ? t.kind : "generic",
      );
      sheetIds.set(tableName, sheetId);
      colIds.set(tableName, new Map());

      const taken = new Set<string>();
      for (const [j, c] of (t.columns ?? []).entries()) {
        const raw = String((c as any).name ?? `Column ${j + 1}`).slice(0, 200);
        // The same key-collision rule `addColumn` applies, restated here rather than reused because
        // this insert sets far more fields than `addColumn` accepts. Two columns named the same in a
        // hand-edited file would otherwise fail the whole import on a UNIQUE constraint.
        let key = normalKey(raw);
        let n = 2;
        while (taken.has(key)) key = `${normalKey(raw)}_${n++}`;
        taken.add(key);

        const id = Number(
          db.prepare(
            `INSERT INTO columns (sheet_id, name, key, position, kind, value_type, prompt, description,
                                  model, max_turns, max_budget_usd, timeout_ms, allowed_tools, mcp_servers,
                                  http_config, enum_values, json_schema, format, width, frozen, rollup,
                                  json_path, on_upstream_empty, on_upstream_error, auto_recompute,
                                  waterfall_json, mcp_config, wait_seconds, auto_run)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          ).run(
            sheetId, raw, key, j,
            // `isColumnKind`, not a private list. The hand-written one here knew nine of the eleven
            // kinds, so a shared workbook's `waterfall` and `wait` columns silently arrived as empty
            // `static` ones — with their configuration dropped by the field list below, which did not
            // carry it either. Both halves had to be fixed together: restoring the kind alone would
            // have produced a waterfall column with no steps.
            isColumnKind((c as any).kind) ? String((c as any).kind) : "static",
            String((c as any).valueType ?? "text"),
            str((c as any).prompt), str((c as any).description),
            str((c as any).model) ?? "auto",
            posInt((c as any).maxTurns, 4),
            (c as any).maxBudgetUsd == null ? 0.05 : Number((c as any).maxBudgetUsd),
            posInt((c as any).timeoutMs, 180_000),
            JSON.stringify(Array.isArray((c as any).allowedTools) ? (c as any).allowedTools : []),
            // Ids only; anything else in the list is dropped. A file cannot describe an app — the
            // command it runs, its environment and its address all live in this machine's own
            // registry — so the worst an id from outside can name is an app that is not set up,
            // which grants nothing and says so when the column runs.
            JSON.stringify(
              Array.isArray((c as any).mcpServers)
                ? [...new Set(((c as any).mcpServers as unknown[]).filter((s) => typeof s === "string"))].sort()
                : [],
            ),
            importHttpConfig((c as any).httpConfig, raw, notes),
            (c as any).enumValues ? JSON.stringify((c as any).enumValues) : null,
            (c as any).jsonSchema ? JSON.stringify((c as any).jsonSchema) : null,
            str((c as any).format), (c as any).width == null ? null : Number((c as any).width),
            (c as any).frozen ? 1 : 0,
            (c as any).rollup ? JSON.stringify((c as any).rollup) : null,
            str((c as any).jsonPath),
            str((c as any).onUpstreamEmpty) ?? "skip",
            str((c as any).onUpstreamError) ?? "block",
            (c as any).autoRecompute ? 1 : 0,
            // A waterfall's steps carry references, so they go through the same name-to-id pass the
            // prompt does, below. Stored as written for now; rewritten with everything else.
            (c as any).waterfall ? JSON.stringify((c as any).waterfall) : null,
            (c as any).mcpConfig ? JSON.stringify((c as any).mcpConfig) : null,
            posInt((c as any).waitSeconds, 0),
          ).lastInsertRowid,
        );
        colIds.get(tableName)!.set(raw, id);
        columnCount++;

        for (const s of (c as any).scripts ?? []) {
          if (typeof s?.code !== "string") continue;
          const hook = String(s.hook ?? "transform");
          const scriptId = Number(
            db
              .prepare(
                `INSERT INTO scripts (column_id, hook, runtime, intent, code, hash, approved_at, refs)
                 VALUES (?, ?, ?, ?, ?, ?, NULL, '[]')`,
              )
              .run(
                id, hook, String(s.runtime ?? "js"), String(s.intent ?? ""),
                s.code, createHash("sha256").update(String(s.code)).digest("hex"),
              ).lastInsertRowid,
          );
          scriptsPending++;

          /**
           * Point the column AT the script. Without this the import was a silent no-op on every
           * script column it carried: the row landed, the editor showed it, the pill read "Needs
           * review", Approve worked — and `runs.ts` returns 0 for a column whose pointer is null, so
           * the column produced nothing, forever, with nothing on screen saying why.
           *
           * The duplicate path has always done this through its own id map. Only the FILE path did
           * not, and no test covered it.
           */
          const field = scriptPointerColumn(hook);
          if (field) db.prepare(`UPDATE columns SET ${field} = ? WHERE id = ?`).run(scriptId, id);
        }
      }
    }

    // References were written as `{{Name}}`; turn them back into ids against the table they landed
    // on. A name this file's table does not have is left as written and reported — the same failure
    // mode, and the same handling, as applying a column template.
    const missing = new Set<string>();
    for (const t of d.tables) {
      const tableName = String(t.name ?? "");
      const sheetId = sheetIds.get(tableName);
      const byName = colIds.get(tableName);
      if (!sheetId || !byName) continue;
      const lower = new Map([...byName].map(([n, id]) => [n.trim().toLowerCase(), id]));

      for (const c of t.columns ?? []) {
        const id = byName.get(String((c as any).name ?? ""));
        if (id == null) continue;
        const fix = (text: string | null): string | null =>
          text == null ? null : text.replace(/\{\{\s*([^{}?]+?)((?:\.[A-Za-z0-9_$-]+|\[\d+\])*)(\?)?\s*\}\}/g,
            (whole, nm, path, opt) => {
              const to = lower.get(String(nm).trim().toLowerCase());
              if (to == null) { missing.add(String(nm).trim()); return whole; }
              return `{{col:${to}${path ?? ""}${opt ?? ""}}}`;
            });

        db.prepare(
          `UPDATE columns SET prompt = ?, description = ?, http_config = ?, source_column_id = ?,
                              lookup_column_id = ?, waterfall_json = ?, mcp_config = ? WHERE id = ?`,
        ).run(
          fix(str((c as any).prompt)),
          fix(str((c as any).description)),
          // Normalised again rather than read back: this rewrites the column's stored settings, and
          // a second writer that skipped the normaliser would undo the first one's work. The notes
          // are already recorded, so this call has nowhere to repeat them.
          fix(importHttpConfig((c as any).httpConfig, String((c as any).name ?? ""), [])),
          lower.get(String((c as any).sourceColumn ?? "").trim().toLowerCase()) ?? null,
          // A lookup's field lives on the OTHER table, so it is resolved after the relations below.
          null,
          // A waterfall step holds a prompt, and an MCP call holds arguments — both carry the same
          // `{{Name}}` references a prompt does, so both go through the same rewrite. Passed through
          // `fix` as TEXT rather than walked field by field: a reference means the same thing
          // wherever it appears, and a walker would have to be taught every step shape that is ever
          // added to a waterfall.
          fix((c as any).waterfall ? JSON.stringify((c as any).waterfall) : null),
          fix((c as any).mcpConfig ? JSON.stringify((c as any).mcpConfig) : null),
          id,
        );
      }

      if (t.primaryColumn) {
        const p = byName.get(String(t.primaryColumn));
        if (p != null) db.prepare("UPDATE sheets SET primary_column_id = ? WHERE id = ?").run(p, sheetId);
      }
      for (const [k, v] of (t.views ?? []).entries()) {
        db.prepare("INSERT INTO views (sheet_id, name, position, row_height, search) VALUES (?, ?, ?, ?, ?)").run(
          sheetId, String((v as any).name ?? `View ${k + 1}`).slice(0, 120), k,
          String((v as any).rowHeight ?? "default"), str((v as any).search),
        );
        if ((v as any).filtersDropped) {
          notes.push(`The view "${(v as any).name}" had filters that a shared file does not carry. It arrived showing every row.`);
        }
      }
    }

    // Relations, then the lookup fields that read through them.
    for (const r of d.relations ?? []) {
      const fromSheet = sheetIds.get(String(r.fromTable));
      const toSheet = sheetIds.get(String(r.toTable));
      const fromCol = colIds.get(String(r.fromTable))?.get(String(r.fromColumn));
      const toCol = colIds.get(String(r.toTable))?.get(String(r.toColumn));
      if (!fromSheet || !toSheet || fromCol == null || toCol == null) {
        notes.push(`The link between "${r.fromTable}" and "${r.toTable}" could not be rebuilt.`);
        continue;
      }
      const relId = Number(
        db.prepare(
          `INSERT INTO relations (workbook_id, from_sheet_id, from_column_id, to_sheet_id, to_column_id, cardinality, match_mode)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          newId, fromSheet, fromCol, toSheet, toCol,
          String(r.cardinality) === "one_to_one" ? "one_to_one" : "many_to_one",
          ["exact", "normalized", "fuzzy"].includes(String(r.matchMode)) ? String(r.matchMode) : "normalized",
        ).lastInsertRowid,
      );

      // Every lookup/rollup column on either side of this link now has a link to point at. The FIELD
      // it reads is named on the far table, which is why this waits until both ends exist.
      for (const side of [
        { sheetId: fromSheet, tableName: String(r.fromTable), far: String(r.toTable) },
        { sheetId: toSheet, tableName: String(r.toTable), far: String(r.fromTable) },
      ]) {
        const table = d.tables.find((t) => String(t.name) === side.tableName);
        const farCols = colIds.get(side.far);
        if (!table || !farCols) continue;
        for (const c of table.columns ?? []) {
          const kind = String((c as any).kind);
          if (kind !== "lookup" && kind !== "rollup") continue;
          const id = colIds.get(side.tableName)?.get(String((c as any).name ?? ""));
          if (id == null) continue;
          const field = (c as any).lookupColumn == null ? null : farCols.get(String((c as any).lookupColumn)) ?? null;
          db.prepare("UPDATE columns SET relation_id = ?, lookup_column_id = ? WHERE id = ? AND relation_id IS NULL")
            .run(relId, field, id);
        }
      }
    }

    if (missing.size > 0) {
      notes.push(
        `${missing.size} reference${missing.size === 1 ? "" : "s"} could not be matched to a column: ` +
        `${[...missing].slice(0, 6).join(", ")}${missing.size > 6 ? "…" : ""}. They were left as written.`,
      );
    }
    if (scriptsPending > 0) {
      notes.push(
        `${scriptsPending} script${scriptsPending === 1 ? "" : "s"} arrived unapproved. This file came from ` +
        `outside this machine — read each one before approving it.`,
      );
    }
    notes.push("Nothing in this workbook is set to run on its own. Turn on what you want after checking it.");

    return {
      workbook: getWorkbook(newId)!,
      tables: sheetIds.size,
      columns: columnCount,
      rows: 0,
      scriptsPending,
      notes,
    };
  });
}

/**
 * Columns whose own definition carries something credential-shaped.
 *
 * A key typed straight into a header is part of the column, so it travels into a duplicate, a
 * template and an exported file — `secrets.ts` opens by calling that the worst thing in the product,
 * and the column-template dialog has always warned about it. The workbook export did not: its menu
 * item promised "never a key", which is the one direction a safety claim must never be wrong in.
 *
 * So the export ASKS FIRST rather than either lying or silently stripping. Stripping would be worse
 * than it sounds — the file would import as a column that looks complete and 401s on every row, and
 * the person who received it has no way to know what was removed.
 *
 * Detection is `wasRedacted`, so there is exactly ONE definition in this product of what looks like
 * a credential, and a shape added to it protects this path the same day.
 */
export function literalSecretsIn(workbookId: string): Array<{ table: string; column: string }> {
  const rows = db
    .prepare(
      `SELECT s.name AS sheet_name, c.name AS column_name, c.http_config, c.prompt, c.mcp_config
         FROM columns c
         JOIN sheets s ON s.id = c.sheet_id
        WHERE s.workbook_id = ? AND s.deleted_at IS NULL AND c.deleted_at IS NULL
        ORDER BY s.position, c.position`,
    )
    .all(workbookId) as any[];

  const out: Array<{ table: string; column: string }> = [];
  for (const r of rows) {
    const blob = [r.http_config, r.prompt, r.mcp_config].filter(Boolean).join("\n");
    if (wasRedacted(stripSecretRefs(blob))) {
      out.push({ table: String(r.sheet_name), column: String(r.column_name) });
    }
  }
  return out;
}

/**
 * Links this workbook holds that its exported file cannot carry.
 *
 * A relation is written by NAME, and a name only means something if the file contains that table. So
 * a link with one end in another workbook is dropped on the way out — silently, until now, which
 * made an exported workbook quietly smaller than the one it was exported from.
 *
 * Moving a table between workbooks is refused while it is linked, so new spanning links cannot be
 * made. This exists for the ones already sitting in databases from before that refusal.
 */
export function droppedRelationsIn(workbookId: string): Array<{ table: string; otherTable: string }> {
  return (
    db
      .prepare(
        `SELECT f.name AS from_name, t.name AS to_name,
                f.workbook_id AS from_wb, t.workbook_id AS to_wb
           FROM relations r
           JOIN sheets f ON f.id = r.from_sheet_id
           JOIN sheets t ON t.id = r.to_sheet_id
          WHERE r.workbook_id = ? AND f.deleted_at IS NULL AND t.deleted_at IS NULL`,
      )
      .all(workbookId) as any[]
  )
    .filter((r) => String(r.from_wb ?? "") !== workbookId || String(r.to_wb ?? "") !== workbookId)
    .map((r) => {
      const inside = String(r.from_wb ?? "") === workbookId;
      return {
        table: inside ? String(r.from_name) : String(r.to_name),
        otherTable: inside ? String(r.to_name) : String(r.from_name),
      };
    });
}

/**
 * Remove `{{secret:Name}}` references before asking whether anything looks like a credential.
 *
 * The reference is the SAFE form — a name, whose value lives outside the database — but the redactor
 * flags it anyway, because one of its patterns matches anything that NAMES itself a secret
 * (`secret:…`), which is right for masking log text and wrong here. Without this, the export warning
 * would fire on the exact habit the product is trying to teach, and a warning that goes off on
 * correct usage is dismissed by reflex, which costs more than never having written it.
 */
function stripSecretRefs(text: string): string {
  return text.replace(/\{\{\s*secret\s*:[^}]*\}\}/gi, "");
}

// The hand-written column-kind list that used to live here is gone. It knew nine of the eleven
// kinds, and `isColumnKind` derives from COLUMN_KINDS, so a kind added tomorrow is understood here
// the day it is added rather than silently degrading to `static`.

/**
 * An imported column's web-request settings, through the same normaliser a saved column goes through
 * — the one `PATCH /columns` and the AI setup lane both use.
 *
 * This was the one writer that stored the file's own JSON verbatim, and two of the fields in it
 * decide what this machine contacts and for how long. `allowPrivate` on a FIXED private host —
 * `169.254.169.254`, or this engine's own port — survived every later check, because every later
 * check is asking whether the host was authored rather than interpolated, and a hand-written file
 * answers yes. `timeoutMs` arrived unbounded by the same route.
 *
 * `allowPrivate` is additionally cleared rather than merely normalised: reaching the operator's own
 * network is a choice only the person now holding the file can make, and it is one tick-box to make
 * it. Same rule as scripts arriving unapproved and schedules arriving switched off.
 */
function importHttpConfig(raw: unknown, columnName: string, notes: string[]): string | null {
  if (!raw || typeof raw !== "object") return null;
  try {
    return JSON.stringify(normalizeHttpConfig({ ...(raw as Record<string, unknown>), allowPrivate: false }));
  } catch (e) {
    notes.push(
      `The web request settings on "${columnName}" could not be read ` +
      `(${e instanceof Error ? e.message : String(e)}), so that column arrived without them.`,
    );
    return null;
  }
}

const normalKey = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "col";
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const posInt = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};
