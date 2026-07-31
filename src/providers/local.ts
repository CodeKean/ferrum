// Local model runtimes — anything serving models from this machine.
//
// The reason this matters more than "one more provider": a local model costs NOTHING per row. The
// whole cost argument in this app is that a million-row AI column is $19.80 on the cheapest hosted
// model and $0 locally. That trade is real but it is not free of consequence — local inference is
// slower per row, so a million cells is roughly a day of compute rather than hours. The UI says so
// rather than presenting "free" as strictly better.
//
// Every runtime here speaks the OpenAI shape, so there is no adapter: this file only finds them and
// lists what they have loaded. The existing OpenAI adapter does the talking. That is also the test
// for what belongs in the list — a SERVER that answers on a port, not a library you write code
// against. Ollama, LM Studio, llama.cpp, LocalAI, vLLM, Modular MAX, Jan, GPT4All, LiteLLM and
// AnythingLLM qualify; LangChain, LlamaIndex, DSPy and the rest of that family cannot, because there
// is nothing to connect to.
//
// Discovery is a PROBE FIRST, configuration second. Asking a user for a base URL to a server running
// on their own machine, on a port these products have used unchanged for years, is a setup step that
// exists only because the app could not be bothered to look — so it looks, and in the normal case
// there is nothing to fill in.
//
// But "almost always right" is not "always", and the address was previously settable only through an
// env var and an engine restart. Anyone running a runtime on another port, or in a container, met a
// screen that said no setup was needed while failing to see their models. So there is now an address
// per runtime, defaulted to the shipped one and vetted for being genuinely local.

import { createOpenAIProvider } from "./openai.ts";
import { isPrivateIp } from "../agent/safeFetch.ts";
import { getKv, setKv } from "../db.ts";
import { getSecretValue } from "../secrets.ts";
import type { Provider } from "./types.ts";

/**
 * The runtimes probed for.
 *
 * A union rather than a bare string, so a typo in a runtime id is a compile error rather than a
 * silent no-match that makes a model unreachable at run time.
 */
export type LocalRuntimeId =
  | "ollama" | "lmstudio" | "llamacpp" | "vllm" | "jan" | "gpt4all" | "litellm" | "anythingllm";

export interface LocalRuntime {
  id: LocalRuntimeId;
  label: string;
  baseUrl: string;
  /** What it is, in one line, for the screen that lists them. */
  note: string;
  /**
   * This runtime will not answer without a token.
   *
   * Most local servers take none — that is half the appeal. Two do: AnythingLLM issues one from its
   * settings page, and LiteLLM is usually started behind a master key. Without somewhere to put it,
   * both would probe as "not running" no matter how correctly they were configured, which is the
   * worst kind of failure: the app reports nothing there while the user is looking straight at it.
   */
  needsKey: boolean;
  /** True when a key has actually been saved. Never the key itself. */
  hasKey: boolean;
}

/** Names that only ever mean "this machine, or this network". */
const LOCAL_SUFFIX = /(^|\.)(localhost|local|internal|localdomain|lan|home\.arpa)$/i;

/**
 * An env-supplied runtime address, or the shipped default.
 *
 * The repo auto-loads `.env`, so this value is not necessarily something the operator typed today —
 * it can arrive with a checked-out tree. A "local runtime" pointed at somebody else's host would
 * send every prompt and every row of the record there, silently, on the one lane the product
 * advertises as private and free. So the address has to actually BE local: it must parse, it must be
 * http(s), and its host must be a loopback/private address or a name that cannot be a public one.
 * Anything else falls back to the default rather than being honoured or throwing at import time.
 */
export function localBaseUrl(raw: string | undefined, dflt: string): string {
  if (!raw || !raw.trim()) return dflt;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return dflt; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return dflt;

  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host) return dflt;
  // A literal address is checkable outright. A NAME cannot be resolved here — this runs at module
  // load — so the test is on the shape instead: bare names and the local-only suffixes are allowed,
  // and anything that looks like a public FQDN is not.
  // Trailing slashes are stripped because `probe` appends "/models" straight onto this.
  const clean = u.toString().replace(/\/+$/, "");
  if (/^[\d.]+$/.test(host) || host.includes(":")) return isPrivateIp(host) ? clean : dflt;
  if (!host.includes(".") || LOCAL_SUFFIX.test(host)) return clean;
  return dflt;
}

