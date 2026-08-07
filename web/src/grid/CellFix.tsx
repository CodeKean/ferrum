// "Work out what's wrong" — the diagnosis, the proposed change, and one row to try it on.
//
// Three steps, and each one is a stop where you can walk away: ASK produces a diagnosis and a
// proposal and changes nothing; APPLY writes the column's settings through the SAME route the setup
// drawer uses, so the guard that stops a model quietly re-enabling private addresses is not
// duplicated here; TRY runs this one row and no others, priced before you press it.
//
// It never runs anything on its own. A proposal that could start a run would be a paid action taken
// on a model's say-so, and the panel this sits in exists because something already went wrong once.

import { useState } from "react";
import { IconPlay } from "../ui/Icon.tsx";
import "./CellFix.css";

interface Change {
  field: string;
  label: string;
  before: string;
  after: string;
}

interface Proposal {
  why?: string;
  changes: Change[];
  missing?: string[];
  script?: { code: string } | null;
}

interface Diagnosis {
  cause: string;
  todo: string;
  errorType: string | null;
}

interface Props {
  cellId: string;
  columnId: string;
  sheetId: string;
  rowId: string;
  /** Reload the cell and the grid after the column's settings change. */
  onApplied: () => void;
  /** Run this one cell. The same path the cell menu uses — there is no second run route. */
  onRunCell: () => void;
  /**
   * Open the column's own editor.
   *
   * The fallback for a suggestion the apply route still cannot reach. That route now writes the mode,
   * the data type, an enum's allowed values, the instruction, the request, the search settings and a
   * script — so the enum case that used to have nowhere to land now does. This stays as the honest
   * way out for anything left over, rather than claiming the column is fine.
   */
  onEditColumn?: () => void;
}

/** A cost in words. Sub-cent amounts are shown in cents, because counting zeros is not reading. */
function money(usd: number | null): string {
  if (usd == null) return "price unknown";
  if (usd === 0) return "free";
  return usd < 0.01 ? `about ${(usd * 100).toFixed(2)}¢` : `about $${usd.toFixed(3)}`;
}

