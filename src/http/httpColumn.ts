// HTTP columns, and outbound webhooks.
//
// These are the same machinery pointed two ways. An HTTP column CALLS an API and keeps what comes
// back; a webhook column SENDS a row somewhere and keeps only whether it landed. Building them twice
// would mean two interpolators, two SSRF stories and two sets of escaping bugs.
//
// `kind: "http"` has been in the type union and in PER_CELL_KINDS since the first phase with no
// executor behind it — so an HTTP column enqueued jobs that could only fail. This is that executor.
//
// ── The rule that matters most ────────────────────────────────────────────────────────────────
// ROW DATA IS NEVER TRUSTED. A cell can contain anything: a quote, a newline, a brace, a full JSON
// document, an attacker's payload from a scraped page. It is interpolated into a URL, a header and a
// JSON body, and each of those has a DIFFERENT escaping rule. Using one for all three is how a
// company name with an ampersand silently truncates a query string, and how a value containing `"}`
// rewrites the body it was meant to sit inside.

import { safeFetch } from "../agent/safeFetch.ts";
import { getPath } from "../jsonPath.ts";
import { escapeFor, type EscapeContext } from "./escape.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A name/value pair in a query string, a header, or a structured body. */
export interface Pair { name: string; value: string }

/**
 * How the body is built.
 *
 * `json` and `form` build the body from NAMED FIELDS rather than from a text template, and that is
 * the security-relevant difference: a structured body is assembled as an object and serialised, so a
 * row value containing `","admin":true` lands as a string inside one field instead of adding a field.
 * `raw` keeps the text template for the cases structure cannot express, and is escaped per context.
 */
export type BodyMode = "none" | "json" | "form" | "raw";

/**
 * What one call costs somewhere else.
 *
 * The engine cannot know this: the money leaves an account it has no visibility into, priced in a
 * unit the provider invented — credits, enrichments, lookups, requests. So the totals for a table
 * that uses an enrichment API were honest about the model spend and silently reported the third-party
 * half as zero, which is the worst kind of wrong for a cost figure. It is not an estimate that is
 * missing, it is a whole column of the bill.
 *
 * Declared rather than guessed, and entirely optional — left blank, nothing changes and the calls
 * simply cost nothing as far as this app is concerned.
 *
 * Stated as "N units per call" and "M units cost $X" rather than as a single price-per-call, because
 * that is how providers actually publish it ("1,000 credits for $49") and because doing the division
 * by hand is exactly where a factor of ten gets lost. Both halves are also worth keeping: the units
 * are what the provider's own dashboard shows, so a total in credits is checkable against the bill in
 * a way a dollar figure is not.
 */
export interface HttpCost {
  /** What the provider calls them. Free text: "credits", "enrichments", "lookups", "requests". */
  unit: string;
  /** How many go on one call. Usually 1, sometimes not. */
  perCall: number;
  /** The size of the bundle the price refers to — "1,000" in "1,000 credits for $49". */
  packUnits: number;
  /** What that bundle costs. */
  packUsd: number;
}