/**
 * The addresses these products ship with.
 *
 * ── Why some entries name TWO products ────────────────────────────────────────────────────────
 *
 * llama.cpp's server and LocalAI both default to port 8080; vLLM and Modular MAX both default to
 * 8000. Only one process can hold a port, so a separate entry per product would mean probing the
 * same address twice and listing whichever one is running under two different names — the same
 * models, twice, attributed to a product that may not even be installed. One entry per ADDRESS, named
 * for what might be answering there, is the honest shape. Anyone running both moves one of them and
 * edits the address here.
 *
 * ── Why this list is not longer ───────────────────────────────────────────────────────────────
 *
 * Only servers belong here. LangChain, LlamaIndex, DSPy, Haystack, Semantic Kernel, the Vercel AI
 * SDK and the rest are libraries you write code against — there is no endpoint for Ferrum to talk
 * to, and adding them would be listing things that can never connect.
 */
const SHIPPED: Array<{
  id: LocalRuntimeId; label: string; url: string; note: string; needsKey?: boolean; env?: string;
}> = [
  {
    id: "ollama", label: "Ollama", url: "http://127.0.0.1:11434/v1", env: "OLLAMA_URL",
    note: "The usual way to run a model on your own machine.",
  },
  {
    id: "lmstudio", label: "LM Studio", url: "http://127.0.0.1:1234/v1", env: "LMSTUDIO_URL",
    note: "A desktop app for downloading and running models. Its server has to be switched on.",
  },
  {
    id: "llamacpp", label: "llama.cpp or LocalAI", url: "http://127.0.0.1:8080/v1", env: "LLAMACPP_URL",
    note: "Both answer on port 8080. llama.cpp is the engine underneath most of the others.",
  },
  {
    id: "vllm", label: "vLLM or Modular MAX", url: "http://127.0.0.1:8000/v1", env: "VLLM_URL",
    note: "Both answer on port 8000. Built for volume on a real GPU rather than for a laptop.",
  },
  {
    id: "jan", label: "Jan", url: "http://127.0.0.1:1337/v1", env: "JAN_URL",
    note: "A desktop app. Its local API server is off until you turn it on in settings.",
  },
  {
    id: "gpt4all", label: "GPT4All", url: "http://127.0.0.1:4891/v1", env: "GPT4ALL_URL",
    note: "A desktop app. Enable the local API server in its settings first.",
  },
  {
    id: "litellm", label: "LiteLLM", url: "http://127.0.0.1:4000/v1", env: "LITELLM_URL",
    note: "A router rather than an engine — it forwards to whatever you have configured behind it.",
    needsKey: true,
  },
  {
    id: "anythingllm", label: "AnythingLLM", url: "http://127.0.0.1:3001/api/v1/openai",
    env: "ANYTHINGLLM_URL",
    note: "Runs your documents and models together. Needs a key made on its API keys page.",
    needsKey: true,
  },
];

const kvKey = (id: LocalRuntimeId) => `local.url.${id}`;

/**
 * Where a runtime's key is kept, for the two that need one.
 *
 * The shared secret store, like every other credential in the app — so masking on read and
 * registration with the redactor come for free instead of being written again here and forgotten in
 * one of the two places. The name says "local" so it cannot be mistaken for a hosted provider's.
 */
export const localSecretName = (id: LocalRuntimeId): string => `${id} (local)`;

/**
 * Where each runtime lives: a stored setting, else an env override, else the shipped default.
 *
 * Not a module-level constant fed only by env. A default right 99% of the time is a good default,
 * but on its own it fails badly in the other 1%: when detection comes back empty the screen says
 * "Ferrum looks for them automatically and no setup is needed here", which, for anyone running
 * Ollama on another port or in a container, is the app confidently telling them there is nothing to
 * configure while being unable to see their runtime, with no way to correct it short of editing a
 * file and restarting the engine. The right shape is a default that is almost always correct AND a
 * way to say otherwise.
 *
 * Read fresh each call rather than cached at import, so changing the address takes effect without a
 * restart. `localBaseUrl` still vets every value: a "local runtime" pointed at someone else's host
 * would ship every prompt and every row there, on the one lane advertised as private and free — so a
 * non-local address is refused and the default stands, whether it arrived from a setting or an env
 * var.
 */
export function localRuntimes(): LocalRuntime[] {
  return SHIPPED.map((r) => ({
    id: r.id,
    label: r.label,
    note: r.note,
    needsKey: !!r.needsKey,
    hasKey: !!localKey(r.id),
    baseUrl: localBaseUrl(getKv(kvKey(r.id)) ?? (r.env ? process.env[r.env] : undefined), r.url),
  }));
}

/** The saved token for a runtime that needs one, or null. */
export function localKey(id: LocalRuntimeId): string | null {
  const v = getSecretValue(localSecretName(id));
  return v && v.trim() ? v.trim() : null;
}

/**
 * Is this a runtime we know?
 *
 * Exported so the routes ask the LIST rather than carrying their own copy of it. The address route
 * checked `id !== "ollama" && id !== "lmstudio"` inline, which meant every runtime added after those
 * two shipped with a settings field that returned "Unknown runtime" — configurable in the UI and
 * refused by the server.
 */
