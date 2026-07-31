// Deduplication: finding repeated rows, and deciding which copy survives.
//
// The reason this is a waterfall rather than one key column: real lists arrive part-populated. Half
// the rows have a work email, the rest only have a company domain, and a few only have a LinkedIn
// URL. Deduping on email alone silently keeps every duplicate that happens to be missing one — and
// "we deduplicated" is then a false statement that nobody has any reason to doubt.
//
// So a table names an ORDERED list of key columns. Each row is keyed by the first of those columns
// it actually has a value in, and rows are duplicates when they agree on the key AND on which
// column produced it. That last part matters: a row keyed by email and a row keyed by domain have
// been compared on different questions, and treating them as equal because the strings match would
// merge two records that were never shown to be the same thing.
//
// ── Every setting belongs to ONE table ───────────────────────────────────────
//
// The rule lives on the sheet row, so two tables in the same workbook can key on different columns
// and neither can act on the other. There is no workspace-wide dedupe and there should not be: the
// columns that identify a company are not the ones that identify a person.
//
// ── What is kept ─────────────────────────────────────────────────────────────
//
// Explicitly chosen, never implied. "Keep the oldest" preserves the row you have already enriched,
// worked and referenced; "keep the newest" preserves the freshest copy of the data. Both are right
// in different jobs, and guessing costs whichever one the user wanted.
//
// ── What is never done ───────────────────────────────────────────────────────
//
// Merging. A merge invents a row that never arrived, from fields chosen by a rule nobody reviewed,
// and it is unrecoverable once the sources are gone. This removes whole rows and says exactly how
// many — anything cleverer belongs behind a preview and an explicit approval.

import { db, tx } from "./db.ts";
import { markSheetDirty } from "./columnStats.ts";
import { bumpDataVersion, countRows, getSheet, invalidateRowCount, listColumns } from "./store.ts";
import { invalidateRedo } from "./undo.ts";

/** Which copy of a duplicate survives. */
export type KeepRule = "oldest" | "newest";

export interface DedupeConfig {
  /** Key columns, in the order they are tried. Empty means deduplication is off. */
  columnIds: number[];
  keep: KeepRule;
  /** Run automatically whenever rows arrive — an import, a delivery, a fan-out. */
  auto: boolean;
  /**
   * Configured key columns that no longer exist. Reported, never acted on — a level that cannot be
   * evaluated has to be visible, because the alternative is a quietly different rule.
   */
  droppedColumnIds?: number[];
}

export const EMPTY_CONFIG: DedupeConfig = { columnIds: [], keep: "oldest", auto: false };

const emptyConfig = (): DedupeConfig => ({ columnIds: [], keep: "oldest", auto: false, droppedColumnIds: [] });

export function getConfig(sheetId: string): DedupeConfig {
  const r = db.prepare("SELECT dedupe_json FROM sheets WHERE id = ?").get(sheetId) as any;
  if (!r?.dedupe_json) return emptyConfig();
  try {
    const parsed = JSON.parse(r.dedupe_json) as Partial<DedupeConfig>;
    const stored = (parsed.columnIds ?? []).map(Number).filter(Number.isInteger);

    // Only columns that still exist on THIS sheet — the same filter setConfig applies on the way in,
    // now applied on the way out too.
    //
    // Without it a key column that had been deleted was still handed to the waterfall, while the
    // value TYPES come from listColumns and therefore no longer had an entry for it. So it silently
    // fell back to plain text normalization: url, phone, number, currency and percent values stopped
    // matching each other and the answer became a confident "no duplicates" on a table that still
    // had them, with the cells still present and still being keyed. Reproduced end to end — 2
    // duplicates before the delete, 0 after.
    const live = new Set(listColumns(sheetId).map((c) => Number(c.id)));
    return {
      columnIds: stored.filter((id) => live.has(id)),
      droppedColumnIds: stored.filter((id) => !live.has(id)),
      keep: parsed.keep === "newest" ? "newest" : "oldest",
      auto: !!parsed.auto,
    };
  } catch {
    // A malformed blob means OFF, not "on with guessed settings". Guessing here deletes rows.
    return emptyConfig();
  }
}

