// What this column has actually done.
//
// The History tab was a hardcoded paragraph: "Run history appears here once this column has run."
// It fetched nothing and rendered nothing, so on a column that had just processed 60,000 rows twice
// it said exactly the same thing — which reads as "you have not run it yet" rather than "this screen
// was never built", and sends someone looking for what they did wrong.
//
// Everything here was already being recorded. The three questions the tab exists to answer, in the
// order people ask them:
//
//   what happened when it ran        — the runs, newest first
//   why are some cells failing       — the distinct errors, grouped, with how many rows each
//   which version of the rule ran    — the code versions and whether they were ever approved

import { useEffect, useState } from "react";
import "./ColumnHistory.css";

interface RunRow {
  id: string;
  status: string;
  total: number;
  done: number;
  errors: number;
  skipped: number;
  costUsd: number;
  budgetUsd: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  pauseReason: string | null;
}

interface History {
  runs: RunRow[];
  failures: Array<{ message: string; rows: number }>;
  scripts: Array<{ id: number; hook: string; version: number; hash: string; runtime: string; approvedAt: string | null; createdAt: string }>;
}

/**
 * A run's outcome in the words the rest of the app uses.
 *
 * `paused_budget` and `paused_quota` are deliberately different sentences: one is a limit the user
 * set and can raise, the other is the provider throttling them and can only be waited out. They read
 * the same as a status string and lead to opposite actions.
 */
const OUTCOME: Record<string, string> = {
  done: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
  running: "Running",
  pending: "Starting",
  cancelling: "Cancelling",
  paused: "Paused",
  paused_budget: "Stopped at its spending limit",
  paused_quota: "Paused — the provider was rate limiting",
  paused_auth: "Paused — the key was rejected",
};

function when(iso: string | null): string {
  if (!iso) return "—";
  // The engine writes SQLite's "YYYY-MM-DD HH:MM:SS" in UTC; Date needs to be told that, or every
  // timestamp reads as local time and a run from an hour ago shows as being in the future.
  const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function took(a: string | null, b: string | null): string {
  if (!a || !b) return "—";
  const utc = (t: string) => new Date(t.includes("T") ? t : `${t.replace(" ", "T")}Z`).getTime();
  const s = Math.round((utc(b) - utc(a)) / 1000);
  if (!Number.isFinite(s) || s < 0) return "—";
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function ColumnHistory({ columnId }: { columnId: string }) {
  const [data, setData] = useState<History | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    fetch(`/api/columns/${columnId}/history`)
      .then((r) => r.json())
      .then((d) => { if (!live) return; if (d.error) setError(d.error); else setData(d); })
      .catch(() => { if (live) setError("Could not reach the engine."); });
    return () => { live = false; };
  }, [columnId]);

  if (error) return <div className="cc-errors" role="alert"><div className="cc-errors__row">{error}</div></div>;
  // A fixed-height placeholder rather than nothing, so the panel does not jump when the data lands.
  if (!data) return <div className="cc-hist__loading" aria-hidden />;

  const nothing = data.runs.length === 0 && data.failures.length === 0 && data.scripts.length === 0;
  if (nothing) {
    return (
      <div className="cc-empty-note">
        This column has not run yet. Once it has, every run shows here with the rows it touched, what
        it cost, and anything that failed.
      </div>
    );
  }

  return (
    <div className="cc-hist">
      {/* Failures first when there are any: it is the reason the tab gets opened. */}
      {data.failures.length > 0 && (
        <section className="cc-hist__sec">
          <h4 className="cc-hist__title">What is failing</h4>
          <ul className="cc-hist__fails">
            {data.failures.map((f, i) => (
              <li key={i} className="cc-hist__fail">
                {/* Count left, message right and flexible — the counts line up down the list and a
                    long message cannot push them out of alignment row by row. */}
                <span className="cc-hist__failn mono">{f.rows.toLocaleString()}</span>
                <span className="cc-hist__failmsg">{f.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="cc-hist__sec">
        <h4 className="cc-hist__title">Runs</h4>
        {data.runs.length === 0 ? (
          <p className="cc-hist__none">No run has touched this column yet.</p>
        ) : (
          <ul className="cc-hist__runs">
            {data.runs.map((r) => (
              <li key={r.id} className="cc-hist__run">
                <span className="cc-hist__when">{when(r.startedAt)}</span>
                <span className="cc-hist__outcome">{OUTCOME[r.status] ?? r.status}</span>
                <span className="cc-hist__counts mono">
                  {r.done.toLocaleString()} done
                  {r.errors > 0 && ` · ${r.errors.toLocaleString()} failed`}
                  {r.skipped > 0 && ` · ${r.skipped.toLocaleString()} skipped`}
                </span>
                <span className="cc-hist__took mono">{took(r.startedAt, r.finishedAt)}</span>
                {/* Zero is "free", not an approximate zero — the same distinction the run strip and
                    the setup panel both got wrong. */}
                <span className="cc-hist__cost mono">{r.costUsd > 0 ? `$${r.costUsd.toFixed(2)}` : "free"}</span>
                {r.pauseReason && <span className="cc-hist__reason">{r.pauseReason}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.scripts.length > 0 && (
        <section className="cc-hist__sec">
          <h4 className="cc-hist__title">Rule versions</h4>
          <ul className="cc-hist__scripts">
            {data.scripts.map((s) => (
              <li key={s.id} className="cc-hist__script">
                <span className="cc-hist__ver mono">v{s.version}</span>
                <span className="cc-hist__hash mono">{s.hash.slice(0, 8)}</span>
                <span className="cc-hist__hook">{s.hook === "condition" ? "run condition" : "value"} · {s.runtime}</span>
                {/* Unapproved is the usual reason a column silently stopped running, so it is stated
                    as a state rather than left as an absent tick. */}
                <span className={s.approvedAt ? "cc-hist__ok" : "cc-hist__warn"}>
                  {s.approvedAt ? "approved" : "never approved — cannot run"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
