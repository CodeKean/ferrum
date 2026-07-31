// "Why is this column empty?"
//
// The header already answers "how much of this is done". This answers the question people actually
// have, which is what happened to the rest — and more importantly, whether pressing Run again will
// do anything about it.
//
// That last part is the whole reason this exists rather than being a nicer tooltip. Four of the five
// reasons a cell is blank are NOT fixed by running the column again; three of them cost money every
// time you try. So each group says plainly whether a re-run helps, and the ones where it does not
// are marked, not buried in a sentence.

import { useEffect, useState } from "react";
import { Popover, type Anchor } from "../ui/Popover.tsx";
import { IconAlert, IconCheck } from "../ui/Icon.tsx";
import "./WhyEmpty.css";

interface Group {
  kind: string;
  errorType: string | null;
  message: string | null;
  count: number;
  sampleRows: number[];
  advice: string;
  fixedByRerunning: boolean;
}

interface Report {
  columnId: number;
  columnName: string;
  total: number;
  filled: number;
  blank: number;
  groups: Group[];
  moreReasons: number;
  moreRows: number;
}

/** The engine's status words are internal. These are what a person would call them. */
const TITLE: Record<string, string> = {
  never_run: "Never run",
  empty: "Never run",
  queued: "Waiting to start",
  running: "Running now",
  done: "Ran, returned nothing",
  not_found: "Nothing found",
  skipped: "Skipped",
  blocked: "Waiting on a column that failed",
  error: "Failed",
  cancelled: "You stopped the run",
};

const n = (x: number) => x.toLocaleString();

export function WhyEmpty({ columnId, anchor, onClose, onGoToRow, scrollContainer }: {
  columnId: number;
  anchor: Anchor | null;
  onClose: () => void;
  /** Jump to one of the rows in a group, so "show me one" is a click. */
  onGoToRow?: (rowId: number) => void;
  scrollContainer?: HTMLElement | null;
}) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    setReport(null);
    setError(null);
    void fetch(`/api/columns/${columnId}/blanks`)
      .then((r) => r.json())
      .then((r) => {
        if (dead) return;
        if (r.error) { setError(r.error); return; }
        setReport(r as Report);
      })
      .catch(() => { if (!dead) setError("Could not reach the engine."); });
    return () => { dead = true; };
  }, [columnId]);

  return (
    <Popover
      anchor={anchor}
      open={!!anchor}
      onClose={onClose}
      width={340}
      scrollContainer={scrollContainer}
      role="dialog"
      label="Why this column is empty"
    >
      <div className="cc-why">
        {report == null && !error ? (
          // Fixed height matching a two-group answer, so the box does not jump when the numbers land.
          <div className="cc-why__skel" aria-live="polite">Working it out…</div>
        ) : error ? (
          <p className="cc-why__error" role="alert">{error}</p>
        ) : report!.blank === 0 ? (
          <p className="cc-why__all">
            <span aria-hidden><IconCheck /></span>
            Every row has a value. Nothing to explain.
          </p>
        ) : (
          <>
            <p className="cc-why__lede">
              <strong>{n(report!.blank)}</strong> of {n(report!.total)} {report!.blank === 1 ? "row is" : "rows are"} empty.
            </p>

            <ul className="cc-why__list">
              {report!.groups.map((g, i) => (
                <li key={i} className="cc-why__group">
                  <div className="cc-why__head">
                    <span className="cc-why__count">{n(g.count)}</span>
                    <span className="cc-why__title truncate">{TITLE[g.kind] ?? g.kind}</span>
                    {/* The class this group was built from. It has always decided the grouping and
                        was never shown, so two rows reading "Failed" with different advice looked
                        like a bug rather than like two different failures. */}
                    {g.errorType && (
                      <span className="cc-why__class mono" title={`Failure class: ${g.errorType}`}>
                        {g.errorType.replace(/_/g, " ")}
                      </span>
                    )}
                    {/* The single most useful thing on this panel: whether pressing Run again is
                        pointless. Stated as a chip rather than left to be read out of the advice. */}
                    {!g.fixedByRerunning && (
                      <span className="cc-why__norerun" title="Running the column again will produce the same result, at the same cost.">
                        re-running won't help
                      </span>
                    )}
                  </div>
                  {g.message && <p className="cc-why__msg">{g.message}</p>}
                  <p className="cc-why__advice">{g.advice}</p>
                  {g.sampleRows.length > 0 && onGoToRow && (
                    <button className="cc-why__show" onClick={() => onGoToRow(g.sampleRows[0]!)}>
                      Show me one
                    </button>
                  )}
                </li>
              ))}
            </ul>

            {/* Truncation is stated. A breakdown that quietly stops short reads as complete, and the
                rows it dropped are exactly the ones nobody would then go looking for. */}
            {report!.moreReasons > 0 && (
              <p className="cc-why__more">
                <span aria-hidden><IconAlert /></span>
                {n(report!.moreRows)} more {report!.moreRows === 1 ? "row" : "rows"} across{" "}
                {n(report!.moreReasons)} other {report!.moreReasons === 1 ? "reason" : "reasons"}, each too
                rare to list.
              </p>
            )}
          </>
        )}
      </div>
    </Popover>
  );
}
