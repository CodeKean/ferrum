// What a model costs, when nobody will tell us automatically.
//
// ── Why this exists ────────────────────────────────────────────────────────────────────────────
//
// OpenRouter publishes a machine-readable price sheet, so a column running through it is estimated,
// billed and capped without anyone typing a number. No other vendor does: Anthropic, OpenAI, Google,
// Mistral and the rest put their rates on a web page meant for a human, and none of them return a
// cost with the response.
//
// Treating that as a hard limit — no estimate, no spend, no per-cell cap — is unnecessary, because
// the answer is already built elsewhere: the HTTP column asks the user to declare what a call costs,
// and the search backends reuse the same
// calculator. A price the user copies once off the vendor's pricing page is a real price. It makes
// the estimate real, the spend report real, and the per-cell limit enforceable.
//
// So this is the same idea in the shape token pricing actually comes in.
//
// ── Why it is per million, with a unit switch ──────────────────────────────────────────────────
//
// Every vendor publishes "$3.00 per million input tokens" or "$0.003 per thousand". Same number, two
// scales, and converting by hand is exactly where a factor of a thousand gets lost — on a million-row
// column that is the difference between $20 and $20,000. So the scale is picked, not assumed.

import { getKv, kvRows, setKv } from "../db.ts";
import { splitModelId } from "./registry.ts";
import { cachedModel } from "./catalog.ts";

/** The scale a vendor quotes at. Both appear on real pricing pages. */
export type PriceScale = 1_000 | 1_000_000;

export interface ModelPrice {
  /** What the user typed, at the scale they chose. */
  input: number;
  output: number;
  /**
   * Cached input, where the vendor charges less for a repeated prompt.
   *
   * Worth its own field rather than folding into input: on this app's workload the same instruction
   * is sent a million times, so the cache rate is most of the bill, and treating a cached token as a
   * full-price one overstates a large column by roughly ten times.
   */
  cachedInput?: number;
  scale: PriceScale;
  /** Free text, so the screen can show where the number came from and when. */
  note?: string;
  updatedAt: string;
}

/** Dollars per million tokens — the one internal form, so nothing downstream has to know the scale. */
export interface PerMillion {
  inputPerM: number;
  outputPerM: number;
  cachedPerM: number;
  /** Where the number came from. Shown, because a typed price and a published one are not the same. */
  source: "published" | "typed";
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/**
 * The key a price is stored under.
 *
 * Two levels, and the more specific wins. A provider-wide price is the common case — somebody using
 * one Anthropic model types one pair of numbers — but a workspace mixing Haiku and Opus needs them
 * apart, and Opus is roughly fifteen times the price of Haiku. One shared number there would not be
 * an approximation, it would be wrong in whichever direction the cheaper model ran.
 */
const providerKey = (provider: string) => `price.provider.${provider}`;
const modelKey = (provider: string, model: string) => `price.model.${provider}/${model}`;

function read(key: string): ModelPrice | null {
  const raw = getKv(key);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as ModelPrice;
    // A stored scale that is neither is treated as per-million rather than rejected: refusing to
    // price would silently disable the cap, and per-million is the form every vendor leads with.
    const scale: PriceScale = p.scale === 1_000 ? 1_000 : 1_000_000;
    return { ...p, scale, input: num(p.input), output: num(p.output), cachedInput: p.cachedInput == null ? undefined : num(p.cachedInput) };
  } catch {
    // A corrupt entry must not wedge every run. It reads as "no price typed", which fails closed
    // wherever a cap is set rather than pricing at zero.
    return null;
  }
}

/** Per-million, from whatever scale it was typed at. */
export function toPerMillion(p: ModelPrice): PerMillion {
  // Normalised HERE, not only on the way out of storage. A price object also arrives straight from a
  // request body, and trusting `scale` verbatim turns an unexpected value into a silent multiplier —
  // a scale of 7 would price everything at 142,857× the rate rather than failing.
  const scale: PriceScale = Number(p.scale) === 1_000 ? 1_000 : 1_000_000;
  const factor = 1_000_000 / scale;
  return {
    inputPerM: p.input * factor,
    outputPerM: p.output * factor,
    // Absent means "not discounted", so cached tokens bill at the full input rate. Assuming a
    // discount nobody stated would understate the bill, which is the wrong direction to be wrong in.
    cachedPerM: (p.cachedInput ?? p.input) * factor,
    source: "typed",
  };
}

