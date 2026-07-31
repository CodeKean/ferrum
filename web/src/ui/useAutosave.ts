// Save what was typed, without saving on every keystroke.
//
// Both ends of that are real problems here. A PATCH per character bumps the column's version and
// marks every downstream cell stale, so typing one sentence would re-stale the sheet forty times.
// But saving only on blur loses the work of anyone who types an instruction and goes straight to
// Run — they never blurred anything, and that is the worst possible moment to drop it.
//
// So: settle shortly after typing stops, flush early on anything that ends the edit, and flush on
// unmount so closing the drawer mid-word keeps the word.

import { useCallback, useEffect, useRef } from "react";

export interface Autosave<T> {
  /** Call on every change. Saves once the changes settle. */
  schedule: (value: T) => void;
  /** Save now if anything is pending. Safe to call when nothing is. */
  flush: () => void;
  /** Adopt a value as already-saved, so a later flush does not re-send it. */
  markSaved: (value: T) => void;
}

export function useAutosave<T>(save: (value: T) => void, delayMs = 600): Autosave<T> {
  const pending = useRef<T | null>(null);
  const lastSent = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Held in a ref so the returned callbacks stay stable across renders. Without it, `flush` changes
  // identity every render and the unmount effect below tears down and re-arms on every keystroke —
  // which on the last render before unmount means flushing nothing.
  const saveRef = useRef(save);
  saveRef.current = save;

  const flush = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const next = pending.current;
    pending.current = null;
    if (next == null) return;
    const snapshot = JSON.stringify(next);
    if (snapshot === lastSent.current) return;
    lastSent.current = snapshot;
    saveRef.current(next);
  }, []);

  const schedule = useCallback((value: T) => {
    pending.current = value;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, delayMs);
  }, [flush, delayMs]);

  const markSaved = useCallback((value: T) => {
    lastSent.current = JSON.stringify(value);
    pending.current = null;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);

  useEffect(() => flush, [flush]);

  return { schedule, flush, markSaved };
}
