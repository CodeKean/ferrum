// One step of the location bar.
//
// Its own component for one reason: renaming needs a per-crumb gesture hook, and a hook cannot be
// called inside the `map` that renders the path.
//
// Every crumb renames, not just the last one. It used to be the last only, which made the gesture
// read as broken rather than as unsupported — a workbook crumb looks identical to a table crumb, and
// double-clicking it did nothing, so the only way to rename a workbook was to leave the table, find
// it in the file browser, and rename it there. The name is on screen; the place it is on screen is
// where it should be editable.
//
// Navigation waits on the double-click rather than racing it. Without that, double-clicking a
// workbook crumb to rename it first NAVIGATED to that workbook — so the rename box opened on a
// screen the user had just been taken away from.

import { useClickOrDouble } from "./ui/clickOrDouble.ts";

export interface Crumb {
  kind: string;
  id: string;
  name: string;
}

interface Props {
  crumb: Crumb;
  /** The end of the path — where you are standing, rather than somewhere above you. */
  last: boolean;
  /** Clicking navigates to it. Not called for the crumb you are already on. */
  onOpen: () => void;
  /** Double-click, or the rename item in the context menu. */
  onStartRename: () => void;
  renaming: boolean;
  onCommitRename: (next: string) => void;
  onCancelRename: () => void;
}

/** What each kind is called, in the words the rest of the app uses. */
const NOUN: Record<string, string> = { table: "table", workbook: "workbook", folder: "folder" };

export function PathCrumb({
  crumb, last, onOpen, onStartRename, renaming, onCommitRename, onCancelRename,
}: Props) {
  // The crumb you are standing on has nothing to navigate to, so its click has no rival and needs no
  // delay — but it still renames on a double-click.
  const gestures = useClickOrDouble(() => { if (!last) onOpen(); }, onStartRename);

  if (renaming) {
    return (
      <span className="cc-path__wrap">
        <span className="cc-path__sep" aria-hidden>/</span>
        <input
          className="cc-path__input"
          defaultValue={crumb.name}
          autoFocus
          aria-label={`Rename this ${NOUN[crumb.kind] ?? "item"}`}
          onFocus={(e) => e.target.select()}
          onBlur={(e) => onCommitRename(e.target.value)}
          onKeyDown={(e) => {
            // Stopped so the grid's key handling and any open drawer do not also act on a keystroke
            // meant for this field.
            e.stopPropagation();
            if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
            if (e.key === "Escape") { e.preventDefault(); onCancelRename(); }
          }}
        />
      </span>
    );
  }

  const noun = NOUN[crumb.kind] ?? "item";
  return (
    <span className="cc-path__wrap">
      <span className="cc-path__sep" aria-hidden>/</span>
      <button
        className={`cc-path__crumb${last ? " cc-path__crumb--here" : ""}`}
        // Says what BOTH gestures do, on every crumb. The old title promised renaming on the last
        // crumb and only opening on the others, which was an accurate description of a bug.
        title={last ? `${crumb.name} — double-click to rename this ${noun}` : `Open ${crumb.name} — double-click to rename this ${noun}`}
        onClick={gestures.onClick}
        onDoubleClick={(e) => { e.stopPropagation(); gestures.onDoubleClick(e); }}
        // The keyboard route to renaming, since a double-click has none. The context menu the rest of
        // the app uses is a right-click, and this matches it.
        onContextMenu={(e) => { e.preventDefault(); onStartRename(); }}
      >
        <span className="truncate">{crumb.name}</span>
      </button>
    </span>
  );
}
