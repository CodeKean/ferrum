// The catalogue of search backends, and the one place a price lives.
//
// Adding an engine is this file plus an adapter: a spec here, a `run` there, and it appears in the
// picker with its own key field and its own price. Nothing else in the product needs to know how
// many there are.

import { getKv, setKv } from "../db.ts";
import type { BackendSpec, SearchBackendId } from "./types.ts";

/**
 * Published list prices, as a starting point.
 *
 * Every one of these is a DEFAULT and is editable — see `perSearchUsd`. They are the vendors' own
 * headline rates for a small paid plan, which is what someone evaluating this will be on. Volume
 * pricing is cheaper and none of these numbers survives contact with a negotiated contract, which is
 * exactly why the budget reads the stored value rather than this table.
 *
 * A wrong number here is not a wrong bill — the real charge is used when the engine reports one, and
 * the per-cell cap is what actually bounds spend. It is the ESTIMATE that is wrong, and the screens
 * say which figure they are showing.
 */
export const BACKENDS: BackendSpec[] = [
  {
    id: "openrouter",
    label: "OpenRouter web search",
    signupUrl: "https://openrouter.ai/settings/keys",
    secretName: "OpenRouter",
    listPriceUsd: 0.005,
    priceNote: "Exa through OpenRouter, up to 10 results. Native model search is billed per model instead.",
    supportsDomainFilter: true,
    returnsContent: false,
  },
  {
    id: "serper",
    label: "Serper.dev",
    signupUrl: "https://serper.dev/api-key",
    secretName: "Serper",
    listPriceUsd: 0.001,
    priceNote: "Google results. Roughly $1 per 1,000 searches on the starter plan; cheaper in volume.",
    supportsDomainFilter: true,
    returnsContent: false,
  },
  {
    id: "exa",
    label: "Exa",
    signupUrl: "https://dashboard.exa.ai/api-keys",
    secretName: "Exa",
    listPriceUsd: 0.005,
    priceNote: "Direct rather than through OpenRouter, so no proxy margin. $5 per 1,000 searches.",
    supportsDomainFilter: true,
    returnsContent: true,
  },
  {
    id: "jina",
    label: "Jina AI",
    signupUrl: "https://jina.ai/api-dashboard/",
    secretName: "Jina",
    listPriceUsd: null,
    priceNote: "Billed in tokens from a credit balance rather than per search, so set your own figure.",
    supportsDomainFilter: false,
    returnsContent: true,
  },
  {
    id: "spider",
    label: "Spider.cloud",
    signupUrl: "https://spider.cloud/account/api-keys",
    secretName: "Spider",
    listPriceUsd: null,
    priceNote: "Credit-based and varies with what it crawls, so set your own figure.",
    supportsDomainFilter: false,
    returnsContent: true,
  },
  {
    id: "firecrawl",
    label: "Firecrawl",
    signupUrl: "https://www.firecrawl.dev/app/api-keys",
    secretName: "Firecrawl",
    listPriceUsd: null,
    priceNote: "Credit-based; one search plus scrape costs several credits. Set your own figure.",
    supportsDomainFilter: false,
    returnsContent: true,
  },
  {
    id: "tavily",
    label: "Tavily",
    signupUrl: "https://app.tavily.com/home",
    secretName: "Tavily",
    listPriceUsd: 0.008,
    priceNote: "Priced per API credit; a basic search is one credit.",
    supportsDomainFilter: true,
    returnsContent: true,
  },
  {
    id: "brave",
    label: "Brave Search",
    signupUrl: "https://api-dashboard.search.brave.com/app/keys",
    secretName: "Brave",
    listPriceUsd: 0.005,
    priceNote: "Independent index. Free tier available at one query per second.",
    supportsDomainFilter: false,
    returnsContent: false,
  },
];

const byId = new Map(BACKENDS.map((b) => [b.id, b]));

export function backendSpec(id: string): BackendSpec | null {
  return byId.get(id as SearchBackendId) ?? null;
}

// ─────────────────────────────────────────────────────────────── the editable price

const priceKey = (id: string) => `search.price.${id}`;

/**
 * What one search on this backend costs, as configured.
 *
 * The stored value wins over the list price, always — including when it is ZERO, which is a real
 * answer for a free tier and must not be read as "unset" and quietly replaced by a list price the
 * user has already told us is wrong.
 */
export function perSearchUsd(id: string): number | null {
  const raw = getKv(priceKey(id));
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return backendSpec(id)?.listPriceUsd ?? null;
}

/** Set the price for a backend. Null clears it back to the list price. */
export function setPerSearchUsd(id: string, usd: number | null): void {
  if (!backendSpec(id)) throw new Error(`Unknown search backend: ${id}`);
  if (usd == null) { setKv(priceKey(id), ""); return; }
  if (!Number.isFinite(usd) || usd < 0) throw new Error("A price has to be zero or more.");
  setKv(priceKey(id), String(usd));
}

/** True when the figure came from the user rather than from the table above. */
export function priceIsCustom(id: string): boolean {
  const raw = getKv(priceKey(id));
  return raw != null && raw !== "";
}

// ─────────────────────────────────────────────────────────────── the chosen backend

const CHOSEN = "search.backend";

/**
 * Which backend searches run through. Workspace-wide, with a per-column override.
 *
 * Defaults to OpenRouter because that is the key the app already asks for — a fresh install can
 * search without a second signup, and the cheaper engines are an upgrade rather than a prerequisite.
 */
export function chosenBackend(): string {
  const raw = String(getKv(CHOSEN) ?? "");
  // A user-described engine is as valid a choice as a built-in one. Validated by PREFIX rather than
  // against a list, because the list of custom engines lives in another module and importing it here
  // would make the registry depend on the thing that depends on it.
  if (raw.startsWith("custom:")) return raw;
  return backendSpec(raw) ? raw : "openrouter";
}

export function setChosenBackend(id: string): void {
  if (!id.startsWith("custom:") && !backendSpec(id)) throw new Error(`Unknown search backend: ${id}`);
  setKv(CHOSEN, id);
}
