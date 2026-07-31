// Filter tree → SQL.
//
// This module is load-bearing well beyond the filter bar, because ONE predicate drives three things
// that must never disagree:
//
//   1. what the grid shows,
//   2. what "select all matching" acts on, and
//   3. which rows a run actually spends money on ("run only the visible rows").
//
// If those diverge you get the classic Clay-clone bug: the user filters to 400 rows, hits Run, and
// the engine bills them for 1,000,000. So a run scope is a VIEW ID, resolved server-side through
// this compiler — never a list of row ids materialized in the browser.
//
// Values are always bound as parameters. Column ids are validated against the table's real columns
// and then inlined as integers, never interpolated as text.

import { DATE_TYPES, NUMERIC_TYPES, type ValueType } from "./types.ts";

export type Conjunction = "and" | "or";

export type Operator =
  // any type
  | "is_empty" | "is_not_empty"
  // text
  | "eq" | "neq" | "contains" | "not_contains" | "starts_with" | "ends_with" | "regex"
  // number / date
  | "gt" | "gte" | "lt" | "lte" | "between"
  // enum / multi
  | "is_any_of" | "is_none_of"
  // cell state — the operators that make reruns targetable
  | "status_is" | "status_is_not" | "is_stale" | "is_not_stale" | "is_pinned";

export interface Condition {
  columnId: number;
  op: Operator;
  /** Bound as a parameter. Arrays are used by between / is_any_of / status_is. */
  value?: string | number | boolean | Array<string | number>;
}

export interface FilterGroup {
  conj: Conjunction;
  /** Nested groups give AND/OR nesting; Clay's builder is two levels, this has no depth limit. */
  children: Array<Condition | FilterGroup>;
}

export const isGroup = (n: Condition | FilterGroup): n is FilterGroup =>
  (n as FilterGroup).children !== undefined;

export interface CompiledFilter {
  /** A SQL fragment constraining `rows.id`, or null when the filter matches everything. */
  sql: string | null;
  params: Array<string | number>;
  /**
   * Conditions that could not be compiled, described in plain words. Empty in the ordinary case.
   *
   * Exists because "could not compile this condition" and "there was no condition" produce the same
   * SQL — none — and therefore the same result: every row. Harmless when viewing, expensive when
   * running. Anything that spends money reads this and refuses rather than widening.
   */
  dropped: string[];
}

/** Operators that read cell STATE rather than cell VALUE. */
const STATE_OPS = new Set<Operator>([
  "status_is", "status_is_not", "is_stale", "is_not_stale", "is_pinned",
]);

/**
 * Numeric comparison needs the value as a number, but `value_text` is text. SQLite's CAST returns 0
 * for non-numeric text, which would make `> 0` match every junk value — so comparisons are guarded
 * by a GLOB that requires the text to actually look numeric.
 */
const NUMERIC_GUARD = `value_text GLOB '-[0-9]*' OR value_text GLOB '[0-9]*'`;

/**
 * Escape the LIKE wildcards in user-supplied text.
 *
 * `%` and `_` are wildcards, so an unescaped "contains 100%" was a search for "100 followed by
 * anything" — it matched every row containing "100", and "50_00" matched "50000". Every LIKE built
 * from user text must go through this and carry `ESCAPE '\'`.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (m) => "\\" + m);
}

/** LIKE with the escape clause, so callers cannot forget it. */
const like = (expr: string) => `${expr} LIKE jslower(?) ESCAPE '\\'`;

