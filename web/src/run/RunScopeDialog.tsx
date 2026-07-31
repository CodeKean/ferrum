// "Run…" — choosing WHICH rows before the confirmation prices them.
//
// The header menu offers the three answers people actually want most of the time (everything, retry
// the failures, fill in the gaps) as one-click items. This dialog is for the fourth case, which the
// menu cannot express: a specific stretch of the sheet.
//
// Why a stretch matters enough to build: on a million-row sheet the sane way to start a paid column
// is fifty rows, read them, then a thousand, then the rest. Without a range the only options are
// "the first N" — which means re-reading the same first N every time — or everything.
//
// This screen deliberately does NOT start the run. It hands a scope to the confirmation, which
// resolves the row count and the cost server-side. Two dialogs rather than one, because the choice
// of rows and the approval of a spend are different decisions and merging them means approving a
// number that moves while you are still picking.

import { useState } from "react";
import { Modal } from "../ui/Modal.tsx";
import type { RunScopeRequest } from "./ConfirmRun.tsx";
import "./RunScopeDialog.css";

type Mode = "all" | "errors" | "never" | "range" | "count";

interface Props {
  columnName: string;
  columnIds: number[];
  /** Total rows in the sheet, for bounding the inputs and captioning the modes. */
  rowCount: number;
  onCancel: () => void;
  onPick: (scope: RunScopeRequest, title: string) => void;
}

const MODES: Array<{ mode: Mode; label: string; hint: string }> = [
  { mode: "all", label: "Every row", hint: "Cells that already have a value are recomputed too." },
  {
    mode: "never",
    label: "Only rows that have never run",
    hint: "Fills the gaps and leaves everything already done alone. The cheapest way to finish a half-run column.",
  },
  {
    mode: "errors",
    label: "Only rows that failed",
    hint: "Retries the failures and nothing else. Costs the failure count, not the sheet.",
  },
  { mode: "count", label: "The first N rows", hint: "A sample from the top, for checking a column before committing to it." },
  { mode: "range", label: "A range of rows", hint: "By the numbers in the row gutter — inclusive at both ends." },
];

