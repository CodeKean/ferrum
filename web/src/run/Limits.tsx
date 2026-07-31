// Speed limits — the table's, and the workspace's.
//
// Opened from the TABLE's own menu, beside its schedules and its restore points, because that is
// what it is about. It first lived in Settings, in the rail next to Models and Keys, and that was
// wrong twice over: it is not a workspace preference, and sitting among workspace preferences while
// listing columns from every table left no way to tell which of the two it was. Scope is now an
// explicit switch that starts on THIS TABLE, and the heading says which is showing.
//
// The limits themselves already worked: one per column, set on the column editor, obeyed by the
// pacer, which also backs off on its own when a provider starts refusing. What was missing was
// anywhere to SEE them. A limit set six weeks ago on a column in a table you have not opened since
// is a limit you no longer know about, and the first you hear of it is a run that is mysteriously
// slow with nothing on screen to explain why.
//
// The more valuable half is the inverse. A PAID column with no limit is the one that earns a 429 or
// a bill, and its absence is invisible by construction — there is no setting to notice. So the
// unlimited paid columns sort to the top: this screen is as much about the gaps as the limits.

import { useCallback, useEffect, useState } from "react";
import { IconPlay } from "../ui/Icon.tsx";
import { Modal } from "../ui/Modal.tsx";
import { Select } from "../ui/Select.tsx";
import "./Limits.css";

interface Limit {
  columnId: string;
  columnName: string;
  kind: string;
  sheetId: string;
  sheetName: string;
  limitPerMin: number;
  waitSeconds: number;
  usedLastMinute: number;
  lastRunAt: string | null;
  paid: boolean;
}

/** How often the used-in-the-last-minute figure is re-read while this screen is open. */
const POLL_MS = 5000;

interface Props {
  sheetId: string;
  sheetName: string;
  onClose: () => void;
  /** Jump to another table — only reachable while the scope is every table. */
  onOpenTable: (sheetId: string) => void;
}

