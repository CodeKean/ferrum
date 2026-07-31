// The model catalogue: what you can run a column on, and what it costs.
//
// Fetched from OpenRouter's PUBLIC model list, which needs no API key and spends nothing — it is a
// price sheet, not an inference call. That matters: the app must be able to tell you what a run will
// cost before you have spent a cent, and a cost estimate that itself costs money is absurd.
//
// Prices are per-token strings in the API and are converted here to dollars per million, once, so no
// caller has to remember the unit. Getting that conversion wrong by 10^6 in either direction is the
// kind of error that makes an estimate reassuring and false.

const MODELS_URL = "https://openrouter.ai/api/v1/models";

/** Long, because a price list does not move hour to hour and a cold fetch blocks the picker. */
const TTL_MS = 6 * 60 * 60_000;

export interface CatalogModel {
  id: string;
  name: string;
  /** Dollars per million tokens. Zero when `priced` is false — read `priced`, not this. */
  inputPerM: number;
  outputPerM: number;
  /**
   * True only when BOTH token prices came back as usable numbers.
   *
   * OpenRouter publishes `-1` for its auto-routers, meaning "the price is whichever model this
   * request lands on". That is not a price and it is not zero. Everything that ranks, estimates or
   * caps must ask this question before reading the numbers above, because a missing price and a
   * genuine $0 are opposite answers and they look identical once both are stored as 0.
   */
  priced: boolean;
  /** Dollars per web search call, as published. Null when the model does not publish one. */
  webSearchPerCall: number | null;
  contextLength: number;
  /** Only tool-calling models can drive the agent lane; the plain model lane accepts any. */
  tools: boolean;
  /** A model that bills nothing. Usually rate-limited, which the UI says. */
  free: boolean;
}

interface Entry {
  models: CatalogModel[];
  fetchedAt: number;
}

let cache: Entry | null = null;
let inFlight: Promise<CatalogModel[]> | null = null;

/**
 * A published per-token price → dollars per million, or null when there is no usable price.
 *
 * Absent, non-numeric and NEGATIVE all mean "no usable price". Returning 0 for those was the bug:
 * `-1` is OpenRouter's "price varies" sentinel on the auto-routers, and read as zero it made two
 * tool-capable paid models rank as the cheapest things on the list and show an estimate of $0.00.
 * Null is the only honest answer, and every caller is forced to handle it.
 */
const perMillion = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n * 1e6 : null;
};

/** Dollars per search call. Published already in dollars, so no per-million conversion. */
const perCall = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Exported for tests: the whole price-reading decision, with no network in it. */
export function parseCatalog(payload: unknown): CatalogModel[] {
  const data = (payload as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return [];

  const out: CatalogModel[] = [];
  for (const raw of data) {
    const m = raw as Record<string, any>;
    if (typeof m?.id !== "string") continue;

    const input = perMillion(m.pricing?.prompt);
    const output = perMillion(m.pricing?.completion);
    const priced = input != null && output != null;
    out.push({
      id: m.id,
      name: typeof m.name === "string" ? m.name : m.id,
      inputPerM: input ?? 0,
      outputPerM: output ?? 0,
      priced,
      // Published per model, and it ranges from $0.0025 to $0.035 a call — nearly a factor of
      // fifteen. An estimate that assumes one flat rate is wrong by that factor on the lane that
      // spends the most.
      webSearchPerCall: perCall(m.pricing?.web_search),
      contextLength: Number(m.context_length) || 0,
      tools: Array.isArray(m.supported_parameters) && m.supported_parameters.includes("tools"),
      // Free means both prices are LITERALLY zero. An unpriced model is not free, it is unknown.
      free: priced && input === 0 && output === 0,
    });
  }

  // Cheapest first, blended 80/20 the way a column actually uses tokens: prompts are long, answers
  // are short. Ranking on input price alone would put a model with a cheap prompt and a ruinous
  // completion at the top of a list headed "cheapest".
  //
  // Unpriced models sort LAST regardless. Their blended price is 0, so left to the comparator they
  // would head a list titled "cheapest" while costing whatever the router picks.
  return out.sort((a, b) => (a.priced === b.priced ? blended(a) - blended(b) : a.priced ? -1 : 1));
}

/**
 * Dollars per million tokens at the 80% input / 20% output mix a typical column runs at.
 *
 * Zero for an unpriced model, which is why nothing may use this as a price without checking
 * `priced` first — it is a sort key, not a quote.
 */
export function blended(m: CatalogModel): number {
  return m.inputPerM * 0.8 + m.outputPerM * 0.2;
}

export async function listModels(force = false): Promise<CatalogModel[]> {
  if (!force && cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.models;
  // One fetch even under concurrent callers. Without this, opening the picker on several columns at
  // once would fire a request each.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await fetch(MODELS_URL, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const models = parseCatalog(await res.json());
      if (models.length === 0) throw new Error("The model list came back empty.");
      cache = { models, fetchedAt: Date.now() };
      return models;
    } catch (e) {
      // Serve a stale list rather than nothing. A price from this morning is a far better basis for
      // an estimate than no estimate at all, and the caller is told how old it is.
      if (cache) return cache.models;
      throw e;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export function catalogAge(): number | null {
  return cache ? Date.now() - cache.fetchedAt : null;
}

/**
 * Has the published list actually been read?
 *
 * The question every "is this model real?" check has to ask first, because `cachedModel` returns
 * null for two opposite situations: the model does not exist, and we have not looked yet. Treating
 * a cold cache as "this model was retired" would refuse every paid run for the first few seconds
 * after the engine starts, or whenever the price sheet is briefly unreachable.
 */
export function catalogLoaded(): boolean {
  return cache != null && cache.models.length > 0;
}

/**
 * The cached list, cheapest-first, or empty.
 *
 * Never a fetch — callers reach for this from synchronous paths (choosing a stand-in for a retired
 * default, checking a model still exists before a run) where a network round trip has no business
 * being. Empty means "nothing known yet", which every caller has to treat as different from
 * "nothing available".
 */
export function cachedModels(): CatalogModel[] {
  return cache?.models ?? [];
}

/**
 * Fill the price cache from a list obtained elsewhere.
 *
 * Exported for tests, which must be able to exercise the free-only guard — a decision made entirely
 * from prices — without a network call deciding whether the test passes.
 */
export function seedCatalog(models: CatalogModel[]): void {
  cache = { models, fetchedAt: Date.now() };
}

/** The one model a column falls back to. Kept here so the picker and the executor cannot disagree. */
export function findModel(models: CatalogModel[], id: string): CatalogModel | null {
  return models.find((m) => m.id === id) ?? null;
}

/**
 * A price from the cache ONLY — never a fetch.
 *
 * The per-cell budget check runs between an agent's turns, inside a synchronous callback, and must
 * not introduce a network round trip into the middle of a cell. Returns null on a cold cache, and
 * the caller treats that as "no price known" rather than as free.
 */
export function cachedModel(id: string): CatalogModel | null {
  return cache?.models.find((m) => m.id === id) ?? null;
}
