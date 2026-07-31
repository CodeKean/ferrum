// What is wrong with the references in a field, and which columns cannot be referenced at all.
//
// Two checks, both of which have to happen BEFORE a save rather than as an error afterwards:
//
//   BROKEN. A reference to a column that is gone resolves to nothing. The engine's own note on this
//   is blunt and correct: "a literal {{Website}} reaching a model is a silent data-quality disaster
//   — it looks fine on row 1 and quietly poisons all 1,000,000." The script route rejects it on
//   save; the PROMPT does not, because a prompt is written through a PATCH that validates nothing.
//   So the one lane that spends money per row was the one lane with no check.
//
//   CIRCULAR. RefMenu has always been able to disable an option and name the loop — `cyclePath` is
//   in its props and its header comment promises it — and nothing ever computed one. So the menu
//   offered every column, including the ones that close a loop, and the user found out afterwards
//   (for a script) or never (for a prompt, where nothing rebuilds the dependency edges at all).
//
// The graph here is built from what the BROWSER can see: prompts, request configs and send configs.
// It cannot see generated script code, so it finds fewer cycles than the engine does — never more.
// That is the safe direction: every path it names is a real one, and the server still refuses the
// rest at save time.

import { findRefs, type RefColumn } from "./refs.ts";

/** All this needs of a column, so both the browser's Column and a test fixture satisfy it. */
export interface GraphColumn extends RefColumn {
  prompt?: string | null;
  httpConfig?: Record<string, unknown> | null;
  sendConfig?: Record<string, unknown> | null;
}

export interface BrokenRef {
  /** How it reads in the field — "/deleted column 12" or "/Websit". */
  label: string;
  /** The closest live column, when one is close enough to be worth offering. Never a wrong guess. */
  suggestion: string | null;
}

/**
 * Levenshtein distance. Mirrors `editDistance` in src/refs.ts.
 *
 * Duplicated rather than imported for the same reason cost.ts duplicates the search rate: the
 * browser bundle does not include server code. It is eight lines of arithmetic with no state.
 */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1);
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[n]!;
}

const norm = (s: string) => s.trim().toLowerCase();

/** The closest column name, or null. Matches the server's rule: a wrong suggestion is worse than none. */
function suggest(name: string, columns: RefColumn[]): string | null {
  const target = norm(name);
  if (!target) return null;
  let best: { name: string; d: number } | null = null;
  for (const c of columns) {
    const d = editDistance(target, norm(c.name));
    if (!best || d < best.d) best = { name: c.name, d };
  }
  return best && best.d <= Math.max(2, Math.floor(target.length / 3)) ? best.name : null;
}

/**
 * Every reference in `stored` that resolves to nothing.
 *
 * Deliberately does NOT flag a bare `/Name` left in stored text. It looks like an unconverted
 * reference and sometimes is — but `//Name`, the documented escape for a literal, is stored as
 * `/Name` too, so the two are indistinguishable here and refusing to save would break the escape.
 * See the note in the report about `toDisplay` not re-escaping.
 */
export function brokenRefs(stored: string, columns: GraphColumn[]): BrokenRef[] {
  const ids = new Set(columns.map((c) => String(c.id)));
  const names = new Set(columns.map((c) => norm(c.name)));
  const out: BrokenRef[] = [];
  const seen = new Set<string>();

  for (const r of findRefs(stored, columns)) {
    if (r.columnId != null) {
      if (ids.has(r.columnId)) continue;
      // An id form carries no original name, so there is nothing to suggest against.
      const label = `/${r.name}`;
      if (!seen.has(label)) { seen.add(label); out.push({ label, suggestion: null }); }
      continue;
    }
    if (names.has(norm(r.name))) continue;
    const label = `/${r.name}`;
    if (!seen.has(label)) { seen.add(label); out.push({ label, suggestion: suggest(r.name, columns) }); }
  }
  return out;
}

/** The column ids one column reads, from every reference-bearing field the browser holds. */
function dependsOn(column: GraphColumn, columns: GraphColumn[]): string[] {
  const out = new Set<string>();
  const live = new Set(columns.map((c) => String(c.id)));

  const fromText = (text: string | null | undefined): void => {
    for (const r of findRefs(text ?? "", columns)) {
      if (r.columnId && live.has(r.columnId)) out.add(r.columnId);
    }
  };

  fromText(column.prompt);
  // References inside a request live in its url, query, header and body values, all of them strings.
  // Serialising the whole object finds them wherever they sit without walking a shape that changes.
  if (column.httpConfig) fromText(JSON.stringify(column.httpConfig));

  // A send config's references are column IDS in a JSON blob, not text — mirrors `sendDeps` in
  // src/refs.ts. Missed here, a send column would look like it depends on nothing.
  const send = column.sendConfig as
    | { mapping?: Record<string, unknown>; keySource?: unknown; listColumnId?: unknown }
    | null
    | undefined;
  if (send) {
    const add = (v: unknown): void => {
      const s = String((v as { columnId?: unknown })?.columnId ?? v ?? "");
      if (s && live.has(s)) out.add(s);
    };
    for (const entry of Object.values(send.mapping ?? {})) {
      if ((entry as { from?: string })?.from === "row") add(entry);
    }
    if ((send.keySource as { from?: string })?.from === "row") add(send.keySource);
    if (send.listColumnId != null) add(send.listColumnId);
  }

  out.delete(String(column.id));
  return [...out];
}

/**
 * For each column, the loop that referencing it from `fromId` would create.
 *
 * Walked over the REVERSE edges: anything that already reads `fromId`, directly or through a chain,
 * cannot be read back by it. The value is the loop written out in names — "Price → Currency → Price"
 * — because "circular reference" on a thirty-column table is not something anyone can act on.
 */
export function cyclePathsFrom(fromId: string, columns: GraphColumn[]): Map<string, string> {
  const name = new Map(columns.map((c) => [String(c.id), c.name]));

  // dependents.get(x) — the columns that read x.
  const dependents = new Map<string, string[]>();
  for (const c of columns) {
    for (const up of dependsOn(c, columns)) {
      const list = dependents.get(up);
      if (list) list.push(String(c.id));
      else dependents.set(up, [String(c.id)]);
    }
  }

  const out = new Map<string, string>();
  const from = String(fromId);
  // Breadth-first, so the loop named is the SHORTEST one — the one a person can follow.
  const queue: Array<{ id: string; trail: string[] }> = [{ id: from, trail: [from] }];
  const seen = new Set<string>([from]);
  while (queue.length > 0) {
    const { id, trail } = queue.shift()!;
    for (const next of dependents.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      const nextTrail = [...trail, next];
      // The trail runs "from is read by a, a is read by b". Reversed and closed with `from`, it
      // reads the way a dependency does: from → next → … → from.
      out.set(next, [from, ...nextTrail.slice(1).reverse(), from].map((id2) => name.get(id2) ?? `column ${id2}`).join(" → "));
      queue.push({ id: next, trail: nextTrail });
    }
  }
  return out;
}
