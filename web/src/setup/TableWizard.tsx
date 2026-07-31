// "Describe the table you want."
//
// The screen a blank workspace should open into. It is an interview rather than a single box
// because the answers change the shape of what gets built — where rows come from, what identifies a
// record, what leaves at the end — and a one-shot prompt guesses all three invisibly.
//
// Answers are typed or pasted, including API documentation. Links are not followed, and the screen
// says so where someone would otherwise paste one and wait.

import { useEffect, useRef, useState } from "react";
import { Modal } from "../ui/Modal.tsx";
import { IconPlus } from "../ui/Icon.tsx";
import "./TableWizard.css";

interface Question { question: string; why?: string }

interface PlannedColumn {
  name: string;
  kind: string;
  valueType: string;
  note?: string;
  prompt?: string;
  http?: Record<string, unknown>;
}

interface TablePlan {
  name: string;
  summary: string;
  columns: PlannedColumn[];
  source: { kind: string; fromTable?: string; note: string };
  destination: { kind: string; toTable?: string; note: string };
  dedupeOn?: string[];
  missing?: string[];
}

interface Turn { role: "user" | "wizard"; text: string }

interface Props {
  onBuilt: (sheetId: string) => void;
  onClose: () => void;
}

const KIND_LABEL: Record<string, string> = {
  static: "typed in",
  ai: "asks a model",
  agent: "searches the web",
  http: "calls an API",
  script: "runs a rule",
};

const SOURCE_LABEL: Record<string, string> = {
  manual: "Typed in, or pasted",
  csv: "Imported from a file",
  webhook: "Sent here by another tool",
  from_table: "Built from another table",
};