export function setConfig(sheetId: string, patch: Partial<DedupeConfig>): DedupeConfig {
  // Undefined means "leave this alone", not "set it to undefined".
  //
  // A plain spread does the second, and a caller that builds its patch as
  // `{ columnIds: maybe ?? undefined, keep, auto }` — which is the natural shape for a route reading
  // an optional body — then wiped the key columns on every settings change. It surfaced as the
  // automatic checkbox refusing to stay ticked, with the real error hidden behind a 400.
  const current = getConfig(sheetId);
  // Field by field rather than a spread: what is stored is exactly the three settings, and nothing
  // derived — `droppedColumnIds` is an observation about the sheet as it is now, and writing it into
  // the saved rule would turn a report into a setting.
  const next: DedupeConfig = { columnIds: current.columnIds, keep: current.keep, auto: current.auto };
  if (patch.columnIds !== undefined) next.columnIds = patch.columnIds;
  if (patch.keep !== undefined) next.keep = patch.keep;
  if (patch.auto !== undefined) next.auto = patch.auto;

  // Only columns that exist on THIS sheet. A stale id would silently drop a level out of the
  // waterfall and change what counts as a duplicate, with nothing on screen to say so.
  const valid = new Set(listColumns(sheetId).map((c) => Number(c.id)));
  next.columnIds = [...new Set(next.columnIds.map(Number))].filter((id) => valid.has(id));
  db.prepare("UPDATE sheets SET dedupe_json = ? WHERE id = ?").run(JSON.stringify(next), sheetId);
  return { ...next, droppedColumnIds: [] };
}

/**
 * The comparable form of a value.
 *
 * Type-aware, because the same company arrives as `https://Acme.com/`, `acme.com` and `www.acme.com`
 * and a plain string comparison calls those three different companies. Deliberately conservative:
 * case and surrounding punctuation are noise, everything else is data.
 */
export function normalizeKey(raw: string | null, valueType: string): string | null {
  if (raw == null) return null;
  let v = raw.trim();
  if (!v) return null;

  if (valueType === "email") return v.toLowerCase();

  if (valueType === "url") {
    try {
      const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
      const host = u.hostname.toLowerCase().replace(/^www\./, "");
      // Path included, because two different pages on one domain are two different things — but a
      // trailing slash is not one of them.
      const path = u.pathname.replace(/\/+$/, "");
      return host + path;
    } catch {
      return v.toLowerCase();
    }
  }

  if (valueType === "phone") {
    const digits = v.replace(/[^\d+]/g, "");
    return digits || null;
  }

  if (valueType === "number" || valueType === "currency" || valueType === "percent") {
    const n = Number(v.replace(/[^0-9.eE+-]/g, ""));
    return Number.isFinite(n) ? String(n) : v.toLowerCase();
  }

  v = v.toLowerCase().replace(/\s+/g, " ");
  return v || null;
}

/**
 * The waterfall, expressed once, in SQL.
 *
 * The first version of this pulled every key cell into JavaScript and grouped them in a Map. It was
 * correct and it was unusable: 4.6 SECONDS on a million rows, run synchronously inside the settings
 * request — which blocks the engine's single thread, so the grid stopped answering too and picking
 * a column felt like the app had died. Every settings change paid it twice, because `apply` then
 * grouped the same rows a second time.
 *
 * Grouping in SQL removes all of that. The normalization is still the SAME function the tests
 * exercise: it is registered as a SQLite function, so there is exactly one definition of what "the
 * same value" means rather than one in JavaScript and a subtly different one in SQL.
 */
let fnRegistered = false;
export function ensureFunction(): void {
  if (fnRegistered) return;
  // Deterministic: identical arguments always give the identical answer, which is what lets SQLite
  // use it inside a GROUP BY without re-evaluating it per comparison.
  (db as unknown as { function: (name: string, opts: object, fn: (...a: any[]) => unknown) => void })
    .function("cc_dedupe_key", { deterministic: true }, (value: string | null, valueType: string) =>
      normalizeKey(value ?? null, valueType ?? "text"),
    );
  fnRegistered = true;
}

/**
 * The CTE that keys every row by the first key column it actually has a value in.
 *
 * Built rather than written out because the number of levels is the user's choice. The parameters
 * come back with it: column ids first, then the matching value types, then the sheet id — the order
 * the placeholders appear in the finished statement.
 */
