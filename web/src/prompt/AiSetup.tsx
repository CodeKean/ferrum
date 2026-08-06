// "Describe what you want. I'll set it up."
//
// The same panel sits at the top of every configuration screen in this drawer, because the thing a
// person actually knows is what they want the column to CONTAIN — not that an API key belongs in a
// header called Authorization with the word Bearer in front of it, or that a domain in a query
// string has to be percent-encoded, or which of five modes is the cheap one.
//
// It PROPOSES. It never applies. What comes back is a list of every field it wants to change, with
// the current value beside the new one, and a button. That matters because the model may have just
// read a documentation page, and a page is text a stranger wrote — the summary is where a request
// pointed somewhere unexpected becomes visible before it is saved rather than after it has run.

import { useEffect, useRef, useState } from "react";
import { IconPlay, IconStop } from "../ui/Icon.tsx";
import { RefField } from "./RefField.tsx";
import type { RefOption } from "./RefMenu.tsx";
import type { Column } from "../api.ts";
import { designCost as money } from "./cost.ts";
import "./AiSetup.css";

export interface SetupChange { field: string; label: string; before: string; after: string }

/** A column the proposal says has to exist first. Accepted one at a time. */
export interface ExtraColumn {
  name: string;
  kind: string;
  valueType: string;
  prompt?: string;
  why: string;
  upstream: boolean;
}

export interface SetupProposal {
  why: string;
  kind?: string;
  valueType?: string;
  prompt?: string;
  http?: Record<string, unknown>;
  script?: { hook: string; runtime: string; intent: string; code: string };
  search?: { maxResults: number };
  send?: { targetSheetName: string; mappingLabels: Array<{ target: string; from: string }> };
  alsoNeeds?: ExtraColumn[];
  modelTier?: "cheap" | "balanced" | "strong";
  modelTierWhy?: string;
  changes: SetupChange[];
  missing: string[];
  readUrl?: string;
  model: string;
  costUsd: number | null;
}

/** What the workspace will DESIGN with, as opposed to what the column runs on. */
interface SetupModel {
  model: string;
  freeOnly: boolean;
  estimateUsd: number | null;
}

interface Props {
  columnId: string;
  /** Narrows what may be proposed, and phrases the placeholder for where you are standing. */
  /** Mirrors SetupArea in src/setup/aiSetup.ts. Every configuration screen is on this list. */
  area:
    | "mode" | "request" | "rule" | "condition" | "prompt" | "search" | "output"
    | "destination" | "link" | "steps";
  placeholder: string;
  /** Only the Request screen has documentation to point at. */
  showDocsUrl?: boolean;
  /** Fired after a proposal is applied, so the drawer reloads what it now holds. */
  onApplied: () => void;

  /**
   * The sheet's columns, so `/` works in here too.
   *
   * Without them this was the one plain-English box in the app that could NOT reference a column —
   * which is the box most likely to need one, since "only run this where /Country is US" is exactly
   * the sort of thing people type into it.
   */
  columns?: Column[];
  refOptions?: RefOption[];

  /**
   * Controlled mode: the panel writes into the caller's field instead of owning a second one.
   *
   * The run-condition screen had TWO plain-English boxes stacked — this panel's, and the one whose
   * text is saved with the generated rule — asking for the same sentence twice with no way to tell
   * which one mattered. In controlled mode this IS that field.
   */
  value?: string;
  onValueChange?: (next: string) => void;
  /** Header text, when "Describe it and I'll set it up" is not what this instance is. */
  title?: string;
  /** Small grey line under the title. */
  sub?: string;
  /** Off when the panel is the screen's primary field and folding it away would hide the field. */
  collapsible?: boolean;
  /**
   * Closed, this is a small BUTTON rather than a full-width bordered strip.
   *
   * The strip sat at the top of every configuration screen in the drawer, on every tab, taking a
   * bordered row plus its own margin before a single field of the actual screen. Across nine tabs
   * that is the same 40-odd pixels of chrome pushing the real content down and adding a scroll to
   * reach the bottom of every one of them — for a panel most visits never open. As a button it costs
   * a control's height, and opening it expands the identical panel in place.
   */
  asButton?: boolean;
}


