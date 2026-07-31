// Checking a direct provider's key, and asking it what it serves.
//
// Both use the same endpoint — `GET /models` — for the same reason the OpenRouter key check uses
// `GET /key`: it costs nothing, returns no tokens, and answers the question before any money is at
// risk. A stored credential that does not work is worse than none, because the app then LOOKS
// configured and the failure surfaces per row, mid-run, as something that reads like an outage.
//
// ── What this deliberately does NOT do ─────────────────────────────────────────────────────────
//
// It does not return prices. OpenRouter publishes a machine-readable price sheet; none of these do —
// their rates live on a marketing page, in a table meant for a human. So a model listed here has a
// name and nothing else, and every screen showing one has to say the price is unknown rather than
// implying zero. Inventing a number here would be worse than the blank: it would flow into the cost
// estimate, the per-cell cap and the spend report, and all three would be confidently wrong.

import { LLM_PROVIDERS, llmProvider, qualifyModelId, type LlmProviderSpec } from "./registry.ts";
import { providerKeyFor } from "./resolve.ts";

export interface DirectModel {
  /** The bare id, as the provider names it. */
  id: string;
  label: string;
}

export interface KeyVerdict {
  ok: boolean;
  error?: string;
  models?: DirectModel[];
  /**
   * Set when the key could not be DISPROVED but was not confirmed either.
   *
   * Not every provider serves a model list — Perplexity does not — and refusing to save a working key
   * because the vendor lacks an endpoint we happen to use for checking would be the tool getting in
   * the way of the user for its own convenience. So the key is accepted and the screen says plainly
   * that it is unverified, rather than showing a green tick it has not earned.
   */
  unverified?: string;
}

function headersFor(spec: LlmProviderSpec, key: string): Record<string, string> {
  if (spec.kind === "anthropic") {
    return { "x-api-key": key, "anthropic-version": "2023-06-01" };
  }
  return { Authorization: `Bearer ${key}` };
}

/** Provider-shaped model lists → ours. Both shapes put the id in the same place. */
function readModels(json: any): DirectModel[] {
  const raw = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
  const out: DirectModel[] = [];
  for (const m of raw) {
    const id = typeof m === "string" ? m : m?.id ?? m?.name;
    if (!id) continue;
    out.push({ id: String(id), label: String(m?.display_name ?? m?.name ?? id) });
  }
  // Alphabetical, because these arrive in no useful order and there is no price to sort by.
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Ask a provider whether this key works, and what it serves.
 *
 * The key is passed IN rather than read from the store, so the same function checks a key that is
 * being saved and one that already was — the check before storing is the whole protection, and a
 * second code path for it is a second place for it to be skipped.
 */
export async function verifyProviderKey(
  providerId: string,
  key: string,
  timeoutMs = 15_000,
): Promise<KeyVerdict> {
  const spec = llmProvider(providerId);
  if (!spec) return { ok: false, error: `Unknown provider "${providerId}".` };
  if (!key.trim()) return { ok: false, error: `Paste your ${spec.label} key.` };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
  try {
    const res = await fetch(`${spec.baseUrl}/models`, {
      headers: headersFor(spec, key.trim()),
      signal: ac.signal,
    });

    // The one definitive answer. Everything else is inconclusive in one direction or the other.
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `${spec.label} rejected that key.` };
    }

    if (!res.ok) {
      return {
        ok: true,
        unverified:
          `${spec.label} answered ${res.status} when asked for its model list, so this key could not ` +
          `be confirmed either way. If it is wrong, runs on this provider will fail per row.`,
      };
    }

    const models = readModels(await res.json().catch(() => null));
    if (!models.length) {
      return {
        ok: true,
        unverified: `${spec.label} accepted the key but returned no model list, so models must be typed in by hand.`,
      };
    }
    return { ok: true, models };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A network failure is NOT evidence about the key, and must not be reported as a bad one — the
    // user would go and regenerate a perfectly good credential.
    return {
      ok: false,
      error: /abort|timeout/i.test(msg)
        ? `${spec.label} did not respond in time. The key was not checked.`
        : `Could not reach ${spec.label}: ${msg}. The key was not checked.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── the picker's copy ────────────────────────────────────────────────────────
//
// A model list per provider, held in memory so the picker does not make one network call per
// configured vendor every time a drawer opens. Filled when a key is saved or rechecked, and on the
// first read after a restart.
//
// Deliberately NOT persisted. A model list is small and cheap to refetch, and a stale one written to
// disk would outlive the key it came from — offering models the user can no longer reach, from a
// vendor they have since removed.

const modelCache = new Map<string, { models: DirectModel[]; at: number }>();
const MAX_AGE_MS = 30 * 60_000;

export function cacheDirectModels(providerId: string, models: DirectModel[]): void {
  modelCache.set(providerId, { models, at: Date.now() });
}

export function forgetDirectModels(providerId: string): void {
  modelCache.delete(providerId);
}

/**
 * Every model from every provider that has a key, in the shape the picker already speaks.
 *
 * `priced: false` on all of them, and that is not a placeholder to fill in later — see the note at
 * the top of this file. The picker shows "price unknown" rather than a zero, because a zero would be
 * read as free by a human and by the cost estimate alike.
 *
 * Never throws and never blocks on a slow vendor: this feeds a list that must open instantly, and a
 * provider that cannot be reached simply contributes nothing this time.
 */
export async function directModelsForPicker(): Promise<
  Array<{ id: string; name: string; provider: string; priced: false; tools: boolean }>
> {
  const configured = LLM_PROVIDERS.filter((p) => p.id !== "openrouter" && !!providerKeyFor(p));

  await Promise.all(
    configured.map(async (spec) => {
      const hit = modelCache.get(spec.id);
      if (hit && Date.now() - hit.at < MAX_AGE_MS) return;
      const key = providerKeyFor(spec);
      if (!key) return;
      const verdict = await verifyProviderKey(spec.id, key).catch(() => null);
      if (verdict?.models) cacheDirectModels(spec.id, verdict.models);
      // A failure caches NOTHING rather than caching an empty list. An empty list would be
      // indistinguishable from "this provider serves no models" and would stick for half an hour.
    }),
  );

  const out: Array<{ id: string; name: string; provider: string; priced: false; tools: boolean }> = [];
  for (const spec of configured) {
    for (const m of modelCache.get(spec.id)?.models ?? []) {
      out.push({
        // The stored form, prefixed — this is the id that goes on a column, and it has to route.
        id: qualifyModelId(spec.id, m.id),
        name: `${m.label} (${spec.label})`,
        provider: spec.id,
        priced: false,
        // Per PROVIDER, because none of these endpoints report tool support per model. A model that
        // cannot call tools fails visibly on a preview row, which is the same trade the local
        // runtimes already make.
        tools: spec.tools,
      });
    }
  }
  return out;
}