function keyedCte(cfg: DedupeConfig, types: Map<number, string>): { sql: string; args: unknown[] } {
  const joins: string[] = [];
  const keyCols: string[] = [];

  cfg.columnIds.forEach((columnId, i) => {
    joins.push(`LEFT JOIN cells c${i} ON c${i}.row_id = r.id AND c${i}.column_id = ?`);
    keyCols.push(`cc_dedupe_key(c${i}.value_text, ?) AS k${i}`);
  });

  // Positional parameters bind in the order the placeholders appear in the FINISHED statement, and
  // the SELECT list is written before the joins — so the value types come first, then the column
  // ids, then the sheet. Pushing the ids first bound each type as a column id: every join matched
  // nothing, every key was null, and the answer was a confident "no duplicates" on a table full of
  // them. Silent, and exactly the kind of wrong this feature cannot afford.
  const args: unknown[] = [
    ...cfg.columnIds.map((columnId) => types.get(columnId) ?? "text"),
    ...cfg.columnIds,
  ];

  const levelCase = cfg.columnIds.map((columnId, i) => `WHEN k${i} IS NOT NULL THEN ${columnId}`).join(" ");
  // SQLite's COALESCE needs at least two arguments, and one key column is the ordinary case — the
  // waterfall is what you reach for second. Written out rather than wrapped, so the single-column
  // statement is also the simplest one.
  const firstKey = cfg.columnIds.length === 1 ? "k0" : `COALESCE(${cfg.columnIds.map((_, i) => `k${i}`).join(", ")})`;

  return {
    // MATERIALIZED is load-bearing, not a hint.
    //
    // Without it SQLite inlines the CTE into every place it is referenced, so the totals, the
    // unkeyed count and the samples each re-walk the table and re-run the normalization — three
    // passes over a million rows, and three million calls across the JavaScript bridge. Computing
    // it once and reusing it is the difference between about a second and about seven.
    sql: `
      WITH v AS MATERIALIZED (
        SELECT r.id AS row_id, ${keyCols.join(", ")}
          FROM rows r
          ${joins.join("\n          ")}
         WHERE r.sheet_id = ?
      ),
      k AS MATERIALIZED (
        SELECT row_id, CASE ${levelCase} END AS col_id, ${firstKey} AS kk
          FROM v
      )`,
    args,
  };
}

export interface DuplicateGroup {
  /** The key these rows share. */
  key: string;
  /** Which key column produced it. */
  columnId: number;
  count: number;
  /** Oldest and newest row in the group — the two candidates for survivor. */
  oldest: number;
  newest: number;
}

export interface DedupeReport {
  /** Groups holding more than one row. */
  groups: number;
  /** Rows that would be removed — always the groups' total minus one per group. */
  duplicates: number;
  /** Rows no key column had a value for. They are never touched. */
  unkeyed: number;
  rows: number;
  /** A few real examples, so a count of 4,000 can be sanity-checked before it deletes anything. */
  samples: Array<{ key: string; column: string; count: number }>;
  /**
   * Key columns named by the rule that no longer exist, so their level of the waterfall was not
   * evaluated. Reported because the alternative is the worst kind of wrong answer: "0 duplicates" on
   * a list full of them, from a rule the user believes is still running.
   */
  droppedKeys: number[];
}

/**
 * Every group holding more than one row, biggest first.
 *
 * `limit` bounds what is RETURNED, never what is counted — the report's totals come from their own
 * aggregate, so asking for five examples cannot quietly become "we found five duplicates".
 */
export function findDuplicates(sheetId: string, cfg = getConfig(sheetId), limit = 0): DuplicateGroup[] {
  if (cfg.columnIds.length === 0) return [];
  ensureFunction();
  const types = new Map(listColumns(sheetId).map((c) => [Number(c.id), c.valueType as string]));
  const { sql, args } = keyedCte(cfg, types);

  const rows = db
    .prepare(
      `${sql}
       SELECT col_id, kk, COUNT(*) AS n, MIN(row_id) AS lo, MAX(row_id) AS hi
         FROM k
        WHERE kk IS NOT NULL
        GROUP BY col_id, kk
       HAVING n > 1
        ORDER BY n DESC${limit > 0 ? ` LIMIT ${Number(limit)}` : ""}`,
    )
    .all(...(args as any[]), sheetId) as any[];

  return rows.map((r) => ({
    key: String(r.kk),
    columnId: Number(r.col_id),
    count: Number(r.n),
    oldest: Number(r.lo),
    newest: Number(r.hi),
  }));
}

