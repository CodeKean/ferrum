// Every place a model can come from.
//
// ── Why this exists ────────────────────────────────────────────────────────────────────────────
//
// Ferrum reached models through OpenRouter and nothing else. That is a good default and a bad only
// option, for the same two reasons the search backends had: an aggregator takes a margin, and it is
// a single point of failure for rate limits, outages and availability. Going direct to OpenAI or
// Anthropic is cheaper per token and gets you the capacity you have actually paid for.
//
// ── Why this is mostly a table and not code ────────────────────────────────────────────────────
//
// Almost every vendor speaks OpenAI's `/chat/completions` shape, including several that have nothing
// to do with OpenAI. So most of what follows is a base URL and a key: `createOpenAIProvider` already
// handles the rest, and the loop above it never learns which vendor answered.
//
// Two do not fit. Anthropic has its own messages API — a separate system field, a different tool
// shape, different stop reasons — and needs a real adapter. Google's native API is different again,
// but it publishes an OpenAI-compatible endpoint, which is what this uses: one shape rather than a
// third adapter to maintain for no behavioural gain.
//
// ── What a combination costs to add ────────────────────────────────────────────────────────────
//
// Nothing multiplies. A provider is one row here; a search engine is one row in the search registry;
// a tool is one function. They meet at `Provider.chat()` and at `AgentTool.run()`, so the number of
// working COMBINATIONS is the product of all three while the number of code paths is their sum.

export type ProviderKind = "openai-compatible" | "anthropic";

export interface LlmProviderSpec {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Base URL, without the trailing `/chat/completions`. */
  baseUrl: string;
  /** The secret holding this provider's key, in the shared store. */
  secretName: string;
  signupUrl: string;
  /** One line on what it is FOR — twenty provider names is not a choice. */
  note: string;
  /**
   * Whether models from here can call tools.
   *
   * Per PROVIDER rather than per model because it is the endpoint that decides: a provider with no
   * tool support cannot drive the agent lane at all, whatever weights it serves. Per-model support
   * is a separate flag that comes from the catalogue.
   */
  tools: boolean;
}

