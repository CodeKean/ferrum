// Columns you can keep and use again.
//
// Every real workspace ends up with the same handful of columns rebuilt from memory on table after
// table — "find the company's careers page", "classify this into our five segments", "call the
// enrichment API and pull the headcount". Rebuilding one means retyping the instruction, re-picking
// the model, re-entering the request, and getting it subtly different every time. A template is the
// column, kept.
//
// ── Why references are stored BY NAME ───────────────────────────────────────────────────────────
//
// A prompt stores `{{col:17}}`, because that survives a rename. Column 17 exists on ONE table, so a
// template holding that id is a template that can only ever be applied back to the table it came
// from — and worse, applied elsewhere it would silently point at whatever column happens to have
// that id there, producing a prompt about the wrong field with no error anywhere.
//
// So a template converts every reference to its column's NAME on the way in, and back to the target
// table's ids on the way out. `{{Website}}` means the same thing on every table that has a Website.
//
// What that cannot do is invent a column that is not there. So a template also records what it
// needs, and applying it reports what was missing rather than quietly producing a prompt with a
// dangling reference — which is the failure that looks like a working column and returns nonsense.
//
// ── Why a template's scripts arrive UNAPPROVED ─────────────────────────────────────────────────
//
// A script column runs code. Scripts in this workspace only ever run after someone has read them and
// approved that exact text, and a template is precisely the path by which code arrives from
// somewhere else — another table, an export, eventually another person. Carrying the approval across
// would make "apply a template" a way to execute code nobody in this workspace has read.
//
// So the code comes with the template and the approval does not. The copy is stored, shown, and
// refused until it has been read here.

import { createHash } from "node:crypto";
import { db, tx } from "./db.ts";
import { canonicalizeRefs, parseRefs, renderRefNames } from "./refs.ts";
import { addColumn, getColumn, listColumns, moveColumn } from "./store.ts";
import { getScript } from "./scripts.ts";
import type { Column } from "./types.ts";

/** The fields that make a column behave the way it does. Presentation and data are not among them. */
const BODY_FIELDS = [
  "prompt", "model", "maxTurns", "maxBudgetUsd", "timeoutMs", "allowedTools", "mcpServers",
  "agent", "httpConfig", "enumValues", "jsonSchema", "description",
  "onUpstreamEmpty", "onUpstreamError", "autoRecompute", "autoRun",
] as const;

/** Every string in a column's definition that can hold a `{{reference}}`. */
const REF_BEARING = new Set(["prompt", "description"]);

export interface TemplateScript {
  hook: string;
  runtime: string;
  intent: string;
  code: string;
}

export interface ColumnTemplate {
  id: number;
  name: string;
  description: string;
  /** A user's own grouping — "Enrichment", "Scoring". Free text; empty is a real, common answer. */
  category: string;
  kind: string;
  valueType: string;
  /** The column definition, with every reference written as a NAME. */
  body: Record<string, unknown>;
  scripts: TemplateScript[];
  /** Column names this template's references need to find on the table it is applied to. */
  requires: string[];
  uses: number;
  createdAt: string;
  updatedAt: string;
}

const row = (r: any): ColumnTemplate => ({
  id: Number(r.id),
  name: String(r.name),
  description: String(r.description ?? ""),
  category: String(r.category ?? ""),
  kind: String(r.kind),
  valueType: String(r.value_type),
  body: JSON.parse(String(r.body_json ?? "{}")),
  scripts: JSON.parse(String(r.scripts_json ?? "[]")),
  requires: JSON.parse(String(r.requires_json ?? "[]")),
  uses: Number(r.uses ?? 0),
  createdAt: String(r.created_at ?? ""),
  updatedAt: String(r.updated_at ?? ""),
});

export function listColumnTemplates(): ColumnTemplate[] {
  // Most-used first, then most recent. A gallery ordered by id makes the one you reach for daily
  // sink further every time you add another.
  return (db
    .prepare("SELECT * FROM column_templates ORDER BY uses DESC, updated_at DESC")
    .all() as any[]).map(row);
}

export function getColumnTemplate(id: number): ColumnTemplate | null {
  const r = db.prepare("SELECT * FROM column_templates WHERE id = ?").get(Number(id)) as any;
  return r ? row(r) : null;
}

