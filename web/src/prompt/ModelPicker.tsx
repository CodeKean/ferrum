// Which model a column runs on, and what it costs.
//
// Sorted cheapest first, deliberately. A picker ordered by popularity or by vendor teaches you
// nothing about the decision you are making; ordered by price, the consequence of scrolling down is
// the point. The default sits near the top rather than at a comfortable mid-range, because an
// unconfigured column should cost the least, not the most defensible-sounding.
//
// Prices come from OpenRouter's public list, which costs nothing to read — so this screen can tell
// you what a run will cost before a cent has been spent. The list itself is fetched by
// `useModelCatalog`, shared with the cost estimate, so the two cannot price the same column
// differently.

import { blended, useModelCatalog, type CatalogModel } from "./models.ts";
import { Select } from "../ui/Select.tsx";
import "./ModelPicker.css";

export type { CatalogModel } from "./models.ts";
export { blended } from "./models.ts";

/**
 * A local model is priced "on this Mac/PC", not "free".
 *
 * Both bill nothing, and calling them the same thing would be misleading in opposite directions: a
 * hosted free model is rate-limited by someone else, and a local one is limited by your own GPU. The
 * label names which constraint you are taking on.
 */
const price = (m: CatalogModel) =>
  m.local ? "on device" : m.free ? "free" : `$${blended(m) < 1 ? blended(m).toFixed(3) : blended(m).toFixed(2)}/M`;

interface Props {
  /** The column's stored model, or "auto" to follow the engine default. */
  value: string;
  /** Only tool-calling models can drive a web-searching column. */
  toolsRequired: boolean;
  onChange: (modelId: string) => void;
  busy?: boolean;
  /**
   * Replaces the "Engine default" option with an explicit OFF, and its value becomes "off".
   *
   * For the second picker on the Model tab, where following the engine default makes no sense: a
   * cheap-first model is either chosen or absent, and "default" would be a third state meaning
   * neither.
   */
  offLabel?: string;
  /** The caption above the control. Defaults to "Model". */
  label?: string;
}

