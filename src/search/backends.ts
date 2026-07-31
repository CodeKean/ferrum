// The adapters. One `run` per engine, all returning the same three fields.
//
// Every one of these is a POST to a fixed, known host with a key, so none of them goes through
// `safeFetch` — that guard exists to stop a MODEL choosing a URL, and nothing here is model-chosen.
// The query is, and it travels as a JSON value rather than in a path, so there is nothing for it to
// escape into.
//
// What each adapter owes the caller:
//   - hits in ranked order, url first, whatever else it has,
//   - a real `costUsd` when the response carries one, and nothing when it does not,
//   - an Error whose message does NOT contain the key.

import type { SearchBackend, SearchHit, SearchOutcome, SearchQuery } from "./types.ts";

/** Shared by every adapter: one request, a bounded body, a clear failure. */
async function post(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  q: SearchQuery,
  label: string,
): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: q.signal,
  });
  if (!res.ok) {
    // The body may echo the key back on an auth failure, so a 401/403 never repeats it. The other
    // statuses carry the useful part — a quota message, a malformed-query complaint.
    const detail = res.status === 401 || res.status === 403
      ? "the key was rejected"
      : (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`${label} search failed (${res.status}): ${detail}`);
  }
  return res.json();
}

async function get(url: string, headers: Record<string, string>, q: SearchQuery, label: string): Promise<any> {
  const res = await fetch(url, { headers, signal: q.signal });
  if (!res.ok) {
    const detail = res.status === 401 || res.status === 403
      ? "the key was rejected"
      : (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`${label} search failed (${res.status}): ${detail}`);
  }
  return res.json();
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Domain filters as Google operators, for engines that take a query string and nothing else. */
function withOperators(q: SearchQuery): string {
  const parts = [q.query];
  for (const d of q.includeDomains ?? []) parts.push(`site:${d}`);
  for (const d of q.excludeDomains ?? []) parts.push(`-site:${d}`);
  return parts.join(" ");
}

/** Google results, cheapest of the lot, and the reason this whole abstraction is worth having. */
const serper: SearchBackend = {
  id: "serper",
  async run(q, key) {
    const json = await post(
      "https://google.serper.dev/search",
      { q: withOperators(q), num: Math.max(1, Math.min(100, q.maxResults)) },
      { "X-API-KEY": key },
      q,
      "Serper",
    );
    const hits: SearchHit[] = (json?.organic ?? []).slice(0, q.maxResults).map((r: any) => ({
      url: String(r.link ?? ""),
      title: str(r.title),
      snippet: str(r.snippet),
    }));
    // Serper bills from a credit balance and reports credits used, not dollars, so there is no
    // real figure to return. The configured per-search price is what the caller falls back to.
    return { hits: hits.filter((h) => h.url) };
  },
};

/** Direct rather than through OpenRouter, so the same engine without the proxy margin. */
const exa: SearchBackend = {
  id: "exa",
  async run(q, key) {
    const body: Record<string, unknown> = {
      query: q.query,
      numResults: Math.max(1, Math.min(100, q.maxResults)),
      // The snippets are the payload. Without this Exa returns links only and the model has to
      // fetch every one of them, which costs more than the search did.
      contents: { text: { maxCharacters: 1200 } },
    };
    if (q.includeDomains?.length) body.includeDomains = q.includeDomains;
    if (q.excludeDomains?.length) body.excludeDomains = q.excludeDomains;

    const json = await post("https://api.exa.ai/search", body, { "x-api-key": key }, q, "Exa");
    const hits: SearchHit[] = (json?.results ?? []).map((r: any) => ({
      url: String(r.url ?? ""),
      title: str(r.title),
      snippet: str(r.text) ?? str(r.snippet),
    }));
    // Exa reports what the request cost. Real figure beats any configured estimate.
    const cost = Number(json?.costDollars?.total);
    return {
      hits: hits.filter((h) => h.url),
      ...(Number.isFinite(cost) ? { costUsd: cost } : {}),
    };
  },
};

const jina: SearchBackend = {
  id: "jina",
  async run(q, key) {
    // Jina's search endpoint takes the query in the path and answers with page content.
    const json = await get(
      `https://s.jina.ai/${encodeURIComponent(q.query)}`,
      { Authorization: `Bearer ${key}`, Accept: "application/json", "X-Respond-With": "no-content" },
      q,
      "Jina",
    );
    const hits: SearchHit[] = (json?.data ?? []).slice(0, q.maxResults).map((r: any) => ({
      url: String(r.url ?? ""),
      title: str(r.title),
      snippet: str(r.description) ?? str(r.content),
    }));
    return { hits: hits.filter((h) => h.url) };
  },
};

const spider: SearchBackend = {
  id: "spider",
  async run(q, key) {
    const json = await post(
      "https://api.spider.cloud/search",
      { search: withOperators(q), search_limit: Math.max(1, Math.min(50, q.maxResults)), fetch_page_content: false },
      { Authorization: `Bearer ${key}` },
      q,
      "Spider",
    );
    const rows = Array.isArray(json) ? json : (json?.content ?? json?.results ?? []);
    const hits: SearchHit[] = rows.slice(0, q.maxResults).map((r: any) => ({
      url: String(r.url ?? r.link ?? ""),
      title: str(r.title),
      snippet: str(r.description) ?? str(r.content),
    }));
    return { hits: hits.filter((h) => h.url) };
  },
};

const firecrawl: SearchBackend = {
  id: "firecrawl",
  async run(q, key) {
    const json = await post(
      "https://api.firecrawl.dev/v1/search",
      { query: withOperators(q), limit: Math.max(1, Math.min(50, q.maxResults)) },
      { Authorization: `Bearer ${key}` },
      q,
      "Firecrawl",
    );
    const hits: SearchHit[] = (json?.data ?? []).map((r: any) => ({
      url: String(r.url ?? ""),
      title: str(r.title),
      snippet: str(r.description) ?? str(r.markdown),
    }));
    return { hits: hits.filter((h) => h.url) };
  },
};

const tavily: SearchBackend = {
  id: "tavily",
  async run(q, key) {
    const body: Record<string, unknown> = {
      query: q.query,
      max_results: Math.max(1, Math.min(20, q.maxResults)),
    };
    if (q.includeDomains?.length) body.include_domains = q.includeDomains;
    if (q.excludeDomains?.length) body.exclude_domains = q.excludeDomains;

    const json = await post(
      "https://api.tavily.com/search",
      body,
      { Authorization: `Bearer ${key}` },
      q,
      "Tavily",
    );
    const hits: SearchHit[] = (json?.results ?? []).map((r: any) => ({
      url: String(r.url ?? ""),
      title: str(r.title),
      snippet: str(r.content),
    }));
    return { hits: hits.filter((h) => h.url) };
  },
};

const brave: SearchBackend = {
  id: "brave",
  async run(q, key) {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", withOperators(q));
    url.searchParams.set("count", String(Math.max(1, Math.min(20, q.maxResults))));
    const json = await get(
      url.toString(),
      { "X-Subscription-Token": key, Accept: "application/json" },
      q,
      "Brave",
    );
    const hits: SearchHit[] = (json?.web?.results ?? []).map((r: any) => ({
      url: String(r.url ?? ""),
      title: str(r.title),
      snippet: str(r.description),
    }));
    return { hits: hits.filter((h) => h.url) };
  },
};

/**
 * Every backend except OpenRouter's.
 *
 * OpenRouter is not here because it is not a search API — it is a chat call carrying a plugin, and
 * it needs a Provider rather than a key. It keeps its existing path in `tools.ts`, which is why the
 * tool takes either.
 */
export const BACKEND_IMPLS: Record<string, SearchBackend> = {
  serper, exa, jina, spider, firecrawl, tavily, brave,
};

export function backendImpl(id: string): SearchBackend | null {
  return BACKEND_IMPLS[id] ?? null;
}

export type { SearchOutcome };