function compileCondition(c: Condition, valueType: ValueType | undefined): CompiledFilter {
  const params: Array<string | number> = [];
  const col = Number(c.columnId);
  if (!Number.isInteger(col)) return { sql: null, params: [], dropped: [] };

  // Every condition is an EXISTS against the cell for (row, column). EXISTS keeps it a clustered
  // primary-key probe rather than a join that materializes.
  const wrap = (inner: string) =>
    `EXISTS (SELECT 1 FROM cells c WHERE c.row_id = r.id AND c.column_id = ${col} AND (${inner}))`;
  const wrapNot = (inner: string) =>
    `NOT EXISTS (SELECT 1 FROM cells c WHERE c.row_id = r.id AND c.column_id = ${col} AND (${inner}))`;

  const v = c.value;
  const scalar = (): string | number => (Array.isArray(v) ? String(v[0] ?? "") : (v as string | number) ?? "");

  switch (c.op) {
    case "is_empty":
      // A cell that does not exist yet is also empty, hence the NOT EXISTS form.
      return { dropped: [], sql: wrapNot(`c.value_text IS NOT NULL AND c.value_text <> ''`), params };
    case "is_not_empty":
      return { dropped: [], sql: wrap(`c.value_text IS NOT NULL AND c.value_text <> ''`), params };

    case "eq":
      if (valueType && NUMERIC_TYPES.has(valueType)) { params.push(Number(scalar())); return { dropped: [], sql: wrap(`(${NUMERIC_GUARD.replace(/value_text/g, "c.value_text")}) AND CAST(c.value_text AS REAL) = ?`), params }; }
      params.push(String(scalar()));
      // jslower on both sides: SQLite's LOWER folds ASCII only, so an accented value would never
      // match itself case-insensitively.
      return { dropped: [], sql: wrap(`jslower(c.value_text) = jslower(?)`), params };
    case "neq":
      params.push(String(scalar()));
      return { dropped: [], sql: wrapNot(`jslower(c.value_text) = jslower(?)`), params };

    case "contains":
      params.push(`%${escapeLike(String(scalar()))}%`);
      return { dropped: [], sql: wrap(like("jslower(c.value_text)")), params };
    case "not_contains":
      params.push(`%${escapeLike(String(scalar()))}%`);
      return { dropped: [], sql: wrapNot(like("jslower(c.value_text)")), params };
    case "starts_with":
      params.push(`${escapeLike(String(scalar()))}%`);
      return { dropped: [], sql: wrap(like("jslower(c.value_text)")), params };
    case "ends_with":
      params.push(`%${escapeLike(String(scalar()))}`);
      return { dropped: [], sql: wrap(like("jslower(c.value_text)")), params };
    case "regex":
      params.push(String(scalar()));
      return { dropped: [], sql: wrap(`c.value_text REGEXP ?`), params };

    case "gt": case "gte": case "lt": case "lte": {
      const opSql = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[c.op];
      if (valueType && DATE_TYPES.has(valueType)) {
        params.push(String(scalar()));
        return { dropped: [], sql: wrap(`c.value_text ${opSql} ?`), params }; // ISO strings compare lexically
      }
      params.push(Number(scalar()));
      return { dropped: [], sql: wrap(`(${NUMERIC_GUARD.replace(/value_text/g, "c.value_text")}) AND CAST(c.value_text AS REAL) ${opSql} ?`), params };
    }

    case "between": {
      const arr = Array.isArray(v) ? v : [];
      if (valueType && DATE_TYPES.has(valueType)) {
        params.push(String(arr[0] ?? ""), String(arr[1] ?? ""));
        return { dropped: [], sql: wrap(`c.value_text BETWEEN ? AND ?`), params };
      }
      params.push(Number(arr[0] ?? 0), Number(arr[1] ?? 0));
      return { dropped: [], sql: wrap(`(${NUMERIC_GUARD.replace(/value_text/g, "c.value_text")}) AND CAST(c.value_text AS REAL) BETWEEN ? AND ?`), params };
    }

    case "is_any_of": case "is_none_of": {
      const arr = (Array.isArray(v) ? v : [v]).filter((x) => x != null);
      if (arr.length === 0) return { sql: null, params: [], dropped: [] };
      const holes = arr.map(() => "jslower(?)").join(",");
      for (const x of arr) params.push(String(x));
      const inner = `jslower(c.value_text) IN (${holes})`;
      return { dropped: [], sql: c.op === "is_any_of" ? wrap(inner) : wrapNot(inner), params };
    }

    case "status_is": case "status_is_not": {
      const arr = (Array.isArray(v) ? v : [v]).filter((x) => x != null);
      if (arr.length === 0) return { sql: null, params: [], dropped: [] };
      const holes = arr.map(() => "?").join(",");
      for (const x of arr) params.push(String(x));
      const inner = `c.status IN (${holes})`;
      return { dropped: [], sql: c.op === "status_is" ? wrap(inner) : wrapNot(inner), params };
    }

    case "is_stale":     return { dropped: [], sql: wrap(`c.stale = 1`), params };
    case "is_not_stale": return { dropped: [], sql: wrapNot(`c.stale = 1`), params };
    case "is_pinned":    return { dropped: [], sql: wrap(`c.pinned = 1`), params };

    default:
      return { sql: null, params: [], dropped: [] };
  }
}

