// Runs that start themselves, on a clock.
//
// This screen decides how money is spent while nobody is looking at it, so its whole shape is
// dictated by that. Three things follow from it and are not negotiable in the layout:
//
//   THE ROW SAYS WHAT WILL HAPPEN, IN WORDS. "Every Monday at 09:00 · 3 columns · next Monday
//   09:00" is readable without opening anything. A list of schedules you have to click into one by
//   one to audit is a list nobody audits.
//
//   THE SWITCH IS THE LAST STEP, AND IT IS SEPARATE. Creating a schedule saves it switched off.
//   Turning it on is its own deliberate act, on a control that says so.
//
//   WHAT HAPPENED LAST TIME IS ON THE ROW. A schedule that quietly did nothing — nothing matched
//   the filter, a key expired, the previous run was still going — is indistinguishable from a
//   broken one unless the reason is where you can see it.

import { useCallback, useEffect, useState } from "react";
import { Modal } from "../ui/Modal.tsx";
import { Select } from "../ui/Select.tsx";
import { IconPlus, IconTrash, IconAlert } from "../ui/Icon.tsx";
import type { Column } from "../api.ts";
import "./Schedules.css";

export type Cadence =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; at: number }
  | { kind: "weekly"; weekday: number; at: number };

interface Scope {
  columnIds?: number[];
  viewId?: number;
}

export interface Schedule {
  id: number;
  sheetId: string;
  name: string;
  cadence: Cadence;
  scope: Scope;
  enabled: boolean;
  force: boolean;
  budgetUsd: number | null;
  nextAt: string;
  lastAt: string | null;
  lastRunId: string | null;
  lastStatus: string;
  runs: number;
}

interface View { id: number; name: string }

/** Kinds that never cost anything and never leave the machine are not worth scheduling. */
const RUNNABLE = new Set(["ai", "agent", "http", "mcp", "send", "script", "lookup", "rollup"]);

const CADENCE_KINDS = [
  { value: "interval", label: "Every so often" },
  { value: "daily", label: "Once a day" },
  { value: "weekly", label: "Once a week" },
];

