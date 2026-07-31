// Turn a JSON column into real columns — Clay's "add a field as a column".
//
// The engine for this was built and tested and then had no way in: `discoverJsonFields`,
// `expandJsonColumn` and `refreshChildren` all worked, with routes in front of them, and nothing in
// the app ever called any of it. This screen is the missing door.
//
// What it does: samples the column's actual values, finds every path inside them — including nested
// ones like `hq.city` — and offers each with the share of rows that have it and a real example. You
// tick the ones you want and they become ordinary columns that stay linked to their source, so
// re-running the source refreshes them.
//
// Coverage is shown because it is the thing that decides whether a field is worth a column. A path
// present in 4% of rows makes a column that is 96% empty, and that is only obvious if you are told.

import { useEffect, useState } from "react";
import { Modal, useModalDismiss } from "../ui/Modal.tsx";
import "./ExpandJson.css";

interface Field {
  path: string;
  valueType: string;
  /** 0..1 — the share of sampled rows where this path has a value. */
  coverage: number;
  sample: string | null;
}

interface Props {
  columnId: string;
  columnName: string;
  onClose: () => void;
  onExpanded: () => void;
}

export function ExpandJson({ columnId, columnName, onClose, onExpanded }: Props) {
  const [fields, setFields] = useState<Field[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The app mounts this conditionally, so `<Modal open>` meant every dismissal skipped the shared
  // exit animation. `dismiss` plays it, then unmounts.
  const [open, dismiss] = useModalDismiss(onClose);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/columns/${columnId}/json-fields`).then((r) => r.json());
        if (cancelled) return;
        if (res.error) { setError(res.error); setFields([]); return; }
        const found: Field[] = res.fields ?? [];
        setFields(found);
        // Pre-tick the paths that are present nearly everywhere and hold a plain value. Those are
        // the ones people want and it saves ticking five boxes; a container or a sparse path is left
        // for the user to choose deliberately.
        setPicked(new Set(found.filter((f) => f.coverage >= 0.9 && f.valueType !== "json").map((f) => f.path)));
      } catch {
        if (!cancelled) { setError("Could not read this column's values."); setFields([]); }
      }
    })();
    return () => { cancelled = true; };
  }, [columnId]);

  const toggle = (path: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });

  const expand = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/columns/${columnId}/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `fields`, with the discovered type carried through — not bare paths. The engine uses the
        // type to set each new column's data type, and dropping it would make every extracted field
        // a text column, so a number arrived as text and sorted lexically ("10" before "9").
        body: JSON.stringify({
          fields: (fields ?? [])
            .filter((f) => picked.has(f.path))
            .map((f) => ({ path: f.path, valueType: f.valueType })),
        }),
      }).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      onExpanded();
      dismiss();
    } catch {
      setError("Could not create the columns.");
    } finally {
      setBusy(false);
    }
  };

  const arrays = (fields ?? []).filter((f) => picked.has(f.path) && f.valueType === "array");

  return (
    <Modal
      open={open}
      onClose={dismiss}
      title={`Fields inside "${columnName}"`}
      footNote={fields === null ? "Reading values…" : `${picked.size} selected`}
      footer={
        <>
          <button className="cc-btn" onClick={dismiss}>Cancel</button>
          <button className="cc-btn cc-btn--primary" onClick={() => void expand()} disabled={busy || picked.size === 0}>
            {picked.size === 1 ? "Add 1 column" : `Add ${picked.size} columns`}
          </button>
        </>
      }
    >
      {error && <div className="cc-modal__error" role="alert">{error}</div>}

      {fields === null ? (
        // Fixed-height rows, so the list does not resize the dialog under the cursor when it lands.
        <div className="cc-xj">
          {[0, 1, 2].map((i) => <div key={i} className="cc-xj__skel"><span className="cc-skel" style={{ width: `${40 + i * 15}%` }} /></div>)}
        </div>
      ) : fields.length === 0 ? (
        <p className="cc-modal__summary">
          Nothing JSON-shaped here. This works on columns holding an object or a list — the output of
          an enrichment or an AI column set to return JSON.
        </p>
      ) : (
        <>
          <div className="cc-xj">
            {fields.map((f) => (
              <label key={f.path} className={`cc-xj__row${picked.has(f.path) ? " cc-xj__row--on" : ""}`}>
                <input type="checkbox" checked={picked.has(f.path)} onChange={() => toggle(f.path)} />
                <span className="cc-xj__path mono truncate">{f.path}</span>
                <span className="cc-xj__type">{f.valueType}</span>
                {/* Coverage decides whether a field is worth a column at all — a path in 4% of rows
                    makes a column that is 96% empty. */}
                <span className={`cc-xj__cov mono${f.coverage < 0.5 ? " cc-xj__cov--low" : ""}`}>
                  {Math.round(f.coverage * 100)}%
                </span>
                <span className="cc-xj__sample mono truncate" title={f.sample ?? undefined}>{f.sample ?? "—"}</span>
              </label>
            ))}
          </div>

          {arrays.length > 0 && (
            <div className="cc-modal__warn">
              {arrays.length === 1 ? `"${arrays[0]!.path}" holds a list` : `${arrays.length} of these hold lists`}. A
              list becomes one column containing the whole list. To get a row per item instead, expand
              it into its own table from the column menu once it exists.
            </div>
          )}

          <p className="cc-modal__summary">
            These stay linked to <strong>{columnName}</strong>. Re-running it refreshes them, so they
            never drift from the JSON they came from.
          </p>
        </>
      )}
    </Modal>
  );
}