export function Limits({ sheetId, sheetName, onClose, onOpenTable }: Props) {
  const [limits, setLimits] = useState<Limit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  /** Starts on the table it was opened from. Widening is a deliberate choice, never the default. */
  const [scope, setScope] = useState<"table" | "workspace">("table");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/limits${scope === "table" ? `?sheet=${encodeURIComponent(sheetId)}` : ""}`)
        .then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      setError(null);
      setLimits(res.limits);
    } catch {
      setError("Could not reach the engine.");
    }
  }, [scope, sheetId]);

  useEffect(() => {
    void load();
    // A poll rather than a live stream: the number moves only while something is running, nobody is
    // watching this screen during a run, and a second SSE channel for a figure that is interesting
    // once an hour is not worth the socket.
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const setLimit = async (l: Limit, next: number) => {
    setSaving(l.columnId);
    try {
      const res = await fetch(`/api/columns/${l.columnId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rateLimitPerMin: next }),
      }).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      setLimits((ls) => ls?.map((x) => (x.columnId === l.columnId ? { ...x, limitPerMin: next } : x)) ?? null);
    } catch {
      setError("That limit was not saved — the engine did not answer.");
    } finally {
      setSaving(null);
    }
  };

  // Unguarded paid columns first, then the ones with a limit, then the rest. Sorted here rather than
  // on the server because it is a presentation decision, and the server's order (by table, then
  // position) is the one a second reader of that route would expect.
  const sorted = (limits ?? []).slice().sort((a, b) => {
    const rank = (l: Limit) => (l.paid && l.limitPerMin === 0 ? 0 : l.limitPerMin > 0 ? 1 : 2);
    return rank(a) - rank(b) || a.sheetName.localeCompare(b.sheetName) || a.columnName.localeCompare(b.columnName);
  });
  const unguarded = sorted.filter((l) => l.paid && l.limitPerMin === 0).length;

  return (
    <Modal
      open
      onClose={onClose}
      // The scope is IN THE TITLE, not only in the switch. A heading that reads the same whichever
      // set is below it is how somebody ends up setting a workspace-wide limit believing they were
      // setting one on this table.
      title={scope === "table" ? `Speed limits · ${sheetName}` : "Speed limits · every table"}
      width={860}
      footNote="A limit is the ceiling you set. The engine also slows down on its own when a provider starts refusing, so a column can run slower than its limit and never faster."
      footer={<button className="cc-btn" onClick={onClose}>Close</button>}
    >
    <div className="cc-limits">
      <header className="cc-limits__head">
        <div className="cc-limits__scope">
          <Select
            label="Showing"
            value={scope}
            options={[
              { value: "table", label: `This table` },
              { value: "workspace", label: "Every table" },
            ]}
            size="sm"
            onChange={(v) => setScope(v)}
          />
        </div>
        <p className="cc-limits__blurb">
          How fast each column is allowed to go, in rows a minute, and how many it actually started in
          the last minute. Zero means no limit.
        </p>
      </header>

      {error && <p className="cc-limits__error" role="alert">{error}</p>}

      {/* Named, and counted. "Some columns have no limit" is a sentence people skim past; a number
          is one they act on. */}
      {unguarded > 0 && (
        <p className="cc-limits__warn" role="status">
          {unguarded === 1
            ? "1 column that spends money has no limit."
            : `${unguarded.toLocaleString()} columns that spend money have no limit.`}{" "}
          They will go as fast as the engine can push them, which is what earns a 429 or a surprise on
          a bill. They are listed first.
        </p>
      )}

      {limits === null && (
        // Skeleton at the real row height and count, so arriving data does not shift the page.
        <div className="cc-limits__list" aria-busy="true">
          {Array.from({ length: 6 }, (_, i) => (
            <div className="cc-limits__row" key={i}><span className="cc-skel" style={{ width: `${40 + ((i * 13) % 40)}%` }} /></div>
          ))}
        </div>
      )}

      {limits !== null && sorted.length === 0 && (
        <p className="cc-limits__empty">
          {scope === "table"
            ? `Nothing in "${sheetName}" spends money or has a limit, so there is nothing to pace. Switch to every table to see the rest of the workspace.`
            : "No columns that spend money, and no limits set anywhere. There is nothing to pace yet."}
        </p>
      )}

      {sorted.length > 0 && (
        <div className="cc-limits__list">
          <div className="cc-limits__row cc-limits__row--head" role="presentation">
            <span>Column</span>
            <span>{scope === "table" ? "" : "Table"}</span>
            <span className="cc-limits__num">Limit / min</span>
            <span className="cc-limits__num">Used in the last minute</span>
            <span />
          </div>

          {sorted.map((l) => {
            const pct = l.limitPerMin > 0 ? Math.min(100, Math.round((l.usedLastMinute / l.limitPerMin) * 100)) : 0;
            // "Near" at four fifths rather than at the limit: a bar that only warns once you are
            // already being throttled tells you something you can no longer act on.
            const near = l.limitPerMin > 0 && pct >= 80;
            return (
              <div className="cc-limits__row" key={l.columnId}>
                <span className="cc-limits__name">
                  <span className="cc-limits__label" title={l.columnName}>{l.columnName}</span>
                  {l.paid && <span className="cc-limits__tag" title="This lane spends money on every row">paid</span>}
                  {l.waitSeconds > 0 && (
                    <span className="cc-limits__tag" title="This column also holds each row for a fixed time">
                      waits {l.waitSeconds}s
                    </span>
                  )}
                </span>

                {/* Only when it varies. Repeating the same table name down every row of a screen
                    that is ABOUT that table is a column of noise. */}
                {scope === "table" ? <span /> : (
                  <button
                    className="cc-linkish truncate cc-limits__table"
                    onClick={() => onOpenTable(l.sheetId)}
                    title={`Open ${l.sheetName}`}
                  >
                    {l.sheetName}
                  </button>
                )}

                {/* Set from here. A screen that lists every limit and makes you go to nine different
                    column editors to change them is a report, not a panel. */}
                <span className="cc-limits__num">
                  <input
                    className="cc-limits__input"
                    type="number"
                    min={0}
                    step={10}
                    value={l.limitPerMin}
                    aria-label={`Rows a minute for ${l.columnName}`}
                    disabled={saving === l.columnId}
                    onChange={(e) => void setLimit(l, Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                  />
                </span>

                <span className="cc-limits__num">
                  <span className="cc-limits__used mono">
                    {l.usedLastMinute.toLocaleString()}
                    {l.limitPerMin > 0 && <span className="cc-limits__of"> / {l.limitPerMin.toLocaleString()}</span>}
                  </span>
                  {/* A bar only where there is a limit to be a proportion OF. Drawing one against
                      "no limit" would need an invented denominator, and an invented denominator on a
                      screen about spending is worse than no bar. */}
                  {l.limitPerMin > 0 && (
                    <span className="cc-limits__bar" aria-hidden>
                      <span className={`cc-limits__fill${near ? " cc-limits__fill--near" : ""}`} style={{ width: `${pct}%` }} />
                    </span>
                  )}
                </span>

                <span className="cc-limits__state">
                  {l.limitPerMin === 0
                    ? <span className={l.paid ? "cc-limits__off" : undefined}>No limit</span>
                    : near ? <span className="cc-limits__near"><IconPlay /> At the limit</span>
                    : null}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
    </Modal>
  );
}
