// The waterfall editor — an ordered list of steps, each with its own stop rule.
//
// THE THING THIS SCREEN HAS TO GET RIGHT is that a waterfall is auditable at a glance. Every step's
// row says what it does, what it costs and when it stops, in words, without opening anything. That is
// not decoration: the order and the stop rules are what decide the bill, and a list you have to click
// into five times to understand is a list nobody checks before pressing Run.
//
// The second thing: the total is shown BOTH ways, always. Best case is the first step's price and is
// what people quote themselves; worst case is every row falling through every step, which on a hard
// list is most of them. And a step whose price nobody has declared is NAMED rather than counted as
// zero — a total that quietly omits a paid API reads as authoritative and is short by exactly the
// amount that matters.

import { useCallback, useMemo, useState } from "react";
import { Select, SAVING_REASON } from "../ui/Select.tsx";
import { IconPlus, IconTrash } from "../ui/Icon.tsx";
import {
  DEFAULT_ACCEPT, STEP_KINDS, STEP_KIND_LABEL, describeAccept, parseWaterfall, waterfallCost,
  type AcceptRule, type StepKind, type Waterfall, type WaterfallStep,
} from "@shared/waterfall.ts";
import { PRESETS, presetStep } from "./waterfallPresets.ts";
import "./WaterfallSettings.css";

interface Props {
  /** The column's stored waterfall JSON, exactly as the engine will read it. */
  value: string | null;
  onChange: (next: Waterfall) => void;
  busy?: boolean;
  error?: string | null;
}

/** Ids have to survive reorders — see WaterfallStep.id. Random rather than positional, deliberately. */
function newId(): string {
  return `s${Math.random().toString(36).slice(2, 10)}`;
}

const ACCEPT_CHOICES: Array<{ value: AcceptRule["kind"]; label: string }> = [
  { value: "non_empty", label: "when it finds anything" },
  { value: "matches", label: "when it looks right" },
  { value: "confidence", label: "when the model is sure" },
  { value: "any", label: "always — even if empty" },
];

