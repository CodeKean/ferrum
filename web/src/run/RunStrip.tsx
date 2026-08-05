// The run strip.
//
// A 32px sticky SEGMENTED STRIP, not a card. The layout rule that keeps it honest: the progress bar
// is the ONLY flex:1 element — every other segment is width:max-content. So when the window is wide
// the bar absorbs the space, which is a meaningful use of it, and no control ever floats at the far
// edge with a void beside it.
//
// Every numeric reserves a min-width sized to its maximum, so a count going 999 -> 1,000 or a cost
// going $0.09 -> $0.11 cannot resize the strip.

import { useCallback, useSyncExternalStore } from "react";
import { clock } from "../store/cellStore.ts";
import { elapsedSeconds, formatDuration, runStore, type RunState } from "./runStore.ts";
import { IconPlay, IconStop } from "../ui/Icon.tsx";
import "./RunStrip.css";

interface Props {
  sheetId: string;
  onShowErrors?: (runId: string) => void;
}

export function RunStrip({ sheetId, onShowErrors }: Props) {
  useSyncExternalStore(runStore.subscribe, runStore.getVersion);
  const runs = runStore.visible(sheetId);
  if (runs.length === 0) return null;

  // Multiple concurrent runs collapse into one strip plus a count chip — never two stacked strips.
  const primary = runs[0]!;
  return (
    // Not a live region itself. It carries an elapsed clock, a percentage and four counts that all
    // change several times a second, and a polite region over that reads every one of them aloud —
    // which is why it was silenced with `aria-live="off"` and why silencing it was also wrong: the
    // one thing in the app that spends money announced neither its start nor its finish. The
    // announcement is a separate, COARSE line below.
    <div className="cc-runstrip" role="group" aria-label="Run progress">
      <RunRow run={primary} extra={runs.length - 1} onShowErrors={onShowErrors} />
      <RunAnnouncer run={primary} />
    </div>
  );
}

/**
 * What a screen reader is actually told about a run.
 *
 * Rounded to ten percent, so a 200,000-row run produces about a dozen announcements rather than one
 * per frame. Terminal states always announce, because "it finished" is the message people are
 * waiting for.
 */
function RunAnnouncer({ run }: { run: RunState }) {
  // Blanks are accounted work — they ran, they finished, they just hold nothing. Left out, the bar
  // stalls short of 100% on a run that is genuinely over.
  const accounted = run.done + run.errors + run.skipped + run.blank;
  const pct = run.total > 0 ? Math.min(100, Math.round((accounted / run.total) * 10) * 10) : 0;

  const message =
    run.status === "done" ? `Run finished. ${run.done.toLocaleString()} answered, ${run.blank.toLocaleString()} came back empty, ${run.errors.toLocaleString()} failed.`
    : run.status === "cancelled" ? `Run cancelled at ${accounted.toLocaleString()} of ${run.total.toLocaleString()} rows.`
    : run.status === "failed" ? "Run failed."
    : run.status.startsWith("paused") ? (run.pauseReason ?? "Run paused.")
    : `Running. ${pct}% of ${run.total.toLocaleString()} rows.`;

  return <span className="sr-only" role="status" aria-live="polite">{message}</span>;
}

