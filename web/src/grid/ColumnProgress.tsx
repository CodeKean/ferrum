// The per-column progress bar that sits under each column header, plus its hover breakdown.
//
// Two states, because they answer different questions:
//   AT REST     — "is this column up to date?" A tick and a word, not a 100% bar. A full bar on every
//                 column is visual noise that says nothing.
//   IN PROGRESS — a real bar with a percentage, driven by the LIVE RUN rather than by re-querying
//                 the database. Recomputing per-column status during a run costs ~400ms per column
//                 on a million rows, which is why the run record is the source while it runs and the
//                 database is only consulted once it finishes.

import { useCallback, useRef, useState } from "react";
import { Popover } from "../ui/Popover.tsx";
import { IconAlert } from "../ui/Icon.tsx";
import "./ColumnProgress.css";

export interface ColumnStats {
  columnId: number;
  total: number;
  byStatus: Record<string, number>;
  stale: number;
  completed: number;
  pct: number;
  computing?: boolean;
  /** 0 means the server has never computed these numbers — the only case with nothing to show. */
  computedAt: number;
}

interface Props {
  stats: ColumnStats | undefined;
  /** Live counts from an active run touching this column; overrides the cached stats while present. */
  live?: { done: number; errors: number; skipped: number; total: number } | null;
  /** The grid's scrollport, so the breakdown dismisses when its column scrolls away sideways. */
  scrollContainer?: HTMLElement | null;
}

const pctLabel = (n: number, total: number): string => {
  if (total === 0) return "0%";
  const p = (n / total) * 100;
  // Clay's own nicety, and a genuinely useful one: never round a nonzero count to 0%, or a
  // nonzero-but-tiny failure count reads as "nothing failed".
  if (n > 0 && p < 1) return "<1%";
  if (n < total && p > 99) return ">99%";
  return `${Math.round(p)}%`;
};

