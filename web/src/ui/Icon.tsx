// Inline SVG icons, Lucide-style: 16px grid, currentColor stroke, 1.5 width. No emoji anywhere.

interface P { size?: number; className?: string }

const base = (size: number, className?: string) => ({
  width: size,
  height: size,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className,
  "aria-hidden": true,
  focusable: false,
});

export const IconPlay = ({ size = 13, className }: P) => (
  <svg {...base(size, className)}><path d="M4.5 3.2v9.6l8-4.8-8-4.8Z" fill="currentColor" stroke="none" /></svg>
);

export const IconStop = ({ size = 13, className }: P) => (
  <svg {...base(size, className)}><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" /></svg>
);

export const IconExpand = ({ size = 13, className }: P) => (
  <svg {...base(size, className)}><path d="M9.5 2.5H13.5V6.5M6.5 13.5H2.5V9.5M13.5 2.5 9 7M2.5 13.5 7 9" /></svg>
);

export const IconAlert = ({ size = 13, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M8 2.8 14.2 13H1.8L8 2.8Z" fill="currentColor" stroke="none" />
    <path d="M8 6.6v2.6" stroke="var(--canvas)" />
    <circle cx="8" cy="11.1" r=".8" fill="var(--canvas)" stroke="none" />
  </svg>
);

export const IconSettings = ({ size = 15, className }: P) => (
  <svg {...base(size, className)}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M12.9 9.8a1.1 1.1 0 0 0 .22 1.21l.04.04a1.33 1.33 0 1 1-1.88 1.88l-.04-.04a1.1 1.1 0 0 0-1.21-.22 1.1 1.1 0 0 0-.67 1v.11a1.33 1.33 0 1 1-2.66 0v-.06a1.1 1.1 0 0 0-.72-1 1.1 1.1 0 0 0-1.21.22l-.04.04a1.33 1.33 0 1 1-1.88-1.88l.04-.04a1.1 1.1 0 0 0 .22-1.21 1.1 1.1 0 0 0-1-.67h-.11a1.33 1.33 0 1 1 0-2.66h.06a1.1 1.1 0 0 0 1-.72 1.1 1.1 0 0 0-.22-1.21l-.04-.04a1.33 1.33 0 1 1 1.88-1.88l.04.04a1.1 1.1 0 0 0 1.21.22h.05a1.1 1.1 0 0 0 .67-1v-.11a1.33 1.33 0 1 1 2.66 0v.06a1.1 1.1 0 0 0 .67 1 1.1 1.1 0 0 0 1.21-.22l.04-.04a1.33 1.33 0 1 1 1.88 1.88l-.04.04a1.1 1.1 0 0 0-.22 1.21v.05a1.1 1.1 0 0 0 1 .67h.11a1.33 1.33 0 1 1 0 2.66h-.06a1.1 1.1 0 0 0-1 .67Z" />
  </svg>
);

export const IconCheck = ({ size = 13, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M3.2 8.4 6.4 11.6 12.8 4.8" />
  </svg>
);

export const IconTrash = ({ size = 13, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M2.6 4.4h10.8M6.4 4.4V3.2a.8.8 0 0 1 .8-.8h1.6a.8.8 0 0 1 .8.8v1.2" />
    <path d="M12.2 4.4l-.5 8a1 1 0 0 1-1 .9H5.3a1 1 0 0 1-1-.9l-.5-8" />
    <path d="M6.7 7v3.6M9.3 7v3.6" />
  </svg>
);

/** Marks a link that leaves the app, so a new tab is never a surprise. */
export const IconExternal = ({ size = 11, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M9.2 2.8H13.2V6.8" />
    <path d="M13.2 2.8 7.2 8.8" />
    <path d="M12 9.6v2.8a1 1 0 0 1-1 1H3.6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.8" />
  </svg>
);

/** A hand-typed value. Small, because it marks a state rather than offering an action. */
export const IconHand = ({ size = 11, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M11.5 2.6 13.4 4.5 5.4 12.5 2.8 13.2 3.5 10.6 11.5 2.6Z" />
  </svg>
);

/**
 * Out of date. A filled dot, and its colour comes from whatever renders it.
 *
 * It used to hardcode `--status-queued-solid` in an inline style, which beat every class that tried
 * to colour it — so the corner mark that wants to sit in the same amber as the pencil beside it
 * could not. Inline styles are the one thing a stylesheet cannot answer.
 */
export const IconStale = ({ size = 13, className }: P) => (
  <svg {...base(size, className)}>
    <circle cx="8" cy="8" r="3.4" fill="currentColor" stroke="none" />
  </svg>
);

/**
 * Typed in by hand, at corner size.
 *
 * FILLED, unlike `IconHand`, because this renders at 9px in the corner of a cell and a 1.5px stroke
 * outline at that size is three grey pixels in a triangle — legible as "something is there" and not
 * as a pencil, which is the whole job.
 */
export const IconPencilMark = ({ size = 9, className }: P) => (
  <svg
    width={size} height={size} viewBox="0 0 16 16"
    fill="currentColor" stroke="none" className={className} aria-hidden focusable={false}
  >
    <path d="M11.8 1.6 14.4 4.2 12.6 6 10 3.4 11.8 1.6ZM9 4.4 11.6 7 4.9 13.7 1.5 14.5 2.3 11.1 9 4.4Z" />
  </svg>
);

export const IconChevronDown = ({ size = 14, className }: P) => (
  <svg {...base(size, className)}><path d="M4 6.5 8 10.5l4-4" /></svg>
);

export const IconCaretUp = ({ size = 12, className }: P) => (
  <svg {...base(size, className)}><path d="M4 9.5 8 5.5l4 4" /></svg>
);

export const IconCaretDown = ({ size = 12, className }: P) => (
  <svg {...base(size, className)}><path d="M4 6.5 8 10.5l4-4" /></svg>
);

export const IconPlus = ({ size = 14, className }: P) => (
  <svg {...base(size, className)}><path d="M8 3.5v9M3.5 8h9" /></svg>
);

export const IconSearch = ({ size = 14, className }: P) => (
  <svg {...base(size, className)}><circle cx="7.2" cy="7.2" r="4.2" /><path d="m10.4 10.4 3 3" /></svg>
);

export const IconMore = ({ size = 14, className }: P) => (
  <svg {...base(size, className)}>
    <circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);

export const IconTable = ({ size = 14, className }: P) => (
  <svg {...base(size, className)}>
    <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
    <path d="M2.5 6.5h11M6.5 6.5V13" />
  </svg>
);

export const IconSun = ({ size = 15, className }: P) => (
  <svg {...base(size, className)}>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.5v1.3M8 13.2v1.3M14.5 8h-1.3M2.8 8H1.5M12.6 3.4l-.9.9M4.3 11.7l-.9.9M12.6 12.6l-.9-.9M4.3 4.3l-.9-.9" />
  </svg>
);

export const IconMoon = ({ size = 15, className }: P) => (
  <svg {...base(size, className)}><path d="M13.2 9.8A5.6 5.6 0 0 1 6.2 2.8a5.8 5.8 0 1 0 7 7Z" /></svg>
);

export const IconDownload = ({ size = 14, className }: P) => (
  <svg {...base(size, className)}><path d="M8 2.5v7.5M5 7.5 8 10.5l3-3M3 12.5h10" /></svg>
);

export const IconUpload = ({ size = 14, className }: P) => (
  <svg {...base(size, className)}><path d="M8 10.5V3M5 6 8 3l3 3M3 12.5h10" /></svg>
);

/* Undo / redo: a curved arrow doubling back on itself. Lucide-style stroke, currentColor, no glyphs. */
export const IconUndo = ({ size = 14, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M3 8h6.5a3 3 0 0 1 0 6H7" />
    <path d="M5.5 5.5 3 8l2.5 2.5" />
  </svg>
);

export const IconRedo = ({ size = 14, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M13 8H6.5a3 3 0 0 0 0 6H9" />
    <path d="M10.5 5.5 13 8l-2.5 2.5" />
  </svg>
);

/** Data arriving. A tray with something dropping into it — the mirror of Export. */
export const IconInbox = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 9.5h3l1 2h4l1-2h3" />
    <path d="M3.5 3.5h9l1.5 6v3h-12v-3z" />
  </svg>
);

// ── column kinds ────────────────────────────────────────────────────────────
//
// One glyph per lane, for the grid header. Identical-looking columns give no clue which two of
// eleven spend money on every row, which one is a copy of something in another table, and which four
// are pulled out of one enrichment's answer. The name was the only
// signal, and a name is whatever somebody typed.
//
// Drawn to be told apart at 12px in a row of them, which rules out anything detailed: each is one
// idea — a pencil, braces, a globe, a plug, a spark, a magnifier, an arrow out, a link, a sigma.

/** A typed-in column. The only kind you can edit by hand. */
export const IconTyped = ({ size = 12, className }: P) => (
  <svg {...base(size, className)}><path d="M11 2.5 13.5 5 5.5 13H3v-2.5L11 2.5Z" /></svg>
);

/** A rule. Braces, because it is code that was written once and runs free. */
export const IconRule = ({ size = 12, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M6 2.5c-1.5 0-2 .7-2 2v1.6c0 .9-.5 1.4-1.5 1.9 1 .5 1.5 1 1.5 1.9v1.6c0 1.3.5 2 2 2" />
    <path d="M10 2.5c1.5 0 2 .7 2 2v1.6c0 .9.5 1.4 1.5 1.9-1 .5-1.5 1-1.5 1.9v1.6c0 1.3-.5 2-2 2" />
  </svg>
);

/** An API call. A globe — it leaves this machine. */
export const IconApi = ({ size = 12, className }: P) => (
  <svg {...base(size, className)}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M2.4 8h11.2M8 2.25c1.5 1.7 2.2 3.6 2.2 5.75S9.5 12.05 8 13.75c-1.5-1.7-2.2-3.6-2.2-5.75S6.5 3.95 8 2.25Z" />
  </svg>
);

/** A connected tool. A plug. */
export const IconTool = ({ size = 12, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M6 2v3.5M10 2v3.5M4.25 5.5h7.5v2.25a3.75 3.75 0 0 1-7.5 0V5.5ZM8 11.5V14" />
  </svg>
);

/** A model answering in one go. The same spark the assistant uses. */
export const IconModel = ({ size = 12, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M8 2c.55 2.7 1.25 3.4 3.95 3.95C9.25 6.5 8.55 7.2 8 9.9c-.55-2.7-1.25-3.4-3.95-3.95C6.75 5.4 7.45 4.7 8 2Z" />
    <path d="M12 10c.25 1.2.55 1.5 1.75 1.75-1.2.25-1.5.55-1.75 1.75-.25-1.2-.55-1.5-1.75-1.75C11.45 11.5 11.75 11.2 12 10Z" />
  </svg>
);

/** An agent that looks things up before answering. A magnifier. */
export const IconResearch = ({ size = 12, className }: P) => (
  <svg {...base(size, className)}><circle cx="7" cy="7" r="4.25" /><path d="m10.2 10.2 3.3 3.3" /></svg>
);

/** A send column. An arrow leaving a box — rows going somewhere else. */
export const IconSend = ({ size = 12, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M7 3H3.5v9.5H13V9" /><path d="M9 7l4.5-4.5M9.75 2.5h3.75v3.75" />
  </svg>
);

/** A lookup. A link, because the value lives in another table. */
export const IconLink = ({ size = 12, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M6.75 9.25a2.5 2.5 0 0 0 3.6.15l2-2a2.55 2.55 0 0 0-3.6-3.6l-1.1 1.1" />
    <path d="M9.25 6.75a2.5 2.5 0 0 0-3.6-.15l-2 2a2.55 2.55 0 0 0 3.6 3.6l1.1-1.1" />
  </svg>
);

/** A rollup. A sigma — it counts or totals the matching rows. */
export const IconRollup = ({ size = 12, className }: P) => (
  <svg {...base(size, className)}><path d="M11.5 3H4.5l3.6 5-3.6 5h7" /></svg>
);

/**
 * A field pulled out of another column's answer.
 *
 * The corner arrow that every file tree uses for "nested under the thing above". Ranked ahead of the
 * lane icon in the header, because on a sheet where one enrichment has been expanded into six
 * columns, "these six came out of that one" is the more useful fact than "all six are rules".
 */
export const IconDerived = ({ size = 12, className }: P) => (
  <svg {...base(size, className)}><path d="M4 3v4.5a2 2 0 0 0 2 2h6" /><path d="M9.75 7.25 12.25 9.5 9.75 11.75" /></svg>
);

/**
 * A waterfall. Three steps down and to the right — try one thing, then the next.
 *
 * The one lane whose whole point is ORDER, so the glyph is the only one here that draws a sequence
 * rather than a thing.
 */
export const IconWaterfall = ({ size = 12, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M2.5 4h4v3.5h4V11h3" />
  </svg>
);

/** A wait. A clock, because the column's entire job is the passing of time. */
export const IconWait = ({ size = 12, className }: P) => (
  <svg {...base(size, className)}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3.2l2 1.3" />
  </svg>
);

/** The assistant. A four-point spark, not an emoji and not a robot. */
export function IconSparkle({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M8 1.75c.6 2.9 1.35 3.65 4.25 4.25-2.9.6-3.65 1.35-4.25 4.25-.6-2.9-1.35-3.65-4.25-4.25C6.65 5.4 7.4 4.65 8 1.75Z" />
      <path d="M12.25 10.5c.3 1.45.68 1.83 2.13 2.13-1.45.3-1.83.67-2.13 2.12-.3-1.45-.67-1.82-2.12-2.12 1.45-.3 1.82-.68 2.12-2.13Z" />
    </svg>
  );
}
