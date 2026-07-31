// The shape of an HTTP column's configuration, and its defaults.
//
// A plain module rather than part of `HttpSettings.tsx`, because this is DATA: the destination
// presets are built from it and its own tests read it, and neither of those can load a .tsx — it
// pulls in React and a stylesheet. Splitting it also stops the presets importing a component file
// just to reach a type.
//
// `HttpSettings.tsx` re-exports everything here, so every existing import keeps working.

export interface Pair { name: string; value: string }

export type BodyMode = "none" | "json" | "form" | "raw";

/**
 * What one call costs at the other end — declared by hand, because nothing else can know it.
 *
 * A model column can be priced from its token counts. An HTTP column cannot: the provider bills in
 * its own currency, on its own plan, on a page nobody here can read. So the workspace asks once —
 * "2 credits a call, 1,000 credits for $49" — and every run after that reports the real number
 * instead of $0.00, which is the answer that made a table calling a paid API look free.
 */
export interface HttpCost {
  unit: string;
  perCall: number;
  packUnits: number;
  packUsd: number;
}

export interface HttpConfig {
  cost?: HttpCost;
  method: string;
  url: string;
  query: Pair[];
  headers: Pair[];
  bodyMode: BodyMode;
  bodyFields: Pair[];
  body: string;
  responsePath: string;
  fireAndForget: boolean;
  removeEmpty: boolean;
  returnMetadata: boolean;
  followRedirects: boolean;
  maxRedirects: number;
  retryOnFailure: boolean;
  maxRetries: number;
  retryStatuses: number[];
  allowPrivate: boolean;
  timeoutMs: number;
}

export const DEFAULT_HTTP: HttpConfig = {
  method: "GET",
  url: "",
  query: [],
  headers: [],
  bodyMode: "none",
  bodyFields: [],
  body: "",
  responsePath: "",
  fireAndForget: false,
  removeEmpty: true,
  returnMetadata: false,
  followRedirects: true,
  maxRedirects: 4,
  retryOnFailure: true,
  maxRetries: 2,
  retryStatuses: [408, 425, 429, 500, 502, 503, 504],
  allowPrivate: false,
  timeoutMs: 20_000,
};