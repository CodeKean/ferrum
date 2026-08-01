// Which model DESIGNS a column, as opposed to which model RUNS it.
//
// These were the same setting, and they are close to opposite decisions.
//
// The per-row model is chosen for a million calls. Every tenth of a cent matters, so the right
// instinct there is the cheapest model that can do the job — which is why the picker sorts by price
// and the default is at the cheap end.
//
// The setup model is chosen for ONE call, and the thing it produces is then applied to every row. A
// worse proposal does not cost a fraction of a cent more; it costs a million rows of wrong answers
// and the run to redo them. The right instinct is the opposite: pay for judgement, once.
//
// Sharing one setting meant those two instincts fought. Setting a column to a free rate-limited
// model to keep a big run cheap ALSO downgraded the model designing it, and the user got a worse
// column for the trouble. Setting it to something strong for a hard column made every "set it up"
// press expensive. Neither is what anyone meant.
//
// So: one workspace-level setup model, stored here, defaulting to the same id the run lane defaults
// to — the change is that the two can now diverge, not that today's behaviour moves under anyone.

import { getKv, setKv } from "../db.ts";
import { DEFAULT_MODEL, resolveProvider, type Resolved } from "../providers/resolve.ts";
import { modelPricePerMillion } from "../providers/prices.ts";
import { cachedModel, listModels } from "../providers/catalog.ts";

const KEY_MODEL = "setup.model";
const KEY_FREE_ONLY = "setup.freeOnly";

/**
 * The model that designs a column when nobody has chosen one — for DISPLAY.
 *
 * The same id the run lane falls back to, deliberately. A default that silently moved to something
 * pricier the day this setting was introduced would be a bill nobody agreed to; the point of this
 * module is that the choice becomes AVAILABLE, not that it is made for you.
 *
 * Label it, do not resolve with it. `resolveSetupProvider` passes "auto" down untouched so the
 * workspace's own chosen model is honoured; substituting this constant there is what made every
 * design call demand an OpenRouter key regardless of what had been set up.
 */
export const DEFAULT_SETUP_MODEL = DEFAULT_MODEL;

/**
 * How long a setup call may take before it is given up on.
 *
 * Much shorter than the 120s a provider allows by default. A run has a progress bar, a cancel button
 * and a reason to be patient; the setup panel has a button that says "Working…" and nothing else, so
 * two minutes of it is indistinguishable from a hang. Sixty seconds is longer than any successful
 * call observed and short enough that giving up feels like an answer.
 */
export const SETUP_TIMEOUT_MS = 60_000;

export interface SetupModelSettings {
  /** The stored id, or "auto" to follow DEFAULT_SETUP_MODEL. */
  model: string;
  /**
   * Refuse to design with anything that bills.
   *
   * A guard rather than a preference. Free models on OpenRouter are rate-limited rather than
   * crippled, and someone exploring the product — or testing it — wants a hard promise that pressing
   * "Set it up" cannot produce a charge, not an intention to pick carefully. When this is on and the
   * chosen model is not known-free, the call is refused BEFORE it is sent, with the reason.
   */
  freeOnly: boolean;
}

export function getSetupSettings(): SetupModelSettings {
  return {
    model: getKv(KEY_MODEL) ?? "auto",
    freeOnly: getKv(KEY_FREE_ONLY) === "1",
  };
}

export function setSetupSettings(next: Partial<SetupModelSettings>): SetupModelSettings {
  if (next.model !== undefined) setKv(KEY_MODEL, String(next.model).trim() || "auto");
  if (next.freeOnly !== undefined) setKv(KEY_FREE_ONLY, next.freeOnly ? "1" : "0");
  return getSetupSettings();
}

/** Thrown when free-only is on and the chosen model is not known to be free. */
export class NotFreeError extends Error {
  readonly cls = "budget" as const;
}

/**
 * Resolve the provider for a DESIGN call, enforcing free-only before anything is sent.
 *
 * The check happens here rather than in the route because there is more than one design caller —
 * the setup panel, the chat assistant and the table wizard all spend on the user's behalf without a
 * run behind them, and a guard that only one of them consults is not a guard.
 */
