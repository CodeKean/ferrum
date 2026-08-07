// Normalizing an enum column's allowed values.
//
// Pulled out of the PATCH route so the rule is one testable function rather than logic buried in a
// request handler. The enum type is the one place a stray duplicate or a blank silently changes what
// a valid answer is: two spellings of the same option split grouping and filtering into three, and a
// blank option would accept an empty answer as valid.

/** The most options an enum column may carry. A list longer than this is a taxonomy, not an enum,
 *  and it stops being something a person picks from or a model is told in one breath. */
export const MAX_ENUM_VALUES = 200;

export interface EnumValuesResult {
  values: string[];
  /** Set when the input was not an array at all — the caller answers 400 rather than storing []. */
  error?: string;
}

/**
 * Clean a submitted options list.
 *
 * Trims each entry, drops the empties, and removes case-insensitive duplicates KEEPING THE FIRST
 * spelling — so "Biotech" then "biotech" collapses to the one the user typed first, which is the one
 * the model will be told and the one coercion stores. Order is otherwise preserved, because an enum's
 * order is a choice (a priority, a lifecycle) the caller made. Over the cap, the extras are dropped
 * rather than the whole request refused: a paste of a thousand rows should not fail, it should keep
 * the first two hundred.
 */
export function normalizeEnumValues(input: unknown): EnumValuesResult {
  // Null and undefined are how the caller says "no constraint" — an empty list, not an error.
  if (input == null) return { values: [] };
  if (!Array.isArray(input)) {
    return { values: [], error: "`enumValues` has to be a list of the allowed options." };
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const v = raw.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= MAX_ENUM_VALUES) break;
  }
  return { values: out };
}
