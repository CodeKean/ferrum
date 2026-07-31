// Which operators a column can actually be filtered by.
//
// Driven by the column's data type, because the engine's operators are type-specific: `gt` compiles
// to a numeric comparison and `contains` to a LIKE. Offering "greater than" on a text column gives
// the user a control that either does nothing or does something surprising, and the rule this whole
// UI follows is that a visible, changeable, silently-ignored control is worse than a missing one.
//
// The list mirrors `Operator` in src/filter.ts. Adding one there without adding it here just means
// it is not offered; adding one HERE that the engine does not implement would produce a filter that
// silently matches everything, so this list must never lead.

export interface OpSpec {
  op: string;
  label: string;
  /** How many value inputs to render: 0 for is-empty, 2 for between. */
  arity: 0 | 1 | 2;
}

const ANY: OpSpec[] = [
  { op: "is_empty", label: "is empty", arity: 0 },
  { op: "is_not_empty", label: "is not empty", arity: 0 },
];

const TEXT: OpSpec[] = [
  { op: "eq", label: "is", arity: 1 },
  { op: "neq", label: "is not", arity: 1 },
  { op: "contains", label: "contains", arity: 1 },
  { op: "not_contains", label: "does not contain", arity: 1 },
  { op: "starts_with", label: "starts with", arity: 1 },
  { op: "ends_with", label: "ends with", arity: 1 },
];

const NUMERIC: OpSpec[] = [
  { op: "eq", label: "is", arity: 1 },
  { op: "neq", label: "is not", arity: 1 },
  { op: "gt", label: "is greater than", arity: 1 },
  { op: "gte", label: "is at least", arity: 1 },
  { op: "lt", label: "is less than", arity: 1 },
  { op: "lte", label: "is at most", arity: 1 },
  { op: "between", label: "is between", arity: 2 },
];

const DATE: OpSpec[] = [
  { op: "eq", label: "is on", arity: 1 },
  { op: "gt", label: "is after", arity: 1 },
  { op: "gte", label: "is on or after", arity: 1 },
  { op: "lt", label: "is before", arity: 1 },
  { op: "lte", label: "is on or before", arity: 1 },
  { op: "between", label: "is between", arity: 2 },
];

const ENUMISH: OpSpec[] = [
  { op: "eq", label: "is", arity: 1 },
  { op: "neq", label: "is not", arity: 1 },
  { op: "is_any_of", label: "is any of", arity: 1 },
  { op: "is_none_of", label: "is none of", arity: 1 },
];

const BOOL: OpSpec[] = [{ op: "eq", label: "is", arity: 1 }];

/**
 * Cell-state operators, offered on EVERY column.
 *
 * These are what make a re-run targetable — "the cell errored", "the cell is stale" — and they are
 * about the cell rather than its value, so they apply whatever the column holds.
 */
const STATE: OpSpec[] = [
  { op: "status_is", label: "the cell is", arity: 1 },
  { op: "status_is_not", label: "the cell is not", arity: 1 },
  { op: "is_stale", label: "the cell is out of date", arity: 0 },
  { op: "is_not_stale", label: "the cell is up to date", arity: 0 },
  { op: "is_pinned", label: "the cell was edited by hand", arity: 0 },
];

const NUMERIC_TYPES = new Set(["number", "currency", "percent"]);
const DATE_TYPES = new Set(["date", "datetime"]);
const ENUM_TYPES = new Set(["enum", "multi_select", "array"]);

export function operatorsFor(valueType: string): OpSpec[] {
  const base =
    NUMERIC_TYPES.has(valueType) ? NUMERIC
    : DATE_TYPES.has(valueType) ? DATE
    : ENUM_TYPES.has(valueType) ? ENUMISH
    : valueType === "boolean" ? BOOL
    : TEXT;
  return [...base, ...ANY, ...STATE];
}

export function specFor(valueType: string, op: string): OpSpec | null {
  return operatorsFor(valueType).find((o) => o.op === op) ?? null;
}

/** The values `status_is` accepts, in the same words the rest of the app uses for them. */
export const STATUS_VALUES = [
  { value: "done", label: "done" },
  { value: "error", label: "failed" },
  { value: "empty", label: "never run" },
  { value: "not_found", label: "not found" },
  { value: "skipped", label: "skipped" },
  { value: "cancelled", label: "stopped" },
  { value: "running", label: "running" },
  { value: "queued", label: "queued" },
];

/**
 * The default operator when a column is picked.
 *
 * `contains` for text rather than `is`, because a spreadsheet filter is nearly always a search for
 * a substring; `is` on a free-text column matches almost nothing and reads as the filter being
 * broken.
 */
export function defaultOp(valueType: string): string {
  if (NUMERIC_TYPES.has(valueType) || DATE_TYPES.has(valueType)) return "eq";
  if (ENUM_TYPES.has(valueType) || valueType === "boolean") return "eq";
  return "contains";
}
