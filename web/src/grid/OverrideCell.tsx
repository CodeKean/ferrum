// Typing over a value a column produced for itself.
//
// ── Why this exists at all ─────────────────────────────────────────────────────────────────────
//
// Hand-correcting one wrong answer in ten thousand is a real thing people need to do — the run
// engine has an entire setting about whether to preserve those corrections. What was wrong before
// was that it happened by ACCIDENT: a stray keystroke on a selected cell wrote over an enrichment's
// answer with no mark that survived a reload, and on a derived column one Delete permanently cut
// that cell off from its source with nothing anywhere saying so.
//
// So the edit is still possible and it is now a decision. One gesture, one cell, one value.
//
// ── Why not an "armed" mode ────────────────────────────────────────────────────────────────────
//
// The obvious alternative is a toggle that makes the next keystroke land. It is worse in the way
// that matters: it is invisible four seconds after you set it, it stays on while you look at
// something else, and it makes Delete destructive again — which is the exact key that caused the
// worst version of this problem.

import { useState } from "react";
import { Modal, useModalDismiss } from "../ui/Modal.tsx";
import { ColumnKindIcon } from "../ui/ColumnKindIcon.tsx";
import { columnBadge, sourceNameOf } from "../ui/columnBadge.ts";
import { overrideWarning } from "@shared/columnLock.ts";
import type { Column } from "../api.ts";
import "./OverrideCell.css";

export interface OverrideTarget {
  rowId: string;
  column: Column;
  /** What the cell holds now, so the box opens on it rather than on nothing. */
  current: string;
}

export function OverrideCell({ target, columns, onClose, onDone, onNotice }: {
  target: OverrideTarget;
  columns: Column[];
  onClose: () => void;
  /** Called after the write lands, so the grid can take the server's version of the cell. */
  onDone: (cell: unknown) => void;
  onNotice?: (message: string) => void;
}) {
  const [open, dismiss] = useModalDismiss(onClose);
  const [value, setValue] = useState(target.current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const badge = columnBadge(target.column, sourceNameOf(target.column, columns));
  const derived = target.column.sourceColumnId != null && !!target.column.jsonPath;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/cells/${target.rowId}:${target.column.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // The flag is what separates a deliberate override from an accident, and it is checked on
        // the SERVER — a client-side "are you sure" that sends an ordinary write would be a prompt
        // rather than a rule.
        body: JSON.stringify({ value, override: true }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.error) {
        setError(String(body?.error ?? "That change was not saved."));
        setBusy(false);
        return;
      }
      onDone(body.cell);
      onNotice?.(
        derived
          ? "Saved. This cell is flagged whenever its source produces something different — restore it from the cell details."
          : "Saved. Runs will leave this value alone.",
      );
      dismiss();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={dismiss}
      title={`Override "${target.column.name}"`}
      footer={
        <>
          <button className="cc-btn" onClick={dismiss} disabled={busy}>Cancel</button>
          <button className="cc-btn cc-btn--primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Override"}
          </button>
        </>
      }
    >
      {error && <div className="cc-modal__error" role="alert">{error}</div>}

      {/* What normally fills this cell, with the same mark the column wears everywhere else. */}
      <div className="cc-ov__what">
        <ColumnKindIcon kind={badge.kind} title={badge.title} />
        <span>{target.column.lockedReason ?? badge.title}</span>
      </div>

      <label className="cc-ov__field">
        <span className="cc-ov__label">Your value</span>
        <textarea
          className="cc-input cc-ov__input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={3}
          autoFocus
          aria-label={`New value for ${target.column.name}`}
        />
      </label>

      {/* The consequence, stated per kind. Each one is true and none is obvious — the http case in
          particular, where pinning protects the WRITE and not the CALL, so somebody overriding a
          cell to stop paying for it would go on paying. */}
      <div className="cc-ov__warn">{overrideWarning(target.column)}</div>

      {/* Emptying is offered as its own button rather than left to be discovered by clearing the
          box, because on a derived column a pinned EMPTY value is the hardest state to recover
          from, and it should be as deliberate as any other override. */}
      {value !== "" && (
        <button className="cc-btn cc-btn--ghost cc-btn--xs cc-ov__clear" onClick={() => setValue("")}>
          Empty this cell instead
        </button>
      )}
    </Modal>
  );
}