/** Ready-made patterns, so nobody has to write a regex to check an email looks like an email. */
const SHAPES: Array<{ value: string; label: string }> = [
  { value: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", label: "an email address" },
  { value: "^[+0-9][0-9 ()\\-.]{6,}$", label: "a phone number" },
  { value: "^(https?://)?[a-z0-9-]+(\\.[a-z0-9-]+)+", label: "a domain or URL" },
  { value: "^https?://(www\\.)?linkedin\\.com/", label: "a LinkedIn URL" },
  { value: ".", label: "anything at all" },
];

export function WaterfallSettings({ value, onChange, busy, error }: Props) {
  // Parsed through the ENGINE'S reader, not a second one written for the editor. A screen that
  // understands the saved shape differently from the thing that runs it is how an editor comes to
  // show steps that never execute.
  const { waterfall, dropped } = useMemo(() => parseWaterfall(value ?? null), [value]);
  const [adding, setAdding] = useState(false);

  const cost = useMemo(() => waterfallCost(waterfall), [waterfall]);

  const update = useCallback((next: Waterfall) => onChange(next), [onChange]);

  const patchStep = (id: string, patch: Partial<WaterfallStep>) =>
    update({ ...waterfall, steps: waterfall.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) });

  const move = (index: number, by: number) => {
    const to = index + by;
    if (to < 0 || to >= waterfall.steps.length) return;
    const steps = [...waterfall.steps];
    const [s] = steps.splice(index, 1);
    steps.splice(to, 0, s!);
    update({ ...waterfall, steps });
  };

  const add = (step: WaterfallStep) => {
    update({ ...waterfall, steps: [...waterfall.steps, step] });
    setAdding(false);
  };

  return (
    <div className="cc-wf">
      <p className="cc-wf__intro">
        Each step runs only if the one before it did not settle the row. A step can call any API, use
        a connected app, ask a model, send an agent, work it out with a rule, or read another table —
        so an email waterfall and a phone waterfall are the same thing in a different order.
      </p>

      {dropped.length > 0 && (
        // Never silent. A dropped step is a provider that has stopped being called, and the row falls
        // through to the more expensive one behind it.
        <p className="cc-wf__warn" role="alert">
          {dropped.join(" ")}
        </p>
      )}

      {waterfall.steps.length === 0 && (
        <p className="cc-wf__empty">
          No steps yet. Add the cheapest thing that might answer first, then the ones worth paying for.
        </p>
      )}

      {waterfall.steps.length > 0 && (
        <ol className="cc-wf__list">
          {waterfall.steps.map((step, i) => (
            <li key={step.id} className={`cc-wf__row${step.enabled ? "" : " cc-wf__row--off"}`}>
              <span className="cc-wf__num" aria-hidden>{i + 1}</span>

              <div className="cc-wf__main">
                <input
                  className="cc-wf__name"
                  value={step.name}
                  aria-label={`Name of step ${i + 1}`}
                  onChange={(e) => patchStep(step.id, { name: e.target.value })}
                />
                <span className="cc-wf__sub">
                  {STEP_KIND_LABEL[step.kind]} · {describeAccept(step.accept ?? waterfall.accept)}
                  {" · "}
                  {step.costUsd == null
                    // Said out loud rather than shown as $0.00. "No price set" is a thing to go and
                    // fix; a zero is a thing people believe.
                    ? <em className="cc-wf__unpriced">no price set</em>
                    : step.costUsd === 0 ? "free" : `$${step.costUsd.toFixed(4)} a row`}
                </span>
              </div>

              <Select
                label="Stops"
                size="sm"
                value={(step.accept ?? waterfall.accept).kind}
                options={ACCEPT_CHOICES}
                disabled={busy}
                disabledReason={SAVING_REASON}
                onChange={(kind) => patchStep(step.id, { accept: defaultRuleFor(kind) })}
              />

              {(step.accept ?? waterfall.accept).kind === "matches" && (
                <Select
                  label="Shape"
                  size="sm"
                  value={((step.accept ?? waterfall.accept) as { pattern: string }).pattern}
                  options={SHAPES}
                  disabled={busy}
                  disabledReason={SAVING_REASON}
                  onChange={(pattern) => patchStep(step.id, { accept: { kind: "matches", pattern } })}
                />
              )}

              <label className="cc-wf__price">
                <span className="sr-only">Cost per row for {step.name}</span>
                <input
                  className="cc-input cc-input--num"
                  type="number"
                  min={0}
                  step="0.001"
                  size={7}
                  placeholder="price"
                  value={step.costUsd == null ? "" : String(step.costUsd)}
                  onChange={(e) => patchStep(step.id, {
                    // Empty means UNDECLARED, not zero. Coercing a cleared box to 0 is how a paid
                    // provider comes to be forecast as free.
                    costUsd: e.target.value.trim() === "" ? null : Number(e.target.value),
                  })}
                />
              </label>

              <div className="cc-wf__acts">
                <button
                  className="hk-icon-btn"
                  aria-label={`Move ${step.name} up`}
                  disabled={i === 0 || busy}
                  onClick={() => move(i, -1)}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m4 10 4-4 4 4" /></svg>
                </button>
                <button
                  className="hk-icon-btn"
                  aria-label={`Move ${step.name} down`}
                  disabled={i === waterfall.steps.length - 1 || busy}
                  onClick={() => move(i, 1)}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m4 6 4 4 4-4" /></svg>
                </button>
                <label className="cc-wf__on" title={step.enabled ? "Running" : "Kept, but skipped"}>
                  <input
                    type="checkbox"
                    checked={step.enabled}
                    onChange={(e) => patchStep(step.id, { enabled: e.target.checked })}
                  />
                  <span className="sr-only">Run {step.name}</span>
                </label>
                <button
                  className="hk-icon-btn"
                  aria-label={`Remove ${step.name}`}
                  disabled={busy}
                  onClick={() => update({ ...waterfall, steps: waterfall.steps.filter((s) => s.id !== step.id) })}
                >
                  <IconTrash />
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className="cc-wf__foot">
        <button className="cc-btn cc-btn--sm" disabled={busy} onClick={() => setAdding(true)}>
          <IconPlus /> Step
        </button>

        {waterfall.steps.some((s) => s.enabled) && (
          <p className="cc-wf__cost">
            <strong>${cost.best.toFixed(4)}</strong> a row if the first step usually answers,
            up to <strong>${cost.worst.toFixed(4)}</strong> if every row falls all the way through.
            {cost.unpriced.length > 0 && (
              <span className="cc-wf__unpriced">
                {" "}Not counted: {cost.unpriced.join(", ")} — no price set, so the real total is higher.
              </span>
            )}
          </p>
        )}
      </div>

      {error && <p className="cc-wf__warn" role="alert">{error}</p>}

      {adding && (
        <AddStep
          onCancel={() => setAdding(false)}
          onAdd={(kind, preset) => add(
            preset
              ? { ...presetStep(preset), id: newId() }
              : { id: newId(), name: STEP_KIND_LABEL[kind], kind, enabled: true, config: {}, costUsd: null },
          )}
        />
      )}
    </div>
  );
}

function defaultRuleFor(kind: AcceptRule["kind"]): AcceptRule {
  switch (kind) {
    case "matches": return { kind: "matches", pattern: SHAPES[0]!.value };
    case "confidence": return { kind: "confidence", min: "medium" };
    case "any": return { kind: "any" };
    case "script": return { ...DEFAULT_ACCEPT };
    default: return { ...DEFAULT_ACCEPT };
  }
}

/**
 * Picking what the new step is.
 *
 * Presets FIRST, and lanes second, because that is the order people think in: "I want Prospeo" comes
 * before "I want an HTTP call". But a preset produces an ordinary step of an ordinary lane, which you
 * can then edit or take apart — it is a starting point, never a special kind of step.
 */
function AddStep({ onAdd, onCancel }: {
  onAdd: (kind: StepKind, preset?: string) => void;
  onCancel: () => void;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const presets = PRESETS.filter(
    (p) => !needle || p.name.toLowerCase().includes(needle) || p.finds.toLowerCase().includes(needle),
  );

  return (
    <div className="cc-wf__add" role="group" aria-label="Add a step">
      <input
        className="cc-input"
        autoFocus
        placeholder="Search providers — email, phone, company…"
        value={q}
        aria-label="Search providers"
        onChange={(e) => setQ(e.target.value)}
      />

      {presets.length > 0 && (
        <ul className="cc-wf__presets">
          {presets.map((p) => (
            <li key={p.id}>
              <button className="cc-wf__preset" onClick={() => onAdd(p.kind, p.id)}>
                <span className="cc-wf__preset-name">{p.name}</span>
                <span className="cc-wf__preset-sub">
                  {p.finds} · {p.costUsd == null ? "price varies" : `$${p.costUsd.toFixed(4)} a row`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="cc-wf__or">or start from scratch</p>
      <ul className="cc-wf__kinds">
        {STEP_KINDS.map((k) => (
          <li key={k}>
            <button className="cc-wf__kind" onClick={() => onAdd(k)}>{STEP_KIND_LABEL[k]}</button>
          </li>
        ))}
      </ul>

      <button className="cc-btn cc-btn--sm" onClick={onCancel}>Cancel</button>
    </div>
  );
}