export function CellFix({ cellId, columnId, sheetId, rowId, onApplied, onRunCell, onEditColumn }: Props) {
  const [step, setStep] = useState<"idle" | "asking" | "review" | "applying" | "applied">("idle");
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** What one more run of this cell would cost, fetched only once there is a reason to offer it. */
  const [tryCost, setTryCost] = useState<number | null | undefined>(undefined);

  const ask = async () => {
    setStep("asking");
    setError(null);
    try {
      const res = await fetch(`/api/cells/${encodeURIComponent(cellId)}/fix`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.error) {
        // Including the refusals that cost nothing — a rejected key or a hit limit comes back as a
        // sentence saying where the fix actually is, which is more use than a proposal would be.
        setError(String(body?.error ?? "Could not work out what went wrong."));
        setStep("idle");
        return;
      }
      setDiagnosis(body.diagnosis ?? null);
      setProposal(body.proposal ?? null);
      setStep("review");
    } catch {
      setError("Could not reach the engine.");
      setStep("idle");
    }
  };

  const apply = async () => {
    if (!proposal) return;
    setStep("applying");
    setError(null);
    try {
      // The EXISTING apply route, deliberately. It re-normalises the proposed request before writing
      // it; a second apply path here would be a second place for that to be forgotten.
      const res = await fetch(`/api/columns/${columnId}/ai-setup/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposal }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.error) {
        setError(String(body?.error ?? "Could not apply that change."));
        setStep("review");
        return;
      }
      onApplied();
      setStep("applied");
      // Priced only now. Asking before the change is applied would quote the cost of the OLD
      // settings, and a proposal that switches lane changes what a row costs entirely.
      void priceOneRow();
    } catch {
      setError("Could not reach the engine.");
      setStep("review");
    }
  };

  const priceOneRow = async () => {
    try {
      const res = await fetch(`/api/sheets/${encodeURIComponent(sheetId)}/resolve-scope`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowIds: [rowId], columnIds: [Number(columnId)] }),
      }).then((r) => r.json());
      // `total`, and only when the estimate is complete. An incomplete estimate is one where a
      // model could not be priced, and rendering its total would print "free" over a call that is
      // about to be billed — the single worst thing this label could do.
      const c = res?.cost;
      setTryCost(c && c.incomplete !== true && typeof c.total === "number" ? c.total : null);
    } catch {
      // A price that could not be fetched is shown as unknown, never as free.
      setTryCost(null);
    }
  };

  if (step === "idle") {
    return (
      <div className="cc-fix">
        {error && <p className="cc-fix__err" role="alert">{error}</p>}
        <button className="cc-btn cc-btn--xs cc-btn--primary" onClick={() => void ask()}>
          Work out what's wrong
        </button>
        <span className="cc-fix__note">Reads this row and the column's settings. Changes nothing.</span>
      </div>
    );
  }

  if (step === "asking") {
    return (
      <div className="cc-fix">
        {/* Fixed height, so the panel does not jump when the answer lands. */}
        <span className="cc-skel cc-fix__skel" />
        <span className="cc-skel cc-fix__skel" />
        <span className="cc-fix__note">Reading the failure…</span>
      </div>
    );
  }

  return (
    <div className="cc-fix">
      {diagnosis && (
        <p className="cc-fix__cause" title={diagnosis.errorType ? `Failure class: ${diagnosis.errorType}` : undefined}>
          <strong>{diagnosis.cause}</strong> {diagnosis.todo}
        </p>
      )}

      {error && <p className="cc-fix__err" role="alert">{error}</p>}

      {proposal?.why && <p className="cc-fix__why">{proposal.why}</p>}

      {/* What would change, before and after, field by field. A proposal summarised as "improve the
          prompt" is one nobody can refuse on the evidence. */}
      {proposal && proposal.changes.length > 0 ? (
        <ul className="cc-fix__changes">
          {proposal.changes.map((c) => (
            <li key={c.field}>
              <span className="cc-fix__field">{c.label}</span>
              <span className="cc-fix__before">{c.before || "(nothing)"}</span>
              <span className="cc-fix__after">{c.after || "(nothing)"}</span>
            </li>
          ))}
        </ul>
      ) : (
        step !== "applied" && (
          /*
           * No change came back — and WHY matters, because the two cases read completely
           * differently to the person in front of them.
           *
           * The first version of this said "Nothing about the column needs changing" in both cases.
           * Caught on the very first live run: the answer came back explaining that the model had
           * returned "Biotechnology" and that the allowed list should include it — and this line
           * appeared directly underneath saying nothing needed changing.
           *
           * The specific hole that produced that — an enum whose allowed values could be edited
           * nowhere, so a correct "add Biotechnology" suggestion had no change to attach — is now
           * closed: the apply route writes `enumValues`, and the proposer returns them as a real
           * change. This branch remains for the genuine leftover case: an answer that describes a
           * change in prose without producing an applicable one. "Ask again" is usually the fix, and
           * the column's own editor is offered for anything this route still cannot reach.
           */
          proposal?.why ? (
            <>
              {/* Says only what is certainly true.
                  The first attempt at this line guessed the reason — "some settings, like a column's
                  list of allowed values, are only editable in the column itself" — and the very next
                  live run disproved it: that answer was about the INSTRUCTION, which is applicable
                  here. A reason stated confidently and wrong is the failure this whole panel exists
                  to stop, so the reason is left out and both ways forward are offered instead. */}
              <p className="cc-fix__note">
                It did not turn that into a change that can be applied from here.
              </p>
              <div className="cc-fix__row">
                {/* Primary, because an answer that describes a change and does not produce one is
                    usually just an incomplete answer, and asking again is free. */}
                <button className="cc-btn cc-btn--xs cc-btn--primary" onClick={() => void ask()}>
                  Ask again
                </button>
                {onEditColumn && (
                  <button className="cc-btn cc-btn--xs cc-btn--ghost" onClick={onEditColumn}>
                    Change it yourself
                  </button>
                )}
              </div>
            </>
          ) : (
            <p className="cc-fix__note">
              Nothing about the column needs changing — the diagnosis above is the whole answer.
            </p>
          )
        )
      )}

      {(proposal?.missing?.length ?? 0) > 0 && (
        <p className="cc-fix__note">It could not be sure about: {proposal!.missing!.join("; ")}</p>
      )}

      {step === "applied" ? (
        <div className="cc-fix__row">
          {/* Offered only AFTER the change is applied, and only for one row. The natural next step —
              re-running the whole column — is the ordinary run dialog with its own confirmation, not
              a shortcut from here. */}
          <button className="cc-btn cc-btn--xs cc-btn--primary" onClick={onRunCell}>
            <IconPlay /> <span>Try this one cell</span>
          </button>
          <span className="cc-fix__note">
            {tryCost === undefined ? "pricing…" : money(tryCost)} · this row only
          </span>
        </div>
      ) : (
        proposal && proposal.changes.length > 0 && (
          <div className="cc-fix__row">
            <button
              className="cc-btn cc-btn--xs cc-btn--primary"
              disabled={step === "applying"}
              onClick={() => void apply()}
            >
              {step === "applying" ? "Applying…" : "Apply this change"}
            </button>
            <button className="cc-btn cc-btn--xs cc-btn--ghost" onClick={() => setStep("idle")}>
              Not now
            </button>
          </div>
        )
      )}
    </div>
  );
}