export function ModelPicker({ value, toolsRequired, onChange, busy, offLabel, label = "Model" }: Props) {
  const { models, defaultModel, loading, error } = useModelCatalog();

  // A web-searching column needs tool calling; filtering here rather than letting a run fail per row
  // on a model that cannot call a tool at all.
  const usable = toolsRequired ? models.filter((m) => m.tools) : models;
  const chosen = usable.find((m) => m.id === value) ?? null;
  const fallback = usable.find((m) => m.id === defaultModel) ?? null;

  /**
   * Why the stored model is not among the options — null when it is.
   *
   * Leaving it out was silent in the worst way: `Select` falls back to its first option, so on the
   * web-search lane the picker showed "Engine default" while the column went on storing and running
   * a model that cannot call tools. Every row of a paid run fails, and the confirmation prices a
   * different model from the one on screen. The stored value is therefore ALWAYS an option, flagged
   * with the reason it cannot be used.
   */
  const stored = models.find((m) => m.id === value) ?? null;
  const strandedReason: "loading" | "unpriced" | "no-tools" | "unknown" | null =
    value === "auto" || value === "off" || chosen ? null
      : loading ? "loading"
        : error ? "unpriced"
          : stored ? "no-tools"
            : "unknown";

  const strandedOption =
    strandedReason === "loading" ? { value, label: value, hint: "checking…" }
      : strandedReason === "unpriced" ? { value, label: `${value} — price list unavailable`, hint: "?" }
        : strandedReason === "no-tools" ? { value, label: `${stored!.name} — cannot search the web`, hint: "unusable" }
          : strandedReason === "unknown" ? { value, label: `${value} — not in the price list`, hint: "unusable" }
            : null;

  /**
   * Grouped, because the list is ~300 long and only one group is the interesting one.
   *
   * A model on this machine is the whole free-lane argument, and flat-sorted by price it landed
   * among a hundred hosted free models with nothing to distinguish it — findable only by knowing its
   * name already. Given its own heading at the top it is the first thing you see. The order WITHIN
   * each group is left exactly as the catalogue gave it, which is cheapest-first.
   */
  const group = (m: CatalogModel) => (m.local ? "On this machine" : m.free ? "Free, hosted" : "Paid");

  const options = [
    ...(strandedOption ? [strandedOption] : []),
    // Either "follow the engine default" or an explicit OFF — never both. On the cheap-first picker
    // a default makes no sense: the model is either chosen or absent, and a third state meaning
    // "whatever the workspace says" would be a way to spend without naming what you are spending on.
    offLabel
      ? { value: "off", label: offLabel, hint: "free" }
      : {
          value: "auto",
          label: fallback ? `Engine default — ${fallback.name}` : "Engine default",
          hint: fallback ? price(fallback) : undefined,
        },
    ...usable.map((m) => ({ value: m.id, label: m.name, hint: price(m), group: group(m) })),
  ];

  return (
    // A <div>, not a <label>. A <button> is a labelable element, so a wrapping label forwards every
    // click in its whole box — caption, price, hint and all — to the trigger, and the dropdown opens
    // when you click near it rather than on it. The Select names itself instead.
    <div className="cc-field cc-modelpick">
      <span className="cc-field__label">
        {label}
        {/* The price of what is actually selected, right where the choice is made.
            OFF is not "the default's price": on the cheap-first picker, off means this step does not
            happen at all, and borrowing the default's rate would put a price on nothing. */}
        <span className="cc-field__sub mono">
          {chosen ? price(chosen)
            : offLabel ? "off"
              : fallback ? `${price(fallback)} (default)` : "—"}
        </span>
      </span>

      <Select
        label={label}
        value={value}
        options={options}
        size="md"
        showLabel={false}
        onChange={onChange}
      />

      {/* Loading, empty and failed are three different things, and collapsing them into one leaves a
          successful fetch that returned nothing usable left "Loading the model list…" on screen
          forever, with nothing saying what had actually happened. */}
      <span className="cc-field__hint">
        {error
          ? "The price list could not be loaded, so costs cannot be estimated. The engine default still runs."
          : loading
            ? "Loading the model list…"
            : usable.length === 0
              ? toolsRequired
                ? "The list came back with no model that can call tools, which a web-searching column needs. Check the engine's provider key, or switch this column to reading the row on the Mode tab."
                : "The list came back empty, so there is nothing to pick. The engine default still runs; check the engine's provider key if this does not clear."
              : toolsRequired
                ? `Cheapest first. ${usable.length} models here can call tools, which a web-searching column needs. A free model bills nothing but is rate-limited, so a large run through one is slow rather than cheap.`
                : `Cheapest first, out of ${usable.length}. Price is per million tokens, blended for how a column actually reads and writes.`}
      </span>

      {/* The stored value cannot run here, and saying so is the whole point — silence meant a paid
          run that failed on every row. */}
      {(strandedReason === "no-tools" || strandedReason === "unknown") && (
        <span className="cc-modelpick__warn" role="alert">
          {strandedReason === "no-tools"
            ? `${stored!.name} cannot call tools, so it cannot search the web. Every row of this column would fail. Pick another model above, or set this column back to reading the row on the Mode tab.`
            : `${value} is not in the price list, so this column cannot be costed and the run will be blocked before it starts. Pick one from the list above.`}
        </span>
      )}

      {/* The honest trade, stated where it is chosen. "Free" alone reads as strictly better, and a
          user who picks it for a million rows on that basis discovers the catch a day later. */}
      {chosen?.local && (
        <span className="cc-modelpick__warn" role="status">
          Runs on this machine: nothing is sent anywhere and nothing is billed. It is slower per row
          than a hosted model, so a very large column is a long wait rather than a big bill — and the
          machine needs to stay awake for it.
          {toolsRequired && " Web search still goes through OpenRouter, so that part is not free."}
        </span>
      )}

      {chosen && !chosen.free && !chosen.local && fallback && blended(chosen) > blended(fallback) * 4 && (
        <span className="cc-modelpick__warn" role="status">
          About {Math.round(blended(chosen) / blended(fallback))}x the price of the default. Worth it
          when the column needs the judgement; expensive when it does not.
        </span>
      )}
      {busy && <span className="cc-field__hint">Saving…</span>}
    </div>
  );
}
