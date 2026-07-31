// Any search tool at all, described rather than coded.
//
// Seven engines ship with adapters, and there will always be an eighth. A SERP API is a small,
// predictable shape — a query goes in a request, a ranked list comes back somewhere in the JSON —
// so the ones Ferrum has not heard of do not need code, they need a description.
//
// This is deliberately the same shape as an HTTP column: a method, a URL, headers, a body built from
// named fields, `{{secret:Name}}` for credentials, and a path into the response. Anyone who has set
// up an HTTP column already knows how to add a search engine, and the security properties come
// along unchanged — a structured body is assembled as an object and serialised, so a value
// containing `","admin":true` lands inside one field rather than adding a field.
//
// The price uses the same model as an HTTP column too: what the vendor calls its units, how many go
// on one call, and what a bundle of them costs. "1,000 searches for $1" and "2 credits a call,
// 10,000 credits for $49" are the same arithmetic, and it is arithmetic this app already does.

import { getKv, setKv } from "../db.ts";
import { callCost, type HttpCost, type Pair } from "../http/httpColumn.ts";
import { getPath, toText } from "../jsonPath.ts";
import { getSecretValue, SECRET_RE } from "../secrets.ts";
import type { SearchBackend, SearchHit, SearchQuery } from "./types.ts";

export interface CustomSearchSpec {
  /** Stable id, `custom:<slug>`. Distinct from the built-ins so a name can never collide with one. */
  id: string;
  label: string;
  method: "GET" | "POST";
  /** May contain `{{query}}`, `{{maxResults}}` and `{{secret:Name}}`. */
  url: string;
  headers: Pair[];
  bodyMode: "none" | "json" | "raw";
  bodyFields: Pair[];
  body: string;
  /** Where the array of results is. Empty means the response IS the array. */
  resultsPath: string;
  /** Field names inside one result. `url` is the only one that is required. */
  urlField: string;
  titleField: string;
  snippetField: string;
  /** Where the response reports what the call cost, if it does at all. */
  costPath: string;
  cost?: HttpCost;
}

const KEY = "search.custom";

export function listCustom(): CustomSearchSpec[] {
  try {
    const raw = getKv(KEY);
    const parsed = raw ? JSON.parse(String(raw)) : [];
    return Array.isArray(parsed) ? parsed.map(normalize) : [];
  } catch {
    // A corrupt blob loses the custom engines, not the app. They are re-addable; a boot failure
    // because one field got mangled is not recoverable by anyone but me.
    return [];
  }
}

export function getCustom(id: string): CustomSearchSpec | null {
  return listCustom().find((c) => c.id === id) ?? null;
}

const slug = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "engine";

function normalize(raw: any): CustomSearchSpec {
  return {
    id: String(raw?.id ?? ""),
    label: String(raw?.label ?? "Untitled engine"),
    method: raw?.method === "GET" ? "GET" : "POST",
    url: String(raw?.url ?? ""),
    headers: Array.isArray(raw?.headers) ? raw.headers : [],
    bodyMode: raw?.bodyMode === "raw" ? "raw" : raw?.bodyMode === "none" ? "none" : "json",
    bodyFields: Array.isArray(raw?.bodyFields) ? raw.bodyFields : [],
    body: String(raw?.body ?? ""),
    resultsPath: String(raw?.resultsPath ?? ""),
    urlField: String(raw?.urlField ?? "url"),
    titleField: String(raw?.titleField ?? "title"),
    snippetField: String(raw?.snippetField ?? "snippet"),
    costPath: String(raw?.costPath ?? ""),
    ...(raw?.cost ? { cost: raw.cost } : {}),
  };
}

export function saveCustom(input: Partial<CustomSearchSpec> & { label: string }): CustomSearchSpec {
  const all = listCustom();
  const label = String(input.label ?? "").trim();
  if (!label) throw new Error("Give the engine a name.");
  if (!String(input.url ?? "").trim()) throw new Error("Give the engine a web address to call.");

  let id = input.id && input.id.startsWith("custom:") ? input.id : `custom:${slug(label)}`;
  // A new engine whose name matches an existing one gets its own id rather than overwriting it.
  if (!input.id) {
    let n = 2;
    while (all.some((c) => c.id === id)) id = `custom:${slug(label)}-${n++}`;
  }

  const spec = normalize({ ...input, id, label });
  const next = all.some((c) => c.id === id) ? all.map((c) => (c.id === id ? spec : c)) : [...all, spec];
  setKv(KEY, JSON.stringify(next));
  return spec;
}

export function deleteCustom(id: string): void {
  setKv(KEY, JSON.stringify(listCustom().filter((c) => c.id !== id)));
}

