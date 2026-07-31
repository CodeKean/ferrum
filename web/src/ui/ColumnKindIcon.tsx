// One glyph per kind of column, rendered the same way everywhere it appears.
//
// The icons only teach anything if they are the SAME icon in every place a column's kind is shown.
// A globe on the grid header and a different mark on the card that sets the column to be a globe is
// two vocabularies, and the reader learns neither — they learn that the marks are decoration.
//
// So the mapping lives here and nowhere else. Three surfaces use it: the grid header, the mode
// picker's cards (where you CHOOSE the kind), and the column drawer's title (where you are looking
// at the one you chose). Anything added later gets it by importing this rather than by picking a
// glyph that seemed right.
//
// ── The colour ─────────────────────────────────────────────────────────────────────────────────
//
// Shape says WHAT the column is; colour says whether it SPENDS. Those are the two questions anyone
// has about a column they did not create, and separating them means one mark answers both. The
// paid lanes carry the brand colour; everything free stays quiet.

import {
  IconApi, IconDerived, IconLink, IconModel, IconResearch, IconRollup, IconRule, IconSend, IconTool, IconTyped,
  IconWait, IconWaterfall,
} from "./Icon.tsx";
import { PAID_KINDS, type BadgeKind } from "./columnBadge.ts";
import "./ColumnKindIcon.css";

const GLYPH: Record<BadgeKind, (p: { size?: number }) => React.ReactElement> = {
  derived: IconDerived,
  typed: IconTyped,
  rule: IconRule,
  api: IconApi,
  tool: IconTool,
  model: IconModel,
  research: IconResearch,
  send: IconSend,
  lookup: IconLink,
  rollup: IconRollup,
  waterfall: IconWaterfall,
  wait: IconWait,
};

/**
 * The mark for a kind of column.
 *
 * A `<span role="img">` rather than a button: it is a label, and making it focusable would add a tab
 * stop in front of every column header — eleven columns, eleven stops before reaching the grid — for
 * something that does nothing when activated.
 */
export function ColumnKindIcon({ kind, title, size, className }: {
  kind: BadgeKind;
  /** Shown on hover and read out. Comes from `columnBadge`, so it says the same thing everywhere. */
  title?: string;
  size?: number;
  className?: string;
}) {
  const Glyph = GLYPH[kind];
  const paid = PAID_KINDS.has(kind);
  return (
    <span
      className={`cc-kindicon cc-kindicon--${kind}${paid ? " cc-kindicon--paid" : ""}${className ? ` ${className}` : ""}`}
      title={title}
      aria-label={title}
      role="img"
      style={size ? { flexBasis: size, width: size, height: size } : undefined}
    >
      <Glyph size={size} />
    </span>
  );
}
