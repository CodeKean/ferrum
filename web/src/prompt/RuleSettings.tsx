// Per-column validation rules, the editor.
//
// The type picker above this decides what SHAPE a value must be; these decide what a valid value
// looks like. The distinction matters in the copy as well as the code, because "number" already
// stops "about forty" and users reasonably ask what a second gate is for — so the hint names the
// values it catches, which are the ones that are the right type and still wrong.
//
// The rules themselves are checked with the ENGINE'S OWN module (`@shared/validate.ts`), not a copy.
// A client that accepted what the server refuses is a form that cannot be saved; one that refused
// what the server accepts is a feature nobody can reach.

import { useState } from "react";
import { patternRisk, RULE_KINDS, ruleIsComplete, type Rule, type RuleKind, type RuleSet } from "@shared/validate.ts";
import { Select } from "../ui/Select.tsx";
import { IconPlus, IconTrash } from "../ui/Icon.tsx";
import "./RuleSettings.css";

const LABEL: Record<RuleKind, string> = {
  required: "Must not be empty",
  min: "At least (number)",
  max: "At most (number)",
  min_length: "At least N characters",
  max_length: "At most N characters",
  pattern: "Matches a pattern",
  one_of: "One of these values",
  not_one_of: "None of these values",
};

/** What the value box is for, per kind. A shared placeholder would be wrong for six of the eight. */
const PLACEHOLDER: Record<RuleKind, string> = {
  required: "",
  min: "1",
  max: "1000",
  min_length: "3",
  max_length: "500",
  pattern: "^[A-Z]{2}-\\d+$",
  one_of: "active, churned, trial",
  not_one_of: "n/a, unknown, none",
};

const LIST_KINDS = new Set<RuleKind>(["one_of", "not_one_of"]);

interface Props {
  value: RuleSet | null;
  onChange: (next: RuleSet | null) => void;
  busy?: boolean;
  /** The server's refusal, shown where the rule is rather than as a toast that has since gone. */
  error?: string | null;
}

export function RuleSettings({ value, onChange, busy, error }: Props) {
  const rules = value?.rules ?? [];
  const onFail = value?.onFail ?? "reject";
  const [adding, setAdding] = useState<RuleKind>("required");

  const commit = (nextRules: Rule[], nextFail: RuleSet["onFail"] = onFail) => {
    // No rules is NULL, not an empty set. They are the same thing to the engine, and storing `{}`
    // would leave a column looking configured in every listing that checks for the field.
    onChange(nextRules.length === 0 ? null : { rules: nextRules, onFail: nextFail });
  };

  const update = (i: number, patch: Partial<Rule>) =>
    commit(rules.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  return (
    <div className="cc-rules">
      <div className="cc-field">
        <span className="cc-field__label">Rules</span>
        <span className="cc-field__hint">
          Checked after the data type, on every hand edit and every value a run produces. The type
          already stops the wrong shape; these stop values that are the right shape and still wrong —
          a headcount of 0, an address of <code>x@x</code>, a 40,000-character page a scrape brought
          back instead of a company name.
        </span>
      </div>

      {error && <p className="cc-rules__error" role="alert">{error}</p>}

      {rules.length === 0 && (
        <p className="cc-rules__empty">No rules yet. Anything the data type accepts goes in.</p>
      )}

      {rules.length > 0 && (
        <ul className="cc-rules__list">
          {rules.map((r, i) => {
            // Checked as it is typed, with the engine's own function — so a pattern that would be
            // refused on save says so now, beside the box, rather than after a round trip.
            const risk = r.kind === "pattern" && typeof r.value === "string" && r.value.trim()
              ? patternRisk(r.value)
              : null;
            const incomplete = !ruleIsComplete(r);
            return (
              <li className="cc-rules__row" key={i}>
                <span className="cc-rules__kind">{LABEL[r.kind]}</span>

                {r.kind !== "required" && (
                  <input
                    className="cc-rules__value"
                    value={
                      LIST_KINDS.has(r.kind) && Array.isArray(r.value) ? r.value.join(", ") : String(r.value ?? "")
                    }
                    placeholder={PLACEHOLDER[r.kind]}
                    aria-label={LABEL[r.kind]}
                    disabled={busy}
                    onChange={(e) =>
                      update(i, {
                        value: LIST_KINDS.has(r.kind)
                          // Split on save rather than on every keystroke, so a trailing comma while
                          // typing the next value does not produce an empty allowed value.
                          ? e.target.value.split(",").map((v) => v.trim()).filter(Boolean)
                          : e.target.value,
                      })
                    }
                  />
                )}

                <input
                  className="cc-rules__msg"
                  value={r.message ?? ""}
                  placeholder="Message (optional) — say why, not what"
                  aria-label="Message when this rule fails"
                  disabled={busy}
                  onChange={(e) => update(i, { message: e.target.value || undefined })}
                />

                <button
                  className="hk-icon-btn"
                  aria-label={`Remove the "${LABEL[r.kind]}" rule`}
                  title="Remove this rule"
                  disabled={busy}
                  onClick={() => commit(rules.filter((_, n) => n !== i))}
                >
                  <IconTrash />
                </button>

                {(risk || incomplete) && (
                  <p className="cc-rules__warn">
                    {risk ?? "This rule has no value yet, so it is not checking anything."}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="cc-rules__add">
        <Select
          label="Rule"
          value={adding}
          options={RULE_KINDS.map((k) => ({ value: k, label: LABEL[k] }))}
          onChange={setAdding}
          size="sm"
        />
        <button
          className="cc-btn cc-btn--ghost cc-btn--sm"
          disabled={busy}
          onClick={() => commit([...rules, { kind: adding }])}
        >
          <IconPlus /> <span>Rule</span>
        </button>
      </div>

      <div className="cc-field">
        <span className="cc-field__label">When a value breaks a rule</span>
        <Select
          label="When a value breaks a rule"
          value={onFail}
          options={[
            { value: "reject", label: "Refuse it", hint: "edit turned away, run's answer becomes an error" },
            { value: "warn", label: "Keep it and flag the cell", hint: "safer on a column that already has values" },
          ]}
          onChange={(v) => commit(rules, v)}
          size="sm"
        />
        <span className="cc-field__hint">
          {/* Said plainly, because this is the choice people get wrong. Switching a populated column
              to "refuse" does not go back and delete anything, so the rule and the table disagree
              from the moment it is set — "flag" is the honest setting there. */}
          Refusing applies to new values only. Turning it on will not remove values already in the
          column that break the rule, so on a column that is already full, flagging is the honest
          choice.
        </span>
      </div>
    </div>
  );
}
