// Column references, the dependency graph, and cycle detection.
//
// A reference is stored as {{col:<id>}} — an ID, never a name. That single choice means renaming a
// column can never break a prompt, a script, or a run condition, and it is why the `/` menu inserts
// a chip rather than literal text. Names are resolved for DISPLAY only.
//
// Legacy/typed-by-hand {{Column Name}} is still accepted on save and rewritten to the id form, so a
// pasted prompt from elsewhere works — but an unresolvable name is REJECTED rather than passed
// through. A literal {{Website}} reaching a model is a silent data-quality disaster: it looks fine
// on row 1 and quietly poisons all 1,000,000.

import { db, getKv, setKv, tx } from "./db.ts";
import { normalizeKey } from "./store.ts";
import { markColumnDirty } from "./columnStats.ts";
import { markCellsDirty } from "./bus.ts";

/**
 * Canonical form: {{col:123}}. Also matches the by-name form for migration.
 *
 * Four shapes, and the last three were all silently unmatched before:
 *
 *   {{col:12}}            required, whole value
 *   {{col:12?}}           OPTIONAL
 *   {{col:12.industry}}   a path into a structured value
 *   {{col:12.industry?}}  both
 *
 * The old pattern was `col:(\d+)` followed straight by `}}`, so anything between the digits and the
 * braces made the whole reference match NOTHING. Not an error, not an unknown name — invisible. And
 * this is the function the DEPENDENCY GRAPH is built from, so an invisible reference is a missing
 * edge: the column reads another column that nothing recorded it as depending on, so it is ordered at
 * depth 0 and runs BEFORE its own input is filled. On a paid lane that is a full sheet of confident
 * answers about blank inputs.
 *
 * Nothing in the live database used either form yet, so no existing edge is wrong — but the editor
 * already offers the optional toggle, so this was one click away at any time.
 *
 * The same shape as `STORED` in refText.ts, which is the display-side parser. The two must agree, so
 * they are changed together or not at all.
 */
const REF_RE = /\{\{\s*(?:col:(\d+)((?:\.[A-Za-z0-9_$-]+|\[\d+\])*)(\?)?|([^{}:?]+?)(\?)?)\s*\}\}/g;

export interface ParsedRefs {
  /** Column ids referenced, deduped, in first-appearance order. */
  ids: number[];
  /** Names that could not be resolved to a column. */
  unknown: string[];
}

export interface ResolveContext {
  sheetId: string;
  /** Column being edited, so a self-reference can be reported distinctly. */
  selfId?: number;
}

/** Build name -> id for a table, keyed on the normalized form. */
function keyMap(sheetId: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of db.prepare("SELECT id, key FROM columns WHERE sheet_id = ? AND deleted_at IS NULL").all(sheetId) as any[]) {
    m.set(r.key, Number(r.id));
  }
  return m;
}

export function parseRefs(text: string | null | undefined, ctx: ResolveContext): ParsedRefs {
  if (!text) return { ids: [], unknown: [] };
  const keys = keyMap(ctx.sheetId);
  const valid = new Set(keys.values());

  const ids: number[] = [];
  const unknown: string[] = [];
  const seen = new Set<number>();

  for (const m of text.matchAll(REF_RE)) {
    // A path and the optional marker are deliberately ignored here. Both change what is READ out of
    // the column; neither changes the fact that this column depends on it. An optional reference
    // still has to run second — "may be blank" is not "may be stale".
    const [, id, , , name] = m;
    if (id) {
      const n = Number(id);
      // An id pointing at a deleted column, or at another table, is not silently dropped.
      if (!valid.has(n)) { unknown.push(`col:${n}`); continue; }
      if (!seen.has(n)) { seen.add(n); ids.push(n); }
    } else if (name) {
      const hit = keys.get(normalizeKey(name));
      if (hit == null) { unknown.push(name.trim()); continue; }
      if (!seen.has(hit)) { seen.add(hit); ids.push(hit); }
    }
  }
  return { ids, unknown };
}

/**
 * Rewrite any by-name references into the canonical id form.
 *
 * The path and the optional marker are carried through unchanged. Dropping either would be a silent
 * rewrite of what the user asked for: losing the `?` turns an optional reference back into a required
 * one, so rows that were meant to run anyway start being skipped, and losing a path widens
 * `/Contact.email` to the whole JSON blob — both on nothing more than a save.
 */
