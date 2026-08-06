// What a directly-bought model costs, copied off the vendor's pricing page.
//
// The same shape as the HTTP column's cost calculator and the search backends' — declare the rate
// once, and everything downstream becomes real: the estimate before a run, the spend afterwards, and
// the per-cell dollar limit, which cannot be enforced against a price nobody knows.
//
// The one thing this screen must get right is the SCALE. Vendors quote "$3.00 per million tokens"
// and "$0.003 per thousand" interchangeably; they are the same rate, and mistaking one for the other
// is a factor of a thousand. On a million-row column that is $20 against $20,000. So the scale is a
// visible control rather than an assumption, and the effective per-million rate is echoed back under
// the fields as you type — the number you can check against the page you copied it from.

import { useEffect, useState } from "react";
import { api, type ModelPrice, type ProviderPrices } from "../api.ts";
import { Select, SAVING_REASON } from "../ui/Select.tsx";
import { IconAlert, IconCheck, IconTrash } from "../ui/Icon.tsx";
import "./PriceForm.css";

const SCALES = [
  { value: "1000000", label: "per 1M tokens" },
  { value: "1000", label: "per 1K tokens" },
];

/** Dollars per million, from whatever scale was typed. Mirrors toPerMillion on the engine side. */
const perM = (v: string, scale: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n * (1_000_000 / scale) : 0;
};

/**
 * Two decimals is not enough here.
 *
 * At the per-1K scale a real rate is $0.015, and `toFixed(2)` renders that as "$0.01" — the echo line
 * exists precisely so a mistyped rate is caught by eye, and it cannot do that while silently
 * rounding a third of the number away. Anything under a dollar gets four places.
 */
const money = (n: number): string =>
  n === 0 ? "$0" : n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;

interface Props {
  providerId: string;
  providerLabel: string;
}

export function PriceForm({ providerId, providerLabel }: Props) {
  const [prices, setPrices] = useState<ProviderPrices | null>(null);
  const [model, setModel] = useState("");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [cached, setCached] = useState("");
  const [scale, setScale] = useState(1_000_000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = async () => {
    try { setPrices(await api.llmPrices(providerId)); } catch { /* the form still works without it */ }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [providerId]);

  const inPerM = perM(input, scale);
  const outPerM = perM(output, scale);
  const cachedPerM = cached.trim() ? perM(cached, scale) : inPerM;

  // Deliberately no "and a million rows would cost $X" line here. That number depends on the prompt,
  // the record and the turn count, and the run estimate already works it out from all three — a
  // second figure computed from a guessed token shape would disagree with it, and the user would
  // have no way to tell which one was lying.

  const save = async () => {
    setBusy(true);
    try {
      const r = await api.saveLlmPrice(providerId, {
        model: model.trim(),
        input: Number(input) || 0,
        output: Number(output) || 0,
        cachedInput: cached.trim() === "" ? "" : Number(cached),
        scale: scale === 1_000 ? 1000 : 1000000,
      });
      setPrices(r.prices);
      setMsg({ kind: "ok", text: model.trim() ? `Saved for ${model.trim()}.` : `Saved for every ${providerLabel} model.` });
      setModel(""); setInput(""); setOutput(""); setCached("");
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };

  const remove = async (m?: string) => {
    setBusy(true);
    try {
      const r = await api.deleteLlmPrice(providerId, m);
      setPrices(r.prices);
      setMsg({ kind: "ok", text: "Removed." });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };

  const row = (label: string, p: ModelPrice, onDelete: () => void) => {
    const f = 1_000_000 / (p.scale === 1000 ? 1000 : 1_000_000);
    return (
      <li key={label} className="cc-price__saved">
        <span className="cc-price__savedname">{label}</span>
        <span className="cc-price__savedrate">
          {money(p.input * f)} in · {money(p.output * f)} out
          {p.cachedInput != null && <> · {money(p.cachedInput * f)} cached</>}
          <span className="cc-price__per"> per 1M</span>
        </span>
        <button className="cc-btn cc-btn--danger" onClick={onDelete} disabled={busy} aria-label={`Remove the price for ${label}`}>
          <IconTrash />
        </button>
      </li>
    );
  };

  const hasAny = !!prices?.provider || !!prices?.models.length;

  return (
    <div className="cc-price">
      <p className="cc-price__lede">
        {providerLabel} does not publish a rate Ferrum can read. Copy it off their pricing page once
        and the cost estimate, the spend report and any per-cell limit all start working.
      </p>

      {hasAny && (
        <ul className="cc-price__list">
          {prices?.provider && row(`Every ${providerLabel} model`, prices.provider, () => void remove())}
          {prices?.models.map((m) => row(m.model, m.price, () => void remove(m.model)))}
        </ul>
      )}

      <div className="cc-price__grid">
        <label className="cc-set__field cc-price__wide">
          <span className="cc-set__label">
            Model
            <span className="cc-set__sub"> — leave blank to price every {providerLabel} model the same</span>
          </span>
          <input
            className="cc-input"
            value={model}
            spellCheck={false}
            placeholder={`every ${providerLabel} model`}
            onChange={(e) => setModel(e.target.value)}
            aria-label="Model this price applies to"
          />
        </label>

        <label className="cc-set__field">
          <span className="cc-set__label">Input</span>
          <input
            className="cc-input" inputMode="decimal" value={input} placeholder="3.00"
            onChange={(e) => setInput(e.target.value)} aria-label="Input price"
          />
        </label>

        <label className="cc-set__field">
          <span className="cc-set__label">Output</span>
          <input
            className="cc-input" inputMode="decimal" value={output} placeholder="15.00"
            onChange={(e) => setOutput(e.target.value)} aria-label="Output price"
          />
        </label>

        <label className="cc-set__field">
          <span className="cc-set__label">
            Cached input
            <span className="cc-set__sub"> — optional</span>
          </span>
          <input
            className="cc-input" inputMode="decimal" value={cached} placeholder="same as input"
            onChange={(e) => setCached(e.target.value)} aria-label="Cached input price"
          />
        </label>

        <div className="cc-set__field">
          <span className="cc-set__label">Quoted</span>
          <Select
            label="Quoted"
            value={String(scale)}
            options={SCALES}
            disabled={busy}
            disabledReason={SAVING_REASON}
            onChange={(v) => setScale(Number(v))}
            size="sm"
            // The field already carries the "Quoted" heading above it; repeating it on the trigger
            // would say the same word twice and eat width the option label needs.
            showLabel={false}
          />
        </div>
      </div>

      {/* Echoed back as you type. The whole point of the scale control is that a mistake here is a
          factor of a thousand, and the only way to catch one is to see the converted number next to
          the page it was copied from. */}
      {(input.trim() || output.trim()) && (
        <p className="cc-price__echo">
          That is <strong>{money(inPerM)}</strong> per million input tokens
          {" and "}<strong>{money(outPerM)}</strong> per million output
          {cached.trim() && <>, cached at <strong>{money(cachedPerM)}</strong></>}.
          {" "}Check that against their pricing page before you save it.
        </p>
      )}

      <div className="cc-set__row">
        <button
          className="cc-btn cc-btn--primary"
          onClick={() => void save()}
          disabled={busy || (!input.trim() && !output.trim())}
        >
          {busy ? "Saving…" : "Save price"}
        </button>
      </div>

      <div className="cc-price__msg" role="status" aria-live="polite">
        {msg?.kind === "err" && <span className="cc-set__err"><IconAlert /> {msg.text}</span>}
        {msg?.kind === "ok" && <span className="cc-set__ok"><IconCheck /> {msg.text}</span>}
      </div>
    </div>
  );
}
