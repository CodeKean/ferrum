// Which model answers, and on whose bill.
//
// Pulled out of the cell executor because a second caller now needs exactly the same decision, and
// the decision has three parts that are easy to get subtly wrong in a copy: a local model needs no
// key, an unconfigured column must not silently land on an expensive default, and an absent key is
// an `auth` failure rather than a crash.

import { createOpenRouterProvider } from "./openrouter.ts";
import { createOpenAIProvider } from "./openai.ts";
import { createAnthropicProvider } from "./anthropic.ts";
import { createLocalProvider, parseLocalModel } from "./local.ts";
import { getProviderKey } from "./keys.ts";
import { llmProvider, splitModelId, type LlmProviderSpec } from "./registry.ts";
import { getSecretValue } from "../secrets.ts";
import { cachedModel, cachedModels, catalogLoaded } from "./catalog.ts";
import { getKv, setKv } from "../db.ts";
import type { Provider } from "./types.ts";

/**
 * The workspace's chosen default, which is what `auto` on a column actually means.
 *
 * There was no way to set this. `DEFAULT_MODEL` below is a hardcoded id, every unconfigured column
 * pointed at it, and nothing — no route, no screen — could change it. So a model running on this
 * machine could be detected, listed, and picked column by column, but could never be made the thing
 * columns use by default. On a workspace whose whole point is that the free lane should be the easy
 * one, the free lane was the only one you had to opt into a column at a time.
 */
const KEY_DEFAULT_MODEL = "run.defaultModel";

/** The stored choice, or "auto" to follow whatever the engine judges best. */
export function getDefaultModelSetting(): string {
  return getKv(KEY_DEFAULT_MODEL) ?? "auto";
}

export function setDefaultModelSetting(id: string): string {
  setKv(KEY_DEFAULT_MODEL, String(id ?? "").trim() || "auto");
  return getDefaultModelSetting();
}

/**
 * Used when nothing has chosen a model.
 *
 * The ONE declaration. A second copy in the cell executor would be read by the cost estimate while
 * the run billed the other, agreeing today and enforced by nothing. Every
 * other module imports it from here, directly or through the executor's re-export.
 *
 * Deliberately the CHEAP end, not the safe-sounding one. The previous default was gpt-4o-mini at
 * ~$0.24 per million tokens blended; this is ~$0.05, so every unconfigured column got billed almost
 * five times over for no decision anyone made. At a million rows that difference is the entire cost
 * of the sheet.
 *
 * Not the absolute cheapest on OpenRouter — there are tool-calling models at $0.014 and fifteen at
 * zero — because a default is a bet placed on the user's behalf, and betting their data quality on
 * an unfamiliar model to save four cents per million tokens is the wrong trade. Going cheaper is a
 * choice they make in the picker, seeing the price, rather than one made silently here.
 */
export const DEFAULT_MODEL = "openai/gpt-oss-20b";

/**
 * The default, unless it has been retired — in which case, the cheapest current stand-in.
 *
 * `DEFAULT_MODEL` is one hardcoded id that EVERY column set to "auto" points at. Providers retire
 * ids routinely, so the day that one goes the whole workspace breaks at once: every unconfigured
 * column, all together, and — since the run gate now refuses a retired model — refusing rather than
 * failing, which is better but no less broken.
 *
 * A hardcoded constant cannot be the only answer to a question the provider gets to change. When the
 * published list is readable and does not contain the default, this picks the cheapest priced,
 * tool-capable model on it. Tool-capable because the agent lane and every design call need a forced
 * tool call, so a default that cannot make one is a default that fails on the harder half of the app.
 *
 * Falls back to the constant whenever the list cannot be read, because an unreachable price sheet is
 * not evidence that anything was retired.
 */