/** What one call on this engine costs, from the same unit arithmetic an HTTP column uses. */
export function customPerSearchUsd(spec: CustomSearchSpec): number | null {
  if (!spec.cost) return null;
  const { usd, units } = callCost(spec.cost);
  // Units declared without a price is a legitimate half — "this burns 2 credits" is worth knowing
  // even before what a credit costs has been filled in. It is not a price, so it is not returned as
  // one; the budget falls back and the screen says the price is unset.
  return units > 0 && usd > 0 ? usd : null;
}

type Context = "url" | "json" | "header" | "plain";

/**
 * Escape a value for where it is going.
 *
 * This is not politeness, it is the difference between working and broken — and in two of these
 * cases between working and exploitable. A query is `acme "pro" plan & pricing` often enough:
 *
 *   url    — unescaped, the space truncates the parameter and the `&` starts a new one, so the
 *            engine silently searches for "acme" and takes whatever the rest looks like as
 *            parameters of its own.
 *   json   — unescaped inside a raw body template, the quote closes the string and the rest of the
 *            query becomes JSON. That is not a formatting bug, it is a request the caller did not
 *            write.
 *   header — a newline splits one header into two, which is header injection.
 *
 * A `json` BODY FIELD needs nothing here: those are assembled as an object and serialised, so
 * `JSON.stringify` has already done it. Only the raw template is exposed.
 */
function escapeFor(value: string, ctx: Context): string {
  switch (ctx) {
    case "url": return encodeURIComponent(value);
    // Strip the quotes `stringify` adds — the template already has them around the placeholder.
    case "json": return JSON.stringify(value).slice(1, -1);
    case "header": return value.replace(/[\r\n]+/g, " ");
    default: return value;
  }
}

/**
 * Fill `{{query}}` and `{{maxResults}}`, then the secrets.
 *
 * Secrets go LAST and are never logged: the same ordering the HTTP lane uses, so everything that
 * could be recorded — a refusal, an error, a debug line — has already been built from the template
 * as written rather than from the version carrying a credential.
 *
 * Only the QUERY is escaped, and that is the point rather than an oversight. The query is the one
 * value here that Ferrum did not write — a model composes it — so it is the one that has to be
 * neutralised. A secret is configuration: it is typed in by the person running the app, and it goes
 * in raw because escaping it would break the legitimate uses. `{{secret:SearxngUrl}}/search?q=…`
 * puts a whole base URL in the template for a self-hosted instance, and URL-encoding that turns it
 * into `https%3A%2F%2F…` and calls nothing.
 *
 * Headers are the exception, and they get stripped of newlines whatever the source: a newline in a
 * header value splits one header into two no matter who put it there.
 */
function fill(text: string, q: SearchQuery, ctx: Context = "plain"): string {
  const withQuery = String(text ?? "")
    .replaceAll("{{query}}", escapeFor(q.query, ctx))
    .replaceAll("{{maxResults}}", String(q.maxResults));

  // Substituted last, and raw — see the note above on why only the query is escaped.
  //
  // An unknown name is left exactly as written, like the HTTP lane: substituting an empty string
  // sends a request with a blank credential and gets a 401 that reads as the key being wrong rather
  // than missing.
  const filled = withQuery.replace(SECRET_RE, (whole, rawName: string) =>
    getSecretValue(String(rawName).trim()) ?? whole,
  );
  return ctx === "header" ? filled.replace(/[\r\n]+/g, " ") : filled;
}

/** Turn a stored description into something the search tool can call. */
export function customBackend(spec: CustomSearchSpec): SearchBackend {
  return {
    id: "custom" as any,
    async run(q) {
      const url = fill(spec.url, q, "url");
      const headers: Record<string, string> = { Accept: "application/json" };
      for (const h of spec.headers) {
        if (!h?.name?.trim()) continue;
        headers[h.name.trim()] = fill(h.value ?? "", q, "header");
      }

      let body: string | undefined;
      if (spec.method === "POST" && spec.bodyMode !== "none") {
        if (spec.bodyMode === "json") {
          const obj: Record<string, unknown> = {};
          for (const f of spec.bodyFields) {
            if (!f?.name?.trim()) continue;
            const v = fill(f.value ?? "", q, "plain");
            // Numbers stay numbers. `"num": "5"` is rejected by several of these APIs, and the one
            // field anybody sets this way is the result count.
            obj[f.name.trim()] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
          }
          body = JSON.stringify(obj);
          headers["Content-Type"] ??= "application/json";
        } else {
          body = fill(spec.body, q, "json");
          headers["Content-Type"] ??= "application/json";
        }
      }

      const res = await fetch(url, { method: spec.method, headers, body, signal: q.signal });
      if (!res.ok) {
        // Same rule as the built-in adapters: an auth failure never repeats the body, because these
        // messages reach the model and are written onto the cell, and a 401 body routinely echoes
        // the credential straight back.
        const detail = res.status === 401 || res.status === 403
          ? "the key was rejected"
          : (await res.text().catch(() => "")).slice(0, 200);
        throw new Error(`${spec.label} search failed (${res.status}): ${detail}`);
      }

      const json = await res.json().catch(() => null);
      const rows = spec.resultsPath ? getPath(json, spec.resultsPath) : json;
      const list = Array.isArray(rows) ? rows : [];

      const hits: SearchHit[] = list.slice(0, q.maxResults).map((r) => ({
        url: toText(getPath(r, spec.urlField)) ?? "",
        title: toText(getPath(r, spec.titleField)) ?? undefined,
        snippet: toText(getPath(r, spec.snippetField)) ?? undefined,
      }));

      const reported = spec.costPath ? Number(toText(getPath(json, spec.costPath))) : NaN;
      return {
        hits: hits.filter((h) => h.url),
        ...(Number.isFinite(reported) && reported >= 0 ? { costUsd: reported } : {}),
      };
    },
  };
}

