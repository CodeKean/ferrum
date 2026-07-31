// Outbound HTTP for agent tools, with the guard that makes it safe to hand a URL to a model.
//
// The threat is concrete, not theoretical. A research agent is given a company website; that page is
// text a stranger wrote, and it can suggest another URL. If the fetcher will follow anything, a
// prospect list becomes a way to read `http://169.254.169.254/` (cloud metadata, i.e. credentials),
// probe `http://127.0.0.1:4317/api/...` (this app's own engine, which holds provider keys), or sweep
// the operator's private network.
//
// Four properties, because any one alone is bypassable:
//   1. scheme and hostname are checked,
//   2. the hostname is RESOLVED and the resulting IP is checked — "evil.com" can point at 127.0.0.1,
//   3. the connection is PINNED to the address that was checked, so a name that answers publicly for
//      the check and privately a millisecond later (DNS rebinding, TTL 0) has nothing to move,
//   4. redirects are followed manually so every hop is checked, not just the first — and neither the
//      caller's body nor the caller's headers follow one off the host they were written for.
//
// Property 3 is why this file requests through `node:http`/`node:https` rather than `fetch`. `fetch`
// takes a URL and resolves the name AGAIN inside itself, so the address the guard approved and the
// address the socket connects to are two separate answers to the same question — and only the first
// one was checked. `http.request` accepts a `lookup`, which lets the socket be told the address the
// guard already validated. Certificate validation is untouched: the request still carries the real
// hostname, so SNI and the certificate are checked against it exactly as before.

import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export interface FetchResult {
  url: string;
  status: number;
  contentType: string;
  /** Truncated to the byte cap. `truncated` says so rather than leaving a silent cut. */
  body: string;
  truncated: boolean;
}

export class BlockedUrlError extends Error {
  constructor(readonly url: string, readonly why: string) {
    super(`Refused to fetch ${url}: ${why}`);
    this.name = "BlockedUrlError";
  }
}

const BLOCKED_HOST = /^(localhost|.*\.local|.*\.internal|.*\.localdomain)$/i;

/** Private, loopback, link-local and other non-public ranges. */
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fe80") || v.startsWith("fc") || v.startsWith("fd")) return true;
    // IPv4-mapped IPv6 (::ffff:127.0.0.1) — the same address wearing a different hat.
    const m = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]!);
    return false;
  }

  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // unparseable → refuse
  const [a, b] = p as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;              // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;     // carrier-grade NAT
  if (a >= 224) return true;                             // multicast + reserved
  return false;
}

/**
 * Throws unless this exact URL is safe to request.
 *
 * `allowPrivate` exists for ONE case: an HTTP column whose URL the user typed themselves, pointing
 * at something on their own network — a local API, an internal service, an automation tool on
 * localhost. Blocking those makes the feature useless for half its real uses.
 *
 * It is NOT a general escape hatch, and the agent lane never sets it. There the URL comes from the
 * model, which may have read it off a page an attacker controls, and 169.254.169.254 is one fetch
 * away from cloud credentials. The caller that opts in has to have a fixed host it wrote itself —
 * see the host-interpolation refusal in httpColumn.ts.
 */
export async function assertFetchable(raw: string, allowPrivate = false): Promise<URL> {
  return (await resolveFetchable(raw, allowPrivate)).url;
}

/** A URL that passed the guard, together with the address the guard checked. */
export interface Fetchable {
  url: URL;
  /** Connect HERE. Re-resolving the name would re-open the window this pinning exists to close. */
  address: string;
}

/** How a hostname is resolved. Swappable so a rebinding answer can be produced in a test. */
export type Resolver = (hostname: string) => Promise<Array<{ address: string }>>;

const dnsResolver: Resolver = (hostname) => lookup(hostname, { all: true });
let resolver: Resolver = dnsResolver;

/** For tests only. `null` restores DNS. */
export function setResolver(next: Resolver | null): void {
  resolver = next ?? dnsResolver;
}

/** `assertFetchable`, keeping the address it approved. */
export async function resolveFetchable(raw: string, allowPrivate = false): Promise<Fetchable> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new BlockedUrlError(raw, "not a valid URL"); }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    // file:// would read the operator's disk; everything else is a way out of the sandbox.
    throw new BlockedUrlError(raw, `scheme ${u.protocol} is not allowed`);
  }
  if (!allowPrivate && BLOCKED_HOST.test(u.hostname)) throw new BlockedUrlError(raw, "host is local");

  // A literal IP needs no lookup; a name does. Checking the NAME alone is not enough — a hostname
  // under someone else's control can resolve wherever they like.
  if (isIP(u.hostname)) {
    if (!allowPrivate && isPrivateIp(u.hostname)) throw new BlockedUrlError(raw, "address is private or loopback");
    return { url: u, address: u.hostname };
  }

  let addrs: Array<{ address: string }>;
  try {
    addrs = await resolver(u.hostname);
  } catch {
    throw new BlockedUrlError(raw, "host does not resolve");
  }
  if (addrs.length === 0) throw new BlockedUrlError(raw, "host does not resolve");
  // ALL resolved addresses must be public. One private answer among several is enough to refuse —
  // which of them a later connect picks is not ours to predict.
  for (const a of addrs) {
    if (!allowPrivate && isPrivateIp(a.address)) throw new BlockedUrlError(raw, `resolves to a private address (${a.address})`);
  }
  // The first checked answer is the one the connection is pinned to, so the set that was approved
  // and the address that is dialled cannot differ.
  return { url: u, address: String(addrs[0]!.address) };
}

