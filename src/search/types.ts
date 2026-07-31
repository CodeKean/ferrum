// Search backends — one interface, many engines.
//
// OpenRouter's web plugin is the obvious way to search: the same key that reaches the model also
// searches, so setup is one field instead of two. It has two costs that only show up at scale.
//
// It is a PROXY, so you pay OpenRouter's margin on top of whatever engine ran underneath. And its
// floor is about $0.005 a search, which on the lane that runs once per row is $5 per thousand rows
// before the model has said anything. Going direct to a SERP API is several times cheaper, and that
// difference is the whole reason a research column is affordable or is not.
//
// ── Why the price is a setting and not a constant ──────────────────────────────────────────────
//
// Every backend here declares a list price, and every one of those numbers will be wrong eventually:
// vendors change rates, and a plan with volume pricing does not pay list. A hardcoded figure would
// therefore produce a per-cell budget that quietly enforces the wrong ceiling — the exact failure
// that made every search record at Exa's $0.005 whatever engine actually ran.
//
// So the list price is a DEFAULT, editable per backend, and the budget runs on whatever number the
// user has corrected it to. When a backend reports its real charge in the response, that wins over
// both — an invoice is not a thing to estimate once it has been handed to you.

/** One result. Deliberately the smallest shape every engine can fill. */
export interface SearchHit {
  url: string;
  title?: string;
  /** The extract. This is the actual payload of a search — not the engine's prose about it. */
  snippet?: string;
}

export interface SearchOutcome {
  hits: SearchHit[];
  /**
   * What this call really cost, when the engine says so. Undefined otherwise, and the caller falls
   * back to the configured per-call price.
   */
  costUsd?: number;
}

export interface SearchQuery {
  query: string;
  maxResults: number;
  /** Restrict to these domains, where the backend supports it. */
  includeDomains?: string[];
  excludeDomains?: string[];
  signal?: AbortSignal;
}

export interface SearchBackend {
  id: SearchBackendId;
  run(q: SearchQuery, key: string): Promise<SearchOutcome>;
}

export const SEARCH_BACKEND_IDS = [
  "openrouter", "serper", "exa", "jina", "spider", "firecrawl", "tavily", "brave",
] as const;
export type SearchBackendId = (typeof SEARCH_BACKEND_IDS)[number];

export interface BackendSpec {
  id: SearchBackendId;
  label: string;
  /** Where to get a key. Shown next to the field, because "paste your key" without a link is a wall. */
  signupUrl: string;
  /**
   * The name of the secret holding this backend's key, in the shared store.
   *
   * Reusing `src/secrets.ts` rather than inventing a second place for keys: it already masks on
   * read, registers values with the redactor so they cannot surface in an error message, and stores
   * the file at 0600. A second key store would be a second one of those to get right.
   */
  secretName: string;
  /**
   * Published list price per search, in dollars. A DEFAULT, not a fact — see the header.
   *
   * Null where the vendor prices by credits or by plan rather than per call, in which case the user
   * has to supply the figure before a budget can mean anything, and the UI asks for it.
   */
  listPriceUsd: number | null;
  /** What the price note should say — the plan it assumes, so a wrong number is recognisable. */
  priceNote: string;
  supportsDomainFilter: boolean;
  /** True when the engine returns page CONTENT rather than just links and snippets. */
  returnsContent: boolean;
}