export function AiSetup({
  columnId, area, placeholder, showDocsUrl, onApplied,
  columns, refOptions, value, onValueChange, title, sub, collapsible = true, asButton = false,
}: Props) {
  const controlled = value !== undefined;
  const [own, setOwn] = useState("");
  const intent = controlled ? value! : own;
  const setIntent = (next: string) => { if (controlled) onValueChange?.(next); else setOwn(next); };
  const [docsUrl, setDocsUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<SetupProposal | null>(null);
  const [setupModel, setSetupModel] = useState<SetupModel | null>(null);
  // Which follow-on columns have been created, so a button cannot be pressed twice into two columns.
  const [added, setAdded] = useState<Record<string, "adding" | "done" | string>>({});
  // Held so the Stop button has something to stop. Without it a slow call could only be waited out.
  const abort = useRef<AbortController | null>(null);

  // Collapsed by default once a column is configured — the panel is for setting something up, and a
  // permanently expanded box at the top of every screen is one more thing to scroll past forever.
  /**
   * Open by default ONLY when it is the screen's own field.
   *
   * In button mode it starts closed, which is the whole point: defaulting to open would render the
   * full panel on every tab exactly as the bordered strip did, and cost the same vertical space
   * under a different name. Once opened it STAYS open across tab switches — the component is not
   * remounted — so somebody using it does not have to reopen it on every screen.
   */
  const [open, setOpen] = useState(!asButton);

  // Which model will design this, and roughly what that costs — fetched when the panel opens, so the
  // answer is on screen BEFORE the button is pressed rather than in the receipt afterwards.
  useEffect(() => {
    if (!open) return;
    let live = true;
    fetch("/api/settings/setup-model")
      .then((r) => r.json())
      .then((d) => { if (live && !d.error) setSetupModel(d); })
      .catch(() => {});
    return () => { live = false; };
  }, [open]);

  const propose = async () => {
    if (!intent.trim()) return;
    const ac = new AbortController();
    abort.current = ac;
    setBusy(true);
    setError(null);
    setAdded({});
    try {
      const res = await fetch(`/api/columns/${columnId}/ai-setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent, docsUrl: docsUrl.trim() || undefined, area }),
        signal: ac.signal,
      }).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      setProposal(res.proposal);
    } catch (e) {
      // A call the user stopped is not a failure, and reporting it as one makes the Stop button look
      // like it broke something.
      if ((e as Error)?.name === "AbortError") setError(null);
      else setError("Could not reach the engine.");
    } finally {
      abort.current = null;
      setBusy(false);
    }
  };

  /**
   * Create ONE of the columns the proposal said were needed first.
   *
   * One at a time, because they are separate suggestions: a proposal saying "you also need Domain
   * and Headcount" is two ideas, and the good one should not have to arrive with the bad one.
   */
  const addExtra = async (c: ExtraColumn) => {
    setAdded((a) => ({ ...a, [c.name]: "adding" }));
    try {
      const res = await fetch(`/api/columns/${columnId}/ai-setup/also`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ column: c }),
      }).then((r) => r.json());
      if (res.error) { setAdded((a) => ({ ...a, [c.name]: res.error })); return; }
      setAdded((a) => ({ ...a, [c.name]: "done" }));
      onApplied();
    } catch {
      setAdded((a) => ({ ...a, [c.name]: "Could not reach the engine." }));
    }
  };

  const apply = async () => {
    if (!proposal) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/columns/${columnId}/ai-setup/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposal }),
      }).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      setProposal(null);
      // Controlled mode keeps the sentence: it is not a throwaway prompt there, it is the field the
      // caller saves alongside the generated rule and shows again next time this screen opens.
      if (!controlled) setIntent("");
      onApplied();
    } catch {
      setError("Could not reach the engine.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`cc-ai${open ? " cc-ai--open" : ""}${asButton && !open ? " cc-ai--bare" : ""}`}>
      {asButton && !open ? (
        // Closed: a control, not a container. No border and no background, so it reads as one of the
        // screen's buttons rather than as a section that happens to be empty.
        <button
          className="cc-btn cc-btn--ghost cc-btn--sm cc-ai__btn"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          title="Describe what you want in plain English and let a model fill this screen in"
        >
          <span className="cc-ai__spark" aria-hidden>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
              <path d="M8 1.8l1.5 3.6 3.7 1.4-3.7 1.4L8 12.2 6.5 8.2 2.8 6.8l3.7-1.4z" />
            </svg>
          </span>
          <span>{title ?? "Describe it"}</span>
        </button>
      ) : collapsible ? (
        <button className="cc-ai__head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className="cc-ai__spark" aria-hidden>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
              <path d="M8 1.8l1.5 3.6 3.7 1.4-3.7 1.4L8 12.2 6.5 8.2 2.8 6.8l3.7-1.4z" />
            </svg>
          </span>
          <span className="cc-ai__title">{title ?? "Describe it and I'll set it up"}</span>
          <span className="cc-ai__caret" aria-hidden>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d={open ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"} />
            </svg>
          </span>
        </button>
      ) : (
        // Not a toggle: this instance IS the screen's field, and folding it away would hide the one
        // box the screen is for.
        <div className="cc-ai__head cc-ai__head--fixed">
          <span className="cc-ai__spark" aria-hidden>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
              <path d="M8 1.8l1.5 3.6 3.7 1.4-3.7 1.4L8 12.2 6.5 8.2 2.8 6.8l3.7-1.4z" />
            </svg>
          </span>
          {/* Title over sub-line, not beside it. Beside, a sub-line long enough to be useful wraps
              to two lines in a narrow right-hand column and reads as a label that has come loose. */}
          <span className="cc-ai__heading">
            <span className="cc-ai__title">{title ?? "Describe it and I'll set it up"}</span>
            {sub && <span className="cc-ai__sub">{sub}</span>}
          </span>
        </div>
      )}

      {open && (
        <div className="cc-ai__body">
          {columns && refOptions ? (
            <RefField
              className="cc-textarea cc-textarea--sm"
              rows={3}
              value={intent}
              columns={columns}
              options={refOptions}
              placeholder={placeholder}
              ariaLabel="What you want this column to do"
              onChange={setIntent}
            />
          ) : (
            <textarea
              className="cc-textarea cc-textarea--sm"
              rows={3}
              value={intent}
              placeholder={placeholder}
              onChange={(e) => setIntent(e.target.value)}
              aria-label="What you want this column to do"
            />
          )}
          {columns && refOptions && (
            <span className="cc-field__hint">
              Type <kbd>/</kbd> to point at another column. A reference follows that column even if
              you rename it later.
            </span>
          )}

          {showDocsUrl && (
            <label className="cc-field cc-field--tight">
              <span className="cc-field__label">
                Link to the docs
                <span className="cc-field__sub">optional — I'll read the page first</span>
              </span>
              <input
                className="cc-input"
                value={docsUrl}
                placeholder="https://docs.example.com/api#lookup"
                spellCheck={false}
                onChange={(e) => setDocsUrl(e.target.value)}
              />
            </label>
          )}

          <div className="cc-ai__actions">
            <button
              className="cc-btn cc-btn--primary"
              onClick={() => void propose()}
              disabled={busy || !intent.trim()}
              title={intent.trim() ? "Work out how this column should be set up." : "Say what this column should do first."}
            >
              <IconPlay /> <span>{busy ? "Working…" : "Set it up"}</span>
            </button>

            {/* A running call can be stopped. Before this the only way out of a slow one was to wait
                it out — up to a minute of a button reading "Working…" with nothing to press, which
                is indistinguishable from a hang. */}
            {busy && (
              <button
                className="cc-btn cc-btn--xs"
                onClick={() => abort.current?.abort()}
                title="Stop waiting for this. Nothing has been changed."
              >
                <IconStop /> <span>Stop</span>
              </button>
            )}

            {/* Said before the money is spent, not after.
                "One model call" is not an amount, and a figure that appears only once the call is
                over is too late to decide with. Naming the model and the price here means the
                decision is made with the number in view. */}
            <span className="cc-ai__note">
              {setupModel == null
                ? "One model call. Nothing runs on your rows."
                : setupModel.freeOnly
                  ? `Designed by ${setupModel.model} — free models only, so this cannot cost anything.`
                  : setupModel.estimateUsd == null
                    ? `Designed by ${setupModel.model}. Its price is not in the model list, so this call cannot be costed.`
                    : setupModel.estimateUsd === 0
                      ? `Designed by ${setupModel.model} — free. Nothing runs on your rows.`
                      : `Designed by ${setupModel.model} — ${money(setupModel.estimateUsd)} for this one call. Nothing runs on your rows.`}
            </span>
          </div>

          {error && <div className="cc-errors" role="alert"><div className="cc-errors__row">{error}</div></div>}

          {proposal && (
            <div className="cc-prop" role="status">
              <p className="cc-prop__why">{proposal.why}</p>

              {proposal.readUrl && (
                <p className="cc-prop__src">
                  Read <a href={proposal.readUrl} target="_blank" rel="noopener noreferrer">{proposal.readUrl}</a>
                </p>
              )}

              {proposal.changes.length === 0 ? (
                <p className="cc-prop__none">Nothing here needs changing — it is already set up this way.</p>
              ) : (
                <ul className="cc-prop__list">
                  {proposal.changes.map((c) => (
                    <li key={c.field} className="cc-prop__row">
                      <span className="cc-prop__label">{c.label}</span>
                      <span className="cc-prop__from truncate" title={c.before}>{c.before}</span>
                      <span className="cc-prop__arrow" aria-hidden>→</span>
                      <span className="cc-prop__to truncate" title={c.after}>{c.after}</span>
                    </li>
                  ))}
                </ul>
              )}

              {/* What it could NOT work out. Without this the user applies a request with the word
                  YOUR_KEY in a header and finds out one failed run later. */}
              {proposal.missing.length > 0 && (
                <div className="cc-prop__missing">
                  <strong>You still need to fill in:</strong>
                  <ul>{proposal.missing.map((m, i) => <li key={i}>{m}</li>)}</ul>
                </div>
              )}

              {proposal.script && (
                <p className="cc-prop__note">
                  It also wrote {proposal.script.code.split("\n").length} lines of code. That is saved
                  unapproved — read it on the Rule tab and approve it before it can run.
                </p>
              )}

              {/* Advice about the PER-ROW model, which is a different decision from the one that
                  produced this proposal — and the expensive one, since it repeats on every row. */}
              {proposal.modelTier && (
                <p className="cc-prop__note">
                  {proposal.modelTier === "cheap"
                    ? "This looks like straightforward work, so a cheap model should handle it — that matters, because this one runs on every row."
                    : proposal.modelTier === "strong"
                      ? "This needs real judgement per row, so a stronger model is worth it — but it runs on every row, so check the estimate before a large run."
                      : "An ordinary model should handle this."}
                  {proposal.modelTierWhy ? ` ${proposal.modelTierWhy}` : ""} You choose it on the Model
                  setting, with the price beside each option.
                </p>
              )}

              {/* Columns that do not exist yet and have to.
                  The panel could only ever describe ONE column, so a request whose honest answer was
                  "you need two columns for that" got a single column that half-worked — typically a
                  prompt quietly guessing at data the table does not hold. Each of these is accepted
                  on its own; none is created until pressed. */}
              {(proposal.alsoNeeds?.length ?? 0) > 0 && (
                <div className="cc-prop__also">
                  <strong>
                    This needs {proposal.alsoNeeds!.length === 1 ? "another column" : `${proposal.alsoNeeds!.length} more columns`} first
                  </strong>
                  <ul className="cc-prop__alsolist">
                    {proposal.alsoNeeds!.map((c) => {
                      const state = added[c.name];
                      return (
                        <li key={c.name} className="cc-prop__alsorow">
                          <span className="cc-prop__alsotext">
                            <span className="cc-prop__alsoname">{c.name}</span>
                            <span className="cc-prop__alsowhy">{c.why}</span>
                          </span>
                          {state === "done" ? (
                            <span className="cc-prop__alsodone">Added</span>
                          ) : (
                            <button
                              className="cc-btn cc-btn--xs"
                              onClick={() => void addExtra(c)}
                              disabled={state === "adding"}
                              title={`Create a ${c.kind} column called ${c.name}. Nothing runs.`}
                            >
                              {state === "adding" ? "Adding…" : `+ ${c.name}`}
                            </button>
                          )}
                          {state && state !== "done" && state !== "adding" && (
                            <span className="cc-prop__alsoerr" role="alert">{state}</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              <div className="cc-prop__foot">
                <span className="cc-prop__meta mono">
                  {proposal.model}
                  {proposal.costUsd === null ? " · free" : money(proposal.costUsd) ? ` · ${money(proposal.costUsd)}` : ""}
                </span>
                <div className="cc-prop__actions">
                  <button className="cc-btn cc-btn--xs" onClick={() => setProposal(null)} disabled={busy}>Discard</button>
                  <button
                    className="cc-btn cc-btn--primary cc-btn--xs"
                    onClick={() => void apply()}
                    disabled={busy || proposal.changes.length === 0}
                    title={proposal.changes.length === 0
                      ? "There is nothing here to apply — it proposed no changes."
                      : "Apply these to the column."}
                  >
                    Apply {proposal.changes.length} change{proposal.changes.length === 1 ? "" : "s"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