/** What a run would do, without doing any of it. */
export function preview(sheetId: string, cfg = getConfig(sheetId)): DedupeReport {
  // Through the store's cached count, not a fresh COUNT(*).
  //
  // This process is the single writer and every path that changes row cardinality invalidates that
  // count, so the SQL was buying a number the process already had — measured at 70ms per call on a
  // million-row sheet. It is paid on every automatic dedupe, which means on every webhook delivery
  // and every import batch, and again inside `apply` because apply previews first.
  const rows = countRows(sheetId);
  const droppedKeys = cfg.droppedColumnIds ?? [];
  // Nothing configured is not "every row is unmatched" — it is "no question has been asked yet".
  // Reporting a million unkeyed rows for a table nobody has set up reads as a problem.
  if (cfg.columnIds.length === 0) return { groups: 0, duplicates: 0, unkeyed: 0, rows, samples: [], droppedKeys };

  ensureFunction();
  const types = new Map(listColumns(sheetId).map((c) => [Number(c.id), c.valueType as string]));
  const { sql, args } = keyedCte(cfg, types);

  // Totals AND examples from ONE statement, so the whole screen costs a single pass. The totals
  // come from their own aggregate rather than from the sampled rows, so asking for five examples
  // can never quietly become "we found five duplicates".
  const found = db
    .prepare(
      `${sql},
       g AS MATERIALIZED (
         SELECT col_id, kk, COUNT(*) AS n FROM k WHERE kk IS NOT NULL GROUP BY col_id, kk HAVING n > 1
       ),
       tot AS (SELECT COUNT(*) AS groups, COALESCE(SUM(n - 1), 0) AS duplicates FROM g)
       SELECT (SELECT groups FROM tot) AS groups,
              (SELECT duplicates FROM tot) AS duplicates,
              (SELECT COUNT(*) FROM k WHERE kk IS NULL) AS unkeyed,
              g.col_id, g.kk, g.n
         FROM g ORDER BY g.n DESC LIMIT 5`,
    )
    .all(...(args as any[]), sheetId) as any[];

  const names = new Map(listColumns(sheetId).map((c) => [Number(c.id), c.name]));

  // No rows back means no group had more than one member — the totals live on the sample rows, so
  // an empty result is a real answer rather than a missing one.
  if (found.length === 0) {
    const empty = db
      .prepare(`${sql} SELECT COUNT(*) AS unkeyed FROM k WHERE kk IS NULL`)
      .get(...(args as any[]), sheetId) as any;
    return { groups: 0, duplicates: 0, unkeyed: Number(empty?.unkeyed ?? 0), rows, samples: [], droppedKeys };
  }

  return {
    groups: Number(found[0].groups ?? 0),
    duplicates: Number(found[0].duplicates ?? 0),
    unkeyed: Number(found[0].unkeyed ?? 0),
    rows,
    samples: found.map((g) => ({
      key: String(g.kk),
      column: names.get(Number(g.col_id)) ?? "?",
      count: Number(g.n),
    })),
    droppedKeys,
  };
}

/**
 * Remove the duplicates, keeping one row per group.
 *
 * One statement. The losers are never materialized in JavaScript, which is what lets this work when
 * the honest answer is "remove 999,992 rows" — a list of that many ids is not something to build in
 * memory, and chunking it would make the delete non-atomic.
 *
 * Returns the same report the preview produced, so the number shown before and the number acted on
 * come from one code path.
 */
export function apply(sheetId: string, cfg = getConfig(sheetId)): DedupeReport {
  const report = preview(sheetId, cfg);
  if (report.duplicates === 0) return report;

  ensureFunction();
  const types = new Map(listColumns(sheetId).map((c) => [Number(c.id), c.valueType as string]));
  const { sql, args } = keyedCte(cfg, types);
  const survivor = cfg.keep === "newest" ? "g.hi" : "g.lo";

  tx(() => {
    // Cells go with their rows: the foreign key is ON DELETE CASCADE.
    db.prepare(
      `DELETE FROM rows WHERE id IN (
         ${sql},
         g AS (
           SELECT col_id, kk, COUNT(*) AS n, MIN(row_id) AS lo, MAX(row_id) AS hi
             FROM k WHERE kk IS NOT NULL GROUP BY col_id, kk HAVING n > 1
         )
         SELECT k.row_id
           FROM k JOIN g ON g.col_id = k.col_id AND g.kk = k.kk
          WHERE k.row_id <> ${survivor}
       )`,
    ).run(...(args as any[]), sheetId);
  });

  invalidateRowCount(sheetId);
  bumpDataVersion(sheetId);
  markSheetDirty(sheetId);
  // Rows are gone, so any pending redo describes a table that no longer exists: replaying it would
  // write a snapshot taken before this back over what survived. The removal itself is deliberately
  // not undoable — see the route — but it must not leave a redo that is.
  invalidateRedo(sheetId);
  // Deliberately no per-cell dirty marking. Naming a million removed cells individually would cost
  // more than the delete did; the row count and data version changing is what tells the grid to
  // refetch, and it already does.
  return report;
}

/**
 * Run deduplication if — and only if — this table asked for it automatically.
 *
 * Called from every path that adds rows. Silent when off, which is the default: a tool that deletes
 * rows nobody asked it to delete is not one anyone will trust with a real list.
 */
export function autoDedupe(sheetId: string): DedupeReport | null {
  if (!getSheet(sheetId)) return null;
  const cfg = getConfig(sheetId);
  if (!cfg.auto || cfg.columnIds.length === 0) return null;
  return apply(sheetId, cfg);
}