export interface HttpConfig {
  /** Optional declared price per call. See HttpCost. */
  cost?: HttpCost;
  method: HttpMethod;
  /** May contain {{col:id}} references. */
  url: string;
  /**
   * Query parameters, kept separate from the URL.
   *
   * Typing `?a={{x}}&b={{y}}` into the address works, but it makes the user responsible for
   * remembering the separator, and a value that renders empty leaves a dangling `b=`. As fields they
   * can be individually named, individually dropped when empty, and read at a glance.
   */
  query: Pair[];
  headers: Pair[];
  bodyMode: BodyMode;
  /** Used by `json` and `form`. */
  bodyFields: Pair[];
  /** Raw body template, used by `raw`. Ignored for GET. */
  body: string;
  /** Where in the JSON response the cell's value is. Empty keeps the whole response. */
  responsePath: string;
  /** Treat any 2xx as success and store nothing — the shape a webhook wants. */
  fireAndForget: boolean;
  /** Drop query parameters and body fields whose value renders empty for this row. */
  removeEmpty: boolean;
  /** Keep the status and headers alongside the value, rather than the value alone. */
  returnMetadata: boolean;
  followRedirects: boolean;
  maxRedirects: number;
  /**
   * Whether a failure is worth another go.
   *
   * This does NOT add a retry loop of its own — the run engine already retries, backs off and
   * respects the Stop button. It decides which statuses are CLASSIFIED as retryable, so the one
   * existing retry path does the right thing instead of two loops multiplying each other.
   */
  retryOnFailure: boolean;
  maxRetries: number;
  retryStatuses: number[];
  timeoutMs: number;
  /**
   * Allow localhost and private addresses.
   *
   * Needed for the ordinary case of calling something on your own machine or network. Only ever
   * honoured when the HOST is fixed in the template — see `hostIsFixed`.
   */
  allowPrivate: boolean;
}

/**
 * Does the template's host come from the template, or from row data?
 *
 * This is what makes `allowPrivate` safe to offer. If the host is fixed, the user chose exactly one
 * destination and pointing it at their own network is their business. If a reference sits in the
 * host, the DESTINATION is row data — and row data can come from a CSV someone sent, or from a page
 * an agent scraped, at which point "allow private" means "let a spreadsheet cell address the cloud
 * metadata endpoint".
 *
 * Checked against the template BEFORE interpolation, because after it there is nothing left to tell
 * an authored host from an injected one.
 */
export function hostIsFixed(urlTemplate: string): boolean {
  // Everything up to the first single slash after the scheme is authority. A reference anywhere in
  // there — host, port, or userinfo — means row data steers the request.
  const m = urlTemplate.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/);
  if (!m) return false;
  return !/\{\{/.test(m[1] ?? "");
}

/** Statuses worth trying again by default: rate limiting, and a server that is briefly unwell. */
export const DEFAULT_RETRY_STATUSES = [408, 425, 429, 500, 502, 503, 504];

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
  retryStatuses: DEFAULT_RETRY_STATUSES,
  timeoutMs: 20_000,
  allowPrivate: false,
};

/**
 * What one call costs, and how many units it burns.
 *
 * Returns zeros when nothing is declared, which is the honest answer rather than a guess: an
 * undeclared price means this app does not know, and inventing one would put a fabricated number in
 * a column of the bill.
 *
 * `packUnits` of zero returns zero rather than dividing by it — a half-filled form must not produce
 * Infinity and poison every total downstream of it.
 */
export function callCost(cost: HttpCost | undefined | null): { usd: number; units: number; unit: string } {
  const unit = String(cost?.unit ?? "").trim();
  const perCall = Number(cost?.perCall ?? 0);
  const packUnits = Number(cost?.packUnits ?? 0);
  const packUsd = Number(cost?.packUsd ?? 0);
  if (!Number.isFinite(perCall) || perCall <= 0) return { usd: 0, units: 0, unit };
  const units = perCall;
  if (!Number.isFinite(packUnits) || packUnits <= 0 || !Number.isFinite(packUsd) || packUsd < 0) {
    // Units without a price is a legitimate half: "this burns 2 credits" is worth counting even when
    // what a credit costs has not been filled in.
    return { usd: 0, units, unit };
  }
  return { usd: (packUsd / packUnits) * perCall, units, unit };
}

/** Values available to a template, keyed by column id AND by name. */
export type RowValues = Map<string, string | null>;

/**
 * `{{col:12}}` by id, or `{{Website}}` by name, either with a trailing `?` for optional.
 *
 * Ids are what the UI writes; names are for hand-editing. The `?` never reaches the request — it is
 * a property of the reference, not of the value.
 */
