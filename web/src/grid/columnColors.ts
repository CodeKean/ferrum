// Colours a column can be.
//
// ── Why a fixed list, and why names rather than hex ────────────────────────────────────────────
//
// A free colour picker looks more capable and is worse here for two reasons. A colour chosen on a
// light background becomes a glare on a dark one, and a stored `#fde68a` is a light-theme decision
// baked into the data that no later theme change can undo. And a grid where thirty columns are
// thirty arbitrary hues stops communicating: colour only means anything while there are few enough
// of them to tell apart.
//
// So a column stores a NAME. Each name resolves to a CSS variable that has a value in both themes,
// so the same column reads correctly either way and the whole palette can be retuned without
// touching a single stored column.
//
// ── Why these are tints, not fills ─────────────────────────────────────────────────────────────
//
// A column colour marks a GROUP of columns — "everything the enrichment step fills in" — while the
// values inside still have to be read, and status still has to be visible on top. So the colour is
// a low-alpha band behind the cells, not a solid fill. This is the one place the standing
// "solid, never semi-transparent" rule does not apply, and it is the case that rule exempts: a
// large soft background rather than a small affordance signalling state.

export interface ColumnColor {
  /** What is stored on the column. */
  id: string;
  label: string;
}

export const COLUMN_COLORS: ColumnColor[] = [
  { id: "slate", label: "Slate" },
  { id: "blue", label: "Blue" },
  { id: "teal", label: "Teal" },
  { id: "green", label: "Green" },
  { id: "amber", label: "Amber" },
  { id: "orange", label: "Orange" },
  { id: "red", label: "Red" },
  { id: "purple", label: "Purple" },
  { id: "pink", label: "Pink" },
];

const IDS = new Set(COLUMN_COLORS.map((c) => c.id));

/** A colour this build knows about, or null. A name from a newer build must not render as garbage. */
export const knownColor = (v: string | null | undefined): string | null =>
  v && IDS.has(v) ? v : null;

/** The band behind the cells of a coloured column. */
export const colorBand = (v: string | null | undefined): string | undefined =>
  knownColor(v) ? `var(--colcol-${v}-band)` : undefined;

/** The solid swatch used in the picker and as the header's marker. */
export const colorDot = (v: string | null | undefined): string | undefined =>
  knownColor(v) ? `var(--colcol-${v})` : undefined;