/**
 * Try a custom engine against a real query, without a column and without a run.
 *
 * The reason this exists rather than "save it and see": a search engine that returns the right
 * status and the wrong PATH produces zero results on every row, silently, and looks identical to a
 * query nobody could answer. One test call showing the parsed hits — and the raw response when the
 * path finds nothing — turns that into a two-minute fix.
 */
export async function tryCustom(spec: CustomSearchSpec, query: string): Promise<{
  hits: SearchHit[];
  costUsd?: number;
  raw?: unknown;
  error?: string;
}> {
  // Named but not saved, checked BEFORE the call rather than after.
  //
  // `fill` deliberately leaves an unknown `{{secret:Name}}` exactly as written — in the run lane that
  // is right, because substituting a blank sends an empty credential and earns a 401 that reads as
  // "your key is wrong" rather than "you have no key". But the whole point of Try is to say what is
  // wrong in words. Left to the call, this surfaces as
  // "Failed to parse URL from {{secret:SearxngUrl}}/search?q=…", which names the problem in a
  // language nobody outside this file speaks.
  const missing = missingSecrets(spec);
  if (missing.length) {
    return {
      hits: [],
      error:
        `This engine needs ${missing.length === 1 ? "a key" : "keys"} saved as ` +
        `${missing.map((n) => `"${n}"`).join(" and ")} on the Keys screen. ` +
        `Add ${missing.length === 1 ? "it" : "them"} and try again.`,
    };
  }

  try {
    const out = await customBackend(spec).run({ query, maxResults: 5 }, "");
    if (out.hits.length === 0) {
      // The response is handed back ONLY when nothing was found, which is exactly when someone needs
      // to see the shape to fix the path. On a working engine it would just be noise.
      const probe = await rawProbe(spec, query);
      return { ...out, raw: probe };
    }
    return out;
  } catch (e) {
    return { hits: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Every `{{secret:Name}}` this engine mentions that has no value saved.
 *
 * Reads the WHOLE description — url, headers, body fields and raw body — because a credential can
 * legitimately live in any of them, and checking only the header would pass an engine whose key sits
 * in the query string.
 */
function missingSecrets(spec: CustomSearchSpec): string[] {
  const whole = [
    spec.url,
    spec.body,
    ...(spec.headers ?? []).map((h) => `${h?.name ?? ""}${h?.value ?? ""}`),
    ...(spec.bodyFields ?? []).map((f) => `${f?.name ?? ""}${f?.value ?? ""}`),
  ].join("\n");

  const out: string[] = [];
  for (const m of whole.matchAll(SECRET_RE)) {
    const name = String(m[1] ?? "").trim();
    if (!name || out.includes(name)) continue;
    if (!getSecretValue(name)) out.push(name);
  }
  return out;
}

/** The unparsed response, so a wrong path can be seen rather than guessed at. */
async function rawProbe(spec: CustomSearchSpec, query: string): Promise<unknown> {
  try {
    const q: SearchQuery = { query, maxResults: 5 };
    const url = fill(spec.url, q, "url");
    const headers: Record<string, string> = { Accept: "application/json" };
    for (const h of spec.headers) if (h?.name?.trim()) headers[h.name.trim()] = fill(h.value ?? "", q, "header");
    let body: string | undefined;
    if (spec.method === "POST" && spec.bodyMode !== "none") {
      const obj: Record<string, unknown> = {};
      for (const f of spec.bodyFields) {
        if (!f?.name?.trim()) continue;
        const v = fill(f.value ?? "", q, "plain");
        obj[f.name.trim()] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
      }
      body = spec.bodyMode === "json" ? JSON.stringify(obj) : fill(spec.body, q, "json");
      headers["Content-Type"] ??= "application/json";
    }
    const res = await fetch(url, { method: spec.method, headers, body });
    return await res.json();
  } catch {
    return null;
  }
}