/**
 * A `dns.lookup` replacement that always answers with one address, whatever it is asked.
 *
 * Handed to `http.request`, it is what makes the socket go where the guard looked. It answers
 * asynchronously because that is the contract `dns.lookup` has, and a connector re-entered
 * synchronously from its own call is a class of bug not worth discovering here.
 */
export function pinnedLookup(address: string) {
  const family = isIP(address);
  return (_hostname: string, options: any, callback?: any) => {
    const cb = typeof options === "function" ? options : callback;
    const all = typeof options === "object" && options !== null && options.all === true;
    queueMicrotask(() => (all ? cb(null, [{ address, family }]) : cb(null, address, family)));
  };
}

/** What the hop loop needs of a response. A subset of `Response`, so the loop reads the same. */
export interface HopResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

/**
 * One request, to `pin.address`, addressed as `pin.url`.
 *
 * Redirects are never followed here — the loop above does that, checking each hop, which is the
 * whole reason this fetcher exists.
 *
 * Exported for the MCP transport, which needs the same pinning but keeps the body as a stream.
 */
export function pinnedFetch(
  pin: Fetchable,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
): Promise<HopResponse> {
  const send = pin.url.protocol === "https:" ? httpsRequest : httpRequest;
  const headers: Record<string, string> = { ...init.headers };
  // Set explicitly rather than left to chunked encoding: plenty of APIs answer a chunked POST with a
  // 411, and `fetch` sent a length here before.
  if (init.body != null) headers["Content-Length"] = String(Buffer.byteLength(init.body));

  return new Promise<HopResponse>((resolve, reject) => {
    const req = send(
      pin.url,
      { method: init.method, headers, signal: init.signal, lookup: pinnedLookup(pin.address) },
      (res) => {
        try {
          // `node:http` hands the body over exactly as it arrived, where `fetch` decoded it. Done
          // here so the byte cap still counts the text a caller will read rather than its
          // compressed size.
          const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
          let stream: Readable = res;
          if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(createGunzip());
          else if (enc === "deflate") stream = res.pipe(createInflate());
          else if (enc === "br") stream = res.pipe(createBrotliDecompress());

          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            // A header a `Headers` will not hold is a header from a server that is not following the
            // grammar. Skipped rather than thrown on, so one odd header is not a failed fetch.
            try {
              if (Array.isArray(v)) for (const one of v) h.append(k, one);
              else if (v != null) h.append(k, String(v));
            } catch { /* not a header worth keeping */ }
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: h,
            body: Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
          });
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      },
    );
    req.on("error", reject);
    if (init.body != null) req.write(init.body);
    req.end();
  });
}

/** Sent on every hop. Identifies nothing and carries no credential, so it may follow a redirect. */
const BASE_HEADERS: Record<string, string> = {
  "User-Agent": "Ferrum/0.1 (+local research agent)",
  Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
  // Asked for explicitly because `node:http` does not, where `fetch` did. Dropping it would quietly
  // multiply the bytes a page costs; the response is decoded on the way in either way.
  "Accept-Encoding": "gzip, deflate, br",
};

/**
 * May the caller's OWN headers follow this redirect?
 *
 * The caller's headers are authored for one destination, and on an HTTP column that is where the API
 * key lives — `Authorization: Bearer …`, `X-Api-Key: …`. The hop loop used to rebuild them
 * identically on every hop, so one 302 from the endpoint handed that key to whatever host the
 * redirect named. The POST body was already withheld after the first hop for exactly this reason;
 * the same reasoning had simply never been applied to the headers.
 *
 * A path change, and an http→https upgrade of the SAME host, keep them: that is the ordinary shape
 * of a redirect on an address the user typed, and stripping there would break working columns to
 * prevent nothing. A different host or port is a different owner, and https→http is the same owner
 * reached in cleartext — neither gets the credential.
 */
export function headersTravel(from: URL, to: URL): boolean {
  // `host` includes the port, so a redirect onto another service on the same machine also drops.
  if (from.host !== to.host) return false;
  if (from.protocol === "https:" && to.protocol !== "https:") return false;
  return true;
}

