// The column header's name, editable in place.
//
// Columns could not be renamed at all — the server route existed, nothing reached it. This is the
// house's in-place editor: no box, no chrome, identical whether you are reading it or typing in it.
// A bordered input appearing on double-click would shift every neighbouring header by its border
// width, which is the layout shift the whole grid is built to avoid.
//
// Renaming is SAFE by construction: prompts and scripts store column ids, never names, so a rename
// cannot break a rule that references this column. That is why this can be a casual double-click
// rather than a dialog with a warning.

import { useEffect, useRef, useState } from "react";

interface Props {
  name: string;
  /** Resolves to an error message, or null on success. */
  onRename: (next: string) => Promise<string | null>;
  onSort: () => void;
  /** Opened by the caller; this only reports the double-click that starts editing. */
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
}

export function ColumnName({ name, onRename, onSort, editing, onEditingChange }: Props) {
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  // The draft follows the committed name whenever editing starts, so an abandoned edit does not
  // reappear the next time the header is double-clicked.
  //
  // Focus is claimed twice, and the second time is not belt-and-braces.
  //
  // Opening this from the context menu removes the menu item that currently holds focus in the same
  // commit, and the browser's focus fix-up for a removed active element lands AFTER this effect —
  // it resets to <body>, silently undoing the focus() below. The field appeared with no caret and
  // typing went nowhere.
  //
  // The re-assert is conditional on focus being on <body> specifically. Unconditional re-focusing
  // would yank the caret back out of anything the user clicked into during that frame, and a frame
  // is long enough for that to happen.
  useEffect(() => {
    if (!editing) return;
    setDraft(name);
    setError(null);

    const claim = () => { ref.current?.focus(); ref.current?.select(); };
    claim();

    // A timer, not requestAnimationFrame: rAF does not fire while the tab is in the background, so
    // an editor opened in a background tab would never become typeable.
    const t = setTimeout(() => {
      if (document.activeElement === document.body) claim();
    }, 0);
    return () => clearTimeout(t);
  }, [editing, name]);

  const commit = async () => {
    const next = draft.trim();
    if (!next || next === name) { onEditingChange(false); return; }

    const err = await onRename(next);
    if (err) {
      // Stay in the editor with the text intact. Closing on failure would discard what was typed and
      // silently leave the old name, which reads as the rename having worked and then reverted.
      setError(err);
      ref.current?.focus();
      return;
    }
    onEditingChange(false);
  };

  if (!editing) {
    return (
      <button
        className="cc-th__label truncate"
        onClick={onSort}
        onDoubleClick={(e) => { e.stopPropagation(); onEditingChange(true); }}
        title={`${name} — click to sort, double-click to rename`}
      >
        <span className="truncate">{name}</span>
      </button>
    );
  }

  return (
    <input
      ref={ref}
      className={`cc-th__rename${error ? " cc-th__rename--error" : ""}`}
      value={draft}
      aria-label={`Rename ${name}`}
      title={error ?? undefined}
      onChange={(e) => { setDraft(e.target.value); setError(null); }}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        // Stopped so the grid's own key handling — and any drawer listening for Escape — does not
        // also act on a keystroke meant for this field.
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); void commit(); }
        if (e.key === "Escape") { e.preventDefault(); onEditingChange(false); }
      }}
    />
  );
}
