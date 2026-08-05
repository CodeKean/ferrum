// One control, two gestures: click does one thing, double-click does another.
//
// The naive pairing — `onClick={sort} onDoubleClick={rename}` — runs BOTH. A double-click dispatches
// two click events before the dblclick, so every rename also fired the single-click action first.
// Measured on the column header: double-clicking "Company" to rename it silently sorted the table by
// Company, and on a table with real content the rows move under the cursor while you are still
// typing the name. The same pairing on the breadcrumb would navigate away from the thing being
// renamed, which is worse — the editor would open on a screen you had just left.
//
// So the single action WAITS to find out whether a second click is coming. The delay is only ever
// paid by the gesture that has a rival; a keyboard activation has none and runs immediately.

import { useCallback, useEffect, useRef } from "react";

/**
 * Slightly above the ~250ms most systems use to decide a double-click, so a deliberate double is
 * never split into two singles. It is a delay on the SINGLE action only, and 280ms on a click that
 * sorts or navigates is not perceptible; a rename that also sorts very much is.
 */
const DOUBLE_MS = 280;

export interface ClickOrDoubleHandlers {
  onClick: (e: { detail: number }) => void;
  onDoubleClick: (e: { detail: number }) => void;
}

export type GestureTimer = { current: ReturnType<typeof setTimeout> | null };

/**
 * The same rule, for a list that renders its rows in a `map` and so cannot call the hook per row.
 *
 * One timer ref is enough for a whole list: only one gesture can be in flight at a time, and a click
 * on a second row while the first is still waiting is a different gesture that supersedes it.
 */
export function clickOrDouble(
  timer: GestureTimer,
  onSingle: () => void,
  onDouble: () => void,
): ClickOrDoubleHandlers {
  return {
    onClick: (e) => {
      if (e.detail === 0) { onSingle(); return; }
      if (e.detail > 1) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => { timer.current = null; onSingle(); }, DOUBLE_MS);
    },
    onDoubleClick: () => {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      onDouble();
    },
  };
}

export function useClickOrDouble(
  onSingle: () => void,
  onDouble: () => void,
  enabled = true,
): ClickOrDoubleHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Callers pass fresh arrows every render. Held in refs so the returned handlers keep a stable
  // identity and a pending timer is never restarted by an unrelated re-render.
  const single = useRef(onSingle);
  const double = useRef(onDouble);
  single.current = onSingle;
  double.current = onDouble;

  // A timer that outlives its component fires into a dead tree. Cleared on unmount rather than left
  // to resolve — the header this hangs off is unmounted every time a column is deleted or reordered.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const handleClick = useCallback((e: { detail: number }) => {
    // `detail === 0` is a keyboard activation: Enter or Space on a focused button. There is no
    // second click coming, so waiting for one only makes the keyboard feel broken. It also means the
    // double action is unreachable by keyboard from here, which is why every caller keeps a second
    // route to it — the context menu, or a rename item in a menu.
    if (e.detail === 0) { single.current(); return; }
    // The browser's own count. The second click of a double arrives with detail 2 and is ignored
    // here; the dblclick handler below is what acts on it.
    if (e.detail > 1) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; single.current(); }, DOUBLE_MS);
  }, []);

  const handleDouble = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    double.current();
  }, []);

  // With the double action turned off the single one must not be delayed for a gesture that can
  // never arrive — that would be a quarter-second of lag on a plain button, bought for nothing.
  return enabled
    ? { onClick: handleClick, onDoubleClick: handleDouble }
    : { onClick: () => single.current(), onDoubleClick: () => { /* nothing to open */ } };
}
