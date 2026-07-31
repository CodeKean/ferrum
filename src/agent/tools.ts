// The tools a research agent gets.
//
// The list is short on purpose. Every tool is a capability someone can try to talk the model into
// using, so the question for each is not "is this useful?" but "what does it cost us if a fetched
// page successfully asks for it?". There is no shell, no filesystem, no sub-agent spawning — a
// research agent looks things up.
//
// Tools are enabled per column by EXACT NAME. Enabling a provider never implies enabling everything
// that provider can do.

import { safeFetch, BlockedUrlError } from "./safeFetch.ts";
import { webPlugin, searchCostUsd, DEFAULT_SEARCH_SETTINGS, type WebSearchSettings } from "../providers/openrouter.ts";
import type { Provider } from "../providers/types.ts";
import type { SearchBackend, SearchHit } from "../search/types.ts";
import type { AgentTool } from "./loop.ts";
import { sanitize } from "./loop.ts";

/**
 * HTML → readable text.
 *
 * Not for tidiness: raw HTML is mostly markup, and a model paying per token to read `<div class=...>`
 * is paying for nothing. Scripts and styles are dropped entirely — a page's inline JS is both the
 * least useful part and a convenient place to hide an instruction.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export interface FetchToolOptions {
  maxBytes?: number;
  timeoutMs?: number;
  /** Cap on what one page contributes to the transcript. */
  maxChars?: number;
}

export function fetchUrlTool(opts: FetchToolOptions = {}): AgentTool {
  const maxChars = opts.maxChars ?? 12_000;

  return {
    name: "fetch_url",
    description:
      "Fetch a public web page or JSON API and return its readable text. Use this to look something " +
      "up on a company's own site. Only public http(s) URLs work.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL" },
      },
      required: ["url"],
    },

    async run(args, ctx) {
      const url = String(args.url ?? "").trim();
      if (!url) return "Error: no url given.";

      try {
        const res = await safeFetch(url, {
          maxBytes: opts.maxBytes ?? 512 * 1024,
          timeoutMs: opts.timeoutMs ?? 20_000,
          signal: ctx.signal,
        });

        if (res.status >= 400) {
          // Returned, not thrown: a 404 is information. The model should try another path rather
          // than have the cell fail.
          return `HTTP ${res.status} for ${res.url}. The page may not exist.`;
        }

        const isJson = /json/i.test(res.contentType);
        const body = isJson ? res.body : htmlToText(res.body);

        // Page content is untrusted input. It goes through the same sanitizer as row values, so a
        // page cannot smuggle in delimiters or invisible instruction text.
        const clean = sanitize(body, maxChars);

        return [
          `Fetched ${res.url} (${res.status}, ${res.contentType || "unknown type"})`,
          res.truncated || body.length > maxChars ? "[content truncated]" : "",
          "",
          clean || "[the page had no readable text]",
        ].filter(Boolean).join("\n");
      } catch (e) {
        if (e instanceof BlockedUrlError) {
          ctx.onDenied?.({ id: "", name: "fetch_url", args }, e.why);
          // The model is told plainly rather than left guessing, but the reason is deliberately
          // generic — a precise "that resolves to 10.0.0.5" is a network-mapping oracle.
          return `Refused: that URL is not a public web address.`;
        }
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };
}

export interface SearchToolOptions {
  /**
   * OpenRouter's plugin path. Used only when `backend` is absent.
   *
   * A cheap model is right here — the payload is the citations, not prose.
   */
  provider?: Provider;
  model?: string;
  /**
   * A direct SERP backend — Serper, Exa, Jina, Spider, Firecrawl, Tavily, Brave.
   *
   * Takes precedence over `provider`. This is how the per-cell price gets under the OpenRouter
   * floor: going direct removes the proxy margin, and the cheapest of these is around a fifth of it.
   */
  backend?: SearchBackend;
  /** The key for that backend, out of the shared secret store. Never logged. */
  backendKey?: string;
  /**
   * What one search on this engine costs, when the engine does not report it.
   *
   * Supplied by the caller from the registry, where it is a user-editable setting, because a
   * hardcoded rate is how every search came to be recorded at Exa's price whatever ran.
   */
  perSearchUsd?: number;
  /** Whatever the column configured. Defaults fill anything left unset. */
  settings?: Partial<WebSearchSettings>;
  /** Reports what the search cost, so a run's spend includes it rather than under-counting. */
  onCost?: (usd: number) => void;
  /**
   * The most this ONE CELL may spend on searching, in dollars. Zero or undefined means no cap.
   *
   * Separate from the cell's overall budget, and from the turn limit, because neither bounds this.
   * A turn cap counts CALLS; the loop's budget is checked between turns and stops the whole cell.
   * Searching is the only thing in the product with a flat per-call price high enough that one
   * extra call matters, and it is the thing a model will do repeatedly if you let it.
   */
  maxSpendUsd?: number;
  /**
   * Hard ceiling on searches per cell, whatever they cost.
   *
   * Belt as well as braces: `maxSpendUsd` cannot bound a search whose price the provider does not
   * report, and an unpriced search must not become an unlimited one.
   */
  maxSearches?: number;
}