/**
 * Read at most `maxBytes`, then stop the transfer.
 *
 * `arrayBuffer()` resolves only once the WHOLE body is in memory, so a cap applied after it
 * describes the slice that is KEPT rather than the transfer that was made: a multi-gigabyte response
 * — hostile, or merely an endpoint returning far more than anyone expected — buffered in full and
 * then trimmed to 512 KB, once per row on an HTTP column, on a single-threaded engine.
 *
 * Exported so the cap is testable without a network.
 */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ body: string; truncated: boolean }> {
  if (!body) return { body: "", truncated: false };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      const room = maxBytes - total;
      if (value.byteLength > room) {
        // Copied rather than kept as a view, so nothing downstream depends on a buffer the stream
        // may reuse once we stop reading from it.
        if (room > 0) { chunks.push(value.slice(0, room)); total += room; }
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    // Releases the socket rather than leaving the rest of an unwanted body to arrive unread.
    await reader.cancel().catch(() => {});
  }

  const buf = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { buf.set(c, at); at += c.byteLength; }
  return { body: new TextDecoder("utf-8", { fatal: false }).decode(buf), truncated };
}

export interface SafeFetchOptions {
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Only for a user-authored URL with a fixed host. Never set on the agent lane. */
  allowPrivate?: boolean;
  /** Defaults to GET. HTTP columns and outbound webhooks need the rest. */
  method?: string;
  /** Merged over the defaults, so a caller can set Authorization or Content-Type. */
  headers?: Record<string, string>;
  body?: string;
  /**
   * When false, a 3xx is RETURNED rather than followed.
   *
   * Distinct from `maxRedirects: 0`, which would exhaust the hop budget and report "too many
   * redirects" — a confusing thing to read when the point was not to follow any. Someone posting a
   * row to a webhook usually wants to know the address redirected, because it means it is wrong.
   */
  followRedirects?: boolean;
}

export async function safeFetch(raw: string, opts: SafeFetchOptions = {}): Promise<FetchResult> {
  const maxBytes = opts.maxBytes ?? 512 * 1024;
  const maxRedirects = opts.maxRedirects ?? 4;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const method = (opts.method ?? "GET").toUpperCase();

  // Cleared the first time a redirect leaves the address the caller wrote, and never restored: a
  // chain that comes back is still a chain that went somewhere else in between.
  let sendCallerHeaders = true;

  let url = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    // The exemption is FIRST HOP ONLY, for the same reason the body is.
    //
    // `allowPrivate` is granted on the strength of a host the user fixed in their own template — and
    // a redirect is precisely the thing that changes the host. Carried into hop 1, a ticked box on a
    // column pointing at an external API let that API's 302 walk the fetcher into 169.254.169.254 or
    // straight back at this engine. Every hop after the first is checked as if the box were off,
    // which is what "every hop is checked again" was always supposed to mean.
    const pin = await resolveFetchable(url, hop === 0 && opts.allowPrivate);
    const u = pin.url;

    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(new Error("fetch timeout")); }, timeoutMs);
    const onAbort = () => ac.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    let res: HopResponse;
    // Stays null while this hop turns out to be a redirect being followed — its body is discarded
    // rather than read, so "no payload" and "keep going" are the same condition.
    let payload: { body: string; truncated: boolean } | null = null;
    try {
      // Never follows a redirect of its own, so each hop is re-checked here. Automatic redirects are
      // the standard way a guarded fetcher ends up on 169.254.169.254 anyway: only the first URL was
      // ever validated.
      res = await pinnedFetch(pin, {
        method,
        // The caller's headers travel only while the destination is still theirs — see
        // `headersTravel`. The defaults go everywhere; they carry nothing.
        headers: sendCallerHeaders ? { ...BASE_HEADERS, ...opts.headers } : { ...BASE_HEADERS },
        // Only on the FIRST hop. Replaying a POST body to wherever a redirect points is how a
        // request meant for one host gets delivered to another — and on an outbound webhook that
        // body is the user's row data.
        body: hop === 0 ? opts.body : undefined,
        signal: ac.signal,
      });

      // Read INSIDE the timeout window and inside the byte cap. Neither may stop at the response
      // HEADERS: awaiting `arrayBuffer()` after the timer is cleared lets a slow drip hold the socket
      // indefinitely and buffers an enormous body whole before it is trimmed.
      if (res.status >= 300 && res.status < 400 && opts.followRedirects !== false) {
        await res.body?.cancel().catch(() => {});
      } else {
        payload = await readCapped(res.body, maxBytes);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // `timedOut` as well as the message: the abort reason travels through as-is here, so the text
      // an aborted request reports is not something to depend on for telling the two apart.
      throw new Error(timedOut || /abort/i.test(msg) ? `Timed out fetching ${url}` : `Could not fetch ${url}: ${msg}`);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }

    if (!payload) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`Redirect from ${url} with no destination`);
      const next = new URL(loc, u);
      if (!headersTravel(u, next)) sendCallerHeaders = false;
      url = next.toString();
      continue;
    }

    return {
      url: u.toString(),
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      body: payload.body,
      truncated: payload.truncated,
    };
  }

  throw new Error(`Too many redirects starting from ${raw}`);
}