export const LLM_PROVIDERS: LlmProviderSpec[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    secretName: "OpenRouter",
    signupUrl: "https://openrouter.ai/settings/keys",
    note: "Every model behind one key, with a published price list. The easiest start, and it takes a margin.",
    tools: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    secretName: "OpenAI",
    signupUrl: "https://platform.openai.com/api-keys",
    note: "GPT models direct from the source. Strong tool calling.",
    tools: true,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    secretName: "Anthropic",
    signupUrl: "https://console.anthropic.com/settings/keys",
    note: "Claude models. The best of the lot at following a long instruction exactly.",
    tools: true,
  },
  {
    id: "google",
    label: "Google Gemini",
    kind: "openai-compatible",
    // Google's OpenAI-compatible endpoint. Its native API is a different shape again, and using the
    // compatible one means no third adapter to keep in step for no behavioural gain.
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    secretName: "Google",
    signupUrl: "https://aistudio.google.com/apikey",
    note: "Gemini. Very large context windows and a generous free tier.",
    tools: true,
  },
  {
    id: "zai",
    label: "Z.AI",
    kind: "openai-compatible",
    // The coding path, which is the one that serves the GLM models. The plain /v4 base answers with
    // a misleading balance error instead of a clear one, which costs an hour to diagnose.
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    secretName: "ZAI",
    signupUrl: "https://z.ai/manage-apikey/apikey-list",
    note: "GLM models. Very cheap for the quality, strong on structured output.",
    tools: true,
  },
  {
    id: "mistral",
    label: "Mistral",
    kind: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    secretName: "Mistral",
    signupUrl: "https://console.mistral.ai/api-keys/",
    note: "European, open-weight models with a hosted option. Good small models.",
    tools: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    secretName: "DeepSeek",
    signupUrl: "https://platform.deepseek.com/api_keys",
    note: "Frontier-adjacent reasoning at a fraction of the price.",
    tools: true,
  },
  {
    id: "groq",
    label: "Groq",
    kind: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    secretName: "Groq",
    signupUrl: "https://console.groq.com/keys",
    note: "Open models served very fast. The one to pick when a million rows have to finish today.",
    tools: true,
  },
  {
    id: "xai",
    label: "xAI",
    kind: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    secretName: "XAI",
    signupUrl: "https://console.x.ai/",
    note: "Grok models.",
    tools: true,
  },
  {
    id: "together",
    label: "Together AI",
    kind: "openai-compatible",
    baseUrl: "https://api.together.xyz/v1",
    secretName: "Together",
    signupUrl: "https://api.together.ai/settings/api-keys",
    note: "A large catalogue of open models, hosted.",
    tools: true,
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    kind: "openai-compatible",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    secretName: "Fireworks",
    signupUrl: "https://fireworks.ai/account/api-keys",
    note: "Open models tuned for throughput and function calling.",
    tools: true,
  },
  {
    id: "cerebras",
    label: "Cerebras",
    kind: "openai-compatible",
    baseUrl: "https://api.cerebras.ai/v1",
    secretName: "Cerebras",
    signupUrl: "https://cloud.cerebras.ai/",
    note: "The fastest tokens per second available, on a small model list.",
    tools: true,
  },
  {
    id: "moonshot",
    label: "Moonshot (Kimi)",
    kind: "openai-compatible",
    baseUrl: "https://api.moonshot.ai/v1",
    secretName: "Moonshot",
    signupUrl: "https://platform.moonshot.ai/console/api-keys",
    note: "Kimi models. Long context, strong agentic behaviour.",
    tools: true,
  },
  {
    id: "perplexity",
    label: "Perplexity",
    kind: "openai-compatible",
    baseUrl: "https://api.perplexity.ai",
    secretName: "Perplexity",
    signupUrl: "https://www.perplexity.ai/settings/api",
    note: "Models that search the web as part of answering, rather than calling a search tool.",
    tools: false,
  },
  {
    id: "deepinfra",
    label: "DeepInfra",
    kind: "openai-compatible",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    secretName: "DeepInfra",
    signupUrl: "https://deepinfra.com/dash/api_keys",
    note: "Open models at low per-token prices.",
    tools: true,
  },
  {
    id: "nebius",
    label: "Nebius AI Studio",
    kind: "openai-compatible",
    baseUrl: "https://api.studio.nebius.com/v1",
    secretName: "Nebius",
    signupUrl: "https://studio.nebius.com/",
    note: "Open models, European hosting.",
    tools: true,
  },
  {
    id: "hyperbolic",
    label: "Hyperbolic",
    kind: "openai-compatible",
    baseUrl: "https://api.hyperbolic.xyz/v1",
    secretName: "Hyperbolic",
    signupUrl: "https://app.hyperbolic.xyz/settings",
    note: "Open models, aggressively priced.",
    tools: true,
  },
  {
    id: "novita",
    label: "Novita AI",
    kind: "openai-compatible",
    baseUrl: "https://api.novita.ai/v3/openai",
    secretName: "Novita",
    signupUrl: "https://novita.ai/settings/key-management",
    note: "Open models with a wide selection.",
    tools: true,
  },
  {
    id: "sambanova",
    label: "SambaNova",
    kind: "openai-compatible",
    baseUrl: "https://api.sambanova.ai/v1",
    secretName: "SambaNova",
    signupUrl: "https://cloud.sambanova.ai/apis",
    note: "Open models on custom silicon, fast.",
    tools: true,
  },
  {
    id: "cohere",
    label: "Cohere",
    kind: "openai-compatible",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    secretName: "Cohere",
    signupUrl: "https://dashboard.cohere.com/api-keys",
    note: "Command models, built around retrieval and business text.",
    tools: true,
  },
  {
    id: "ai21",
    label: "AI21",
    kind: "openai-compatible",
    baseUrl: "https://api.ai21.com/studio/v1",
    secretName: "AI21",
    signupUrl: "https://studio.ai21.com/account/api-key",
    note: "Jamba models. Very long context.",
    tools: true,
  },
];
//
// Ollama and LM Studio are deliberately NOT in this list. They already have a home in `local.ts`,
// which probes for them, lets their address be changed, and vets that address for actually being on
// this machine before any prompt is sent to it. A second entry here with a hardcoded URL would look
// equivalent and quietly skip all three, on the one lane the product advertises as private.
// A local model keeps its own id form, `local:ollama/llama3`, handled in `resolveProvider`.

const byId = new Map(LLM_PROVIDERS.map((p) => [p.id, p]));

export function llmProvider(id: string): LlmProviderSpec | null {
  return byId.get(id) ?? null;
}

/**
 * Split `anthropic:claude-sonnet-4` into its provider and its model.
 *
 * A prefix is needed because the same model id is served by several providers at different prices —
 * `llama-3.3-70b` exists on Groq, Together, Fireworks, DeepInfra and OpenRouter — so an id alone
 * does not say who to bill or which key to use.
 *
 * An id with no prefix means OpenRouter, which is what every model id in this workspace meant before
 * there was a choice. Nothing stored has to be rewritten.
 */
export function splitModelId(id: string): { provider: string; model: string } {
  const raw = String(id ?? "").trim();
  const at = raw.indexOf(":");
  if (at > 0) {
    const provider = raw.slice(0, at);
    // Only a KNOWN provider counts as a prefix. OpenRouter model ids contain no colon, but a local
    // one is `ollama:llama3` and a future id might legitimately contain one — so an unrecognised
    // prefix is treated as part of the model name rather than silently routed somewhere.
    if (byId.has(provider)) return { provider, model: raw.slice(at + 1) };
  }
  return { provider: "openrouter", model: raw };
}

export const qualifyModelId = (provider: string, model: string): string =>
  provider === "openrouter" ? model : `${provider}:${model}`;