/**
 * A COLUMN reference. `{{col:12}}`, `{{col:12.field?}}`, or `{{Website}}`.
 *
 * The `(?!\s*secret:)` is load-bearing. A saved key is written as `{{secret:Name}}`, and without
 * that guard the by-name branch matched it — so `missingRequired` looked for a column called
 * "secret:Prospeo", never found one, and SKIPPED every row of a correctly configured column with
 * the message "Nothing in /secret:Prospeo for this row". The request was never sent and the reason
 * pointed at a column that does not exist.
 *
 * The two grammars have to stay disjoint: a secret is substituted in exactly one place, and every
 * other resolver must leave it alone rather than half-understand it.
 */
const REF = /\{\{col:(\d+)((?:\.[A-Za-z0-9_$-]+|\[\d+\])*)(\?)?\}\}|\{\{(?!\s*secret:)([^}?]+)(\?)?\}\}/g;

/**
 * The value a reference actually asks for: the whole cell, or one field inside it.
 *
 * A path only means anything on a value that parses as JSON. When it does not — a plain string, a
 * number, a cell holding an error message — the answer is EMPTY rather than the whole value. That is
 * the important half. Falling back to the whole value would put an entire JSON blob, or an unrelated
 * string, into a request that asked for one field, and it would look like it worked: a populated
 * field, a 200 back, a wrong answer nobody has a reason to check. Empty is visible, and on a required
 * reference it skips the row instead of paying for it.
 */
function readRef(raw: string | null | undefined, path: string | undefined): string {
  if (raw == null) return "";
  if (!path) return String(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return "";
  }
  // `.industry` arrives with its leading dot; parsePath wants the bare path.
  const got = getPath(parsed, path.replace(/^\./, ""));
  if (got == null) return "";
  return typeof got === "object" ? JSON.stringify(got) : String(got);
}

/**
 * Which required references have nothing in them for this row.
 *
 * The reason this exists rather than "render it and see": a template with a blank domain in it still
 * produces a perfectly well-formed request, and the endpoint still answers, and the answer is about
 * nothing. Once per row, at whatever that endpoint charges. Catching it before the call is the whole
 * difference between a skipped cell and a paid-for wrong one.
 *
 * Optional references are left out on purpose — that is what marking one optional means.
 */
export function missingRequired(templates: string[], values: RowValues): string[] {
  const missing = new Set<string>();
  for (const t of templates) {
    if (!t) continue;
    for (const m of t.matchAll(REF)) {
      const [, id, path, idOpt, name, nameOpt] = m;
      if (idOpt || nameOpt) continue;
      const key = id ?? (name ?? "").trim();
      const raw = values.get(key) ?? (name ? values.get(name.trim().toLowerCase()) : undefined);
      // Judged on what the reference actually READS. A cell holding `{"industry":null}` is not empty,
      // but `/Firmographics.industry` on it is — and it is the field that was asked for, so it is the
      // field that decides whether this row is worth paying for. Reported under the full reference so
      // the skip message names the field rather than just the column.
      if (readRef(raw, path).trim() === "") missing.add(key + (path ?? ""));
    }
  }
  return [...missing];
}

/**
 * Substitute row values into a template.
 *
 * SINGLE PASS, deliberately. If this were recursive, a cell containing "{{col:7}}" — which is
 * trivially achievable from a scraped page — would expand on the second pass and read a column the
 * template never mentioned. One line of code, and the difference between a template engine and a
 * data-exfiltration primitive.
 */
export function render(template: string, values: RowValues, ctx: EscapeContext): string {
  if (!template) return "";
  return template.replace(REF, (_m, byId?: string, path?: string, _idOpt?: string, byName?: string) => {
    const key = byId ?? (byName ?? "").trim();
    const raw = values.get(key) ?? (byName ? values.get(byName.trim().toLowerCase()) : undefined);
    return escapeFor(readRef(raw, path), ctx);
  });
}