/** The price a user typed for this exact model, or for its provider. Null when neither exists. */
export function typedPrice(modelId: string): ModelPrice | null {
  const { provider, model } = splitModelId(modelId);
  return read(modelKey(provider, model)) ?? read(providerKey(provider));
}

/**
 * What this model costs per million tokens — published if there is one, typed if there is not.
 *
 * THE one place that answers this. Every estimate, every spend record and the per-cell cap read it,
 * so a price typed once works everywhere at once rather than in whichever screens remembered to look.
 *
 * Null means genuinely unknown, and every caller treats that as a reason to stop or to report a
 * blank — never as zero. A missing price read as free is a cap that never fires.
 */
export function modelPricePerMillion(modelId: string): PerMillion | null {
  // The published sheet wins. It is updated without anyone doing anything, and a number typed months
  // ago against a rate that has since changed should not override today's real one.
  const published = cachedModel(modelId);
  if (published?.priced) {
    return {
      inputPerM: published.inputPerM,
      outputPerM: published.outputPerM,
      // The catalogue does not break out a cache rate, so this matches the behaviour already in
      // place for OpenRouter rather than inventing a discount.
      cachedPerM: published.inputPerM,
      source: "published",
    };
  }
  const typed = typedPrice(modelId);
  return typed ? toPerMillion(typed) : null;
}

/** Cost of one call's tokens, or null when the price is unknown. */
export function priceTokens(
  modelId: string,
  u: { inputTokens: number; outputTokens: number; cachedInputTokens?: number },
): number | null {
  const p = modelPricePerMillion(modelId);
  if (!p) return null;
  // Cached tokens are counted at the cache rate and NOT again as input. Providers report them as a
  // subset of the input count, so adding both would bill the same tokens twice.
  const cached = Math.min(num(u.cachedInputTokens), num(u.inputTokens));
  const fresh = num(u.inputTokens) - cached;
  return (fresh * p.inputPerM + cached * p.cachedPerM + num(u.outputTokens) * p.outputPerM) / 1e6;
}

export interface SavePrice {
  /** A provider id ("anthropic") for a provider-wide price. */
  provider: string;
  /** A bare model id for a price that applies to just that model. Blank for provider-wide. */
  model?: string;
  input: number;
  output: number;
  cachedInput?: number;
  scale: PriceScale;
  note?: string;
}

export function savePrice(input: SavePrice): ModelPrice {
  const provider = String(input.provider ?? "").trim();
  if (!provider) throw new Error("Which provider is this price for?");
  const model = String(input.model ?? "").trim();

  const scale: PriceScale = Number(input.scale) === 1_000 ? 1_000 : 1_000_000;
  const price: ModelPrice = {
    input: num(input.input),
    output: num(input.output),
    cachedInput: input.cachedInput == null || input.cachedInput === ("" as unknown) ? undefined : num(input.cachedInput),
    scale,
    note: String(input.note ?? "").trim().slice(0, 200) || undefined,
    updatedAt: new Date().toISOString(),
  };

  // Both zero is not a price, it is an empty form. Stored, it would read as "this model is free" and
  // make a per-cell limit pass every row while the real bill accumulated.
  if (price.input === 0 && price.output === 0) {
    throw new Error("Put in at least one rate — a price of zero would report every run as free.");
  }

  setKv(model ? modelKey(provider, model) : providerKey(provider), JSON.stringify(price));
  return price;
}

export function deletePrice(provider: string, model?: string): void {
  const m = String(model ?? "").trim();
  setKv(m ? modelKey(provider, m) : providerKey(provider), "");
}

/** Every price typed for one provider: the provider-wide one, and any per-model overrides. */
export function pricesFor(provider: string): {
  provider: ModelPrice | null;
  models: Array<{ model: string; price: ModelPrice }>;
} {
  const prefix = `price.model.${provider}/`;
  const models: Array<{ model: string; price: ModelPrice }> = [];
  for (const { key } of kvRows(prefix)) {
    const price = read(key);
    if (price) models.push({ model: key.slice(prefix.length), price });
  }
  models.sort((a, b) => a.model.localeCompare(b.model));
  return { provider: read(providerKey(provider)), models };
}
