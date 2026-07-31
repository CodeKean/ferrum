// Telling one column from another at a glance.
//
// Every header looked identical. On a sheet of eleven columns there was no way to see which two
// spend money on every row, which one is a copy of a value in another table, and which four are
// fields pulled out of a single enrichment's answer — the name was the only signal, and a name is
// whatever somebody happened to type. So "Industry" written by a model, "Industry" copied across a
// link, and "Industry" typed in by hand were three different things wearing one label.
//
// Clay's answer is a glyph per column type and a visible parent → child relationship, and it is the
// right one: the distinction is permanent, it is what decides whether a column costs anything, and
// it is the first question anyone asks about a column they did not create.
//
// ── Why the derived check comes first ──────────────────────────────────────────────────────────
//
// A field pulled out of a JSON column is STORED as a rule, so ranking by kind would label six
// expanded fields "a rule over the other columns" — true of the storage, and not the thing worth
// knowing. On a sheet where one enrichment has been expanded, "these six came out of that one" is
// the fact that explains the shape of the table.

import type { Column } from "../api.ts";

export type BadgeKind =
  | "derived" | "typed" | "rule" | "api" | "tool" | "model" | "research" | "send" | "lookup" | "rollup"
  | "waterfall" | "wait";

/**
 * The kinds that bill on every row.
 *
 * The one distinction worth colour, and the reason it is a set here rather than a boolean on each
 * badge: the mode picker names a LANE that no column has been set to yet, so it has no badge to read
 * `paid` off — it needs to ask the question about the kind itself.
 */
// A waterfall is here because it CAN spend — what it actually costs depends on which step settles
// the row, and a lane that might bill on every row has to look like one.
export const PAID_KINDS: ReadonlySet<BadgeKind> = new Set<BadgeKind>(["api", "tool", "model", "research", "waterfall"]);

/**
 * The mark for a column KIND, with no column in hand.
 *
 * For the mode picker, which shows the eight lanes as choices before any of them has been picked.
 * A derived column has no lane of its own — it is a projection, recognised by having a source — so
 * it is deliberately absent here and comes only from `columnBadge`.
 */
export function badgeForKind(kind: string): BadgeKind {
  return (LANE[kind]?.kind ?? "rule") as BadgeKind;
}

export interface ColumnBadge {
  kind: BadgeKind;
  /** Shown on hover and focus. Says what the column is, and for a child, what it came out of. */
  title: string;
  /** True when this column bills on every row. Drives the emphasis, not the glyph. */
  paid: boolean;
}

const LANE: Record<string, { kind: BadgeKind; title: string; paid: boolean }> = {
  static: { kind: "typed", title: "Typed in. You fill this column yourself and nothing runs.", paid: false },
  script: { kind: "rule", title: "A rule works this out from the other columns on this row. Free, and the same answer every time.", paid: false },
  http: { kind: "api", title: "Calls an API once per row. Billed by whoever owns that endpoint.", paid: true },
  mcp: { kind: "tool", title: "Asks a connected app once per row.", paid: true },
  ai: { kind: "model", title: "A model reads each row and answers. Costs money per row.", paid: true },
  agent: { kind: "research", title: "A model researches each row, and may search the web, before answering. The most expensive kind.", paid: true },
  send: { kind: "send", title: "Writes rows into another table. This column holds the receipt.", paid: false },
  lookup: { kind: "lookup", title: "Copied across from a matching row in another table.", paid: false },
  rollup: { kind: "rollup", title: "Counts or totals the matching rows in another table.", paid: false },
  waterfall: { kind: "waterfall", title: "Tries each step in turn and stops at the first one that settles the row. What it costs depends on how far down it had to go.", paid: true },
  wait: { kind: "wait", title: "Holds each row for a set time, then lets it carry on. Free — it costs nothing but the clock.", paid: false },
};

/**
 * What this column IS, for the header.
 *
 * `sourceName` is the parent's name where there is one — the caller has the column list, this does
 * not. A child whose parent has since been deleted still gets the derived badge, because it is still
 * a projection; it just cannot say of what.
 */
export function columnBadge(col: Column, sourceName?: string | null): ColumnBadge {
  if (col.sourceColumnId != null && col.jsonPath) {
    return {
      kind: "derived",
      title: sourceName
        ? `Pulled out of "${sourceName}" at ${col.jsonPath}. Free — it re-reads that answer rather than asking again.`
        : `Pulled out of another column at ${col.jsonPath}.`,
      paid: false,
    };
  }
  const lane = LANE[col.kind] ?? { kind: "rule" as BadgeKind, title: "This column produces its own value.", paid: false };
  return { ...lane };
}

/**
 * The parent's name, from the columns already on screen.
 *
 * Deliberately not a fetch. The header renders for every column on every frame of a scroll, and the
 * list it needs is the one it was handed.
 */
export function sourceNameOf(col: Column, all: Column[]): string | null {
  if (col.sourceColumnId == null) return null;
  return all.find((c) => Number(c.id) === Number(col.sourceColumnId))?.name ?? null;
}
