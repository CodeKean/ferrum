// The table assistant.
//
// A right-docked panel with no backdrop, on purpose: the grid stays live behind it, so a suggestion
// can be applied and its effect watched in the same breath. A modal would hide the one thing the
// conversation is about.
//
// Every proposed change is applied ONE AT A TIME. A reply can hold a good suggestion and a wrong
// one, and an "apply all" button is how the wrong one gets in.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconPlay } from "../ui/Icon.tsx";
import { Modal } from "../ui/Modal.tsx";
import { RefField } from "../prompt/RefField.tsx";
import { toDisplay } from "../prompt/refs.ts";
import type { RefOption } from "../prompt/RefMenu.tsx";
import type { Column } from "../api.ts";
import "./Assistant.css";

interface Action {
  kind: "add_column" | "set_prompt" | "set_mode" | "set_dedupe";
  why: string;
  name?: string;
  columnId?: number;
  columnKind?: string;
  valueType?: string;
  prompt?: string;
  columnNames?: string[];
  keep?: string;
}

interface Bubble {
  /** The engine's id for this turn. Absent only for a question still in flight. */
  id?: number;
  role: "user" | "assistant";
  text: string;
  actions?: Action[];
  /** Actions already applied, by index, so a done one cannot be applied twice. */
  applied?: Record<number, string>;
  /**
   * Changes it proposed that this table could not accept.
   *
   * Said out loud rather than dropped. This is the other half of "it says it will do something and
   * then does not": the sentence describes a change, the change failed its checks on the way back,
   * and the transcript showed the sentence with no button under it and no explanation.
   */
  dropped?: number;
}

/** One stage of an answer in flight, named as it happens so a longer wait reads as work. */
interface Step {
  phase: "draft" | "check" | "revise" | "done";
  label: string;
  round?: number;
}

interface Props {
  sheetId: string;
  columns: Column[];
  onClose: () => void;
  onChanged: () => void;
}

const STARTERS = [
  "What is in this table?",
  "Why is a column failing?",
  "Add a column that finds each company's industry",
  "How should I match duplicates here?",
];

/** What an action says it will do, in the words of the screen that would have done it. */
function describe(a: Action, columns: Column[]): string {
  const name = (id?: number) => columns.find((c) => Number(c.id) === id)?.name ?? "a column";
  switch (a.kind) {
    case "add_column": return `Add a column “${a.name}” that ${a.columnKind === "static" ? "you type into" : a.columnKind === "ai" ? "asks a model" : a.columnKind === "agent" ? "searches the web" : a.columnKind === "http" ? "calls an API" : "runs a rule"}`;
    case "set_prompt": return `Change what “${name(a.columnId)}” asks`;
    case "set_mode": return `Make “${name(a.columnId)}” ${a.columnKind}`;
    case "set_dedupe": return `Match duplicates on ${(a.columnNames ?? []).join(", then ")}`;
  }
}