/** Does this template read anything from the row? Decides whether a body field may carry a type. */
export function hasRef(template: string): boolean {
  return /\{\{/.test(template);
}

/**
 * A structured body field's value, as it goes into the object.
 *
 * A field whose template mentions NO column is authored text, so `42`, `true` and `{"a":1}` are
 * meant as a number, a boolean and an object. A field that DOES read the row is always a string,
 * however number-like it looks — that is the rule that stops a cell containing `{"admin":true}`
 * from becoming structure in the request instead of a value inside it.
 */
export function bodyValue(template: string, values: RowValues): unknown {
  const rendered = render(template, values, "raw");
  if (hasRef(template)) return rendered;
  const t = rendered.trim();
  if (t === "") return "";
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.startsWith("{") || t.startsWith("[")) {
    try { return JSON.parse(t); } catch { return rendered; }
  }
  return rendered;
}

/** `?a=1&b=2` for the pairs that survive, or "" when none do. */
export function buildQuery(pairs: Pair[], values: RowValues, removeEmpty: boolean): string {
  const parts: string[] = [];
  for (const p of pairs) {
    if (!p.name.trim()) continue;
    const v = render(p.value, values, "url");
    if (removeEmpty && v === "") continue;
    parts.push(`${encodeURIComponent(p.name.trim())}=${v}`);
  }
  return parts.length ? parts.join("&") : "";
}

/** Merge a built query string into a URL that may already carry one. */
export function withQuery(url: string, query: string): string {
  if (!query) return url;
  const hash = url.indexOf("#");
  const base = hash === -1 ? url : url.slice(0, hash);
  const frag = hash === -1 ? "" : url.slice(hash);
  return `${base}${base.includes("?") ? "&" : "?"}${query}${frag}`;
}

export interface HttpOutcome {
  status: number;
  /** The extracted value, or null for fire-and-forget and for a path that matched nothing. */
  value: string | null;
  /** Present on failure. */
  error?: string;
  durationMs: number;
}

export function normalizeHttpConfig(raw: unknown): HttpConfig {
  const c = (raw ?? {}) as Partial<HttpConfig>;
  const method = String(c.method ?? "GET").toUpperCase();
  const allowed: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
  if (!allowed.includes(method as HttpMethod)) {
    throw new Error(`Unsupported method "${method}".`);
  }

  const headers = Array.isArray(c.headers)
    ? c.headers
        .filter((h) => h && typeof h.name === "string" && h.name.trim())
        // Header NAMES are validated rather than escaped: a name is not user data in the way a value
        // is, and anything outside the token grammar is a mistake worth refusing at save time.
        .map((h) => {
          const name = String(h.name).trim();
          if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) throw new Error(`"${name}" is not a valid header name.`);
          return { name, value: String(h.value ?? "") };
        })
    : [];

  const pairs = (raw: unknown): Pair[] =>
    Array.isArray(raw)
      ? raw
          .filter((p) => p && typeof (p as Pair).name === "string" && (p as Pair).name.trim())
          .map((p) => ({ name: String((p as Pair).name).trim(), value: String((p as Pair).value ?? "") }))
      : [];

  const url = String(c.url ?? "").trim();
  if (c.allowPrivate && url && !hostIsFixed(url)) {
    throw new Error(
      "Private addresses cannot be allowed when the web address itself comes from a column — " +
        "that would let a cell decide which machine to contact.",
    );
  }

  const timeoutMs = Number(c.timeoutMs ?? DEFAULT_HTTP.timeoutMs);
  const body = String(c.body ?? "");
  const bodyFields = pairs(c.bodyFields);

  // Configs written before structured bodies existed have a `body` string and no mode. Reading that
  // as "none" would silently drop the body of every webhook already configured, so the mode is
  // inferred from what is there rather than defaulted.
  const allowedModes: BodyMode[] = ["none", "json", "form", "raw"];
  const bodyMode: BodyMode = allowedModes.includes(c.bodyMode as BodyMode)
    ? (c.bodyMode as BodyMode)
    : bodyFields.length ? "json" : body.trim() ? "raw" : "none";

  const int = (v: unknown, dflt: number, lo: number, hi: number) => {
    const n = Number(v ?? dflt);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : dflt;
  };

  const retryStatuses = Array.isArray(c.retryStatuses)
    ? [...new Set(c.retryStatuses.map(Number).filter((n) => Number.isInteger(n) && n >= 100 && n <= 599))]
    : DEFAULT_RETRY_STATUSES;

  return {
    method: method as HttpMethod,
    url,
    query: pairs(c.query),
    headers,
    bodyMode,
    bodyFields,
    body,
    responsePath: String(c.responsePath ?? "").trim(),
    fireAndForget: !!c.fireAndForget,
    // Kept only when it says something. A cost block of all zeros is the same as no cost block, and
    // storing it would make an untouched form look like a declared price of nothing.
    cost: (() => {
      const k = c.cost as Partial<HttpCost> | undefined;
      if (!k) return undefined;
      const unit = String(k.unit ?? "").trim().slice(0, 40);
      const perCall = Number(k.perCall ?? 0);
      const packUnits = Number(k.packUnits ?? 0);
      const packUsd = Number(k.packUsd ?? 0);
      if (!unit && !(perCall > 0)) return undefined;
      return {
        unit,
        // Negatives and NaN are refused into zero rather than stored: a negative price would make a
        // table's total go DOWN as it spends, which is the least noticeable possible corruption.
        perCall: Number.isFinite(perCall) && perCall > 0 ? perCall : 0,
        packUnits: Number.isFinite(packUnits) && packUnits > 0 ? packUnits : 0,
        packUsd: Number.isFinite(packUsd) && packUsd > 0 ? packUsd : 0,
      };
    })(),
    removeEmpty: c.removeEmpty === undefined ? DEFAULT_HTTP.removeEmpty : !!c.removeEmpty,
    returnMetadata: !!c.returnMetadata,
    followRedirects: c.followRedirects === undefined ? DEFAULT_HTTP.followRedirects : !!c.followRedirects,
    maxRedirects: int(c.maxRedirects, DEFAULT_HTTP.maxRedirects, 0, 10),
    retryOnFailure: c.retryOnFailure === undefined ? DEFAULT_HTTP.retryOnFailure : !!c.retryOnFailure,
    // Capped low on purpose. This multiplies against the row count, so "retry 20 times" on a sheet
    // whose endpoint is down is not persistence, it is twenty times the requests to reach the same
    // failure — and on a metered API, twenty times the bill.
    maxRetries: int(c.maxRetries, DEFAULT_HTTP.maxRetries, 0, 5),
    retryStatuses: retryStatuses.length ? retryStatuses : DEFAULT_RETRY_STATUSES,
    // Refused outright when the host is interpolated, rather than saved and quietly ignored at run
    // time — a setting that appears on but does nothing is worse than one that will not turn on.
    allowPrivate: !!c.allowPrivate,
    // Bounded: a per-row request with a ten-minute timeout turns a stalled endpoint into a run that
    // looks hung rather than one that reports failures.
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(1000, Math.min(120_000, timeoutMs)) : DEFAULT_HTTP.timeoutMs,
  };
}

