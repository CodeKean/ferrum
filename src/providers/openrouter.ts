// OpenRouter.
//
// The default provider, and for most users the only one they need to configure: one key reaches
// every major model AND web search, so Ferrum does not have to ask for a second vendor's key just
// to let an agent look something up.
//
// There is no separate adapter class — OpenRouter is OpenAI-compatible, so this is the OpenAI
// adapter with the right base URL, the attribution headers OpenRouter asks for, and knowledge of the
// one field that is theirs alone (the `web` plugin).

import { createOpenAIProvider } from "./openai.ts";
import type { Provider } from "./types.ts";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterConfig {
  apiKey: string;
  /** Shown on OpenRouter's leaderboards; harmless, and it identifies our traffic if we ever need to. */
  appName?: string;
  timeoutMs?: number;
}

export function createOpenRouterProvider(cfg: OpenRouterConfig): Provider {
  return createOpenAIProvider({
    id: "openrouter",
    baseUrl: OPENROUTER_BASE_URL,
    apiKey: cfg.apiKey,
    timeoutMs: cfg.timeoutMs,
    // The one host that reports what a call actually billed, which is the only way to know what a
    // web search cost — a flat per-call charge that appears in no token count.
    reportsCost: true,
    headers: {
      "HTTP-Referer": "https://github.com/athm793/ferrum",
      "X-Title": cfg.appName ?? "Ferrum",
    },
  });
}

/** Search backends OpenRouter can use. They differ in what they support — see ENGINE_SUPPORT. */
export const SEARCH_ENGINES = ["auto", "native", "exa", "firecrawl", "parallel", "perplexity"] as const;
export type SearchEngine = (typeof SEARCH_ENGINES)[number];

export type SearchContextSize = "low" | "medium" | "high";

export interface WebSearchSettings {
  /** "auto" leaves it to OpenRouter: the model's own search if it has one, otherwise Exa. */
  engine: SearchEngine;
  maxResults: number;
  /** Restrict results to these domains. Wildcards (`*.substack.com`) and paths (`acme.com/blog`). */
  includeDomains: string[];
  excludeDomains: string[];
  /** How much page content the model's OWN search pulls back. Native engines only. */
  contextSize: SearchContextSize | null;
  /** Overrides the instruction prepended to the results. Blank uses OpenRouter's default. */
  searchPrompt: string;
  /**
   * The two per-cell ceilings, read by `searchBudgetUsd` and `maxSearchesFor` in the executor.
   *
   * Optional on purpose, and absent is not the same as zero. Absent means "never set, use the
   * default"; zero means "the user turned the ceiling off". Storing a number for the absent case
   * would make the defaults unreachable and silently pin every existing column to whatever this
   * build happens to ship.
   *
   * Not part of `webPlugin`'s payload — they govern how many times we call the search, not how the
   * search behaves once called.
   */
  maxSpendUsd?: number;
  maxSearches?: number;
}

export const DEFAULT_SEARCH_SETTINGS: WebSearchSettings = {
  engine: "auto",
  maxResults: 5,
  includeDomains: [],
  excludeDomains: [],
  contextSize: null,
  searchPrompt: "",
};

/**
 * Which settings each engine actually honours.
 *
 * This exists so the UI can say so. A control that is visible, changeable, and silently ignored by
 * the selected backend is the same defect as a button wired to nothing — worse here, because the
 * user would believe their results were filtered when they were not, and act on the output.
 */
export const ENGINE_SUPPORT: Record<SearchEngine, { domains: "both" | "include-only" | "exclusive" | "none"; contextSize: boolean }> = {
  auto:       { domains: "both",         contextSize: false },
  exa:        { domains: "both",         contextSize: false },
  // "native" means the model provider's own search, so support depends on which model is selected:
  // Anthropic and xAI accept include OR exclude but not both, Google filters not at all, OpenAI
  // takes include only. "exclusive" is the safe description of that spread.
  native:     { domains: "exclusive",    contextSize: true },
  firecrawl:  { domains: "both",         contextSize: false },
  parallel:   { domains: "both",         contextSize: false },
  perplexity: { domains: "both",         contextSize: false },
};