export function TableWizard({ onBuilt, onClose }: Props) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [plan, setPlan] = useState<TablePlan | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [built, setBuilt] = useState<{ sheetId: string; columns: number; webhookToken?: string; notWired: string[] } | null>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { boxRef.current?.focus(); }, [questions]);

  const send = async (text: string) => {
    const next: Turn[] = [...turns, { role: "user", text }];
    setTurns(next);
    setDraft("");
    setQuestions(null);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/wizard/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turns: next }),
      }).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      if (res.step === "ask") {
        setQuestions(res.questions);
        // The questions go into the transcript as the wizard's turn, so the next round knows what
        // it already asked — otherwise it asks the same thing again in slightly different words.
        setTurns([...next, { role: "wizard", text: res.questions.map((q: Question) => q.question).join("\n") }]);
      } else {
        setPlan(res.plan);
      }
    } catch {
      setError("Could not reach the engine.");
    } finally {
      setBusy(false);
    }
  };

  const build = async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/wizard/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      }).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      setBuilt({ sheetId: res.sheet.id, columns: res.columnsCreated, webhookToken: res.webhookToken, notWired: res.notWired ?? [] });
    } catch {
      // The plan is still on screen and still buildable. Silently going back to "Build it" after a
      // failed request reads as the button doing nothing at all.
      setError("Could not reach the engine.");
    } finally {
      setBusy(false);
    }
  };

  const started = turns.length > 0;

  return (
    <Modal
      open
      onClose={onClose}
      title="Build a table"
      width={640}
      footNote={
        built ? "Built. Open it and start filling it in."
        : plan ? "Nothing is created until you build it."
        : started ? "Answer in your own words. Paste documentation as text if it helps."
        : "Describe it in a sentence. It will ask what it needs."
      }
      footer={
        built ? (
          <button className="cc-btn cc-btn--primary" onClick={() => { onBuilt(built.sheetId); onClose(); }}>
            Open it
          </button>
        ) : (
          <button className="cc-btn" onClick={onClose}>Cancel</button>
        )
      }
    >
      {error && <div className="cc-modal__error" role="alert">{error}</div>}

      <div className="cc-wiz">
        {/* The conversation so far. Kept visible while answering, because the second answer usually
            depends on remembering the first. */}
        {turns.length > 0 && !built && (
          <ol className="cc-wiz__thread">
            {turns.map((t, i) => (
              <li key={i} className={`cc-wiz__turn cc-wiz__turn--${t.role}`}>
                <span className="cc-wiz__who">{t.role === "user" ? "You" : "Asked"}</span>
                <span className="cc-wiz__text">{t.text}</span>
              </li>
            ))}
          </ol>
        )}

        {built ? (
          <div className="cc-wiz__done">
            <p className="cc-wiz__lead">
              <strong>{plan?.name}</strong> is ready, with {built.columns} {built.columns === 1 ? "column" : "columns"}.
            </p>
            {built.webhookToken && (
              <p className="cc-wiz__note">
                It has an address for incoming data. Open <strong>Sources</strong> in the table to copy it and send a
                test.
              </p>
            )}
            {/* Said plainly, because the alternative is finding out a week later that the thing the
                plan described was never actually built. */}
            {built.notWired.length > 0 && (
              <div className="cc-wiz__missing">
                <span className="cc-wiz__missinglead">Still to do by hand:</span>
                <ul>{built.notWired.map((n, i) => <li key={i}>{n}</li>)}</ul>
              </div>
            )}
          </div>
        ) : plan ? (
          <div className="cc-wiz__plan">
            <p className="cc-wiz__lead">{plan.summary}</p>

            <div className="cc-wiz__facts">
              <span className="cc-wiz__fact">
                Rows arrive: <strong>{SOURCE_LABEL[plan.source.kind] ?? plan.source.kind}</strong>
              </span>
              {plan.dedupeOn && plan.dedupeOn.length > 0 && (
                <span className="cc-wiz__fact">
                  Duplicates matched on <strong>{plan.dedupeOn.join(", then ")}</strong>
                </span>
              )}
            </div>
            {plan.source.note && <p className="cc-wiz__note">{plan.source.note}</p>}

            <ul className="cc-wiz__cols">
              {plan.columns.map((c) => (
                <li key={c.name} className="cc-wiz__col">
                  <span className="cc-wiz__colname truncate">{c.name}</span>
                  <span className="cc-wiz__colkind">{KIND_LABEL[c.kind] ?? c.kind}</span>
                  <span className="cc-wiz__coltype mono">{c.valueType}</span>
                  <span className="cc-wiz__colnote truncate" title={c.note ?? c.prompt ?? ""}>
                    {c.note ?? c.prompt ?? ""}
                  </span>
                </li>
              ))}
            </ul>

            {plan.destination.kind !== "none" && (
              <p className="cc-wiz__note">
                {/* The model's own sentence usually ends in a full stop; adding another produced
                    "…outreach table.. That part". Trimmed rather than assumed either way. */}
                Meant to send data on: {(plan.destination.note || plan.destination.kind).replace(/[.s]+$/, "")}. That
                part is not wired up automatically.
              </p>
            )}

            {plan.missing && plan.missing.length > 0 && (
              <div className="cc-wiz__missing">
                <span className="cc-wiz__missinglead">You will need:</span>
                <ul>{plan.missing.map((m, i) => <li key={i}>{m}</li>)}</ul>
              </div>
            )}

            <div className="cc-wiz__foot">
              <button className="cc-btn cc-btn--xs" disabled={busy} onClick={() => { setPlan(null); setDraft(""); }}>
                Keep talking
              </button>
              <button className="cc-btn cc-btn--primary" disabled={busy} onClick={() => void build()}>
                {busy ? "Building…" : "Build it"}
              </button>
            </div>
          </div>
        ) : (
          <>
            {questions && (
              <ul className="cc-wiz__questions">
                {questions.map((q, i) => (
                  <li key={i}>
                    <span className="cc-wiz__q">{q.question}</span>
                    {q.why && <span className="cc-wiz__why">{q.why}</span>}
                  </li>
                ))}
              </ul>
            )}

            <textarea
              ref={boxRef}
              className="cc-wiz__box"
              value={draft}
              rows={started ? 4 : 3}
              disabled={busy}
              placeholder={
                started
                  ? "Answer here. Paste documentation as text if it helps."
                  : "A table of UK PR agencies, with a contact for each, coming in from a form."
              }
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim()) {
                  e.preventDefault();
                  void send(draft.trim());
                }
              }}
            />

            <div className="cc-wiz__foot">
              {/* Said where someone would otherwise paste a link and wait for something to happen. */}
              <span className="cc-wiz__hint">
                Links are not opened — paste the part of the documentation that matters as text.
              </span>
              <button
                className="cc-btn cc-btn--primary"
                disabled={busy || !draft.trim()}
                onClick={() => void send(draft.trim())}
              >
                {busy ? "Thinking…" : started ? "Answer" : "Start"}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
