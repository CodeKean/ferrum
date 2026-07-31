// Provider presets — a starting point, never a special kind of step.
//
// Picking "Prospeo work email" fills in an ORDINARY API step: a URL, a header holding a saved key,
// the fields to send, and where in the reply the answer is. You can then edit every part of it, or
// delete half and keep the rest. Nothing here is privileged; a preset and a step you typed yourself
// are the same object by the time it is saved.
//
// WHY THIS IS DATA AND NOT CODE. Same trade the search engines took. A vendor that changes its
// response shape is then a one-line data fix rather than a release, a vendor nobody here has heard of
// is reachable on day one, and the app's vocabulary stays "call an API" rather than becoming a list
// of companies that has to be maintained forever.
//
// THREE HONESTY RULES, because a wrong preset costs the user money on every row:
//
//   1. Every entry is written from the provider's PUBLISHED documentation, and the docs URL is on the
//      entry so it can be checked rather than trusted.
//   2. A price is only filled in where the provider publishes a per-call rate. Where it is a plan, a
//      bundle or a credit whose value depends on the tier, the price is NULL and the editor says "no
//      price set" out loud. A plausible-looking number here would be a fabricated cost in a total
//      someone approves a spend against.
//   3. The key is a `{{secret:Name}}` reference, never a place to paste the key itself. Keys live in
//      the key store, and a preset that invited a paste into a column config would put credentials in
//      the sheet's own data.
//
// `{{col:NAME}}` placeholders are left for the user to point at their own columns — the preset cannot
// know which column holds the email, and guessing would produce a request that silently sends blanks.

import type { StepKind, WaterfallStep } from "@shared/waterfall.ts";

export interface Preset {
  id: string;
  name: string;
  /** What it returns, in the words someone searching for it would use. */
  finds: string;
  kind: StepKind;
  /** Published per-call price, or null where the provider only prices by plan or credit bundle. */
  costUsd: number | null;
  /** So a wrong entry can be checked against the source rather than argued about. */
  docs: string;
  config: Record<string, unknown>;
}

/** An HTTP step, with this app's own defaults for everything the preset does not set. */
function http(over: Record<string, unknown>): Record<string, unknown> {
  return {
    httpConfig: {
      method: "POST",
      url: "",
      query: [],
      headers: [],
      bodyMode: "json",
      bodyFields: [],
      body: "",
      responsePath: "",
      fireAndForget: false,
      removeEmpty: true,
      returnMetadata: false,
      followRedirects: true,
      maxRedirects: 4,
      retryOnFailure: true,
      // 429 is the one that matters on a paid provider: a rate limit is a "come back", not a miss,
      // and treating it as a miss would fall through to the next provider and pay twice.
      retryStatuses: [408, 429, 500, 502, 503, 504],
      maxRetries: 2,
      timeoutMs: 20_000,
      allowPrivate: false,
      ...over,
    },
  };
}

