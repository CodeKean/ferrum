// Undo and redo.
//
// The state lives on the SERVER and is read back after every mutation, rather than being mirrored
// here. A browser-side stack would be wrong the moment a second tab was open, and wrong again after
// a reload — and an undo button that is confidently wrong about what it will undo is worse than no
// undo button, because it will be trusted.
//
// The label names the operation ("Undo delete column \"Industry\""), because "Undo" alone asks the
// user to remember what they last did, and the moment they reach for undo is exactly the moment they
// are not sure.

import { useCallback, useEffect, useState } from "react";
import { IconRedo, IconUndo } from "./ui/Icon.tsx";
import "./UndoBar.css";

interface Entry { id: number; kind: string; label: string }
interface State { undo: Entry | null; redo: Entry | null }

interface Props {
  sheetId: string;
  /** Bumped by the app after any mutation, so the buttons re-read without polling. */
  revision: number;
  /** Something changed on the server — the grid has to refetch. */
  onApplied: () => void;
}

export function UndoBar({ sheetId, revision, onApplied }: Props) {
  const [state, setState] = useState<State>({ undo: null, redo: null });
  const [busy, setBusy] = useState(false);
  /** Why the last undo or redo did not happen. */
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/sheets/${sheetId}/undo`).then((r) => r.json());
      setState({ undo: res.undo ?? null, redo: res.redo ?? null });
    } catch { /* the buttons stay disabled rather than the toolbar failing */ }
  }, [sheetId]);

  // Doing anything else clears a stale failure — the message belongs to one press, not to the rest
  // of the session.
  useEffect(() => { setError(null); void refresh(); }, [refresh, revision]);

  const act = useCallback(
    async (dir: "undo" | "redo") => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/sheets/${sheetId}/${dir}`, { method: "POST" }).then((r) => r.json());
        // The server returns the NEW state with the result, so the labels relabel in the same round
        // trip instead of flickering through a stale one.
        if (res.state) setState({ undo: res.state.undo ?? null, redo: res.state.redo ?? null });
        if (res.ok) { onApplied(); return; }
        // A refused undo comes back as HTTP 200 carrying the reason, so `ok` is the only thing that
        // says whether anything happened. Unread, every failed undo was a dead click: the button
        // re-enabled, the label stayed, and nothing on screen had changed.
        setError(res.error ?? "That could not be undone.");
      } catch {
        setError("Could not reach the engine.");
      } finally {
        setBusy(false);
      }
    },
    [sheetId, onApplied],
  );

  // Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z, ignored while typing. Without the field check, undo inside a
  // half-typed column name would revert a column deletion instead of the character just typed —
  // the browser's own text undo has to keep working where text is being edited.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, [contenteditable='true']")) return;
      e.preventDefault();
      void act(e.shiftKey ? "redo" : "undo");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act]);

  return (
    <div className="cc-undo">
      <button
        className="hk-icon-btn"
        onClick={() => void act("undo")}
        disabled={busy || !state.undo}
        aria-label={state.undo ? `Undo ${state.undo.label}` : "Nothing to undo"}
        title={state.undo ? `Undo ${state.undo.label}  ·  Ctrl+Z` : "Nothing to undo"}
      >
        <IconUndo />
      </button>
      <button
        className="hk-icon-btn"
        onClick={() => void act("redo")}
        disabled={busy || !state.redo}
        aria-label={state.redo ? `Redo ${state.redo.label}` : "Nothing to redo"}
        title={state.redo ? `Redo ${state.redo.label}  ·  Ctrl+Shift+Z` : "Nothing to redo"}
      >
        <IconRedo />
      </button>
      {/* Only when there is something to say. The engine's own words are shown rather than a
          generic apology — "FOREIGN KEY constraint failed" is ugly, but it is the truth and it is
          searchable, and a message the user can quote beats one that says nothing. */}
      {error && (
        <span className="cc-undo__error truncate" role="alert" title={error}>{error}</span>
      )}
    </div>
  );
}