const INTERVALS = [
  { value: "15", label: "15 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "60", label: "1 hour" },
  { value: "180", label: "3 hours" },
  { value: "360", label: "6 hours" },
  { value: "720", label: "12 hours" },
  { value: "1440", label: "1 day" },
];

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
  .map((d, i) => ({ value: String(i), label: d }));

/** Every half hour of the day. Enough control for "before I get in" without a time widget. */
const TIMES = Array.from({ length: 48 }, (_, i) => {
  const m = i * 30;
  const v = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return { value: String(m), label: v };
});

const clock = (at: number) =>
  `${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`;

/** Mirrors `describe` on the server, so the row reads the same before and after it is saved. */
export function describe(c: Cadence): string {
  if (c.kind === "interval") {
    const m = c.minutes;
    if (m % 1440 === 0) return m === 1440 ? "Every day" : `Every ${m / 1440} days`;
    if (m % 60 === 0) return m === 60 ? "Every hour" : `Every ${m / 60} hours`;
    return `Every ${m} minutes`;
  }
  if (c.kind === "daily") return `Every day at ${clock(c.at)}`;
  return `Every ${DAYS[c.weekday]?.label ?? "day"} at ${clock(c.at)}`;
}

/** Stored UTC without a zone marker, like every other timestamp here. */
const parse = (s: string) => new Date(`${s.replace(" ", "T")}Z`);

/**
 * "in 4 hours", "tomorrow 07:00" — a relative answer, because the question this column answers is
 * "is that soon", not "what is the date".
 */
function when(iso: string | null, tense: "future" | "past" = "future"): string {
  if (!iso) return "—";
  const d = parse(iso);
  const mins = Math.round((d.getTime() - Date.now()) / 60_000);
  const n = Math.abs(mins);
  // Which side of now it falls on is NOT inferred from the sign. A firing that just happened and one
  // about to happen are both zero minutes away, and the caller is the only thing that knows which —
  // reading it off the sign put "any moment" against a run that had already finished.
  const past = tense === "past" || mins < 0;
  if (n < 1) return past ? "just now" : "any moment";
  const rel =
    n < 60 ? `${n} min`
    : n < 60 * 36 ? `${Math.round(n / 60)} hr`
    : `${Math.round(n / 1440)} days`;
  return past ? `${rel} ago` : `in ${rel}`;
}

interface Props {
  sheetId: string;
  sheetName: string;
  columns: Column[];
  onClose: () => void;
}

export function Schedules({ sheetId, sheetName, columns, onClose }: Props) {
  const [list, setList] = useState<Schedule[] | null>(null);
  const [views, setViews] = useState<View[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);

  const runnable = columns.filter((c) => RUNNABLE.has(String(c.kind)));

  const load = useCallback(async () => {
    try {
      const [s, v] = await Promise.all([
        fetch(`/api/sheets/${sheetId}/schedules`).then((r) => r.json()),
        fetch(`/api/sheets/${sheetId}/views`).then((r) => r.json()).catch(() => ({ views: [] })),
      ]);
      if (s.error) { setError(s.error); return; }
      setList(s.schedules ?? []);
      setViews(v.views ?? []);
    } catch {
      setError("Could not reach the engine.");
    }
  }, [sheetId]);

  useEffect(() => { void load(); }, [load]);

  const patch = async (id: number, body: Record<string, unknown>, ok?: string) => {
    setError(null); setNote(null);
    try {
      const r = await fetch(`/api/schedules/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }).then((x) => x.json());
      if (r.error) { setError(r.error); return; }
      if (ok) setNote(ok);
      await load();
    } catch { setError("Could not save that change."); }
  };

  const remove = async (id: number) => {
    await fetch(`/api/schedules/${id}`, { method: "DELETE" });
    setNote("Schedule removed.");
    await load();
  };

  const runNow = async (id: number) => {
    setError(null); setNote(null);
    try {
      const r = await fetch(`/api/schedules/${id}/run`, { method: "POST" }).then((x) => x.json());
      if (r.error) { setError(r.error); return; }
      setNote("Started. It is in the run strip like any other run — you can watch or cancel it there.");
      await load();
    } catch { setError("Could not start it."); }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Scheduled runs · ${sheetName}`}
      width={720}
      footNote="A schedule starts an ordinary run: it appears in the run strip, it can be cancelled, and it obeys this table's spending limit."
      footer={<button className="cc-btn" onClick={onClose}>Close</button>}
    >
      {editing ? (
        <Editor
          sheetId={sheetId}
          columns={runnable}
          views={views}
          value={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={async (msg) => { setEditing(null); setNote(msg); await load(); }}
          onError={setError}
        />
      ) : (
        <>
          {list == null && <div className="cc-sched__skel" />}

          {list && list.length === 0 && (
            <div className="cc-sched__empty">
              <p className="cc-sched__empty__h">Nothing runs on a clock here yet.</p>
              <p className="cc-sched__empty__p">
                A schedule re-runs the columns you pick, on its own — which is the only way to notice
                something that changed on the other end, since nothing here changes when it does.
              </p>
            </div>
          )}

          {list && list.length > 0 && (
            <ul className="cc-sched__list">
              {list.map((s) => (
                <li key={s.id} className={`cc-sched__row${s.enabled ? " cc-sched__row--on" : ""}`}>
                  <div className="cc-sched__main">
                    <span className="cc-sched__name">{s.name || describe(s.cadence)}</span>
                    <span className="cc-sched__meta">
                      {s.name ? `${describe(s.cadence)} · ` : ""}
                      {countOf(s, runnable)}
                      {s.budgetUsd != null ? ` · stops at $${s.budgetUsd}` : ""}
                      {s.force ? " · re-runs everything" : ""}
                    </span>
                    {/* What happened last time, on the row. Always occupies its line so switching a
                        schedule on cannot make the row taller and shift the ones below it. */}
                    <span className="cc-sched__last">
                      {s.lastStatus
                        ? `${s.lastStatus} ${when(s.lastAt, "past")}`
                        : "Has not run yet."}
                    </span>
                  </div>

                  <span className="cc-sched__next" title={s.enabled ? `Next: ${s.nextAt} UTC` : "Switched off"}>
                    {s.enabled ? when(s.nextAt) : "off"}
                  </span>

                  <div className="cc-sched__acts">
                    <button
                      className={`cc-sched__switch${s.enabled ? " cc-sched__switch--on" : ""}`}
                      role="switch"
                      aria-checked={s.enabled}
                      aria-label={`${s.enabled ? "Switch off" : "Switch on"} ${s.name || describe(s.cadence)}`}
                      onClick={() => void patch(s.id, { enabled: !s.enabled },
                        s.enabled ? "Switched off. It will not run again until you switch it back on."
                                  : "Switched on. The clock starts from now, so it will not fire straight away.")}
                    >
                      <span className="cc-sched__knob" />
                    </button>
                    <button className="cc-btn cc-btn--sm" onClick={() => void runNow(s.id)}>Run now</button>
                    <button className="cc-btn cc-btn--sm" onClick={() => setEditing(s)}>Edit</button>
                    <button
                      className="cc-icon-btn"
                      title="Remove this schedule"
                      aria-label={`Remove ${s.name || describe(s.cadence)}`}
                      onClick={() => void remove(s.id)}
                    >
                      <IconTrash />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <button className="cc-btn cc-sched__add" onClick={() => setEditing("new")}>
            <IconPlus /> Schedule
          </button>
        </>
      )}

      <div className="cc-sched__msg" role="status" aria-live="polite">
        {error && <span className="cc-sched__err"><IconAlert /> {error}</span>}
        {!error && note && <span className="cc-sched__ok">{note}</span>}
      </div>
    </Modal>
  );
}

/** "3 columns · only the rows in Qualified" — the sentence that makes a row auditable. */
function countOf(s: Schedule, columns: Column[]): string {
  const ids = s.scope.columnIds ?? [];
  const cols = ids.length === 0
    ? "every column that runs"
    : ids.length === 1
      ? (columns.find((c) => Number(c.id) === ids[0])?.name ?? "1 column")
      : `${ids.length} columns`;
  return s.scope.viewId ? `${cols} · one saved view` : cols;
}

// ── the editor ─────────────────────────────────────────────────────────────────────────────────

function Editor(
  { sheetId, columns, views, value, onCancel, onSaved, onError }:
  {
    sheetId: string;
    columns: Column[];
    views: View[];
    value: Schedule | null;
    onCancel: () => void;
    onSaved: (note: string) => void | Promise<void>;
    onError: (e: string | null) => void;
  },
) {
  const [name, setName] = useState(value?.name ?? "");
  const [cadence, setCadence] = useState<Cadence>(value?.cadence ?? { kind: "daily", at: 7 * 60 });
  const [picked, setPicked] = useState<number[]>(value?.scope.columnIds ?? []);
  const [viewId, setViewId] = useState<number | null>(value?.scope.viewId ?? null);
  const [force, setForce] = useState(value?.force ?? false);
  const [budget, setBudget] = useState(value?.budgetUsd == null ? "" : String(value.budgetUsd));
  const [busy, setBusy] = useState(false);

  /**
   * What ONE firing of this would cost, from the server, as the choices change.
   *
   * The single most important thing on this screen. Everything else here is a description of an
   * intention; this is the only number, and without it "every hour" and "every week" are the same
   * decision made blind. It comes from `/resolve-scope` — the same endpoint the ordinary run
   * confirmation uses, resolving the same predicate the run itself will — so it cannot disagree
   * with what the run does.
   *
   * Deliberately labelled "one pass", not "per month": multiplying by the cadence would look
   * authoritative and be wrong the moment the skip applies to some rows and not others.
   */
  const [pass, setPass] = useState<{ rows: number; usd: number; free: boolean; unknown: boolean } | null>(null);

  useEffect(() => {
    let dead = false;
    const scope = { ...(picked.length > 0 ? { columnIds: picked } : {}), ...(viewId != null ? { viewId } : {}) };
    // Debounced: ticking through a column list would otherwise fire a resolve per keystroke, and on
    // a million-row table each of those is real work on the one thread the engine has.
    const t = setTimeout(() => {
      void fetch(`/api/sheets/${sheetId}/resolve-scope`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(scope),
      })
        .then((r) => r.json())
        .then((r) => {
          if (dead || r.error) { if (!dead) setPass(null); return; }
          setPass({
            rows: Number(r.rowCount ?? 0),
            usd: Number(r.cost?.total ?? 0),
            free: !!r.cost?.free,
            // An unpriced column is NOT free, and saying "$0" about one is the reassurance that
            // turns into a surprise. Said plainly instead.
            unknown: !!r.cost?.incomplete || (r.cost?.columns ?? []).some((c: any) => c.unpriced),
          });
        })
        .catch(() => { if (!dead) setPass(null); });
    }, 300);
    return () => { dead = true; clearTimeout(t); };
  }, [sheetId, picked, viewId]);

  const save = async () => {
    setBusy(true); onError(null);
    const body = {
      name: name.trim(),
      cadence,
      scope: { ...(picked.length > 0 ? { columnIds: picked } : {}), ...(viewId != null ? { viewId } : {}) },
      force,
      budgetUsd: budget.trim() === "" ? null : Number(budget),
    };
    try {
      const r = await fetch(
        value ? `/api/schedules/${value.id}` : `/api/sheets/${sheetId}/schedules`,
        { method: value ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      ).then((x) => x.json());
      if (r.error) { onError(r.error); return; }
      await onSaved(
        value
          ? "Saved."
          : "Saved, and switched off. Turn it on when you are happy with what it will run.",
      );
    } catch {
      onError("Could not save that schedule.");
    } finally { setBusy(false); }
  };

  const toggle = (id: number) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <div className="cc-sched__form">
      <div className="cc-sched__fields">
        <div className="cc-field cc-field--tight">
          <span className="cc-field__label">Called</span>
          <input
            className="cc-input"
            value={name}
            placeholder={describe(cadence)}
            disabled={busy}
            aria-label="Name for this schedule"
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="cc-field cc-field--tight">
          <span className="cc-field__label">How often</span>
          <div className="cc-sched__inline">
            <Select
              label=""
              showLabel={false}
              value={cadence.kind}
              options={CADENCE_KINDS}
              onChange={(k) =>
                setCadence(
                  k === "interval" ? { kind: "interval", minutes: 60 }
                  : k === "daily" ? { kind: "daily", at: 7 * 60 }
                  : { kind: "weekly", weekday: 1, at: 9 * 60 },
                )
              }
            />
            {cadence.kind === "interval" && (
              <Select
                label="" showLabel={false}
                value={String(cadence.minutes)}
                options={INTERVALS}
                onChange={(v) => setCadence({ kind: "interval", minutes: Number(v) })}
              />
            )}
            {cadence.kind === "weekly" && (
              <Select
                label="" showLabel={false}
                value={String(cadence.weekday)}
                options={DAYS}
                onChange={(v) => setCadence({ ...cadence, weekday: Number(v) })}
              />
            )}
            {cadence.kind !== "interval" && (
              <Select
                label="" showLabel={false}
                value={String(cadence.at)}
                options={TIMES}
                searchable
                onChange={(v) => setCadence({ ...cadence, at: Number(v) })}
              />
            )}
          </div>
        </div>
      </div>

      <div className="cc-sched__sec">
        <span className="cc-field__label">What it runs</span>
        {columns.length === 0 ? (
          <p className="cc-sched__hint">This table has no columns that run, so a schedule would have nothing to do.</p>
        ) : (
          <>
            <div className="cc-sched__cols">
              {columns.map((c) => (
                <label key={String(c.id)} className="cc-sched__col">
                  <input
                    type="checkbox"
                    checked={picked.includes(Number(c.id))}
                    disabled={busy}
                    onChange={() => toggle(Number(c.id))}
                  />
                  <span>{c.name}</span>
                </label>
              ))}
            </div>
            <p className="cc-sched__hint">
              {picked.length === 0
                ? "Nothing picked means every column that runs — which is the most expensive option, so pick the ones you mean."
                : `${picked.length} picked.`}
            </p>
          </>
        )}
      </div>

      <div className="cc-sched__fields">
        <div className="cc-field cc-field--tight">
          <span className="cc-field__label">Which rows</span>
          <Select
            label="" showLabel={false}
            value={viewId == null ? "" : String(viewId)}
            options={[{ value: "", label: "Every row" }, ...views.map((v) => ({ value: String(v.id), label: v.name }))]}
            onChange={(v) => setViewId(v === "" ? null : Number(v))}
          />
        </div>

        <div className="cc-field cc-field--tight">
          <span className="cc-field__label">Stop after spending</span>
          <div className="cc-sched__inline">
            <span className="cc-sched__unit">$</span>
            <input
              className="cc-input cc-input--num"
              type="number"
              min={0}
              step={1}
              size={5}
              value={budget}
              placeholder="no limit"
              disabled={busy}
              aria-label="Stop this schedule after spending, in dollars"
              onChange={(e) => setBudget(e.target.value)}
            />
          </div>
        </div>
      </div>

      <label className="cc-sched__check">
        <input type="checkbox" checked={force} disabled={busy} onChange={(e) => setForce(e.target.checked)} />
        <span>
          Re-run every row, even ones that have not changed
          <span className="cc-sched__hint">
            Off, a column that reads other columns skips rows whose inputs are the same as last
            time — so a daily check over a million rows can cost almost nothing. A column that reads
            nothing from this table has no inputs to compare, so it runs every row every time
            whatever this is set to. Check what one full pass costs before switching the schedule on.
          </span>
        </span>
      </label>

      {/* Label left, value right, edge to edge — and always present, so the row cannot appear and
          push the buttons under a pointer about to click them. */}
      <div className="cc-sched__pass">
        <span className="cc-sched__pass__k">Each time this runs</span>
        <span className="cc-sched__pass__v">
          {pass == null
            ? "…"
            : `${pass.rows.toLocaleString()} row${pass.rows === 1 ? "" : "s"} · ${
                pass.unknown ? "price unknown"
                : pass.free ? "free"
                : pass.usd === 0 ? "$0"
                : pass.usd >= 0.01 ? `about $${pass.usd.toFixed(2)}`
                : `under a cent`
              }`}
        </span>
      </div>

      <div className="cc-sched__formacts">
        <button className="cc-btn cc-btn--primary" onClick={() => void save()} disabled={busy}>
          {busy ? "Saving…" : value ? "Save" : "Create it"}
        </button>
        <button className="cc-btn" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}