export function ColumnProgress({ stats, live, scrollContainer }: Props) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const show = useCallback(() => {
    if (!ref.current) return;
    setRect(ref.current.getBoundingClientRect());
    setOpen(true);
  }, []);

  /**
   * What activation does. Hover and focus reveal the breakdown; activating toggles it.
   *
   * This was a `div role="button" tabIndex=0` with no onClick and no onKeyDown at all — a tab stop
   * on every column, announced as a button, that did nothing when pressed. Eleven dead stops on the
   * sheet it was measured on. A real <button> gets Enter and Space for free.
   */
  const toggle = useCallback(() => {
    if (open) { setOpen(false); return; }
    show();
  }, [open, show]);

  if (!stats && !live) return <div className="cc-cp" aria-hidden="true" />;

  const total = live?.total ?? stats?.total ?? 0;
  const done = live ? live.done : (stats?.byStatus.done ?? 0) + (stats?.byStatus.not_found ?? 0);
  const errors = live ? live.errors : stats?.byStatus.error ?? 0;
  const skipped = live ? live.skipped : stats?.byStatus.skipped ?? 0;
  const running = stats?.byStatus.running ?? 0;
  const queued = stats?.byStatus.queued ?? 0;
  const empty = stats?.byStatus.empty ?? 0;
  const stale = stats?.stale ?? 0;

  const accounted = done + errors + skipped;
  const pct = total === 0 ? 0 : Math.min(100, Math.round((accounted / total) * 100));
  const active = !!live || running > 0 || queued > 0;
  const unknown = !live && !stats?.computedAt;
  // A column with no numbers yet must not claim to be up to date — that would report a million
  // unrun cells as finished.
  const upToDate = !active && !unknown && empty === 0 && errors === 0 && stale === 0 && total > 0;

  return (
    <>
      <button
        type="button"
        className="cc-cp"
        ref={ref}
        onMouseEnter={show}
        onMouseLeave={() => setOpen(false)}
        onFocus={show}
        onBlur={() => setOpen(false)}
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${pct}% complete — show breakdown`}
      >
        {upToDate ? (
          <>
            <span className="cc-cp__tick" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3.5 8.5l3 3 6-7" />
              </svg>
            </span>
            <span className="cc-cp__label">Up to date</span>
          </>
        ) : (
          <>
            <span className="cc-cp__track">
              <span className="cc-cp__fill cc-cp__fill--done" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
              <span className="cc-cp__fill cc-cp__fill--skip" style={{ width: `${total ? ((done + skipped) / total) * 100 : 0}%`, zIndex: 1 }} />
              <span className="cc-cp__fill cc-cp__fill--err" style={{ width: `${total ? (accounted / total) * 100 : 0}%`, zIndex: 0 }} />
            </span>
            {/* Reserved width — 0% to 100% must not shift the bar beside it.
                `computing` alone is NOT a reason to hide the number: a slightly stale percentage is
                the whole point of keeping the previous value. Only a column the server has never
                measured (computedAt 0) has nothing to show. */}
            <span className="cc-cp__pct mono">{unknown ? "…" : `${pct}%`}</span>
          </>
        )}
      </button>

      <Popover
        open={open}
        anchor={rect ? { rect } : null}
        anchorEl={ref}
        onClose={() => setOpen(false)}
        width={330}
        label="Column run breakdown"
        scrollContainer={scrollContainer}
      >
        <div className="cc-cpp">
          <div className="cc-cpp__head">
            {unknown
              ? "Counting this column…"
              : `${pctLabel(accounted, total)} (${accounted.toLocaleString()} ${accounted === 1 ? "cell" : "cells"}) completed`}
          </div>

          {errors > 0 && (
            <Row
              pct={pctLabel(errors, total)} count={errors} total={total}
              tone="err" label="failed"
              icon={<IconAlert size={14} />}
            />
          )}
          {done > 0 && (
            <Row
              pct={pctLabel(done, total)} count={done} total={total}
              tone="done" label="ran successfully"
              icon={<TickCircle />}
            />
          )}
          {skipped > 0 && (
            <Row
              pct={pctLabel(skipped, total)} count={skipped} total={total}
              tone="skip" label="skipped by a run condition"
              icon={<DashCircle />}
            />
          )}
          {(running > 0 || queued > 0) && (
            <Row
              pct={pctLabel(running + queued, total)} count={running + queued} total={total}
              tone="run" label={running > 0 ? "in progress" : "queued"}
              icon={<span className="cc-cpp__spin" />}
            />
          )}
          {empty > 0 && (
            <Row
              pct={pctLabel(empty, total)} count={empty} total={total}
              tone="idle" label="never run"
              icon={<DashCircle />}
            />
          )}

          {stale > 0 && (
            <div className="cc-cpp__note">
              {stale.toLocaleString()} {stale === 1 ? "cell is" : "cells are"} stale — an upstream column
              changed after these ran.
            </div>
          )}
        </div>
      </Popover>
    </>
  );
}

function Row({ pct, count, total, tone, label, icon }: {
  pct: string; count: number; total: number; tone: string; label: string; icon: React.ReactNode;
}) {
  return (
    <div className="cc-cpp__row">
      <span className="cc-cpp__bar">
        <span className={`cc-cpp__bar-fill cc-cpp__bar-fill--${tone}`} style={{ width: `${total ? Math.max(2, (count / total) * 100) : 0}%` }} />
      </span>
      <span className={`cc-cpp__icon cc-cpp__icon--${tone}`}>{icon}</span>
      <span className="cc-cpp__text">
        {pct} ({count.toLocaleString()} {count === 1 ? "cell" : "cells"}) {label}
      </span>
    </div>
  );
}

const TickCircle = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <circle cx="8" cy="8" r="7" />
    <path d="M4.8 8.2l2.1 2.1 4.3-4.6" fill="none" stroke="var(--canvas)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const DashCircle = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <circle cx="8" cy="8" r="7" />
    <rect x="4.6" y="7.2" width="6.8" height="1.6" rx="0.8" fill="var(--canvas)" />
  </svg>
);