export async function resolveSetupProvider(): Promise<Resolved & { free: boolean }> {
  const { model, freeOnly } = getSetupSettings();

  // "auto" is handed STRAIGHT THROUGH, rather than swapped for DEFAULT_SETUP_MODEL first.
  //
  // Those are not the same thing, and the difference was the whole of a bug. `resolveProvider` only
  // consults the workspace's chosen model when it is asked for "auto"; give it a concrete id and it
  // resolves that id and nothing else. DEFAULT_SETUP_MODEL is an OpenRouter id, so substituting it
  // here sent every design call to OpenRouter no matter what the workspace had been set to.
  //
  // What that looked like: set Ferrum up with a local model, or save a key for Anthropic or OpenAI
  // directly, and the app agrees an AI is configured — columns run, the model picker lists it — but
  // the assistant, the setup panel and promote-to-rule all answer "No OpenRouter key configured."
  // Nothing on screen explains why a second, unrelated key is wanted, and the only lane the product
  // promises is free is the one that hit it hardest.
  //
  // Passing "auto" down means the setup lane follows the same setting a column does, which is what
  // the word already meant everywhere else in the app.
  const resolved = resolveProvider(model === "auto" ? null : model);

  // A model running on this machine bills nothing by construction, so free-only never blocks one —
  // and it needs no price list to prove it.
  if (resolved.isLocal) return { ...resolved, free: true };

  // The price list is loaded before the decision, not read from whatever happens to be cached.
  //
  // This is the difference between a guard and a coin toss. Prices live in a process-lifetime cache,
  // so on the first setup call after the engine starts the cache is EMPTY — and an empty cache reads
  // as "this model has no published price", which the guard below refuses. Free-only would have
  // blocked every model including free ones until something else happened to warm the cache. The
  // list needs no API key and spends nothing, so loading it here costs one request, once.
  if (freeOnly) {
    // A failure is not fatal: `cachedModel` then returns null and the refusal below explains that
    // the price could not be confirmed, which is the correct fail-closed answer rather than a crash.
    await listModels().catch(() => {});
  }

  const priced = cachedModel(resolved.model);
  const free = !!priced && priced.priced && priced.inputPerM === 0 && priced.outputPerM === 0;

  if (freeOnly && !free) {
    // Deliberately different sentences for "it costs money" and "we cannot tell whether it costs
    // money". Refusing an unpriced model looks like a bug until you are told the price list is the
    // reason, and an unpriced model is exactly where an unexpected charge would come from.
    throw new NotFreeError(
      priced
        ? `"${resolved.model}" is not a free model, and setup is set to free models only. Pick a free one in Settings, or turn that off.`
        : `The price of "${resolved.model}" is not in the model list, so it cannot be confirmed free — and setup is set to free models only. Pick a model from the list in Settings, or turn that off.`,
    );
  }

  return { ...resolved, free };
}

/**
 * Make a design call, and cope with the models that cannot be forced to answer with a tool.
 *
 * Every design surface asks for `tool_choice: "required"`, because a proposal has to come back as
 * structured settings rather than as prose. Supporting tools and ENFORCING a forced tool call are
 * two different capabilities, and the catalogue only publishes the first — so a model listed as
 * tool-capable can still refuse the request outright. Measured on `openai/gpt-oss-20b:free`:
 *
 *   503 — no online provider for model "gpt-oss-20b" advertises inference-time tool_choice
 *   enforcement
 *
 * which reached the user as "Something went wrong inside Ferrum. The details are in the server log."
 * That is the worst possible answer: nothing was wrong inside Ferrum, the fix is one dropdown away,
 * and the message sends someone to a log file to find out. Free models are the ones most likely to
 * hit it, which is exactly backwards for anyone trying to use the product without spending.
 *
 * So: ask nicely, and if the provider will not be forced, ask again without forcing. Most models
 * call the tool anyway when it is the only one offered. Only if that also comes back without a tool
 * call is it a failure, and then it is reported as a fact about the model with the fix in the
 * sentence.
 */
export async function designCall(
  provider: Resolved["provider"],
  model: string,
  req: { messages: unknown[]; tools: unknown[]; maxTokens: number; temperature: number; signal?: AbortSignal },
  toolName: string,
): Promise<{ args: Record<string, unknown>; model: string; usage: { inputTokens: number; outputTokens: number } }> {
  const send = (toolChoice: "required" | "auto") =>
    provider.chat({ model, toolChoice, ...req } as never);

  let res;
  try {
    res = await send("required");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Matched on what the provider actually says rather than on the status code: a 503 is ordinarily
    // "try again later", and retrying an unsupported capability forever is the stall this is here to
    // prevent.
    if (!/tool_choice|tool choice/i.test(msg)) throw e;
    res = await send("auto");
  }

  const call = res.toolCalls?.find((c) => c.name === toolName) ?? res.toolCalls?.[0];
  if (!call) {
    throw new Error(
      `${model} answered without filling in the settings. Some models — free ones especially — cannot ` +
        `be made to answer in a fixed shape. Pick a different model under Settings → Models → What builds columns for you, ` +
        `or describe what you want in one plain sentence and try again.`,
    );
  }
  return { args: call.args as Record<string, unknown>, model: res.model, usage: res.usage };
}

/**
 * What one design call is expected to cost, before it is made.
 *
 * An estimate from the list price and a typical setup call's shape, not a measurement. It exists
 * because "One model call" is not an amount, and a figure that appears only
 * ever shown AFTER the money was spent. Null when the model is unpriced, which the UI states rather
 * than rounding to zero.
 */
export function estimateSetupCost(modelId: string): number | null {
  const m = modelPricePerMillion(modelId);
  if (!m) return null;
  // Measured from the calls this module makes: the table description and schema dominate the input,
  // and a proposal is a few hundred tokens out. Rounded up rather than down — an estimate that
  // undershoots is the one that erodes trust.
  const INPUT_TOKENS = 3000;
  const OUTPUT_TOKENS = 700;
  return (INPUT_TOKENS * m.inputPerM) / 1e6 + (OUTPUT_TOKENS * m.outputPerM) / 1e6;
}