export function isLocalRuntimeId(id: string): id is LocalRuntimeId {
  return SHIPPED.some((r) => r.id === id);
}

/** The shipped address, so a screen can show what "leave it blank" will use. */
export function defaultLocalUrl(id: LocalRuntimeId): string {
  return SHIPPED.find((r) => r.id === id)?.url ?? "";
}

/**
 * Store an address, or clear it back to the default with an empty string.
 *
 * Returns what will ACTUALLY be used, which is not always what was passed: a rejected address falls
 * back, and returning the stored string would let a screen report success for a value that is being
 * ignored.
 */
export function setLocalUrl(id: LocalRuntimeId, url: string): LocalRuntime | null {
  const trimmed = String(url ?? "").trim();
  setKv(kvKey(id), trimmed);
  // The discovered-model list is cached for 30 seconds. Without this, correcting an address and
  // pressing "Check again" re-reads the cache and reports the OLD address's result — so a fix looks
  // like a failure for half a minute and the obvious conclusion is that the new address is wrong too.
  cache = null;
  return localRuntimes().find((r) => r.id === id) ?? null;
}

/** Prefix that marks a model as local. The executor routes on it; the catalogue never sees these. */
export const LOCAL_PREFIX = "local:";

export interface LocalModel {
  /** "local:ollama/llama3.1:8b" — runtime AND model, because two runtimes can hold the same name. */
  id: string;
  name: string;
  runtime: LocalRuntime["id"];
  runtimeLabel: string;
}

export function isLocalModel(modelId: string): boolean {
  return modelId.startsWith(LOCAL_PREFIX);
}

/** "local:ollama/llama3.1:8b" → { runtime, model }. Returns null for anything else. */
export function parseLocalModel(modelId: string): { runtime: LocalRuntime; model: string } | null {
  if (!isLocalModel(modelId)) return null;
  const rest = modelId.slice(LOCAL_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const runtimeId = rest.slice(0, slash);
  const runtime = localRuntimes().find((r) => r.id === runtimeId);
  // The model name is everything after the FIRST slash: Ollama names contain slashes and colons
  // ("library/qwen2.5:7b"), and splitting on every separator would mangle them.
  return runtime ? { runtime, model: rest.slice(slash + 1) } : null;
}

interface Entry { models: LocalModel[]; at: number }
let cache: Entry | null = null;

/** Short: a runtime is started and stopped far more often than a hosted price list changes. */
const TTL_MS = 30_000;

async function probe(rt: LocalRuntime, timeoutMs: number): Promise<LocalModel[]> {
  try {
    const key = localKey(rt.id);
    const res = await fetch(`${rt.baseUrl}/models`, {
      // The token goes on the PROBE too, not only on the chat call. LiteLLM and AnythingLLM reject
      // an unauthenticated model list, so without it a correctly configured runtime reports as
      // "not running" — the app insisting nothing is there while the user looks straight at it.
      headers: { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      // Short and hard. A runtime that is not running usually refuses instantly, but a half-started
      // one can hang — and discovery must never be the thing that makes the app feel broken.
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    if (!Array.isArray(json?.data)) return [];

    return json.data
      .filter((m) => typeof m?.id === "string" && m.id)
      .map((m) => ({
        id: `${LOCAL_PREFIX}${rt.id}/${m.id}`,
        name: String(m.id),
        runtime: rt.id,
        runtimeLabel: rt.label,
      }));
  } catch {
    // Not running, wrong port, or too slow. All three mean "nothing to offer from here", and none of
    // them is an error worth showing — the user has not asked for a local model yet.
    return [];
  }
}

export async function discoverLocalModels(force = false, timeoutMs = 1200): Promise<LocalModel[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.models;
  // Probed in parallel: two sequential timeouts would make a machine with neither runtime installed
  // wait twice as long to be told nothing is there.
  const found = (await Promise.all(localRuntimes().map((rt) => probe(rt, timeoutMs)))).flat();
  cache = { models: found, at: Date.now() };
  return found;
}

/**
 * A provider pointed at a local runtime.
 *
 * No API key — the whole point of the optional `apiKey` in the OpenAI adapter. A layer that assumed
 * every provider needs one would reject the only free option in the product.
 *
 * The timeout is far longer than a hosted call's: a 7B model on a consumer GPU can take tens of
 * seconds for a long answer, and cutting it off at the hosted default would make local models look
 * broken rather than slow.
 */
export function createLocalProvider(runtime: LocalRuntime): Provider {
  return createOpenAIProvider({
    id: runtime.id,
    baseUrl: runtime.baseUrl,
    // Undefined for the runtimes that take none — the adapter's apiKey is optional precisely so the
    // free lane does not need an invented credential.
    apiKey: localKey(runtime.id) ?? undefined,
    timeoutMs: 180_000,
  });
}