export function effectiveDefaultModel(): string {
  // A chosen default wins over the built-in one. Checked for existence the same way, so picking a
  // model and then having the provider retire it degrades exactly like the hardcoded default does
  // rather than leaving the whole workspace pointed at a dead id.
  const chosen = getKv(KEY_DEFAULT_MODEL);
  if (chosen && chosen !== "auto") {
    // A local model is never in the published price list — that list is OpenRouter's. Asking whether
    // it is still "in the catalogue" would retire every local default the moment it was set.
    if (parseLocalModel(chosen)) return chosen;
    if (!catalogLoaded() || cachedModel(chosen)) return chosen;
    // Falls through: the chosen model is gone, so the stand-in logic below applies to it too.
  }

  if (!catalogLoaded()) return DEFAULT_MODEL;
  if (cachedModel(DEFAULT_MODEL)) return DEFAULT_MODEL;

  // The list is already sorted cheapest-first with unpriced entries last, so the first usable entry
  // IS the cheapest usable one.
  const stand = cachedModels().find((m) => m.priced && m.tools && m.inputPerM >= 0);
  return stand?.id ?? DEFAULT_MODEL;
}

export interface Resolved {
  provider: Provider;
  /** The id to send. A local model's id has its `local:runtime/` prefix stripped. */
  model: string;
  /** True when this runs on the user's own machine and costs nothing. */
  isLocal: boolean;
  /** Which hosted provider is being billed. "local" when nobody is. */
  providerId: string;
}

export class NoProviderError extends Error {
  readonly cls = "auth" as const;
}

/**
 * A hosted provider's key.
 *
 * OpenRouter keeps its own store — it was here first, and the setup wizard, the key check and the
 * credit readout all reach for it by name. Every other provider uses the shared secret store, the
 * same one the search backends use, so masking on read and registration with the redactor are
 * inherited rather than written a second time and forgotten in one of the two places.
 */
export function providerKeyFor(spec: LlmProviderSpec): string | null {
  if (spec.id === "openrouter") return getProviderKey("openrouter");
  const v = getSecretValue(spec.secretName);
  return v && v.trim() ? v.trim() : null;
}

export const providerHasKey = (spec: LlmProviderSpec): boolean => !!providerKeyFor(spec);

export function resolveProvider(requested?: string | null): Resolved {
  const chosen = requested && requested !== "auto" ? requested : effectiveDefaultModel();
  const local = parseLocalModel(chosen);

  // A local model needs no key and costs nothing. Requiring one here would make the only free lane
  // in the product unreachable for anyone who has not signed up to a hosted provider — which is
  // precisely the person a local runtime is for.
  if (local) {
    return {
      provider: createLocalProvider(local.runtime),
      model: local.model,
      isLocal: true,
      providerId: "local",
    };
  }

  // An id with no known prefix means OpenRouter, which is what every model id in every existing
  // workbook meant before there was a choice. Nothing stored has to be rewritten.
  const { provider: providerId, model } = splitModelId(chosen);

  if (providerId === "openrouter") {
    const apiKey = getProviderKey("openrouter");
    if (!apiKey) throw new NoProviderError("No OpenRouter key configured.");
    return { provider: createOpenRouterProvider({ apiKey }), model, isLocal: false, providerId };
  }

  const spec = llmProvider(providerId);
  // `splitModelId` only treats a KNOWN provider as a prefix, so this cannot happen from a model id.
  // It can happen from a hand-written config, and a clear message beats a crash on `spec.label`.
  if (!spec) throw new NoProviderError(`Unknown model provider: ${providerId}`);

  const apiKey = providerKeyFor(spec);
  // `NoProviderError` rather than a plain throw, because its `auth` class is the one failure that
  // stops the whole run instead of retrying. No amount of retrying conjures a key, and the
  // alternative is a million rows each failing slowly and separately.
  if (!apiKey) throw new NoProviderError(`No ${spec.label} key saved. Add one in Settings → Models.`);

  if (spec.kind === "anthropic") {
    return {
      provider: createAnthropicProvider({ apiKey, baseUrl: spec.baseUrl }),
      model,
      isLocal: false,
      providerId,
    };
  }

  return {
    provider: createOpenAIProvider({ id: spec.id, baseUrl: spec.baseUrl, apiKey }),
    model,
    isLocal: false,
    providerId,
  };
}