function RunRow({ run, extra, onShowErrors }: { run: RunState; extra: number; onShowErrors?: (id: string) => void }) {
  const now = useSyncExternalStore(
    useCallback((l: () => void) => clock.subscribe(l), []),
    () => clock.now,
  );

  const finished = run.status === "done" || run.status === "cancelled" || run.status === "failed";
  const paused = run.status.startsWith("paused");
  const elapsed = elapsedSeconds(run.startedAt, now);
  const eta = finished || paused ? null : runStore.eta(run.id);

  // Blanks are accounted work — they ran, they finished, they just hold nothing. Left out, the bar
  // stalls short of 100% on a run that is genuinely over.
  const accounted = run.done + run.errors + run.skipped + run.blank;
  const pct = run.total > 0 ? Math.min(100, Math.round((accounted / run.total) * 100)) : 0;

  const act = async (path: string) => {
    await fetch(`/api/runs/${run.id}/${path}`, { method: "POST" });
  };

  if (finished) {
    // Converts in place rather than vanishing: the final cost is the number people want to read.
    return (
      <>
        <span className="cc-rs__seg cc-rs__label truncate">
          {run.status === "cancelled" ? "Cancelled" : run.status === "failed" ? "Run failed" : "Finished"}
        </span>
        <span className="cc-rs__seg cc-rs__bar-seg">
          <ProgressBar run={run} pct={100} />
        </span>
        {/* "answered", not "done", once blanks are counted separately — a blank cell is also done in
            the sense of finished, and the word that distinguishes them is what the number means. */}
        <span className="cc-rs__seg cc-rs__count mono">{run.done.toLocaleString()} answered</span>
        {run.blank > 0 && (
          <span
            className="cc-rs__seg cc-rs__blank mono"
            title="These rows ran and came back with no answer. They were counted as done until now, which is how a column that half filled reported itself complete."
          >
            {run.blank.toLocaleString()} empty
          </span>
        )}
        {run.skipped > 0 && <span className="cc-rs__seg cc-rs__skip mono">{run.skipped.toLocaleString()} skipped</span>}
        {run.errors > 0 && (
          <button className="cc-rs__seg cc-rs__errors" onClick={() => onShowErrors?.(run.id)}>
            {run.errors.toLocaleString()} {run.errors === 1 ? "error" : "errors"}
          </button>
        )}
        {/* A run that spent nothing says "free", not "≈ $0.00". The confirmation before it already
            said free, and an approximate zero reads as a small charge rounded down — a claim about
            money that is not true on a lane which cannot cost anything. */}
        {/* What the empty and failed cells cost is named here rather than folded into the total. A
            search that billed and returned nothing is real money, and inside one number it reads as
            progress. */}
        <span
          className="cc-rs__seg cc-rs__cost mono"
          title={
            run.costUsd <= 0
              ? "Nothing in this run bills anything."
              : run.wasteUsd > 0
                ? `Estimated from list prices — not a bill. About $${run.wasteUsd.toFixed(2)} of this bought nothing: rows that failed or came back empty still pay for what they used.`
                : "Estimated from list prices — not a bill."
          }
        >
          {run.costUsd > 0 ? `≈ $${run.costUsd.toFixed(2)}` : "free"}
          {run.wasteUsd > 0 && <span className="cc-rs__waste"> · ${run.wasteUsd.toFixed(2)} wasted</span>}
        </span>
        <span className="cc-rs__seg cc-rs__time mono">{formatDuration(elapsed)}</span>
      </>
    );
  }

  return (
    <>
      <button
        className="cc-rs__seg cc-rs__icon"
        onClick={() => act(paused ? "resume" : "pause")}
        aria-label={paused ? "Resume run" : "Pause run"}
        title={paused ? "Resume" : "Pause — lets in-flight rows finish"}
      >
        {paused ? <IconPlay /> : <PauseGlyph />}
      </button>

      <span className="cc-rs__seg cc-rs__label truncate" title={run.summary}>
        {paused ? (run.pauseReason ?? "Paused") : run.summary || "Running"}
      </span>

      {/* The only flex:1 segment. */}
      <span className="cc-rs__seg cc-rs__bar-seg">
        <span className="cc-rs__count mono">
          {accounted.toLocaleString()} / {run.total.toLocaleString()}
        </span>
        <ProgressBar run={run} pct={pct} />
      </span>

      <span className="cc-rs__seg cc-rs__pct mono">{pct}%</span>

      {run.blank > 0 && (
        <span className="cc-rs__seg cc-rs__blank mono" title="Rows that ran and came back with no answer">
          {run.blank.toLocaleString()} empty
        </span>
      )}

      {run.skipped > 0 && (
        <span className="cc-rs__seg cc-rs__skip mono" title="Rows a run condition filtered out before spending anything">
          {run.skipped.toLocaleString()} skipped
        </span>
      )}

      {run.errors > 0 && (
        <button className="cc-rs__seg cc-rs__errors" onClick={() => onShowErrors?.(run.id)}>
          {run.errors.toLocaleString()} {run.errors === 1 ? "error" : "errors"}
        </button>
      )}

      <span className="cc-rs__seg cc-rs__cost mono" title="Estimated from list prices — not a bill.">
        {run.costUsd > 0 ? `≈ $${run.costUsd.toFixed(2)}` : "free"}
      </span>
      <span className="cc-rs__seg cc-rs__time mono">{formatDuration(elapsed)}</span>
      <span className="cc-rs__seg cc-rs__eta mono" title="Estimated from recent throughput">
        {eta == null ? "—" : `~${formatDuration(eta)}`}
      </span>

      {extra > 0 && <span className="cc-rs__seg cc-rs__chip">+{extra}</span>}

      <button
        className="cc-rs__seg cc-rs__icon cc-rs__cancel"
        onClick={() => act("cancel")}
        aria-label="Cancel run"
        title="Cancel — finished rows keep their values"
      >
        <IconStop />
      </button>
    </>
  );
}

/** Four stacked segments in one track. Widths animate via transform, so the bar never causes layout. */
function ProgressBar({ run, pct }: { run: RunState; pct: number }) {
  const total = Math.max(1, run.total);
  const w = (n: number) => `${Math.min(100, (n / total) * 100)}%`;
  return (
    // A progressbar with no accessible name is announced as a bare percentage with nothing to say
    // what it is measuring. `aria-valuetext` because "62 percent" is less use than the row counts
    // the sighted reading of this strip gives you.
    <span
      className="cc-rs__track"
      role="progressbar"
      aria-label="Rows completed"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${pct}% — ${(run.done + run.errors + run.skipped + run.blank).toLocaleString()} of ${run.total.toLocaleString()} rows`}
    >
      {/* Stacked back to front, each one the running total up to and including its own band. The
          blank band sits between answered and skipped: it is finished work that produced nothing, so
          it must fill the bar without being mistaken for an answer. */}
      <span className="cc-rs__fill cc-rs__fill--done" style={{ width: w(run.done) }} />
      <span className="cc-rs__fill cc-rs__fill--blank" style={{ width: w(run.done + run.blank), zIndex: 2 }} />
      <span className="cc-rs__fill cc-rs__fill--skip" style={{ width: w(run.done + run.blank + run.skipped), zIndex: 1 }} />
      <span className="cc-rs__fill cc-rs__fill--err" style={{ width: w(run.done + run.blank + run.skipped + run.errors), zIndex: 0 }} />
    </span>
  );
}

function PauseGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="4" y="3.5" width="3" height="9" rx="1" />
      <rect x="9" y="3.5" width="3" height="9" rx="1" />
    </svg>
  );
}
