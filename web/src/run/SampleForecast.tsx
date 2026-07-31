// What ten real rows say the other 999,990 will cost.
//
// The estimate above this in the confirm dialog is arithmetic — token shapes and published prices.
// It is the right thing to show first and it is a MODEL of the run. This panel is the run: a handful
// of rows executed for real, measured, and projected from.
//
// Everything shown here is deliberately checkable. The median per row, the number of rows left, and
// the product of the two are all on screen, so the projection can be verified rather than trusted.
// A single confident total with no working is the shape of a number people stop believing the first
// time it is wrong.

import { useEffect, useRef, useState } from "react";
import { IconPlay } from "../ui/Icon.tsx";

export interface Forecast {
  runId: string;
  cells: number;
  rowsSampled: number;
  ofRows: number;
  done: number;
  notFound: number;
  errored: number;
  skipped: number;
  failureRate: number;
  spent: number;
  perRow: { min: number; median: number; p90: number; max: number };
  medianMs: number;
  projection: { remainingRows: number; low: number; likely: number; high: number } | null;
  whyNot: string | null;
  estimatedPerRow: number | null;
  estimateRatio: number | null;
  free: boolean;
}

interface Props {
  runId: string;
  /** True once the sample run has finished, so polling can stop. */
  onDone?: (f: Forecast) => void;
}

/** How often the forecast is re-read while the sample is still running. */
const POLL_MS = 1_200;

/**
 * The factor by which a measured cost has to beat the estimate before the gap is called out.
 *
 * Below this the two disagreeing is ordinary — the estimate assumes a typical answer length and real
 * answers vary. Above it, the estimate is wrong in a way that will be wrong again on every other
 * column of this sheet, which is worth saying once.
 */
const ESTIMATE_OFF = 2;

function usd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

export function SampleForecast({ runId, onDone }: Props) {
  const [f, setF] = useState<Forecast | null>(null);
  const [status, setStatus] = useState<string>("running");
  const [error, setError] = useState<string | null>(null);
  // Held in a ref so the poll effect depends on runId alone. A parent that re-renders every tick
  // would otherwise tear the interval down and start it again on each one.
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const res = await fetch(`/api/runs/${runId}/forecast`).then((r) => r.json());
        if (!live) return;
        if (res.error) { setError(res.error); return; }
        setF(res.forecast);
        const s = String(res.run?.status ?? "running");
        setStatus(s);
        if (s === "running" || s === "pending" || s === "paused") {
          timer = setTimeout(() => void tick(), POLL_MS);
        } else {
          doneRef.current?.(res.forecast);
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void tick();

    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [runId]);

  if (error) return <div className="cc-modal__error" role="alert">{error}</div>;

  const running = status === "running" || status === "pending";

  // A fixed-height frame either way. The panel fills in as rows finish, and a dialog that grows a
  // line at a time under the cursor is how a button ends up somewhere else at the moment it is
  // clicked.
  if (!f || (running && f.rowsSampled === 0)) {
    return (
      <div className="cc-fc cc-fc--waiting" aria-live="polite">
        <span className="cc-skel" style={{ width: "55%" }} />
        <span className="cc-skel" style={{ width: "35%" }} />
        <span className="cc-skel" style={{ width: "45%" }} />
        <p className="cc-fc__note">Running the sample rows for real. This costs what those rows cost.</p>
      </div>
    );
  }

  const p = f.projection;
  const estimateOff =
    f.estimateRatio != null && (f.estimateRatio >= ESTIMATE_OFF || f.estimateRatio <= 1 / ESTIMATE_OFF);

  return (
    <div className="cc-fc" aria-live="polite">
      <div className="cc-fc__head">
        <span className="cc-fc__label">
          {running ? "Sampling" : "Sampled"} {f.rowsSampled.toLocaleString()} of{" "}
          {f.ofRows.toLocaleString()} rows
        </span>
        <span className="cc-fc__spent mono">{f.free ? "free" : usd(f.spent)} spent</span>
      </div>

      {/* How the sample actually went. This sits ABOVE the money, because a column that answered
          three cells out of ten has a problem no cost figure describes.

          Counted in CELLS, and labelled as cells. These are per column, so a three-column sample of
          ten rows has thirty of them — printed bare under a heading that says "10 of 120 rows" it
          read as a contradiction, because "10 answered, 10 errored" over ten rows is impossible. */}
      <ul className="cc-fc__tally">
        <li><span className="mono">{f.done.toLocaleString()}</span> cells answered</li>
        {f.notFound > 0 && <li><span className="mono">{f.notFound.toLocaleString()}</span> with no answer</li>}
        {f.errored > 0 && (
          <li className="cc-fc__tally--bad"><span className="mono">{f.errored.toLocaleString()}</span> errored</li>
        )}
      </ul>

      {!f.free && (
        <dl className="cc-fc__rows">
          <div>
            <dt>Cheapest row</dt>
            <dd className="mono">{usd(f.perRow.min)}</dd>
          </div>
          <div className="cc-fc__rows--key">
            <dt>Typical row</dt>
            <dd className="mono">{usd(f.perRow.median)}</dd>
          </div>
          <div>
            <dt>Priciest row</dt>
            <dd className="mono">{usd(f.perRow.max)}</dd>
          </div>
        </dl>
      )}

      {p ? (
        <div className="cc-fc__proj">
          <span className="cc-fc__proj-label">
            The remaining {p.remainingRows.toLocaleString()}{" "}
            {p.remainingRows === 1 ? "row" : "rows"}
          </span>
          <strong className="cc-fc__proj-value mono">{f.free ? "free" : usd(p.likely)}</strong>
          {!f.free && (
            <span className="cc-fc__proj-range mono">
              {usd(p.low)} – {usd(p.high)}
            </span>
          )}
        </div>
      ) : (
        // Not an empty state. The sample ran and its answer is "do not project from this", which is
        // the finding — so it gets the same weight the number would have had.
        <div className="cc-fc__warn" role="alert">{f.whyNot}</div>
      )}

      {estimateOff && !f.free && (
        <p className="cc-fc__note">
          The estimate said <span className="mono">{usd(f.estimatedPerRow!)}</span> a row and the real
          rows came in at <span className="mono">{usd(f.perRow.median)}</span> —{" "}
          {f.estimateRatio! > 1
            ? `${f.estimateRatio!.toFixed(1)}× more`
            : `${(1 / f.estimateRatio!).toFixed(1)}× less`}
          . Estimates for this sheet's other columns will be out by roughly the same amount.
        </p>
      )}

      {/* Said plainly rather than implied. Someone who samples to save money should not later
          discover they paid twice for these rows. */}
      <p className="cc-fc__note">
        These {f.rowsSampled.toLocaleString()} rows keep their answers, so running the rest does not
        redo them.
      </p>
    </div>
  );
}

/** The action that starts the sample, for the confirm dialog's footer. */
export function SampleButton({ rows, onClick, busy }: { rows: number; onClick: () => void; busy: boolean }) {
  return (
    <button className="cc-btn" onClick={onClick} disabled={busy}>
      <IconPlay />
      Sample {rows} rows first
    </button>
  );
}
