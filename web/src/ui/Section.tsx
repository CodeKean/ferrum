// A collapsible group of settings.
//
// The request screen has more than a dozen fields and only three of them matter on a typical column.
// Showing all of them flat makes the two that need filling in indistinguishable from the ten that
// have a sensible default; hiding them behind a tab makes them unfindable. Sections are the middle:
// everything is present and countable, and only what you opened is in your way.
//
// The `summary` is what stops a collapsed section from being a mystery — "3 headers" beside a closed
// Headers section says whether it needs opening. It is also what fills the row: a lone label with a
// caret at the far right and a void between them is the dead space this codebase keeps deleting.

import { useId, useState, type ReactNode } from "react";
import "./Section.css";

interface Props {
  label: string;
  /** Right-aligned state, e.g. "3 headers" or "none". Keeps the row full and the section legible shut. */
  summary?: string;
  /** Open on first render. Sections holding a required field start open. */
  defaultOpen?: boolean;
  children: ReactNode;
}

export function Section({ label, summary, defaultOpen = false, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();

  return (
    <section className={`cc-sect${open ? " cc-sect--open" : ""}`}>
      <button
        className="cc-sect__head"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="cc-sect__caret" aria-hidden>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 3l5 5-5 5" />
          </svg>
        </span>
        <span className="cc-sect__label">{label}</span>
        {/* Reserved width, so "none" becoming "3 headers" cannot shift the caret or resize the row. */}
        <span className="cc-sect__summary truncate">{summary ?? ""}</span>
      </button>

      {/* Kept mounted while closing so the collapse animates out rather than vanishing. The grid-rows
          0fr → 1fr trick animates to CONTENT height, which a max-height guess cannot do without
          either clipping a long section or easing through empty space on a short one. */}
      <div className="cc-sect__wrap" id={id} role="region" aria-label={label} inert={!open}>
        <div className="cc-sect__body">{children}</div>
      </div>
    </section>
  );
}
