// Removing duplicate rows.
//
// This screen deletes data, so its shape is dictated by that: nothing here removes a row until the
// count of what would go has been shown, and the count is produced by the same code the run uses.
// Changing a setting only ever re-counts.
//
// The waterfall is the part worth explaining in the UI rather than in a tooltip. Half a real list
// has an email, the rest only a domain, a few only a LinkedIn URL — so "match on Email" quietly
// keeps every duplicate that happens to be missing one, and reports success. An ordered list of
// columns is the fix, and reading it as a sentence ("first Email, then Domain") is how it stops
// being a feature people have to be taught.

import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "../ui/Modal.tsx";
import { Select } from "../ui/Select.tsx";
import { IconPlus } from "../ui/Icon.tsx";
import type { Column } from "../api.ts";
import "./Dedupe.css";

interface Config {
  columnIds: number[];
  keep: "oldest" | "newest";
  auto: boolean;
}

interface Report {
  groups: number;
  duplicates: number;
  unkeyed: number;
  rows: number;
  samples: Array<{ key: string; column: string; count: number }>;
}

interface Props {
  sheetId: string;
  /** Named on screen, because this rule belongs to ONE table and acts only on that table's rows. */
  sheetName: string;
  columns: Column[];
  /**
   * Open with this column already chosen as the thing to match on.
   *
   * Set when this was opened from a column's own menu — "deduplicate on this column" is a complete
   * sentence, and making the user re-pick the column they just right-clicked is the sort of small
   * repetition that makes a menu item feel like it did not work.
   *
   * Only applied when there is no saved rule yet: overwriting a waterfall someone built, because
   * they right-clicked a header, would be a destructive answer to a mild request.
   */
  startWith?: number | null;
  onClose: () => void;
  onChanged: () => void;
}

