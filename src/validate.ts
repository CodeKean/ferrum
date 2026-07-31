// Per-column validation rules.
//
// The type system already refuses a value that is not the SHAPE the column asked for — "Expected a
// number, got 'about forty'". That is coercion, and it is not validation: a number column happily
// accepts -3 for an employee count, an email column accepts `x@x` for a deliverable address, and a
// text column accepts a 40,000-character page of HTML that a model scraped by mistake. Those are the
// values that quietly poison a list, because they are the right type.
//
// So this is the second gate: shape first, then RULES.
//
// IMPORT-FREE ON PURPOSE. The client checks a value as you type and the engine checks it before it
// is written, and those two must never disagree — a browser that accepts what the server refuses is
// a form that cannot be submitted, and a browser that refuses what the server accepts is a feature
// nobody can reach. One module, reached from the client through the `@shared` alias.
//
// Everything here is DETERMINISTIC and cheap. A rule runs on every cell of every run, so nothing in
// it may call out, allocate per character, or backtrack.

export type RuleKind =
  | "required"
  | "min" | "max"
  | "min_length" | "max_length"
  | "pattern"
  | "one_of" | "not_one_of";

export interface Rule {
  kind: RuleKind;
  /** The bound, the pattern, or the list — read according to `kind`. */
  value?: string | number | string[];
  /**
   * What to say when it fails, in the user's own words.
   *
   * Optional, and when it is absent the generated sentence names the rule and the value. A custom
   * message is worth having because the generated one can only describe the RULE ("must be at least
   * 1"), where the person who wrote it knows the REASON ("headcount of zero means the company is
   * closed — check the source").
   */
  message?: string;
}

export interface RuleSet {
  rules: Rule[];
  /**
   * What a failure does.
   *
   * `reject` refuses the value: a hand edit is turned away and a run's answer becomes an error cell.
   * `warn` writes the value and marks the cell, which is the honest default for a rule added to a
   * column that already holds a million rows — switching a populated column to `reject` would not
   * retroactively delete anything, so the two would disagree about what is in the table.
   */
  onFail: "reject" | "warn";
}

export const RULE_KINDS: readonly RuleKind[] = [
  "required", "min", "max", "min_length", "max_length", "pattern", "one_of", "not_one_of",
] as const;

export function isRuleKind(v: unknown): v is RuleKind {
  return typeof v === "string" && (RULE_KINDS as readonly string[]).includes(v);
}

/** What a rule needs to be complete. A half-built rule must never be stored, because a rule that
 *  cannot be evaluated is one that silently passes everything. */
export function ruleIsComplete(r: Rule): boolean {
  switch (r.kind) {
    case "required": return true;
    case "one_of": case "not_one_of":
      return Array.isArray(r.value) && r.value.length > 0;
    case "pattern":
      return typeof r.value === "string" && r.value.trim() !== "";
    default:
      return r.value != null && String(r.value).trim() !== "" && Number.isFinite(Number(r.value));
  }
}

/**
 * Refuse a pattern that can hang the engine.
 *
 * A regular expression runs once per cell, and a catastrophically backtracking one — nested
 * quantifiers over an overlapping alternation, the `(a+)+$` family — takes exponential time on an
 * input that does not match. On a million-row column that is not a slow run, it is an engine that
 * never finishes and gives no reason.
 *
 * This is a conservative structural check, not a decision procedure, and it is deliberately blunt:
 * a rejected pattern costs somebody a rewrite, an accepted bad one costs everybody the table.
 */
export function patternRisk(source: string): string | null {
  if (source.length > 200) return "That pattern is very long. Keep it under 200 characters.";
  // A quantifier applied to a group that itself ends in a quantifier: (x+)+, (x*)*, (x+)*, (x{2,})+
  if (/\([^)]*[+*}]\s*\)\s*[+*{]/.test(source)) {
    return "That pattern has a repeat inside a repeat, which can take effectively forever on a value that does not match. Simplify it.";
  }
  try {
    new RegExp(source);
  } catch (e) {
    return `That is not a valid pattern: ${e instanceof Error ? e.message : String(e)}`;
  }
  return null;
}

