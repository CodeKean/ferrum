// ⌘K.
//
// Every action in this app already exists behind a menu, a drawer or a header button, and finding
// the right one means knowing which of those it is filed under. That is fine at ten commands and
// unusable at sixty. This is one box that reaches all of them by name, and it is the only surface
// where a user does not have to know how the app is organised to use it.
//
// NOT a Modal. A modal is for the moments that genuinely block — confirming a spend, confirming a
// discard — and it centres a heavy panel with a header and a footer. This is a light overlay near
// the top of the window that the grid stays visible behind, because the thing you are about to act
// on is usually the thing you are looking at.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { rank } from "./commandMatch.ts";
import "./CommandPalette.css";

export interface Command {
  /** Stable across renders — it is the React key and the "recently used" identity. */
  id: string;
  label: string;
  /** The group heading it appears under. */
  group: string;
  /** Words that should find it but are not in its name: "csv" for Export, "sheet" for Table. */
  keywords?: string;
  /** Shown right-aligned: a shortcut, or a one-word note about what will happen. */
  hint?: string;
  /**
   * Present and non-empty means the command is OFFERED BUT REFUSED, and this is the reason.
   *
   * It is shown rather than the command being hidden. A palette that silently omits what you are
   * looking for cannot be told apart from one that does not have it, and "Undo — nothing to undo"
   * answers the question that dropping the row leaves open.
   */
  disabledReason?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}

/** Matches the CSS exit duration; kept in one place so the two cannot drift. */
const EXIT_MS = 120;

export function CommandPalette({ open, onClose, commands }: Props) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // A fresh box every time it opens. Reopening onto the last search is briefly convenient and then
  // permanently confusing — you type, nothing appears, because the box already held three letters
  // you cannot see the point of.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    setLeaving(false);
    // The input mounts with the portal, so focus waits one frame for it to exist.
    const t = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(t);
  }, [open]);

  const results = useMemo(
    () => rank(commands, query, (c) => c.label, (c) => `${c.keywords ?? ""} ${c.group}`),
    [commands, query],
  );

  // The cursor is clamped rather than reset on every keystroke: typing one more letter usually
  // narrows the list without changing which command you are aiming at, and snapping back to the top
  // each time makes it impossible to type and press Enter in one motion.
  const active = Math.min(cursor, Math.max(0, results.length - 1));

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, results.length]);

  const dismiss = () => {
    setLeaving(true);
    setTimeout(onClose, EXIT_MS);
  };

  const choose = (i: number) => {
    const cmd = results[i]?.item;
    if (!cmd || cmd.disabledReason) return;
    // Closed BEFORE the command runs. Several of these open a drawer or a dialog and move focus
    // into it; leaving the palette mounted meant it took the focus straight back on its own exit
    // and the thing it had just opened was left unreachable.
    onClose();
    cmd.run();
  };

  if (!open) return null;

  // Grouped for display, but the ORDER inside a group is the ranking's, and the groups themselves
  // appear in the order their best result did. Sorting groups alphabetically would put the best
  // match halfway down the list, which defeats the ranking entirely.
  const groups: Array<{ name: string; items: Array<{ i: number; cmd: Command; hits: number[] }> }> = [];
  results.forEach((r, i) => {
    const name = r.item.group;
    let g = groups.find((x) => x.name === name);
    if (!g) { g = { name, items: [] }; groups.push(g); }
    g.items.push({ i, cmd: r.item, hits: r.hits });
  });

  return createPortal(
    <div
      className={`cc-cmdk${leaving ? " cc-cmdk--out" : ""}`}
      // The scrim dismisses; a click INSIDE the panel must not, which is why this checks the target
      // rather than relying on the panel to stop propagation — a stopped click also breaks text
      // selection inside the input on some platforms.
      onMouseDown={(e) => { if (e.target === e.currentTarget) dismiss(); }}
    >
      <div className="cc-cmdk__panel" role="dialog" aria-modal="true" aria-label="Commands">
        <input
          ref={inputRef}
          className="cc-cmdk__input"
          placeholder="Type a command, or a table to jump to…"
          value={query}
          role="combobox"
          aria-expanded="true"
          aria-controls="cc-cmdk-list"
          aria-activedescendant={results[active] ? `cc-cmdk-opt-${active}` : undefined}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setCursor(Math.min(active + 1, results.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setCursor(Math.max(active - 1, 0)); }
            else if (e.key === "Home") { e.preventDefault(); setCursor(0); }
            else if (e.key === "End") { e.preventDefault(); setCursor(results.length - 1); }
            else if (e.key === "Enter") { e.preventDefault(); choose(active); }
            else if (e.key === "Escape") { e.preventDefault(); dismiss(); }
          }}
        />

        <div className="cc-cmdk__list" id="cc-cmdk-list" role="listbox" ref={listRef}>
          {results.length === 0 && (
            /* Named, not a shrug. "No results" leaves you wondering whether the command exists
               under another name or the box is broken. */
            <p className="cc-cmdk__empty">Nothing here matches “{query}”.</p>
          )}
          {groups.map((g) => (
            <div key={g.name} className="cc-cmdk__group">
              <div className="cc-cmdk__grouphead">{g.name}</div>
              {g.items.map(({ i, cmd, hits }) => (
                <div
                  key={cmd.id}
                  id={`cc-cmdk-opt-${i}`}
                  role="option"
                  aria-selected={i === active}
                  aria-disabled={!!cmd.disabledReason}
                  data-active={i === active}
                  className={`cc-cmdk__row${cmd.disabledReason ? " cc-cmdk__row--off" : ""}`}
                  // Hover moves the cursor, so the mouse and the keyboard cannot end up pointing at
                  // two different rows while one of them is highlighted.
                  onMouseMove={() => setCursor(i)}
                  onClick={() => choose(i)}
                >
                  <span className="cc-cmdk__label truncate">{mark(cmd.label, hits)}</span>
                  <span className="cc-cmdk__hint mono">{cmd.disabledReason ?? cmd.hint ?? ""}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The letters the query matched, marked in place. */
function mark(label: string, hits: number[]) {
  if (hits.length === 0) return label;
  const set = new Set(hits);
  return [...label].map((ch, i) =>
    set.has(i) ? <b key={i} className="cc-cmdk__hit">{ch}</b> : <span key={i}>{ch}</span>,
  );
}