export function Assistant({ sheetId, columns, onClose, onChanged }: Props) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  /** The steps of the answer currently in flight, in order — the last is the one happening now. */
  const [steps, setSteps] = useState<Step[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showContext, setShowContext] = useState(false);
  const [context, setContext] = useState<string | null>(null);
  /** Until the stored transcript has arrived, an empty panel is not the same as no conversation. */
  const [loading, setLoading] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  /**
   * The conversation, from the engine.
   *
   * It used to live in this component's state alone, so closing the panel destroyed it — as did a
   * reload, and as did opening another table and coming back. Everything said in a conversation
   * about a table is context for what is said next, so losing it is not losing one message.
   */
  useEffect(() => {
    let dead = false;
    setLoading(true);
    void fetch(`/api/sheets/${sheetId}/assistant/messages`)
      .then((r) => r.json())
      .then((res) => {
        if (dead) return;
        setBubbles(
          ((res.messages ?? []) as any[]).map((m) => ({
            id: m.id, role: m.role, text: m.text,
            actions: m.actions ?? [], applied: m.applied ?? {},
          })),
        );
      })
      .catch(() => { /* an unreachable engine is reported by the first send, not by an empty panel */ })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [sheetId]);

  /**
   * `/` works in here too, the same as it does in every field in the column drawer.
   *
   * `draft` is held in STORED form (`{{col:id}}`) so a reference survives a rename, and is turned
   * back into `/Column name` on the way out — the assistant reasons about names, not ids, so sending
   * it the id form would be sending it something it cannot read.
   */
  const refOptions: RefOption[] = useMemo(
    () => columns.map((c) => ({ column: c, sample: null })),
    [columns],
  );
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [bubbles.length, busy]);

  // Dismissal matches every other overlay: Escape, and a click outside — with a carve-out for
  // portalled popovers, which are visually ours but not DOM descendants.
  //
  // The TOGGLE that opens this panel is carved out too, and has to be. It matched none of the
  // exemptions, so pressing it while the panel was open closed the panel on `pointerdown` — taking
  // the whole conversation with it — and the `click` that followed reopened an empty one. The
  // button read as broken and the transcript was unrecoverable.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest(".cc-as") || t.closest(".cc-pop") || t.closest(".cc-modal-scrim")) return;
      if (t.closest("[data-cc-assistant-toggle]")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pointerdown", onDown); };
  }, [onClose]);

  const send = useCallback(async (text: string) => {
    // Kept so a failure can put things back exactly as they were. The question was shown in the
    // transcript the moment it was sent and the box was emptied, and neither was undone when the
    // send failed — so a failed question sat there looking asked, with no answer coming and nothing
    // to press, and the words were gone from the box as well. Asking again meant typing it again.
    const prevBubbles = bubbles;
    const prevDraft = draft;

    const history: Bubble[] = [...bubbles, { role: "user", text }];
    setBubbles(history);
    setDraft("");
    setBusy(true);
    setSteps([]);
    setError(null);

    // The answer arrives as a stream of newline-delimited JSON, not one response: `step` lines while
    // it plans and checks itself, then a single `done` or `error`. Read line by line so each step can
    // be shown the moment it starts rather than all at once when it finishes.
    const fail = (msg: string) => {
      setError(msg);
      // Nothing was said, so nothing stays said. The words go back in the box, where fixing whatever
      // the error named and pressing Send once more is the whole recovery.
      setBubbles(prevBubbles);
      setDraft(prevDraft || text);
    };
    try {
      // Only the new question goes up. The engine owns the transcript now and reads the history from
      // its own store — sending the browser's copy meant the model's memory was whatever this panel
      // happened to be holding, which after a reload was nothing at all while the user could still
      // read the whole conversation on screen.
      const res = await fetch(`/api/sheets/${sheetId}/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      // A pre-stream refusal (no such table, empty question) still answers as plain JSON.
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        fail(j?.error ?? "Could not reach the engine.");
        return;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let settled = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const raw = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!raw) continue;
          const msg = JSON.parse(raw) as
            | { type: "step"; phase: Step["phase"]; label: string; round?: number }
            | { type: "done"; reply: string; actions?: Action[]; dropped?: number; userTurnId?: number; turnId?: number }
            | { type: "error"; error: string };

          if (msg.type === "step") {
            // The terminal "Ready" step is not shown — the finished answer replaces the whole strip a
            // beat later, and a checkmark that appears and vanishes reads as a flicker.
            if (msg.phase !== "done") setSteps((prev) => [...prev, { phase: msg.phase, label: msg.label, round: msg.round }]);
          } else if (msg.type === "done") {
            settled = true;
            setBubbles([
              ...history.map((b, i) => (i === history.length - 1 ? { ...b, id: msg.userTurnId } : b)),
              { id: msg.turnId, role: "assistant", text: msg.reply, actions: msg.actions ?? [], applied: {}, dropped: msg.dropped ?? 0 },
            ]);
          } else if (msg.type === "error") {
            settled = true;
            fail(msg.error);
          }
        }
      }
      // The stream ended without a terminal line — a dropped connection mid-answer. Put things back
      // rather than leave the question sitting there looking asked with no answer coming.
      if (!settled) fail("The answer was cut off. Try again.");
    } catch {
      fail("Could not reach the engine.");
    } finally {
      setBusy(false);
      setSteps([]);
    }
  }, [bubbles, draft, sheetId]);

  const apply = async (bubbleIndex: number, actionIndex: number, action: Action) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sheets/${sheetId}/assistant/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The turn and the index go with it, so the engine can record that this one is done. Without
        // them a re-opened panel offered an already-applied change again — and applying "add a
        // column" twice adds two columns.
        body: JSON.stringify({ action, turnId: bubbles[bubbleIndex]?.id, actionIndex }),
      }).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      setBubbles((prev) =>
        prev.map((b, i) => (i === bubbleIndex ? { ...b, applied: { ...(b.applied ?? {}), [actionIndex]: res.said } } : b)),
      );
      onChanged();
    } catch {
      // Said out loud. Without this the button un-disabled itself, nothing changed, and the action
      // still read as pending — which is indistinguishable from having applied it.
      setError("Could not reach the engine.");
    } finally {
      setBusy(false);
    }
  };

  const openContext = async () => {
    setShowContext((v) => !v);
    if (context) return;
    const res = await fetch(`/api/sheets/${sheetId}/assistant/context`).then((r) => r.json()).catch(() => null);
    setContext(res?.context ?? "Could not read the table.");
  };

  return (
    <aside className="cc-as" role="dialog" aria-label="Table assistant">
      <header className="cc-as__head">
        <div className="cc-as__title">
          <strong>Assistant</strong>
          <span className="cc-as__sub">
            {bubbles.length > 0
              // Says the thing that is now true and was not before: closing this does not lose it.
              ? `${bubbles.length} ${bubbles.length === 1 ? "message" : "messages"}, kept with this table`
              : "Ask about this table, or describe a change"}
          </span>
        </div>
        {bubbles.length > 0 && (
          <button
            className="hk-icon-btn"
            onClick={() => setConfirmClear(true)}
            disabled={busy}
            aria-label="Start a new conversation"
            title="Start a new conversation — this one is kept until you clear it"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8" />
            </svg>
          </button>
        )}
        <button className="hk-icon-btn" onClick={onClose} aria-label="Close the assistant" title="Close">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </header>

      <div className="cc-as__body">
        {/* Fixed-height placeholders while the stored transcript arrives. Without them the panel
            opened on the starter prompts and then replaced them with a conversation, which reads as
            the starters having been dismissed by something the user did not do. */}
        {loading && (
          <>
            <div className="cc-as__bubble cc-as__bubble--user"><span className="cc-as__skel" style={{ width: "55%" }} /></div>
            <div className="cc-as__bubble cc-as__bubble--assistant"><span className="cc-as__skel" style={{ width: "80%" }} /></div>
          </>
        )}

        {!loading && bubbles.length === 0 && (
          <div className="cc-as__starters">
            <p className="cc-as__empty">
              It can see this table's columns, how full they are, and any errors — not the rows
              themselves.
            </p>
            {STARTERS.map((s) => (
              <button key={s} className="cc-as__starter" onClick={() => void send(s)}>{s}</button>
            ))}
          </div>
        )}

        {bubbles.map((b, i) => (
          <div key={i} className={`cc-as__bubble cc-as__bubble--${b.role}`}>
            <span className="cc-as__text">{b.text}</span>

            {/* The reply described a change, the change failed its checks on the way back, and
                without this the bubble showed the sentence with nothing under it — which is what
                "it says it will do something and then doesn't" looks like from the outside. */}
            {(b.dropped ?? 0) > 0 && (
              <span className="cc-as__dropped" role="status">
                {b.dropped === 1
                  ? "It proposed one change this table cannot take, so there is nothing to apply above. Say what you want in different words and it will try again."
                  : `It proposed ${b.dropped} changes this table cannot take, so there is nothing to apply above. Say what you want in different words and it will try again.`}
              </span>
            )}

            {b.actions && b.actions.length > 0 && (
              <ul className="cc-as__actions">
                {b.actions.map((a, j) => {
                  const done = b.applied?.[j];
                  return (
                    <li key={j} className="cc-as__action">
                      <span className="cc-as__what">
                        <span className="cc-as__doing">{describe(a, columns)}</span>
                        {a.why && <span className="cc-as__why">{a.why}</span>}
                        {done && <span className="cc-as__done">{done}</span>}
                      </span>
                      <button
                        className="cc-btn cc-btn--xs"
                        disabled={busy || !!done}
                        onClick={() => void apply(i, j, a)}
                      >
                        {done ? "Applied" : "Apply"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ))}

        {busy && (
          <div className="cc-as__thinking" role="status" aria-live="polite">
            {steps.length === 0 ? (
              <div className="cc-as__step cc-as__step--active">
                <span className="cc-as__stepdot" />
                <span className="cc-as__steplabel">Thinking…</span>
              </div>
            ) : (
              steps.map((s, i) => {
                const active = i === steps.length - 1;
                return (
                  <div key={i} className={`cc-as__step ${active ? "cc-as__step--active" : "cc-as__step--done"}`}>
                    <span className="cc-as__stepdot">
                      {!active && (
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M2.5 6.5l2.5 2.5 4.5-5.5" />
                        </svg>
                      )}
                    </span>
                    <span className="cc-as__steplabel">
                      {s.label}{s.round && s.round > 1 ? ` · round ${s.round}` : ""}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* Dismissable. It had no control on it at all, so a message like "No OpenRouter key
          configured." stayed on screen until the next send SUCCEEDED — which, when the error is
          that there is no key, is never. It read as part of the panel rather than as something
          that had just happened. */}
      {error && (
        <div className="cc-as__error" role="alert">
          <span>{error}</span>
          <button
            className="cc-as__errorx"
            onClick={() => setError(null)}
            aria-label="Dismiss this message"
            title="Dismiss"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </div>
      )}

      {showContext && (
        <pre className="cc-as__context mono">{context ?? "Reading…"}</pre>
      )}

      <footer className="cc-as__foot">
        <div
          className="cc-as__boxwrap"
          onKeyDown={(e) => {
            e.stopPropagation();
            // Enter sends, unless the reference menu is open — there it belongs to the menu, and
            // stealing it would fire a half-typed question every time somebody picked a column.
            // The menu listens in the capture phase and calls preventDefault when it takes the key,
            // so checking that is exact where a "is the menu on screen" guess would not be.
            if (e.key !== "Enter" || e.shiftKey || e.defaultPrevented) return;
            if (!draft.trim()) return;
            e.preventDefault();
            void send(toDisplay(draft, columns).trim());
          }}
        >
          <RefField
            className="cc-as__box"
            rows={2}
            value={draft}
            columns={columns}
            options={refOptions}
            disabled={busy}
            autoFocus
            placeholder="Ask, or describe a change — type / for a column"
            ariaLabel="Ask the assistant"
            onChange={setDraft}
          />
        </div>
        <div className="cc-as__footrow">
          {/* No hidden context: what it can see is one click away. */}
          <button className="cc-as__peek" onClick={() => void openContext()}>
            {showContext ? "Hide what it can see" : "What can it see?"}
          </button>
          <button
            className="cc-btn cc-btn--primary cc-btn--xs"
            disabled={busy || !draft.trim()}
            onClick={() => void send(toDisplay(draft, columns).trim())}
          >
            <IconPlay /> <span>Send</span>
          </button>
        </div>
      </footer>

      {/* Asked, not done. The transcript is the only record of what was proposed and what was
          applied, and there is no undo for throwing it away. */}
      {confirmClear && (
        <Modal
          open
          onClose={() => setConfirmClear(false)}
          title="Start a new conversation?"
          footNote="The columns it already added stay exactly as they are."
          footer={
            <>
              <button className="cc-btn" onClick={() => setConfirmClear(false)}>Keep it</button>
              <button
                className="cc-btn cc-btn--danger"
                onClick={() => {
                  setConfirmClear(false);
                  void fetch(`/api/sheets/${sheetId}/assistant/messages`, { method: "DELETE" })
                    .then(() => setBubbles([]))
                    .catch(() => setError("Could not clear the conversation."));
                }}
              >
                Clear it
              </button>
            </>
          }
        >
          <p className="cc-as__confirm">
            This throws away {bubbles.length} {bubbles.length === 1 ? "message" : "messages"} about this
            table, including what it suggested and what you applied. Nothing in the table changes.
          </p>
        </Modal>
      )}
    </aside>
  );
}