export function canonicalizeRefs(text: string, sheetId: string): string {
  const keys = keyMap(sheetId);
  const byName = text.replace(REF_RE, (whole, idPart, path, idOpt, namePart, nameOpt) => {
    if (idPart) return `{{col:${idPart}${path ?? ""}${idOpt ?? ""}}}`;
    const hit = keys.get(normalizeKey(namePart));
    return hit != null ? `{{col:${hit}${nameOpt ?? ""}}}` : whole;
  });
  return canonicalizeSlashRefs(byName, sheetId);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Turn a plain `/Column Name` into a real reference.
 *
 * The `/` menu inserts a chip, so nobody clicking through the UI produces this. Everybody else does:
 * a prompt pasted from a document, a column configured over the API, or anyone who simply typed the
 * name out instead of picking it from the list — which the field's own hint, "Type / to put another
 * column's value in", invites.
 *
 * Until this, that text was stored and SENT verbatim. `What industry is /Company in?` went to the
 * model with the words "/Company" in it and no value substituted, on every row, with no pill in the
 * editor and no warning anywhere. That is precisely the silent poisoning this file's header warns
 * about, arriving through the door the interface advertises.
 *
 * Only an EXACT match against a live column converts. A slash followed by something that is not a
 * column name is ordinary text — a date, "and/or", a URL — and is left alone; a lookbehind keeps it
 * off `https://Company` and anything glued to a word. Longest name first, so a sheet with both
 * "Company" and "Company Size" cannot have the short one swallow the long one's tail.
 */
export function canonicalizeSlashRefs(text: string, sheetId: string): string {
  if (!text.includes("/")) return text;
  const cols = (db
    .prepare("SELECT id, name FROM columns WHERE sheet_id = ? AND deleted_at IS NULL")
    .all(sheetId) as Array<{ id: number; name: string }>)
    .filter((c) => c.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  if (cols.length === 0) return text;

  const byName = new Map(cols.map((c) => [c.name.trim().toLowerCase(), Number(c.id)]));
  const alt = cols.map((c) => escapeRe(c.name.trim())).join("|");
  // An existing {{...}} is matched FIRST and passed straight through, so a reference that already
  // contains a slash in a path is never chewed up by the second half of this pattern.
  const re = new RegExp(`\\{\\{[^{}]*\\}\\}|(?<![\\w/])/(${alt})(?![\\w-])`, "gi");

  return text.replace(re, (whole, name?: string) => {
    if (name === undefined) return whole;
    const id = byName.get(name.trim().toLowerCase());
    return id == null ? whole : `{{col:${id}}}`;
  });
}

/** Render references as names, for display in an editor chip or an error message. */
export function renderRefNames(text: string, sheetId: string): string {
  const names = new Map<number, string>();
  for (const r of db.prepare("SELECT id, name FROM columns WHERE sheet_id = ? AND deleted_at IS NULL").all(sheetId) as any[]) {
    names.set(Number(r.id), r.name);
  }
  // The path and the marker stay visible. An error message naming `{{Contact}}` when the rule really
  // reads `{{Contact.email?}}` sends the reader looking at the wrong thing.
  return text.replace(REF_RE, (whole, idPart, path, idOpt) =>
    idPart
      ? `{{${names.get(Number(idPart)) ?? `deleted column ${idPart}`}${path ?? ""}${idOpt ?? ""}}}`
      : whole,
  );
}

/** Suggest a replacement for an unresolvable name (edit distance over the table's column names). */
export function suggestColumn(name: string, sheetId: string): string | null {
  const target = normalizeKey(name);
  let best: { name: string; d: number } | null = null;
  for (const r of db.prepare("SELECT name, key FROM columns WHERE sheet_id = ? AND deleted_at IS NULL").all(sheetId) as any[]) {
    const d = editDistance(target, r.key);
    if (!best || d < best.d) best = { name: r.name, d };
  }
  // Only offer a suggestion that is actually close; a wrong one is worse than none.
  return best && best.d <= Math.max(2, Math.floor(target.length / 3)) ? best.name : null;
}

function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  const cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = cur.slice();
  }
  return prev[n]!;
}