function describe(r: Rule): string {
  switch (r.kind) {
    case "required": return "must not be empty";
    case "min": return `must be at least ${r.value}`;
    case "max": return `must be at most ${r.value}`;
    case "min_length": return `must be at least ${r.value} characters`;
    case "max_length": return `must be at most ${r.value} characters`;
    case "pattern": return `must match ${String(r.value)}`;
    case "one_of": return `must be one of: ${(r.value as string[]).join(", ")}`;
    case "not_one_of": return `must not be one of: ${(r.value as string[]).join(", ")}`;
  }
}

/**
 * Check one value.
 *
 * Returns the FIRST failure's message, or null when every rule passes. First rather than all: the
 * message ends up in a cell's error, on one line, and a cell that reads "must be at least 1; must
 * match ^[0-9]+$; must not be empty" tells you less than the first one does.
 *
 * An EMPTY value is checked only against `required`. Every other rule describes what a value must
 * look like, and applying "at least 3 characters" to a cell nobody has filled in yet would mark the
 * whole unfilled column as broken — emptiness is the business of exactly one rule.
 */
export function checkValue(value: string | null | undefined, set: RuleSet | null | undefined): string | null {
  if (!set || set.rules.length === 0) return null;
  const text = value == null ? "" : String(value);
  const empty = text.trim() === "";

  for (const r of set.rules) {
    if (!ruleIsComplete(r)) continue; // stored incomplete: cannot be evaluated, so it does not judge
    if (r.kind === "required") {
      if (empty) return r.message ?? "This must not be empty.";
      continue;
    }
    if (empty) continue;

    let ok = true;
    switch (r.kind) {
      case "min": case "max": {
        const n = Number(text);
        // A non-number reaching a numeric rule is NOT a failure of that rule — coercion owns the
        // shape, and reporting "must be at least 1" for the value "abc" points at the wrong thing.
        if (!Number.isFinite(n)) continue;
        ok = r.kind === "min" ? n >= Number(r.value) : n <= Number(r.value);
        break;
      }
      case "min_length": ok = [...text].length >= Number(r.value); break;
      case "max_length": ok = [...text].length <= Number(r.value); break;
      case "pattern": {
        const src = String(r.value);
        if (patternRisk(src)) continue; // never stored, but a database edited by hand can hold one
        ok = new RegExp(src).test(text);
        break;
      }
      case "one_of":
        ok = (r.value as string[]).some((v) => v.trim().toLowerCase() === text.trim().toLowerCase());
        break;
      case "not_one_of":
        ok = !(r.value as string[]).some((v) => v.trim().toLowerCase() === text.trim().toLowerCase());
        break;
    }
    if (!ok) return r.message ?? `This ${describe(r)}.`;
  }
  return null;
}

/**
 * Read a stored rule set.
 *
 * Anything unreadable becomes NO RULES rather than throwing. The alternative is a column whose
 * config got corrupted refusing every write to it with a parse error, which is a table nobody can
 * use over a feature nobody asked to be blocked by. A rule that vanishes lets a bad value in; a rule
 * that throws locks the column — and the first is recoverable.
 */
export function parseRules(json: string | null | undefined): RuleSet | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as RuleSet;
    if (!parsed || !Array.isArray(parsed.rules)) return null;
    const rules = parsed.rules.filter((r) => r && isRuleKind(r.kind));
    if (rules.length === 0) return null;
    return { rules, onFail: parsed.onFail === "warn" ? "warn" : "reject" };
  } catch {
    return null;
  }
}

/** Validate a rule set on the way IN, so nothing unusable is ever stored. Returns a reason or null. */
export function rulesProblem(set: RuleSet): string | null {
  for (const r of set.rules) {
    if (!isRuleKind(r.kind)) return `"${String(r.kind)}" is not a rule this understands.`;
    if (!ruleIsComplete(r)) return `The "${r.kind}" rule is missing its value.`;
    if (r.kind === "pattern") {
      const risk = patternRisk(String(r.value));
      if (risk) return risk;
    }
    if ((r.kind === "min" || r.kind === "max" || r.kind === "min_length" || r.kind === "max_length")
        && !Number.isFinite(Number(r.value))) {
      return `The "${r.kind}" rule needs a number.`;
    }
  }
  return null;
}