/** Which of a column's names a piece of text refers to — the template's shopping list. */
function refNamesIn(text: string, sheetId: string, selfId: number): string[] {
  const { ids } = parseRefs(text, { sheetId, selfId });
  const names = new Map<number, string>();
  for (const c of listColumns(sheetId)) names.set(Number(c.id), c.name);
  return ids.map((id) => names.get(Number(id))).filter((n): n is string => !!n);
}

/**
 * Keep a column as a template.
 *
 * Snapshots what the column DOES, never what it holds: no cells, no run history, no stats. And never
 * a credential — an HTTP column's headers travel as written, so a key typed directly into a header
 * would travel with it. That is why the API-key store exists and why this refuses to look for one:
 * the honest guard is at the point where a template LEAVES the machine, and it is stated on screen.
 */
export function saveColumnTemplate(
  columnId: number,
  meta: { name?: string; description?: string; category?: string },
): ColumnTemplate {
  const col = getColumn(columnId);
  if (!col) throw new Error("That column no longer exists.");

  const body: Record<string, unknown> = {};
  const requires = new Set<string>();

  for (const f of BODY_FIELDS) {
    const v = (col as any)[f];
    if (v == null) continue;
    if (typeof v === "string" && REF_BEARING.has(f)) {
      // Ids out, names in — see the header. Recorded as a requirement in the same pass, so the two
      // can never disagree about what this template needs.
      for (const n of refNamesIn(v, col.sheetId, Number(col.id))) requires.add(n);
      body[f] = renderRefNames(v, col.sheetId);
      continue;
    }
    body[f] = v;
  }

  // An HTTP column's references live inside its config, not in a prompt. Walked as a whole so a
  // reference in a query value, a header or a body field is converted like any other.
  if (col.httpConfig) {
    const asText = JSON.stringify(col.httpConfig);
    for (const n of refNamesIn(asText, col.sheetId, Number(col.id))) requires.add(n);
    body.httpConfig = JSON.parse(renderRefNames(asText, col.sheetId));
  }

  const scripts: TemplateScript[] = [];
  for (const id of [col.conditionScriptId, col.transformScriptId]) {
    if (id == null) continue;
    const s = getScript(Number(id));
    if (s) scripts.push({ hook: s.hook, runtime: s.runtime, intent: s.intent, code: s.code });
  }

  const made = db
    .prepare(
      `INSERT INTO column_templates (name, description, category, kind, value_type, body_json, scripts_json, requires_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      String(meta.name ?? col.name).trim().slice(0, 120) || col.name,
      String(meta.description ?? "").trim().slice(0, 500),
      String(meta.category ?? "").trim().slice(0, 60),
      col.kind,
      col.valueType,
      JSON.stringify(body),
      JSON.stringify(scripts),
      JSON.stringify([...requires]),
    ) as any;

  return getColumnTemplate(Number(made.id))!;
}

export function updateColumnTemplate(
  id: number,
  patch: { name?: string; description?: string; category?: string },
): ColumnTemplate {
  const before = getColumnTemplate(id);
  if (!before) throw new Error("That template no longer exists.");
  db.prepare(
    "UPDATE column_templates SET name = ?, description = ?, category = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(
    String(patch.name ?? before.name).trim().slice(0, 120) || before.name,
    String(patch.description ?? before.description).trim().slice(0, 500),
    String(patch.category ?? before.category).trim().slice(0, 60),
    Number(id),
  );
  return getColumnTemplate(id)!;
}

export function deleteColumnTemplate(id: number): void {
  db.prepare("DELETE FROM column_templates WHERE id = ?").run(Number(id));
}

export interface ApplyResult {
  column: Column;
  /** Names the template needed that this table does not have. The reference is left as written. */
  missing: string[];
  /** Scripts copied across, all of them unapproved — see the header. */
  scriptsPending: number;
}

/**
 * What a template would find, WITHOUT creating anything.
 *
 * Applying and then reading a warning is the wrong order for a column that may be paid: the answer
 * to "this table has no Website" is usually "apply it somewhere else", and by then the column
 * exists. So the same matching runs first, on its own.
 */
export function checkColumnTemplate(id: number, sheetId: string): { missing: string[]; matched: string[] } {
  const t = getColumnTemplate(id);
  if (!t) throw new Error("That template no longer exists.");
  const have = new Map(listColumns(sheetId).map((c) => [normal(c.name), c.name]));
  const missing: string[] = [];
  const matched: string[] = [];
  for (const need of t.requires) {
    if (have.has(normal(need))) matched.push(need);
    else missing.push(need);
  }
  return { missing, matched };
}

/** The same folding `canonicalizeRefs` uses, so "check" and "apply" cannot disagree. */
const normal = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function applyColumnTemplate(id: number, sheetId: string, name?: string): ApplyResult {
  const t = getColumnTemplate(id);
  if (!t) throw new Error("That template no longer exists.");

  const { missing } = checkColumnTemplate(id, sheetId);

  return tx(() => {
    const made = addColumn(sheetId, {
      name: String(name ?? t.name).trim() || t.name,
      kind: t.kind as any,
      valueType: t.valueType as any,
    });
    const colId = Number(made.id);

    // Names back to ids, against the TABLE THIS LANDS ON. A name with no match here is left exactly
    // as written rather than dropped: `{{Website}}` in a prompt is at least legible as a thing that
    // did not resolve, where a silent deletion leaves an instruction that reads as complete and is
    // about nothing.
    const body = { ...t.body };
    for (const f of Object.keys(body)) {
      if (typeof body[f] === "string" && REF_BEARING.has(f)) {
        body[f] = canonicalizeRefs(body[f] as string, sheetId);
      }
    }
    if (body.httpConfig) {
      body.httpConfig = JSON.parse(canonicalizeRefs(JSON.stringify(body.httpConfig), sheetId));
    }

    db.prepare(
      `UPDATE columns
          SET prompt = ?, model = ?, max_turns = ?, max_budget_usd = ?, timeout_ms = ?,
              allowed_tools = ?, mcp_servers = ?, agent_json = ?, http_config = ?,
              enum_values = ?, json_schema = ?, description = ?,
              on_upstream_empty = ?, on_upstream_error = ?, auto_recompute = ?,
              auto_run = ?
        WHERE id = ?`,
    ).run(
      str(body.prompt), str(body.model) ?? "auto",
      num(body.maxTurns, 6), body.maxBudgetUsd == null ? null : Number(body.maxBudgetUsd),
      num(body.timeoutMs, 60_000),
      JSON.stringify(body.allowedTools ?? []),
      JSON.stringify(body.mcpServers ?? []),
      body.agent ? JSON.stringify(body.agent) : null,
      body.httpConfig ? JSON.stringify(body.httpConfig) : null,
      body.enumValues ? JSON.stringify(body.enumValues) : null,
      body.jsonSchema ? JSON.stringify(body.jsonSchema) : null,
      str(body.description),
      str(body.onUpstreamEmpty) ?? "skip",
      str(body.onUpstreamError) ?? "skip",
      body.autoRecompute ? 1 : 0,
      /**
       * auto_run is deliberately NOT carried across.
       *
       * It is the one field in a template that starts spending money without anyone pressing
       * anything. Applying a template is a setup step, and a setup step that silently arms a column
       * to run itself is the same mistake as a schedule that switches itself on. Turn it on here,
       * after looking at what arrived.
       */
      0,
      colId,
    );

    // Code travels; approval does not. See the header.
    for (const s of t.scripts) {
      db.prepare(
        `INSERT INTO scripts (column_id, hook, runtime, intent, code, hash, approved_at, refs)
         VALUES (?, ?, ?, ?, ?, ?, NULL, '[]')`,
      ).run(colId, s.hook, s.runtime, s.intent, s.code, createHash("sha256").update(s.code).digest("hex"));
    }

    db.prepare("UPDATE column_templates SET uses = uses + 1 WHERE id = ?").run(Number(id));

    // At the end of the table, where a new column belongs — a template applied into the middle of
    // someone's column order would be a surprise, not a convenience.
    const order = listColumns(sheetId).map((c) => Number(c.id));
    moveColumn(colId, order.length - 1);

    return { column: getColumn(colId)!, missing, scriptsPending: t.scripts.length };
  });
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