/**
 * Find the columns a generated script reads through its `row` object.
 *
 * Generated code does not use {{col:7}} — it reads `row.website`, because that is what makes it
 * legible in review. So the dependency set must be derived from those accesses too, not only from
 * template references.
 *
 * Getting this wrong is silent and total: without it a script receives an EMPTY row object, every
 * rule evaluates against undefined, and a condition gate quietly rejects every row while looking
 * like it ran fine.
 */
export function parseRowAccesses(code: string | null | undefined, sheetId: string): number[] {
  if (!code) return [];

  // Column keys are exposed to scripts with whitespace collapsed to underscores.
  const byScriptKey = new Map<string, number>();
  for (const r of db.prepare("SELECT id, key FROM columns WHERE sheet_id = ? AND deleted_at IS NULL").all(sheetId) as any[]) {
    byScriptKey.set(String(r.key).replace(/\s+/g, "_"), Number(r.id));
  }

  const found = new Set<number>();
  const add = (name: string) => {
    const id = byScriptKey.get(name.toLowerCase());
    if (id != null) found.add(id);
  };

  // row.website / row?.website
  for (const m of code.matchAll(/\browS?\s*\??\.\s*([A-Za-z_$][\w$]*)/g)) add(m[1]!);
  // row["website"] / row['website']
  for (const m of code.matchAll(/\brow\s*\??\[\s*["']([^"']+)["']\s*\]/g)) add(m[1]!);
  // PowerShell / bash: $r.values.website  or  .values.website
  for (const m of code.matchAll(/\.values\s*\.\s*([A-Za-z_$][\w$]*)/g)) add(m[1]!);
  for (const m of code.matchAll(/\.values\s*\[\s*["']([^"']+)["']\s*\]/g)) add(m[1]!);

  return [...found];
}

// ─────────────────────────────────────────────────────────────── dependency graph

export type DepVia = "prompt" | "transform" | "condition" | "http" | "mcp" | "send";

/**
 * The column ids a `send` configuration reads, straight out of its stored JSON.
 *
 * A send column's references are not text. They are column IDS inside a JSON blob — the mapping's
 * sources, the match key, and the list being exploded — so a dependency scan that only reads prompts
 * and script code finds none of them and reports that a send column depends on nothing.
 *
 * That is not a cosmetic gap. `topoDepths` then gives it depth 0, so it sorts AHEAD of every column
 * it reads: the send runs first, writes a table full of nulls, and — because the match key resolved
 * to null too — those rows can never be matched again, so the later, correct run duplicates the
 * destination instead of repairing it. Cycle detection and the stale cascade both come free once the
 * edges exist.
 */
function sendDeps(raw: unknown, live: Set<number>): number[] {
  if (typeof raw !== "string" || !raw) return [];
  let cfg: any;
  // A malformed blob means no edges, never a thrown save: this runs on every dependency rebuild.
  try { cfg = JSON.parse(raw); } catch { return []; }
  if (!cfg || typeof cfg !== "object") return [];

  const out: number[] = [];
  // Only a column that still exists on this table can be depended on — a mapping left pointing at a
  // hard-deleted column would otherwise fail the edge's foreign key and take the whole save with it.
  const add = (v: unknown): void => {
    const id = Number(v);
    if (Number.isFinite(id) && live.has(id) && !out.includes(id)) out.push(id);
  };
  const fromRow = (s: any): void => { if (s && s.from === "row") add(s.columnId); };

  for (const entry of Object.values(cfg.mapping ?? {})) fromRow(entry);
  fromRow(cfg.keySource);
  // `per_item` explodes one column's cell, so the send cannot run before that cell is filled.
  if (cfg.listColumnId != null) add(cfg.listColumnId);
  return out;
}

/**
 * Rewrite a column's dependency edges from all of its reference-bearing fields.
 *
 * Conditions produce edges exactly like prompts do. That is not a detail: a run condition reading
 * {{Country}} means the column genuinely depends on Country, so it must be ordered after it, and
 * must go stale when it changes. Treating conditions as "just config" is how a gate silently
 * evaluates against an empty upstream. A send column's destination mapping is the same argument in
 * a different shape — see `sendDeps`.
 */