/**
 * Web search, via the model provider rather than a second vendor.
 *
 * Running the model locally does not give you search — a local model has no connection to anything.
 * Search means querying a search engine, which normally means a second account and a second key
 * (Brave, Serper, Tavily). OpenRouter's web plugin removes that: the same key that reaches the model
 * also searches, so Ferrum asks the user to configure exactly one thing.
 *
 * It is a TOOL rather than the `:online` suffix because `:online` searches on every call in the
 * loop. As a tool it fires when the model decides it needs to look something up.
 */
/** OpenRouter's plugin path: a chat call whose citations ARE the results. */
async function viaOpenRouter(
  opts: SearchToolOptions,
  query: string,
  settings: WebSearchSettings,
  signal?: AbortSignal,
): Promise<{ hits: SearchHit[]; cost?: number }> {
  if (!opts.provider) throw new Error("No search provider configured.");
  const res = await opts.provider.chat({
    model: opts.model ?? "",
    // The plugin searches BEFORE the model answers, so the prompt just has to be the query. The
    // answer we want is in the citations, not in whatever the model says about them.
    messages: [{ role: "user", content: query }],
    plugins: [webPlugin(settings)],
    maxTokens: 64,
    signal,
  });
  return {
    hits: (res.citations ?? []).map((c) => ({ url: c.url, title: c.title, snippet: c.content })),
    ...(res.usage.costUsd != null ? { cost: res.usage.costUsd } : {}),
  };
}

/** A plain SERP endpoint: a query in, a ranked list out. */
async function viaBackend(
  opts: SearchToolOptions,
  query: string,
  settings: WebSearchSettings,
  signal?: AbortSignal,
): Promise<{ hits: SearchHit[]; cost?: number }> {
  const { backend, backendKey } = opts;
  if (!backend) throw new Error("No search backend configured.");
  if (!backendKey) {
    // Named, so the fix is one step rather than a hunt through settings.
    throw new Error(`No API key saved for ${backend.id}. Add one in Settings → Search.`);
  }
  const out = await backend.run(
    {
      query,
      maxResults: settings.maxResults,
      includeDomains: settings.includeDomains,
      excludeDomains: settings.excludeDomains,
      signal,
    },
    backendKey,
  );
  return { hits: out.hits, ...(out.costUsd != null ? { cost: out.costUsd } : {}) };
}