export function Dedupe({ sheetId, sheetName, columns, startWith, onClose, onChanged }: Props) {
  const [config, setConfig] = useState<Config>({ columnIds: [], keep: "oldest", auto: false });
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sheets/${sheetId}/dedupe`).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      setConfig(res.config);
    } catch {
      setError("Could not reach the engine.");
    }
  }, [sheetId]);

  /**
   * The count, asked for separately.
   *
   * Counting is a full pass over the table — about two seconds on a million rows — and it used to
   * ride along with every settings read and write. That meant picking a column froze the whole app,
   * because the engine is single-threaded and the grid's own requests queued behind it. Now the
   * setting saves instantly and the number arrives when it arrives, with the wait visible.
   */
  const [counting, setCounting] = useState(false);
  const countRun = useRef(0);
  const recount = useCallback(async (cfg: Config) => {
    if (cfg.columnIds.length === 0) { setReport(null); setCounting(false); return; }
    const run = ++countRun.current;
    setCounting(true);
    try {
      const res = await fetch(`/api/sheets/${sheetId}/dedupe/preview`).then((r) => r.json());
      // A slower earlier count must not overwrite a newer one — changing two settings quickly would
      // otherwise leave the screen showing the answer to the first question.
      if (run !== countRun.current) return;
      if (res.error) { setError(res.error); return; }
      setReport(res.preview);
    } catch {
      if (run === countRun.current) setError("Could not count the duplicates.");
    } finally {
      if (run === countRun.current) setCounting(false);
    }
  }, [sheetId]);

  useEffect(() => {
    void (async () => {
      await load();
      const res = await fetch(`/api/sheets/${sheetId}/dedupe`).then((r) => r.json()).catch(() => null);
      if (!res?.config) return;
      // Opened from a column's menu with nothing configured: take the hint. With a rule already
      // saved, leave it alone — see `startWith`.
      if (startWith != null && (res.config.columnIds ?? []).length === 0) {
        const seeded = { ...res.config, columnIds: [startWith] };
        await fetch(`/api/sheets/${sheetId}/dedupe`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ columnIds: [startWith] }),
        }).catch(() => null);
        setConfig(seeded);
        void recount(seeded);
        return;
      }
      void recount(res.config);
    })();
  }, [load, recount, sheetId, startWith]);

  const patch = async (next: Partial<Config>) => {
    setBusy(true);
    setError(null);
    setConfirming(false);
    try {
      const res = await fetch(`/api/sheets/${sheetId}/dedupe`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      }).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      setConfig(res.config);
      void recount(res.config);
    } catch {
      setError("Could not reach the engine.");
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sheets/${sheetId}/dedupe/run`, { method: "POST" }).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      setDone(res.report);
      setConfirming(false);
      onChanged();
      await load();
      void recount(config);
    } catch {
      // The destructive path. A failure here has to be stated: the button goes back to "Yes, remove
      // them" either way, and a silent one reads as the rows having been removed.
      setError("Could not remove the duplicates — nothing was changed.");
    } finally {
      setBusy(false);
    }
  };

  const byId = new Map(columns.map((c) => [Number(c.id), c]));
  const chosen = config.columnIds.filter((id) => byId.has(id));
  const available = columns.filter((c) => !chosen.includes(Number(c.id)));

  const setKeys = (ids: number[]) => void patch({ columnIds: ids });

  return (
    <Modal
      open
      onClose={onClose}
      title="Deduplication"
      width={620}
      footNote={
        chosen.length === 0
          ? `Nothing is being matched on in "${sheetName}" yet.`
          : `"${sheetName}" matches on ${chosen.map((id) => byId.get(id)!.name).join(", then ")}`
      }
      footer={<button className="cc-btn" onClick={onClose}>Done</button>}
    >
      {error && <div className="cc-modal__error" role="alert">{error}</div>}

      <div className="cc-dd">
        {/* The waterfall, read as a sentence. */}
        <div className="cc-dd__keys">
          <p className="cc-dd__lead">
            This rule belongs to <strong>{sheetName}</strong> and acts on nothing else. Two rows are the
            same when they match on the first of these columns that <em>both</em> have a value in.
            Order matters — put the strongest identifier first.
          </p>

          {chosen.length === 0 ? (
            <p className="cc-dd__none">No columns picked, so nothing is a duplicate yet.</p>
          ) : (
            <ol className="cc-dd__list">
              {chosen.map((id, i) => (
                <li key={id} className="cc-dd__key">
                  <span className="cc-dd__step mono">{i === 0 ? "first" : "then"}</span>
                  <span className="cc-dd__name truncate">{byId.get(id)!.name}</span>
                  <button
                    className="hk-icon-btn"
                    aria-label={`Move ${byId.get(id)!.name} up`}
                    disabled={i === 0 || busy}
                    title="Try this one earlier"
                    onClick={() => {
                      const next = [...chosen];
                      [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                      setKeys(next);
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 10l4-4 4 4" /></svg>
                  </button>
                  <button
                    className="hk-icon-btn"
                    aria-label={`Move ${byId.get(id)!.name} down`}
                    disabled={i === chosen.length - 1 || busy}
                    title="Try this one later"
                    onClick={() => {
                      const next = [...chosen];
                      [next[i], next[i + 1]] = [next[i + 1]!, next[i]!];
                      setKeys(next);
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l4 4 4-4" /></svg>
                  </button>
                  <button
                    className="hk-icon-btn"
                    aria-label={`Stop matching on ${byId.get(id)!.name}`}
                    disabled={busy}
                    title="Remove"
                    onClick={() => setKeys(chosen.filter((x) => x !== id))}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
                  </button>
                </li>
              ))}
            </ol>
          )}

          {available.length > 0 && (
            <div className="cc-dd__add">
              <Select
                label="Match on another column"
                value=""
                size="sm"
                showLabel={false}
                options={[
                  { value: "", label: "Match on another column…" },
                  ...available.map((c) => ({ value: String(c.id), label: c.name })),
                ]}
                onChange={(v) => { if (v) setKeys([...chosen, Number(v)]); }}
              />
              <IconPlus />
            </div>
          )}
        </div>

        {/* Which copy survives. Explicit, because both answers are right in different jobs and
            guessing costs whichever one was wanted. */}
        <div className="cc-field cc-field--tight">
          <span className="cc-field__label">
            When rows match, keep
            <span className="cc-field__sub">the other copies are removed</span>
          </span>
          <Select
            label="Keep"
            value={config.keep}
            size="sm"
            showLabel={false}
            options={[
              { value: "oldest", label: "The one that arrived first" },
              { value: "newest", label: "The one that arrived last" },
            ]}
            onChange={(v) => void patch({ keep: v as Config["keep"] })}
          />
        </div>

        <label className="cc-dd__check">
          <input
            type="checkbox"
            checked={config.auto}
            disabled={busy || chosen.length === 0}
            onChange={(e) => void patch({ auto: e.target.checked })}
          />
          <span>
            Do this automatically whenever rows arrive
            <span className="cc-dd__checkhint">
              Applies after every import, delivery and added row. Off by default, because it removes
              rows without asking.
            </span>
          </span>
        </label>

        {/* What would happen. Always visible, never behind a button — the number IS the decision. */}
        <div className="cc-dd__report" role="status">
          {done ? (
            <>
              <strong>
                Removed {done.duplicates.toLocaleString()} {done.duplicates === 1 ? "row" : "rows"}.
              </strong>{" "}
              {report?.rows.toLocaleString()} remain.
            </>
          ) : chosen.length === 0 ? (
            <>Pick a column above and the count of duplicates appears here.</>
          ) : report && report.duplicates === 0 ? (
            <>
              <strong>No duplicates.</strong> Nothing in this table matches on{" "}
              {chosen.map((id) => byId.get(id)!.name).join(" or ")}.
              {report.unkeyed > 0 && (
                <span className="cc-dd__caveat">
                  {" "}
                  {report.unkeyed.toLocaleString()} of {report.rows.toLocaleString()} rows are empty in
                  every column above, so nothing could be compared for them.
                </span>
              )}
            </>
          ) : counting ? (
            <>
              {/* Said out loud, because on a large table this takes a couple of seconds and a
                  silent pause reads as the screen having stopped working. */}
              <strong>Counting…</strong>
              <span className="cc-dd__caveat"> Checking every row for matches on {chosen.map((id) => byId.get(id)!.name).join(", then ")}.</span>
            </>
          ) : report ? (
            <>
              <strong>
                {report.duplicates.toLocaleString()} {report.duplicates === 1 ? "row" : "rows"} would be
                removed
              </strong>{" "}
              across {report.groups.toLocaleString()} {report.groups === 1 ? "match" : "matches"}, leaving{" "}
              {(report.rows - report.duplicates).toLocaleString()}.
              {report.unkeyed > 0 && (
                <span className="cc-dd__caveat">
                  {" "}
                  {report.unkeyed.toLocaleString()} rows have nothing in any of these columns and are
                  left alone.
                </span>
              )}
              {report.samples.length > 0 && (
                <ul className="cc-dd__samples">
                  {report.samples.map((s) => (
                    <li key={`${s.column}:${s.key}`}>
                      <span className="cc-dd__samplecol">{s.column}</span>
                      <span className="cc-dd__samplekey mono truncate">{s.key}</span>
                      <span className="cc-dd__samplecount mono">×{s.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <span className="cc-skel" style={{ width: "60%" }} />
          )}
        </div>

        <div className="cc-dd__foot">
          {confirming ? (
            <>
              <span className="cc-dd__warn">
                This removes {report?.duplicates.toLocaleString()} rows and cannot be undone.
              </span>
              <button className="cc-btn cc-btn--xs" onClick={() => setConfirming(false)}>Cancel</button>
              <button className="cc-btn cc-btn--danger" onClick={() => void run()} disabled={busy}>
                {busy ? "Removing…" : "Yes, remove them"}
              </button>
            </>
          ) : (
            <button
              className="cc-btn cc-btn--primary"
              disabled={busy || !report || report.duplicates === 0}
              title={report?.duplicates === 0 ? "There is nothing to remove." : undefined}
              onClick={() => { setDone(null); setConfirming(true); }}
            >
              Remove duplicates
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