export function rebuildDeps(sheetId: string, columnId: number): void {
  const col = db.prepare("SELECT * FROM columns WHERE id = ?").get(columnId) as any;
  if (!col) return;

  const extra: Array<{ via: DepVia; id: number }> = [];
  if (col.send_config) {
    for (const id of sendDeps(col.send_config, new Set(keyMap(sheetId).values()))) {
      extra.push({ via: "send", id });
    }
  }
  const sources: Array<{ via: DepVia; text: string | null }> = [
    { via: "prompt", text: col.prompt },
    { via: "http", text: col.http_config },
    // Parsed out of the raw JSON as TEXT, like http_config above: the refs live in argument values,
    // and scanning the blob finds them without walking a shape this file would then have to track.
    // Missing these is not cosmetic — the column lands at depth 0 and runs before its inputs exist.
    { via: "mcp", text: col.mcp_config },
  ];
  for (const [field, via] of [["transform_script_id", "transform"], ["condition_script_id", "condition"]] as const) {
    if (col[field] != null) {
      const s = db.prepare("SELECT code, intent FROM scripts WHERE id = ?").get(col[field]) as any;
      // Both the generated CODE and the plain-English INTENT can carry references.
      if (s) sources.push({ via, text: `${s.intent ?? ""}\n${s.code ?? ""}` });

      // AND the row accesses in the code, which the template parser cannot see.
      //
      // This was the gap, and it was silent and expensive. A generated script reads its inputs as
      // `row.website`, not as `{{col:17}}` — saveScript says so in as many words and takes the union
      // of both parsers before it validates. This function, which writes the graph the ENGINE runs
      // on, used only the template half. So a script column that reads another column recorded NO
      // dependency at all, and the consequences were not cosmetic:
      //
      //   topological order — it landed at depth 0 and could run BEFORE the column it reads.
      //     Measured on two script columns, the consumer named first in the request: it produced
      //     "saw:NOTHING" and reported success. A wrong answer, silently, with no error anywhere.
      //   cycle detection   — could not see a loop between two script columns.
      //   the stale cascade — had no edge to follow, so editing an input marked nothing out of date.
      //
      // One parser per question was never the design; this restores the union saveScript documents.
      if (s?.code) {
        for (const dep of parseRowAccesses(s.code, sheetId)) extra.push({ via, id: dep });
      }
    }
  }

  db.prepare("DELETE FROM column_deps WHERE column_id = ?").run(columnId);
  const ins = db.prepare(
    "INSERT OR IGNORE INTO column_deps (sheet_id, column_id, depends_on, via) VALUES (?, ?, ?, ?)",
  );
  for (const src of sources) {
    const { ids } = parseRefs(src.text, { sheetId, selfId: columnId });
    for (const dep of ids) {
      if (dep === columnId) continue; // self-reference is rejected at save time, not recorded
      ins.run(sheetId, columnId, dep, src.via);
    }
  }
  for (const e of extra) {
    if (e.id !== columnId) ins.run(sheetId, columnId, e.id, e.via);
  }
}

export interface CycleResult {
  ok: boolean;
  /** Column names along the cycle, e.g. ["Price", "Currency", "Price"]. */
  path?: string[];
}

/**
 * Detect a cycle across the whole table's graph.
 *
 * Kahn's algorithm first (cheap, tells us IF there is a cycle), then a DFS restricted to the
 * residual nodes to recover an actual path — because "circular reference" without naming the loop
 * is unactionable when a table has thirty columns.
 */
