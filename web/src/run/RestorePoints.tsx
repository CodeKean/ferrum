// Putting back what a run replaced.
//
// The sentence this screen has to get right, and the reason it is not called "Undo": the VALUES come
// back, the MONEY does not. A run that spent $40 cannot be un-spent, and a screen that implied
// otherwise would be lying about the one thing people check. So the money is stated plainly on the
// confirmation rather than left for the user to work out.
//
// Three things are on every row, for the same reason they are on a schedule's row: what the run was
// about to do, how many cells were saved, and whether this copy has already been used. A list you
// have to click into one by one to work out which entry is which is a list nobody uses in the ten
// seconds after a bad run, which is exactly when it is needed.

import { useCallback, useEffect, useState } from "react";
import { Modal } from "../ui/Modal.tsx";
import { IconAlert } from "../ui/Icon.tsx";
import "./RestorePoints.css";

export interface RestorePoint {
  runId: string;
  sheetId: string;
  label: string;
  cellCount: number;
  columnIds: number[];
  createdAt: string;
  restoredAt: string | null;
}

interface RestoreResult { restored: number; cleared: number; gone: number }

/** "3 minutes ago" beats a timestamp here: the question is always "was that the run I just made?". */
function ago(iso: string): string {
  // SQLite writes `datetime('now')` as UTC without a zone marker, so it is spelled out rather than
  // handed to Date as-is — parsed locally it reads hours in the future and every entry says "just now".
  const then = Date.parse(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (!Number.isFinite(then)) return iso;
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} ${hrs === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

export function RestorePoints({ sheetId, sheetName, onClose, onRestored }: {
  sheetId: string;
  sheetName: string;
  onClose: () => void;
  /** So the grid refetches the cells that just changed underneath it. */
  onRestored?: () => void;
}) {
  const [points, setPoints] = useState<RestorePoint[] | null>(null);
  const [confirming, setConfirming] = useState<RestorePoint | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<RestoreResult | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sheets/${sheetId}/snapshots`).then((r) => r.json());
      setPoints(res.snapshots ?? []);
    } catch {
      setError("Could not reach the engine.");
      setPoints([]);
    }
  }, [sheetId]);

  useEffect(() => { void load(); }, [load]);

  const restore = async (p: RestorePoint) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${p.runId}/restore`, { method: "POST" }).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      setDone(res.result as RestoreResult);
      setConfirming(null);
      await load();
      onRestored?.();
    } catch {
      setError("Could not reach the engine.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={`Restore points for ${sheetName}`}
        footNote="Kept for the last three runs on this table. Values only — a run's cost is not refunded."
        footer={<button className="cc-btn" onClick={onClose}>Close</button>}
      >
        {done && (
          <p className="cc-rp__done" role="status">
            Put back {done.restored.toLocaleString()} {done.restored === 1 ? "value" : "values"}
            {done.cleared > 0 && <> and emptied {done.cleared.toLocaleString()} {done.cleared === 1 ? "cell" : "cells"} the run had filled</>}
            {done.gone > 0 && <> · {done.gone.toLocaleString()} had nowhere to go back to, because the row or column has since been deleted</>}.
          </p>
        )}

        {points === null && <p className="cc-rp__empty">Loading…</p>}

        {points?.length === 0 && (
          <p className="cc-rp__empty">
            Nothing to put back yet. A restore point is saved automatically whenever a run is about to
            replace cells that already hold answers — a first run over an empty column has nothing to
            save, so it makes none.
          </p>
        )}

        {points && points.length > 0 && (
          <ul className="cc-rp__list">
            {points.map((p) => (
              <li key={p.runId} className="cc-rp__row">
                <div className="cc-rp__main">
                  <span className="cc-rp__label truncate" title={p.label}>{p.label}</span>
                  <span className="cc-rp__sub">
                    {p.cellCount.toLocaleString()} {p.cellCount === 1 ? "cell saved" : "cells saved"} · {ago(p.createdAt)}
                    {p.restoredAt && <> · put back {ago(p.restoredAt)}</>}
                  </span>
                </div>
                <button className="cc-btn cc-btn--sm" onClick={() => { setDone(null); setConfirming(p); }}>
                  Put values back
                </button>
              </li>
            ))}
          </ul>
        )}

        {error && !confirming && <p className="cc-rp__error"><IconAlert /> {error}</p>}
      </Modal>

      <Modal
        open={!!confirming}
        onClose={() => setConfirming(null)}
        title="Put the old values back?"
        footNote={error ?? "This replaces what the run produced. It does not refund what the run cost."}
        footer={
          <>
            <button className="cc-btn" onClick={() => setConfirming(null)}>Cancel</button>
            <button
              className="cc-btn cc-btn--primary"
              disabled={busy}
              onClick={() => confirming && void restore(confirming)}
            >
              Put back {confirming?.cellCount.toLocaleString()} {confirming?.cellCount === 1 ? "value" : "values"}
            </button>
          </>
        }
      >
        <p className="cc-modal__summary">
          <strong>{confirming?.label}</strong>
        </p>
        <p className="cc-rp__warn">
          Every cell this run replaced goes back to the value it held before — and every cell the run
          FILLED that was empty before goes back to empty. Cells that a later run has since rewritten
          are left alone.
        </p>
      </Modal>
    </>
  );
}