export function RunScopeDialog({ columnName, columnIds, rowCount, onCancel, onPick }: Props) {
  const [mode, setMode] = useState<Mode>("all");
  /**
   * "Do it again even where nothing changed."
   *
   * Off by default, because on is the expensive answer and the one nobody asked for. With it off the
   * engine compares each row's inputs against what they were when the cell was last written and
   * skips the ones that match — so pressing Run twice on a settled column costs nothing the second
   * time. On, every row is paid for again. That is occasionally what you want (a prompt whose answer
   * depends on something outside the sheet, a model you have since changed your mind about), which
   * is why it is here rather than removed.
   */
  const [again, setAgain] = useState(false);
  const [count, setCount] = useState(50);
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(Math.min(100, rowCount));

  const clamp = (n: number) => Math.max(1, Math.min(rowCount || 1, Math.floor(n) || 1));

  const build = (): { scope: RunScopeRequest; title: string } => {
    // `force` is a CHOICE now, and it defaults off.
    //
    // Hardcoding it true here, or on any other run path, switches off both the batch lane's skip
    // and the engine's per-cell input-hash check. Re-running a column then re-does — and re-charges
    // for — every row whose inputs have not changed since the last run, and the engine's ability to
    // skip those never fires from this screen at all.
    //
    // Read the "errors" branch below against this line rather than against what it says it does.
    // A comment describing intended behaviour while the code does the opposite is the kind that
    // stops the next reader from checking.
    const base: RunScopeRequest = { columnIds, force: again };
    switch (mode) {
      case "errors":
        // Never forced: these cells are in `error`, so they hold no value to protect and the skip
        // would not have touched them anyway. Forcing here could only widen the set if the status
        // filter ever changed.
        return { scope: { ...base, force: false, statuses: ["error"] }, title: `Retry failed rows in "${columnName}"` };
      case "never":
        // Empty AND cancelled: a cell stopped mid-run never produced a value, so "has not run" has
        // to include it or a stopped run could never be finished off. Never forced, for the same
        // reason as the retry above — none of these cells hold a value the skip would protect.
        return { scope: { ...base, force: false, statuses: ["empty", "cancelled"] }, title: `Run unrun rows in "${columnName}"` };
      case "count":
        return { scope: { ...base, limit: clamp(count) }, title: `Run the first ${clamp(count).toLocaleString()} rows of "${columnName}"` };
      case "range": {
        const lo = clamp(from);
        const hi = Math.max(lo, clamp(to));
        return { scope: { ...base, fromRow: lo, toRow: hi }, title: `Run rows ${lo.toLocaleString()}–${hi.toLocaleString()} of "${columnName}"` };
      }
      default:
        return { scope: base, title: `Run "${columnName}"` };
    }
  };

  const rangeSize = mode === "range" ? Math.max(0, Math.max(clamp(from), clamp(to)) - clamp(from) + 1) : 0;

  return (
    <Modal
      open
      onClose={onCancel}
      title={`Run "${columnName}"`}
      footNote="The next step prices it before anything starts."
      footer={
        <>
          <button className="cc-btn" onClick={onCancel}>Cancel</button>
          <button className="cc-btn cc-btn--primary" onClick={() => { const b = build(); onPick(b.scope, b.title); }}>
            Continue
          </button>
        </>
      }
    >
      {/* Outside the radio group: it is not a fifth way to choose rows, it is a modifier on whichever
          one is selected. Hidden for the two status modes, where it is meaningless — those cells
          hold no value to redo. */}
      {mode !== "errors" && mode !== "never" && (
        <label className="cc-rsd__again">
          <input type="checkbox" checked={again} onChange={(e) => setAgain(e.target.checked)} />
          <span className="cc-rsd__again-text">
            <span className="cc-rsd__label">Redo rows that already have an answer</span>
            <span className="cc-rsd__hint">
              {again
                ? "Every row in the range is paid for again, including the ones nothing has changed for."
                : "Rows whose inputs have not changed since they last ran are skipped, and cost nothing."}
            </span>
          </span>
        </label>
      )}

      <div className="cc-rsd" role="radiogroup" aria-label="Which rows to run">
        {MODES.map((m) => (
          <div key={m.mode} className={`cc-rsd__row${mode === m.mode ? " cc-rsd__row--on" : ""}`}>
            <button
              role="radio"
              aria-checked={mode === m.mode}
              className="cc-rsd__pick"
              onClick={() => setMode(m.mode)}
            >
              <span className="cc-rsd__label">{m.label}</span>
              <span className="cc-rsd__hint">{m.hint}</span>
            </button>

            {/* The inputs live INSIDE the option they belong to and are only mounted when it is
                selected — a number box under an unselected option reads as editable and does
                nothing. Reserved height on the row keeps the list from jumping as modes change. */}
            {mode === "count" && m.mode === "count" && (
              <div className="cc-rsd__inputs">
                <label className="cc-rsd__field">
                  <span>Rows</span>
                  <input
                    className="cc-input cc-input--num cc-rsd__n"
                    type="number"
                    min={1}
                    max={rowCount || 1}
                    value={count}
                    autoFocus
                    onChange={(e) => setCount(Number(e.target.value) || 1)}
                    onBlur={() => setCount(clamp(count))}
                  />
                </label>
              </div>
            )}

            {mode === "range" && m.mode === "range" && (
              <div className="cc-rsd__inputs">
                <label className="cc-rsd__field">
                  <span>From row</span>
                  <input
                    className="cc-input cc-input--num cc-rsd__n"
                    type="number"
                    min={1}
                    max={rowCount || 1}
                    value={from}
                    autoFocus
                    onChange={(e) => setFrom(Number(e.target.value) || 1)}
                    onBlur={() => setFrom(clamp(from))}
                  />
                </label>
                <label className="cc-rsd__field">
                  <span>To row</span>
                  <input
                    className="cc-input cc-input--num cc-rsd__n"
                    type="number"
                    min={1}
                    max={rowCount || 1}
                    value={to}
                    onChange={(e) => setTo(Number(e.target.value) || 1)}
                    onBlur={() => setTo(Math.max(clamp(from), clamp(to)))}
                  />
                </label>
                {/* The count the range works out to, so the size is visible before the pricing step
                    rather than being a surprise on the next screen. */}
                <span className="cc-rsd__count mono">
                  {rangeSize.toLocaleString()} {rangeSize === 1 ? "row" : "rows"}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}