export function detectCycle(sheetId: string): CycleResult {
  const nodes = (db.prepare("SELECT id, name FROM columns WHERE sheet_id = ? AND deleted_at IS NULL").all(sheetId) as any[]);
  const names = new Map<number, string>(nodes.map((n) => [Number(n.id), n.name]));

  const edges = db.prepare("SELECT DISTINCT column_id, depends_on FROM column_deps WHERE sheet_id = ?").all(sheetId) as any[];
  const out = new Map<number, number[]>();
  const indegree = new Map<number, number>();
  for (const n of nodes) { out.set(Number(n.id), []); indegree.set(Number(n.id), 0); }
  for (const e of edges) {
    const from = Number(e.depends_on), to = Number(e.column_id);
    if (!out.has(from) || !out.has(to)) continue;
    out.get(from)!.push(to);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }

  const queue = [...indegree].filter(([, d]) => d === 0).map(([id]) => id);
  const removed = new Set<number>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    removed.add(id);
    for (const next of out.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  const residual = [...out.keys()].filter((id) => !removed.has(id));
  if (residual.length === 0) return { ok: true };

  // Recover a concrete cycle inside the residual set.
  const inResidual = new Set(residual);
  const stack: number[] = [];
  const onStack = new Set<number>();
  const visited = new Set<number>();
  let found: number[] | null = null;

  const dfs = (id: number): void => {
    if (found) return;
    visited.add(id);
    stack.push(id);
    onStack.add(id);
    for (const next of out.get(id) ?? []) {
      if (!inResidual.has(next) || found) continue;
      if (onStack.has(next)) {
        found = [...stack.slice(stack.indexOf(next)), next];
        return;
      }
      if (!visited.has(next)) dfs(next);
    }
    stack.pop();
    onStack.delete(id);
  };
  for (const id of residual) { if (!visited.has(id)) dfs(id); if (found) break; }

  return {
    ok: false,
    path: (found ?? residual).map((id) => names.get(id) ?? `column ${id}`),
  };
}

/**
 * Topological depth per column: 0 for a column with no dependencies, otherwise one more than its
 * deepest upstream. The queue orders jobs by this, so a row's cells run in a valid order without a
 * barrier between depths.
 */
export function topoDepths(sheetId: string): Map<number, number> {
  const edges = db.prepare("SELECT DISTINCT column_id, depends_on FROM column_deps WHERE sheet_id = ?").all(sheetId) as any[];
  const deps = new Map<number, number[]>();
  for (const r of db.prepare("SELECT id FROM columns WHERE sheet_id = ? AND deleted_at IS NULL").all(sheetId) as any[]) {
    deps.set(Number(r.id), []);
  }
  for (const e of edges) {
    deps.get(Number(e.column_id))?.push(Number(e.depends_on));
  }

  const depth = new Map<number, number>();
  const visiting = new Set<number>();
  const walk = (id: number): number => {
    const hit = depth.get(id);
    if (hit != null) return hit;
    // A cycle is rejected at save time; this guard only stops a stale graph from recursing forever.
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let d = 0;
    for (const up of deps.get(id) ?? []) d = Math.max(d, walk(up) + 1);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const id of deps.keys()) walk(id);
  return depth;
}

/** Every column downstream of `columnId`, transitively. Used by the stale cascade. */
export function transitiveDownstream(sheetId: string, columnId: number): number[] {
  const edges = db.prepare("SELECT DISTINCT column_id, depends_on FROM column_deps WHERE sheet_id = ?").all(sheetId) as any[];
  const out = new Map<number, number[]>();
  for (const e of edges) {
    const from = Number(e.depends_on);
    if (!out.has(from)) out.set(from, []);
    out.get(from)!.push(Number(e.column_id));
  }
  const seen = new Set<number>();
  const queue = [columnId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const next of out.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return [...seen];
}

// ─────────────────────────────────────────────────────────── the stale cascade

/**
 * How many row ids go into one `IN (...)`. SQLite refuses a statement over 32,766 bound variables.
 * 500 is the batch size the rest of the engine reads and writes in.
 */
const STALE_CHUNK = 500;

/**
 * Above this, per-cell deltas are not broadcast.
 *
 * A cascade from a hand edit touches a handful of cells and should light up instantly. A cascade
 * from a run that filled 200,000 rows touches hundreds of thousands, and pushing one delta each
 * would flood the stream to say something the column's own counter already says. Past the threshold
 * the column is marked dirty — which refreshes the header count — and the glyphs appear as the grid
 * fetches each window, which is when they are actually looked at.
 */
const BROADCAST_LIMIT = 2000;

/**
 * Mark everything downstream of a changed cell as out of date.
 *
 * THIS IS THE PIECE THAT WAS MISSING. Everything that reads `cells.stale` was built — the glyph in
 * the grid, the "an upstream column changed after this ran" line in the cell drawer, the count on
 * every column header, the `is_stale` / `is_not_stale` filter operators, and a partial index in
 * db.ts tuned specifically for the count. Nothing anywhere ever wrote the flag. So the count was
 * permanently zero, the glyph never appeared, and the two filters matched nothing on every table —
 * a whole feature that looked finished from the outside and did nothing.
 *
 * Row-scoped, because references are row-scoped: editing row 5's Website makes row 5's Industry out
 * of date and says nothing at all about row 6.
 *
 * @param rowIds The rows whose upstream changed. Pass null for "every row of this sheet", which is
 *   both faster and what a whole-column run means.
 */
export function markDownstreamStale(
  sheetId: string,
  columnId: number,
  rowIds: number[] | null,
): number {
  const downstream = transitiveDownstream(sheetId, Number(columnId));
  if (downstream.length === 0) return 0;
  if (rowIds && rowIds.length === 0) return 0;

  const cols = downstream.map(() => "?").join(",");
  // Only cells that HOLD AN ANSWER can be out of date.
  //
  // An empty cell is not stale, it has simply never run, and marking it would put an
  // "out of date" glyph on a column nobody has run yet. An errored cell is not stale either: its
  // input hash was already cleared when it failed, so the next run retries it regardless, and
  // calling it stale would double-count the same "needs another go" in two places.
  //
  // Pinned cells are excluded because a run never overwrites one. Flagging a pinned cell as out of
  // date would promise a refresh that is never coming.
  const base =
    `UPDATE cells SET stale = 1
      WHERE column_id IN (${cols})
        AND pinned = 0
        AND stale = 0
        AND status IN ('done','not_found')`;

  const touched: string[] = [];
  let changed = 0;

  const run = (extraSql: string, extraParams: Array<string | number>) => {
    const stmt = db.prepare(`${base}${extraSql}`);
    const res = stmt.run(...downstream, ...extraParams);
    changed += Number(res.changes ?? 0);
  };

  if (rowIds == null) {
    // Whole sheet: one statement per cascade rather than one per 500 rows. The row filter is
    // replaced by the sheet, which the column list already implies but which keeps the statement
    // honest if a column id is ever reused across sheets.
    run(" AND row_id IN (SELECT id FROM rows WHERE sheet_id = ?)", [sheetId]);
  } else {
    for (let i = 0; i < rowIds.length; i += STALE_CHUNK) {
      const chunk = rowIds.slice(i, i + STALE_CHUNK);
      run(` AND row_id IN (${chunk.map(() => "?").join(",")})`, chunk);
    }
  }

  if (changed === 0) return 0;

  for (const id of downstream) markColumnDirty(id);

  // Per-cell deltas only for a cascade small enough to be worth streaming — see BROADCAST_LIMIT.
  if (rowIds != null && rowIds.length * downstream.length <= BROADCAST_LIMIT) {
    for (const r of rowIds) for (const c of downstream) touched.push(`${r}:${c}`);
    markCellsDirty(touched);
  }

  return changed;
}

/**
 * Re-derive the dependency graph for every column, once.
 *
 * Needed because the edges are written at SAVE time, and until today `rebuildDeps` could not see a
 * script's `row.<column>` accesses at all. So every script column saved before this fix has no
 * dependency recorded — and no amount of fixing the writer repairs a graph that was already written
 * wrong. Without this, the fix only helps columns someone happens to edit again.
 *
 * Cheap and idempotent: it re-parses text the engine already holds and rewrites rows in a table with
 * one entry per reference. It touches no cell and starts no run. Guarded by a version key so it runs
 * once per upgrade rather than on every boot — re-deriving is safe, but a few hundred columns of
 * parsing on every start is a cost with no benefit.
 */
export function backfillDeps(): { columns: number; edgesBefore: number; edgesAfter: number } | null {
  const VERSION = "deps.backfill.v2-rowaccess";
  if (getKv(VERSION) === "done") return null;

  const before = Number((db.prepare("SELECT COUNT(*) AS n FROM column_deps").get() as { n: number }).n);
  const cols = db
    .prepare("SELECT id, sheet_id FROM columns WHERE deleted_at IS NULL")
    .all() as Array<{ id: number; sheet_id: string }>;

  tx(() => {
    for (const c of cols) {
      // One column failing to parse must not abandon the rest of the graph half-rebuilt.
      try { rebuildDeps(String(c.sheet_id), Number(c.id)); } catch { /* leave that column's edges as they were */ }
    }
    setKv(VERSION, "done");
  });

  const after = Number((db.prepare("SELECT COUNT(*) AS n FROM column_deps").get() as { n: number }).n);
  return { columns: cols.length, edgesBefore: before, edgesAfter: after };
}