export function webSearchTool(opts: SearchToolOptions): AgentTool {
  const settings = { ...DEFAULT_SEARCH_SETTINGS, ...opts.settings };

  /**
   * The configured price for whatever engine this is, used when the engine does not report one.
   *
   * Reads through to the registry rather than assuming Exa: a Serper search costs a fifth of what
   * the old hardcoded figure claimed, and a budget enforced against the wrong number is not a
   * budget. Falls back to the published OpenRouter rate only when there is nothing better.
   */
  const listPrice = (): number =>
    opts.perSearchUsd ?? searchCostUsd(settings.maxResults);

  // Per CELL, because the tool is built per cell. Closed over rather than passed around, so the
  // budget cannot be reset by anything that happens inside the loop.
  let spent = 0;
  let searches = 0;
  /** What the last search actually cost, used to predict the next one. */
  let lastCost: number | null = null;

  /**
   * Refuse the SEARCH, never the row.
   *
   * The distinction that makes this safe: this returns a normal tool result, the same as "no results
   * found" does. The loop carries on, the model takes another turn, and it still calls `finish` and
   * produces a properly structured answer. Nothing is aborted mid-flight, so there is no truncated
   * or half-parsed output — that failure belongs to the loop's own budget, which stops the cell and
   * reports an error saying so.
   *
   * What this CAN produce is worse than gibberish and quieter: a model that answers confidently
   * with no evidence, which is the silent wrong value the model lanes are warned about everywhere
   * else in this product. So the message does not merely say "stop" — it says what to do instead,
   * in the only terms that reliably work on a model, which is telling it that not knowing is an
   * acceptable answer and guessing is not.
   */
  const refuse = (why: string): string =>
    `${why} Do not search again for this row. Answer using what you have already found. If that is ` +
    `not enough to answer, say so plainly and report that the value could not be found — do not ` +
    `guess, and do not infer a plausible-looking answer from nothing.`;

  return {
    name: "web_search",
    description:
      "Search the web and get back a list of pages with short extracts. Use this when you do not " +
      "already know which page holds the answer. If you know the URL, use fetch_url instead — it is " +
      "free and returns the whole page.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "What to search for, in plain words" } },
      required: ["query"],
    },

    async run(args, ctx) {
      const query = String(args.query ?? "").trim();
      if (!query) return "Error: no query given.";

      // Checked BEFORE the call, which is the only place it can save anything: a search is billed
      // the moment it runs, so a limit tested afterwards is a report, not a limit.
      if (opts.maxSearches != null && searches >= opts.maxSearches) {
        return refuse(
          `This row has used its ${opts.maxSearches} allowed ${opts.maxSearches === 1 ? "search" : "searches"}.`,
        );
      }
      /**
       * Refused BEFORE the spend, not after it.
       *
       * "Stop once you have spent the budget" is not a ceiling — it lets the call that crosses the
       * line through, so a $0.003 budget bought two $0.0025 searches and charged $0.005. A limit you
       * can exceed by one of the most expensive units in the product is a suggestion.
       *
       * So the next search is priced before it runs, from what the last one actually cost, and
       * refused if it would take the cell over.
       *
       * The FIRST search is always allowed. A budget below the price of a single search would
       * otherwise disable the lane silently — the column would return nothing on every row and look
       * broken rather than capped, which is the failure this was explicitly asked not to have. One
       * search happens, its real price is recorded, and the screens say what it was.
       */
      if (opts.maxSpendUsd != null && opts.maxSpendUsd > 0 && searches > 0) {
        const expected = lastCost ?? listPrice();
        if (spent + expected > opts.maxSpendUsd) {
          return refuse(
            `This row has spent $${spent.toFixed(4)} of its $${opts.maxSpendUsd.toFixed(4)} search allowance, ` +
            `and another search would take it over.`,
          );
        }
      }

      try {
        /**
         * One of two paths, and only one of them is a search API.
         *
         * OpenRouter's web search is a CHAT call carrying a plugin — the results come back as
         * citations on a message. Everything else is a plain SERP endpoint that takes a query and
         * answers with a list. They are different enough that pretending otherwise would mean
         * wrapping a chat provider in a fake search interface, so the tool takes either and this is
         * the only place that knows which it has.
         */
        const { hits, cost } = opts.backend
          ? await viaBackend(opts, query, settings, ctx.signal)
          : await viaOpenRouter(opts, query, settings, ctx.signal);

        searches++;
        /**
         * What it ACTUALLY cost, when the engine says.
         *
         * Not `searchCostUsd()` unconditionally, which is Exa's published rate charged for every
         * search whatever engine ran. That records a native search on a cheap model at twice its
         * price and one on an expensive model at a seventh of it, so on the costliest lane in the
         * product the number in the usage log is a guess wearing a decimal point.
         *
         * Order of trust: the reported charge, then the price configured for this backend, then the
         * published list rate. Each step down is less certain and the screens say which one they are
         * showing. It is a floor rather than a quote, which is what the estimate always claimed.
         */
        const charged = cost ?? listPrice();
        spent += charged;
        lastCost = charged;
        opts.onCost?.(charged);

        if (hits.length === 0) {
          // Distinguished from an error: "nothing found" is a real answer, and treating it as a
          // failure would make the model retry a search that will return nothing again.
          return `No results for "${sanitize(query, 200)}".`;
        }

        return [
          `${hits.length} result(s) for "${sanitize(query, 200)}":`,
          "",
          ...hits.map((h, i) =>
            [
              `${i + 1}. ${sanitize(h.title ?? h.url, 200)}`,
              `   ${h.url}`,
              h.snippet ? `   ${sanitize(h.snippet, 700)}` : "",
            ].filter(Boolean).join("\n"),
          ),
        ].join("\n");
      } catch (e) {
        // Caught for the same reason fetch_url catches: a failed tool is not a failed cell, the model
        // gets to try something else. And it is caught HERE rather than in the loop because the loop
        // writes a raw error string into the transcript — which would make a provider's error body
        // the one piece of outside content that reaches the model without passing sanitize().
        return `Error: ${sanitize(e instanceof Error ? e.message : String(e), 500)}`;
      }
    },
  };
}

export interface ToolsetOptions extends FetchToolOptions {
  /** Omit to build a toolset with no search — fetch_url alone needs no key and costs nothing. */
  search?: SearchToolOptions;
}

/**
 * Registry, so a column stores tool NAMES and the executor resolves them.
 *
 * A MAP rather than an object literal, and that is the allowlist working as written. Looking a name
 * up on a plain object also answers for everything `Object.prototype` carries: `"toString"` returned
 * a function whose result — the string `"[object Object]"` — is truthy and went into the toolset as a
 * nameless entry the provider then rejects, `"constructor"` produced an empty object the same way,
 * and `"__proto__"` threw outright. A Map has no inherited keys, so an unknown name is simply
 * unknown.
 */
export function buildToolset(names: string[], opts: ToolsetOptions = {}): AgentTool[] {
  const available = new Map<string, () => AgentTool | null>([
    ["fetch_url", () => fetchUrlTool(opts)],
    // Requesting search without a configured provider yields no tool rather than a broken one, so a
    // column authored on a configured machine degrades instead of failing on one that is not.
    ["web_search", () => (opts.search ? webSearchTool(opts.search) : null)],
  ]);
  const out: AgentTool[] = [];
  for (const n of names) {
    const make = available.get(n);
    // An unknown name is dropped rather than throwing: a column referencing a tool from an older
    // build should degrade to a narrower agent, not a broken one.
    const tool = make?.();
    if (tool) out.push(tool);
  }
  return out;
}
