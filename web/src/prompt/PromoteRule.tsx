// "Turn this into a rule that runs for nothing."
//
// A column asking a model on every row is often paying, forever, for something that is not a
// judgement at all — a domain pulled out of a URL, a name split in two, a title bucketed into three
// levels. Those are derivable, and anything derivable can be a rule that costs nothing.
//
// WHAT THIS SCREEN IS FOR IS THE EVIDENCE, not the offer. A generated rule that looks right and is
// subtly wrong would be applied to every future row of a column nobody re-reads, because it used to
// be right. So the numbers come first and they are always the same numbers: how many rows it was
// checked on, how many it matched, and — when it did not — exactly which rows differed and what each
// side said. A percentage on its own is not something a person can act on; three rows they can read
// is.
//
// The verdict never hides the disagreements, including when it says yes. "97% agreement" is the
// moment to look at the other 3%, not the moment to stop looking.

import { useState } from "react";
import { IconAlert } from "../ui/Icon.tsx";
import "./PromoteRule.css";

interface Disagreement {
  rowId: number;
  inputs: Record<string, string | null>;
  model: string;
  rule: string;
}

interface Promotion {
  code: string;
  verdict: "promote" | "close" | "no";
  summary: string;
  examplesUsed: number;
  model: string;
  agreement: { checked: number; agreed: number; rate: number; errored: number; examples: Disagreement[] };
  memorisation: { hits: number; looked: number; memorised: boolean };
}

export function PromoteRule({ columnId, columnName, onAccepted }: {
  columnId: string;
  columnName: string;
  /** So the drawer can send the user to the rule screen, where the code is read and approved. */
  onAccepted: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Promotion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);

  const check = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/columns/${columnId}/promote`, { method: "POST" }).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      setResult(res.promotion as Promotion);
    } catch {
      setError("Could not reach the engine.");
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => {
    if (!result) return;
    setAccepting(true);
    setError(null);
    try {
      const res = await fetch(`/api/columns/${columnId}/promote/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: result.code, summary: result.summary }),
      }).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      onAccepted(res.next ?? "Saved. Read it on the Rule screen and approve it.");
    } catch {
      setError("Could not reach the engine.");
    } finally {
      setAccepting(false);
    }
  };

  return (
    <section className="cc-promote">
      <h3 className="cc-promote__title">Could this run for nothing?</h3>
      <p className="cc-promote__intro">
        If the answers in <strong>{columnName}</strong> can be worked out from the columns it reads,
        a rule can reproduce them and this column stops costing anything. Checking is free — it uses
        answers you have already paid for, and asks nothing of the model per row.
      </p>

      <button className="cc-btn cc-btn--sm" onClick={() => void check()} disabled={busy}>
        {busy ? "Checking…" : "Check"}
      </button>

      {error && <p className="cc-promote__error" role="alert"><IconAlert /> {error}</p>}

      {result && (
        <div className={`cc-promote__result cc-promote__result--${result.verdict}`} role="status">
          <p className="cc-promote__verdict">{result.summary}</p>

          {/* The numbers, always, whatever the verdict — including when it says yes. A rate with no
              denominator is what lets "100%" over four rows read like "100%" over four hundred. */}
          <p className="cc-promote__stats">
            Written from {result.examplesUsed.toLocaleString()} answered rows ·
            {" "}checked on {result.agreement.checked.toLocaleString()} it had never seen ·
            {" "}matched {result.agreement.agreed.toLocaleString()}
            {result.agreement.errored > 0 && <> · broke on {result.agreement.errored.toLocaleString()}</>}
          </p>

          {result.agreement.examples.length > 0 && (
            <details className="cc-promote__diffs">
              {/* Open by DEFAULT on anything short of a clean pass. When the rule is being offered,
                  the disagreements are the thing worth reading before agreeing; hiding them behind a
                  click is how a 90% gets accepted as a 100%. */}
              <summary>Where it differs ({result.agreement.examples.length} shown)</summary>
              <table className="cc-promote__table">
                <thead>
                  <tr>
                    <th>Inputs</th>
                    <th>Model said</th>
                    <th>Rule says</th>
                  </tr>
                </thead>
                <tbody>
                  {result.agreement.examples.map((d) => (
                    <tr key={d.rowId}>
                      <td className="cc-promote__inputs">
                        {Object.entries(d.inputs).map(([k, v]) => (
                          <span key={k} className="cc-promote__in"><em>{k}</em> {v ?? "—"}</span>
                        ))}
                      </td>
                      <td>{d.model}</td>
                      <td>{d.rule}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="cc-promote__hint">
                Worth reading rather than skimming: on a difference like this the rule is sometimes
                right and the model was not.
              </p>
            </details>
          )}

          {result.code && (
            <details className="cc-promote__code">
              <summary>The rule</summary>
              <pre>{result.code}</pre>
            </details>
          )}

          {/* Offered on "close" as well as on "promote", and that is deliberate. A 93% rule may be
              exactly right with one line changed, and the person who can tell is the one reading the
              differences above — refusing to hand it over would make them retype it. Nothing is
              switched either way: it saves as an unapproved rule and the column keeps using the
              model until somebody reads the code. */}
          {result.code && result.verdict !== "no" && (
            <button className="cc-btn cc-btn--primary cc-btn--sm" onClick={() => void accept()} disabled={accepting}>
              {result.verdict === "promote" ? "Save this rule" : "Save it to edit"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