/**
 * Compile a filter tree into a SQL fragment over the alias `r` (the `rows` table).
 *
 * `columnTypes` maps column id -> value type, and doubles as the allowlist: a condition naming a
 * column that does not belong to this table is dropped rather than compiled.
 */
export function compileFilter(
  node: FilterGroup | null | undefined,
  columnTypes: Map<number, ValueType>,
): CompiledFilter {
  if (!node) return { sql: null, params: [], dropped: [] };
  // A filter is a tree; a malformed one arriving over HTTP is a 500 unless the shape is checked
  // here. `{op, conditions}` — the shape someone would plausibly send — threw
  // "node.children is not iterable" and reached the user as "Something went wrong inside Ferrum".
  if (!Array.isArray(node.children)) {
    return { sql: null, params: [], dropped: ["a filter with no list of conditions in it"] };
  }

  const parts: string[] = [];
  const params: Array<string | number> = [];
  const dropped: string[] = [];

  for (const child of node.children) {
    if (isGroup(child)) {
      const compiled = compileFilter(child, columnTypes);
      dropped.push(...compiled.dropped);
      if (compiled.sql) { parts.push(`(${compiled.sql})`); params.push(...compiled.params); }
      continue;
    }

    // WHY each of these is recorded rather than quietly skipped: every condition makes a result
    // SMALLER, so a condition that vanishes makes it BIGGER. All of them vanishing leaves `sql:
    // null`, which means "matches everything" — so a filter the engine could not understand turned
    // a run over 10 rows into a run over the whole sheet. Measured: 10 -> 30, and the summary read
    // "every row", so the confirmation dialog agreed with itself while ignoring what was asked for.
    // On a paid lane that is the entire table billed. Callers that spend money refuse when this list
    // is non-empty; the grid, where degrading gracefully is the right behaviour, ignores it.
    if (!columnTypes.has(Number(child.columnId))) {
      dropped.push(`a condition on a column that is not in this table (id ${String(child.columnId)})`);
      continue;
    }
    const compiled = compileCondition(child, columnTypes.get(Number(child.columnId)));
    if (compiled.sql) {
      parts.push(`(${compiled.sql})`);
      params.push(...compiled.params);
    } else {
      dropped.push(`a condition using an operator this table does not understand ("${String(child.op)}")`);
    }
  }

  if (parts.length === 0) return { sql: null, params: [], dropped };
  return { sql: parts.join(node.conj === "or" ? " OR " : " AND "), params, dropped };
}

/** Describe a filter in plain words, for the run-confirm dialog and the empty state. */
export function describeFilter(node: FilterGroup | null | undefined, names: Map<number, string>): string {
  if (!node || node.children.length === 0) return "no filters";
  const parts = node.children.map((child) => {
    if (isGroup(child)) return `(${describeFilter(child, names)})`;
    const name = names.get(Number(child.columnId)) ?? "column";
    const val = Array.isArray(child.value) ? child.value.join(" and ") : String(child.value ?? "");
    const phrase: Record<string, string> = {
      is_empty: "is empty", is_not_empty: "is not empty",
      eq: `is ${val}`, neq: `is not ${val}`,
      contains: `contains ${val}`, not_contains: `does not contain ${val}`,
      starts_with: `starts with ${val}`, ends_with: `ends with ${val}`, regex: `matches ${val}`,
      gt: `is over ${val}`, gte: `is at least ${val}`, lt: `is under ${val}`, lte: `is at most ${val}`,
      between: `is between ${val}`,
      is_any_of: `is any of ${val}`, is_none_of: `is none of ${val}`,
      status_is: `status is ${val}`, status_is_not: `status is not ${val}`,
      is_stale: "is stale", is_not_stale: "is not stale", is_pinned: "was edited by hand",
    };
    return `${name} ${phrase[child.op] ?? child.op}`;
  });
  return parts.join(node.conj === "or" ? " or " : " and ");
}
