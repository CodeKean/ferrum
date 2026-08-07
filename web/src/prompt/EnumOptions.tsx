// The allowed values of an `enum` column.
//
// The enum type existed and could be picked, but its options could be set nowhere — so an enum
// column behaved exactly like a text one and the "Fix this cell" helper could diagnose a missing
// option with nowhere to put it. This is that missing editor.
//
// It is a CONTROLLED list: the parent owns `value` and saves on change, so "Saved." can stay honest
// and the server's cleaned list (dupes and blanks removed) is what comes back. Local text state
// exists only so a keystroke does not round-trip through a save on every character; a row commits its
// text on blur or Enter, and structural changes — add, remove, reorder — commit at once.

import { useEffect, useRef, useState } from "react";
import { IconCaretUp, IconCaretDown, IconTrash, IconPlus } from "../ui/Icon.tsx";
import "./EnumOptions.css";

interface Props {
  /** The stored options. The parent re-seeds this from the server's normalised answer. */
  value: string[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
}

export function EnumOptions({ value, onChange, disabled }: Props) {
  /** The list being edited. Seeded from `value`, and re-seeded when an outside change lands and no
   *  row is being typed in — the same rule the prompt field uses, so a save's cleaned list can be
   *  adopted without yanking the caret out of a row mid-word. */
  const [rows, setRows] = useState<string[]>(value);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (wrap.current?.contains(document.activeElement)) return;
    setRows(value);
  }, [value]);

  /** Commit the current rows upward. Blanks and dupes are the server's to clean; sending the raw
   *  list keeps this component from fighting the user mid-edit over a row they are still typing. */
  const commit = (next: string[]) => { setRows(next); onChange(next); };

  const editRow = (i: number, text: string) =>
    setRows((prev) => prev.map((v, j) => (j === i ? text : v)));

  const removeRow = (i: number) => commit(rows.filter((_, j) => j !== i));

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = rows.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    commit(next);
  };

  const add = () => {
    // Focus the new row so a run of options can be typed without reaching for the mouse each time.
    setRows((prev) => [...prev, ""]);
    requestAnimationFrame(() => {
      const inputs = wrap.current?.querySelectorAll<HTMLInputElement>(".cc-enum__input");
      inputs?.[inputs.length - 1]?.focus();
    });
  };

  return (
    <div className="cc-enum" ref={wrap}>
      <span className="cc-field__label">Allowed values</span>

      {rows.length > 0 && (
        <ul className="cc-enum__list">
          {rows.map((v, i) => (
            <li key={i} className="cc-enum__row">
              <input
                className="cc-input cc-enum__input"
                value={v}
                disabled={disabled}
                placeholder="an option…"
                aria-label={`Option ${i + 1}`}
                onChange={(e) => editRow(i, e.target.value)}
                onBlur={() => commit(rows)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); commit(rows); add(); }
                }}
              />
              <div className="cc-enum__ctrls">
                <button
                  className="hk-icon-btn cc-enum__btn"
                  disabled={disabled || i === 0}
                  title={i === 0 ? "Already first." : "Move up"}
                  aria-label={`Move option ${i + 1} up`}
                  onClick={() => move(i, -1)}
                ><IconCaretUp /></button>
                <button
                  className="hk-icon-btn cc-enum__btn"
                  disabled={disabled || i === rows.length - 1}
                  title={i === rows.length - 1 ? "Already last." : "Move down"}
                  aria-label={`Move option ${i + 1} down`}
                  onClick={() => move(i, 1)}
                ><IconCaretDown /></button>
                <button
                  className="hk-icon-btn cc-enum__btn cc-enum__btn--del"
                  disabled={disabled}
                  title={`Remove "${v || "this option"}"`}
                  aria-label={`Remove option ${i + 1}`}
                  onClick={() => removeRow(i)}
                ><IconTrash /></button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <button className="cc-btn cc-btn--sm cc-enum__add" onClick={add} disabled={disabled}>
        <IconPlus /> <span>Option</span>
      </button>

      <p className="cc-field__hint">
        {rows.filter((v) => v.trim()).length > 0
          ? "A run must return one of these — the model is told the list, and an answer outside it is turned away and retried. Blank and duplicate options are dropped when saved."
          : "With no options, this behaves like a plain text column. Add the values a run is allowed to return to turn it into a real choice."}
      </p>
    </div>
  );
}