export async function callHttp(
  cfg: HttpConfig,
  values: RowValues,
  signal?: AbortSignal,
): Promise<HttpOutcome> {
  const started = Date.now();
  const base = render(cfg.url, values, "url");
  if (!base) return { status: 0, value: null, error: "This column has no URL yet.", durationMs: 0 };
  const url = withQuery(base, buildQuery(cfg.query, values, cfg.removeEmpty));

  const headers: Record<string, string> = {};
  for (const h of cfg.headers) headers[h.name] = render(h.value, values, "header");
  const contentType = () => headers["Content-Type"] ?? headers["content-type"];

  let body: string | undefined;
  if (cfg.method !== "GET") {
    if (cfg.bodyMode === "json" || cfg.bodyMode === "form") {
      const kept = cfg.bodyFields.filter((f) => {
        if (!cfg.removeEmpty) return true;
        return render(f.value, values, "raw") !== "";
      });
      if (cfg.bodyMode === "json") {
        // Built as an OBJECT and then serialised, never spliced as text. A row value cannot add a
        // field, close a brace, or change a type — whatever it contains ends up as one string in one
        // field, which is what a body field means.
        const obj: Record<string, unknown> = {};
        for (const f of kept) obj[f.name] = bodyValue(f.value, values);
        body = JSON.stringify(obj);
        if (!contentType()) headers["Content-Type"] = "application/json";
      } else {
        body = kept.map((f) => `${encodeURIComponent(f.name)}=${render(f.value, values, "url")}`).join("&");
        if (!contentType()) headers["Content-Type"] = "application/x-www-form-urlencoded";
      }
    } else if (cfg.bodyMode === "raw" && cfg.body.trim() !== "") {
      // A text template still has to be escaped for what it is. JSON-looking text gets the JSON
      // escaper so a value containing a quote sits inside its field rather than ending it.
      const isJson =
        /application\/json/i.test(contentType() ?? "") ||
        cfg.body.trim().startsWith("{") ||
        cfg.body.trim().startsWith("[");
      body = render(cfg.body, values, isJson ? "json" : "raw");
      if (isJson && !contentType()) headers["Content-Type"] = "application/json";
    }
  }

  try {
    const res = await safeFetch(url, {
      method: cfg.method,
      headers,
      body,
      timeoutMs: cfg.timeoutMs,
      signal,
      // Belt and braces: normalize already refuses the combination, and re-deriving it here means a
      // config written straight to the database cannot bypass the check either.
      allowPrivate: cfg.allowPrivate && hostIsFixed(cfg.url),
      followRedirects: cfg.followRedirects,
      maxRedirects: cfg.maxRedirects,
      // Enough for an API response; a column is not a place to store a megabyte.
      maxBytes: 256 * 1024,
    });

    const durationMs = Date.now() - started;

    // A 4xx/5xx is a FAILURE, not a value. Writing the error body into the cell would leave a column
    // full of {"error":"rate limited"} that sorts and filters like real data.
    if (res.status < 200 || res.status >= 300) {
      return {
        status: res.status,
        value: null,
        error: `The endpoint returned ${res.status}. ${res.body.slice(0, 160)}`.trim(),
        durationMs,
      };
    }

    // Wraps whatever the cell would otherwise hold, so "what came back" and "what the endpoint said
    // about it" stay one value rather than the status being lost the moment it succeeds.
    const wrap = (value: string | null): string | null =>
      cfg.returnMetadata
        ? JSON.stringify({ status: res.status, url: res.url, contentType: res.contentType, value })
        : value;

    if (cfg.fireAndForget) return { status: res.status, value: wrap(null), durationMs };

    if (!cfg.responsePath) return { status: res.status, value: wrap(res.body), durationMs };

    let parsed: unknown;
    try { parsed = JSON.parse(res.body); } catch {
      return { status: res.status, value: null, error: "The response was not JSON, so no field could be read from it.", durationMs };
    }

    const picked = getPath(parsed, cfg.responsePath);
    // A path that matched nothing is reported rather than written as an empty cell: "the field moved"
    // and "the field is empty" are different problems and only one of them is the endpoint's fault.
    if (picked === undefined) {
      return { status: res.status, value: null, error: `No "${cfg.responsePath}" in the response.`, durationMs };
    }
    return {
      status: res.status,
      value: wrap(typeof picked === "string" ? picked : JSON.stringify(picked)),
      durationMs,
    };
  } catch (e) {
    return {
      status: 0,
      value: null,
      error: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - started,
    };
  }
}