export const PRESETS: Preset[] = [
  {
    id: "prospeo-email",
    name: "Prospeo — work email",
    finds: "work email from a LinkedIn URL or a name and domain",
    kind: "http",
    // Prospeo prices by credit bundle rather than per call, and the value of a credit depends on the
    // plan — so there is no honest per-row number to put here.
    costUsd: null,
    docs: "https://prospeo.io/api/email-finder",
    config: http({
      url: "https://api.prospeo.io/email-finder",
      headers: [{ key: "X-KEY", value: "{{secret:Prospeo}}" }, { key: "Content-Type", value: "application/json" }],
      bodyFields: [{ key: "first_name", value: "{{col:First name}}" }, { key: "last_name", value: "{{col:Last name}}" }, { key: "company", value: "{{col:Domain}}" }],
      responsePath: "response.email",
    }),
  },
  {
    id: "prospeo-mobile",
    name: "Prospeo — mobile number",
    finds: "mobile phone from a LinkedIn URL",
    kind: "http",
    costUsd: null,
    docs: "https://prospeo.io/api/mobile-finder",
    config: http({
      url: "https://api.prospeo.io/mobile-finder",
      headers: [{ key: "X-KEY", value: "{{secret:Prospeo}}" }, { key: "Content-Type", value: "application/json" }],
      bodyFields: [{ key: "url", value: "{{col:LinkedIn}}" }],
      responsePath: "response.raw_format",
    }),
  },
  {
    id: "betterenrich-work-email",
    name: "BetterEnrich — work email",
    finds: "work email from a name and a company domain",
    kind: "http",
    costUsd: null,
    docs: "https://docs.betterenrich.com",
    config: http({
      url: "https://api.betterenrich.com/v1/enrichment/find-work-email",
      headers: [{ key: "X-API-KEY", value: "{{secret:BetterEnrich}}" }, { key: "Content-Type", value: "application/json" }],
      bodyFields: [{ key: "first_name", value: "{{col:First name}}" }, { key: "last_name", value: "{{col:Last name}}" }, { key: "domain", value: "{{col:Domain}}" }],
      responsePath: "data.email",
    }),
  },
  {
    id: "betterenrich-verify",
    name: "BetterEnrich — verify an email",
    finds: "whether an address is deliverable",
    kind: "http",
    costUsd: null,
    docs: "https://docs.betterenrich.com",
    config: http({
      url: "https://api.betterenrich.com/v1/enrichment/verify-email",
      headers: [{ key: "X-API-KEY", value: "{{secret:BetterEnrich}}" }, { key: "Content-Type", value: "application/json" }],
      bodyFields: [{ key: "email", value: "{{col:Email}}" }],
      responsePath: "data.status",
    }),
  },
  {
    id: "hunter-email",
    name: "Hunter — work email",
    finds: "work email from a name and a company domain",
    kind: "http",
    costUsd: null,
    docs: "https://hunter.io/api-documentation/v2#email-finder",
    config: http({
      method: "GET",
      url: "https://api.hunter.io/v2/email-finder",
      query: [
        { key: "domain", value: "{{col:Domain}}" },
        { key: "first_name", value: "{{col:First name}}" },
        { key: "last_name", value: "{{col:Last name}}" },
        { key: "api_key", value: "{{secret:Hunter}}" },
      ],
      bodyMode: "none",
      responsePath: "data.email",
    }),
  },
  {
    id: "hunter-verify",
    name: "Hunter — verify an email",
    finds: "whether an address is deliverable",
    kind: "http",
    costUsd: null,
    docs: "https://hunter.io/api-documentation/v2#email-verifier",
    config: http({
      method: "GET",
      url: "https://api.hunter.io/v2/email-verifier",
      query: [{ key: "email", value: "{{col:Email}}" }, { key: "api_key", value: "{{secret:Hunter}}" }],
      bodyMode: "none",
      responsePath: "data.status",
    }),
  },
  {
    id: "guess-pattern",
    name: "Guess from the company pattern",
    finds: "an address built from the names — free, and worth trying first",
    kind: "script",
    costUsd: 0,
    docs: "",
    // Left for the user to write, because the pattern is theirs. The point of shipping it as a preset
    // is that a FREE first step is the single biggest saving in any email waterfall, and nobody thinks
    // to add one unless it is offered beside the paid providers.
    config: {},
  },
  {
    id: "ask-a-model",
    name: "Ask a model",
    finds: "anything a model can work out from the row",
    kind: "ai",
    costUsd: null,
    docs: "",
    config: {},
  },
  {
    id: "agent-look",
    name: "Send an agent to look",
    finds: "anything that needs the web read rather than recalled",
    kind: "agent",
    costUsd: null,
    docs: "",
    config: { allowedTools: ["fetch_url", "web_search"] },
  },
];

/** A preset as a step. The id is replaced by the caller so two of the same preset can coexist. */
export function presetStep(presetId: string): WaterfallStep {
  const p = PRESETS.find((x) => x.id === presetId);
  if (!p) {
    // Cannot happen from the UI, which only offers ids from this list — but a step defaulting to
    // something plausible would be worse than an obvious blank one.
    return { id: presetId, name: presetId, kind: "http", enabled: true, config: {}, costUsd: null };
  }
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    enabled: true,
    config: p.config,
    costUsd: p.costUsd,
  };
}