/**
 * Build the plugin block.
 *
 * Deliberately NOT applied to every request in an agent loop, and not via the `:online` model
 * suffix. Both make the provider search on EVERY call — an eight-turn loop would run eight searches
 * at $0.005 each, most of them re-searching what it already had. Attaching it to a single
 * deliberate call, from a tool the model chooses to use, is the same capability at a fraction of
 * the cost.
 *
 * Empty and default values are OMITTED rather than sent as empty arrays or blank strings. An empty
 * `include_domains: []` is ambiguous — "no restriction" and "restrict to nothing" look identical on
 * the wire, and which one a backend picks is not ours to guess.
 */
export function webPlugin(settings: Partial<WebSearchSettings> = {}): Record<string, unknown> {
  const s = { ...DEFAULT_SEARCH_SETTINGS, ...settings };
  const plugin: Record<string, unknown> = { id: "web", max_results: s.maxResults };

  if (s.engine !== "auto") plugin.engine = s.engine;
  if (s.includeDomains.length) plugin.include_domains = s.includeDomains;
  if (s.excludeDomains.length) plugin.exclude_domains = s.excludeDomains;
  if (s.searchPrompt.trim()) plugin.search_prompt = s.searchPrompt.trim();
  // Native-only, and nested one level deeper than the rest of the plugin's options.
  if (s.contextSize && (s.engine === "native" || s.engine === "auto")) {
    plugin.web_search_options = { search_context_size: s.contextSize };
  }

  return plugin;
}

export interface KeyCheck {
  ok: boolean;
  error?: string;
  /** OpenRouter's own label for the key, so the UI can show which key is in use. */
  label?: string;
  /** Remaining credit, when OpenRouter reports a limit. Null means no limit is set on the key. */
  remainingUsd?: number | null;
  usageUsd?: number;
  /** True when the key is restricted to free models — an agent column would fail on every row. */
  freeTierOnly?: boolean;
}

/**
 * Verify a key before trusting it.
 *
 * Uses `GET /key`, which costs nothing and returns no tokens — the same reasoning as the Claude
 * canary: a stored credential that does not work is worse than none, because the UI then looks
 * configured and the failure surfaces per row, mid-run, as something that reads like an outage.
 *
 * It also answers a question the Claude canary could not: how much credit is left. A run of ten
 * thousand agent cells against $2 of credit fails two thirds of the way through, and knowing the
 * balance up front turns that into a warning before anything is spent.
 */
