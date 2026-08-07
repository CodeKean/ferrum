// How a currency / percent column is shown.
//
// The engine stores these as plain numbers so they sort and filter numerically; this is the display
// half — the symbol and the decimal places. Presentation only: nothing here changes a stored value,
// re-runs a row, or affects sort/filter/copy. A currency column with nothing set still reads better
// than a bare number (grouped, two decimals); it only GAINS a symbol once a code is entered, because
// defaulting the symbol to "$" would misrepresent a column of euros.

import { formatDisplay, type ValueFormat } from "@shared/valueFormat.ts";
import "./FormatFields.css";

interface Props {
  /** "currency" or "percent" — the only two types that carry a descriptor. */
  kind: "currency" | "percent";
  value: ValueFormat;
  onChange: (next: ValueFormat) => void;
  disabled?: boolean;
}

/** A representative number to preview the format against, so a choice is visible before it is saved. */
const SAMPLE = "1234.5";

export function FormatFields({ kind, value, onChange, disabled }: Props) {
  const set = (patch: Partial<ValueFormat>) => {
    const next = { ...value, ...patch };
    // Drop empty keys so an unset field stores nothing rather than an empty string the server would
    // have to clean anyway.
    if (!next.currency) delete next.currency;
    if (next.decimals == null || Number.isNaN(next.decimals)) delete next.decimals;
    onChange(next);
  };

  return (
    <div className="cc-fmt">
      <span className="cc-field__label">How it’s shown</span>

      <div className="cc-fmt__row">
        {kind === "currency" && (
          <label className="cc-fmt__field">
            <span className="cc-fmt__label">Currency</span>
            <input
              className="cc-input cc-fmt__code"
              value={value.currency ?? ""}
              disabled={disabled}
              placeholder="USD"
              maxLength={3}
              aria-label="Currency code, three letters"
              onChange={(e) => set({ currency: e.target.value.toUpperCase().replace(/[^A-Z]/g, "") || undefined })}
            />
          </label>
        )}
        <label className="cc-fmt__field">
          <span className="cc-fmt__label">Decimal places</span>
          <input
            className="cc-input cc-fmt__dec"
            type="number"
            min={0}
            max={10}
            value={value.decimals ?? ""}
            disabled={disabled}
            placeholder={kind === "currency" ? "2" : "auto"}
            aria-label="Decimal places"
            onChange={(e) => set({ decimals: e.target.value === "" ? undefined : Math.max(0, Math.min(10, Math.floor(Number(e.target.value)))) })}
          />
        </label>
      </div>

      {/* Shows the choice on a real number before it is committed — a symbol and a decimal count read
          very differently in the abstract and on "1,234.50". */}
      <p className="cc-field__hint">
        Preview: <span className="mono">{formatDisplay(SAMPLE, kind, value)}</span>
        {kind === "currency" && !value.currency && " — add a code to show a symbol"}
      </p>
    </div>
  );
}