export async function checkKey(apiKey: string, timeoutMs = 15_000): Promise<KeyCheck> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
  try {
    const res = await fetch(`${OPENROUTER_BASE_URL}/key`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ac.signal,
    });
    const text = await res.text();

    if (res.status === 401 || res.status === 403) return { ok: false, error: "OpenRouter rejected that key." };
    if (!res.ok) return { ok: false, error: `OpenRouter returned ${res.status}: ${text.slice(0, 200)}` };

    let json: any;
    try { json = JSON.parse(text); } catch { return { ok: false, error: "OpenRouter returned an unreadable response." }; }

    const d = json?.data ?? {};
    const limit = d.limit == null ? null : Number(d.limit);
    const usage = Number(d.usage ?? 0);

    return {
      ok: true,
      label: d.label ? String(d.label) : undefined,
      usageUsd: usage,
      remainingUsd: limit == null ? null : Math.max(0, limit - usage),
      freeTierOnly: !!d.is_free_tier,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: /abort|timeout/i.test(msg) ? "OpenRouter did not respond in time." : `Could not reach OpenRouter: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Domains the user typed → the form the API takes. Rejects the ones that would silently misbehave. */
function cleanDomains(input: unknown, field: string): string[] {
  if (input == null) return [];
  const list = Array.isArray(input) ? input : String(input).split(/[\s,]+/);
  const out: string[] = [];
  for (const raw of list) {
    let d = String(raw).trim().toLowerCase();
    if (!d) continue;
    // People paste URLs. Taking "https://acme.com/pricing" literally as a domain matches nothing and
    // looks like the filter is broken, so the host (and any path) is extracted instead.
    d = d.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
    if (!/^[a-z0-9*.\-]+(\.[a-z0-9*\-]+)+(\/.*)?$/.test(d)) {
      throw new Error(`"${raw}" does not look like a domain — use acme.com, *.acme.com or acme.com/blog.`);
    }
    if (!out.includes(d)) out.push(d);
  }
  if (out.length > 50) throw new Error(`Too many entries in ${field} (max 50).`);
  return out;
}

/**
 * Validate and normalize settings arriving from the UI.
 *
 * Throws rather than coercing. A silently clamped value is worse than a rejected one here: the user
 * sees the number they typed, the API receives something else, and the search behaves in a way that
 * matches neither.
 */
export function normalizeAgentSettings(input: any): { search: WebSearchSettings } {
  const s = input?.search ?? {};

  const engine = String(s.engine ?? "auto") as SearchEngine;
  if (!(SEARCH_ENGINES as readonly string[]).includes(engine)) {
    throw new Error(`Unknown search engine "${engine}".`);
  }

  const maxResults = Number(s.maxResults ?? 5);
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) {
    throw new Error("Results per search must be a whole number between 1 and 50.");
  }

  const contextSize = s.contextSize == null || s.contextSize === "" ? null : String(s.contextSize);
  if (contextSize && !["low", "medium", "high"].includes(contextSize)) {
    throw new Error(`Unknown context size "${contextSize}".`);
  }

  const includeDomains = cleanDomains(s.includeDomains, "included domains");
  const excludeDomains = cleanDomains(s.excludeDomains, "excluded domains");
  const both = includeDomains.filter((d) => excludeDomains.includes(d));
  if (both.length) {
    // Left to the backend this resolves differently per engine. Better to refuse than to guess.
    throw new Error(`"${both[0]}" is in both the include and exclude lists.`);
  }

  const search: WebSearchSettings = {
    engine,
    maxResults,
    includeDomains,
    excludeDomains,
    contextSize: contextSize as SearchContextSize | null,
    searchPrompt: String(s.searchPrompt ?? "").slice(0, 2000),
  };

  // The two ceilings, carried only when the caller actually sent them.
  //
  // They were missing from this function while the editor offered both controls and the executor
  // read both — so every save round-tripped through here and came back without them, and the form
  // re-seeded from the answer and visibly reverted. A control that cannot be saved is worse than no
  // control: it says the ceiling is yours to set and then quietly keeps its own.
  const spend = s.maxSpendUsd;
  if (spend !== undefined && spend !== null && spend !== "") {
    const v = Number(spend);
    if (!Number.isFinite(v) || v < 0) {
      throw new Error("The most a cell may spend on searches must be zero or more.");
    }
    search.maxSpendUsd = v;
  }

  const searches = s.maxSearches;
  if (searches !== undefined && searches !== null && searches !== "") {
    const v = Number(searches);
    if (!Number.isInteger(v) || v < 0 || v > 16) {
      throw new Error("Searches per cell must be a whole number between 0 and 16.");
    }
    search.maxSearches = v;
  }

  return { search };
}

/**
 * What one search costs, for the estimate shown before a run.
 *
 * Exa's published rate: $0.005 for up to 10 results, $0.001 for each beyond. Other engines price
 * differently — native search is billed by the model provider and Firecrawl draws on its own
 * credits — so this is a floor for those, not a quote, and the UI says "est." accordingly.
 */
export function searchCostUsd(maxResults: number): number {
  return 0.005 + Math.max(0, maxResults - 10) * 0.001;
}
