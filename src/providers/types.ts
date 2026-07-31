// The provider-neutral shape every model adapter speaks.
//
// One vocabulary in the middle, thin adapters at the edges. The alternative — letting each provider's
// own message format leak into the agent loop — means the loop grows a branch per vendor and the
// tool-calling logic gets written three times.
//
// Deliberately smaller than any vendor's full API. Ferrum needs chat plus tool calling; it does not
// need vision, audio, batching or assistants, and modelling those would be shape without a caller.

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the arguments. Every provider takes this shape, give or take a wrapper. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  /** Provider-assigned id. Echoed back with the result so a parallel batch stays paired up. */
  id: string;
  name: string;
  /** Parsed arguments. Adapters own the parsing so the loop never sees a raw JSON string. */
  args: Record<string, unknown>;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Cached-prompt reads, where the provider reports them. Drives the cache-hit ratio. */
  cachedInputTokens?: number;
  /**
   * What this call ACTUALLY cost, as the provider billed it. Undefined when it does not say.
   *
   * The reason this exists rather than pricing tokens ourselves: a web search is not priced in
   * tokens at all. It is a flat per-call charge that varies from $0.0025 to $0.035 depending on
   * which engine ran and which model's native search it was, and nothing in the token counts
   * reflects it. Ferrum was recording every search at one hardcoded rate — Exa's $0.005 — so on the
   * most expensive lane in the product the recorded spend was a guess that could be out by 7x in
   * either direction.
   *
   * When the provider reports the real figure it wins over anything computed here, because the
   * invoice is not a thing to be estimated when it has been handed to us.
   */
  costUsd?: number;
}

/** A source the provider consulted on our behalf, e.g. OpenRouter's web plugin. */
export interface Citation {
  url: string;
  title?: string;
  /** The extracted snippet. This is the actual payload of a search — not the model's prose. */
  content?: string;
}

export interface ChatResult {
  /** Assistant text. Empty string when the turn was purely tool calls. */
  text: string;
  toolCalls: ToolCall[];
  /** Present when the provider ran a search itself. Feeds the answer's `source_url`. */
  citations?: Citation[];
  /** Why the model stopped. `tool_calls` means it wants results before continuing. */
  stop: "stop" | "tool_calls" | "length" | "other";
  usage: Usage;
  /** Echoed back so cost is priced against the model that actually answered, which is not always
   *  the one that was asked for — providers substitute. */
  model: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  /** Force a tool call rather than letting the model answer in prose. */
  toolChoice?: "auto" | "required";
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /**
   * Provider-side plugins, passed through untouched. OpenRouter's `[{ id: "web" }]` is the one that
   * matters here: it makes the provider search the web itself, which is how Ferrum gets search
   * without a second vendor and a second key.
   */
  plugins?: Array<Record<string, unknown>>;
}

/**
 * Errors are classified HERE, not at the call site.
 *
 * The retry policy already in runs.ts turns on this class, and it is the difference between a dead
 * credential costing one paused run and costing three minutes per cell across a hundred thousand
 * rows. An adapter that returns a bare Error loses that, so every adapter maps its provider's
 * failures onto this.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly cls: "auth" | "rate_limit" | "overloaded" | "timeout" | "budget" | "schema" | "unknown",
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface Provider {
  /** Stable id used in config and in the model registry, e.g. "openai", "openrouter", "ollama". */
  readonly id: string;
  chat(req: ChatRequest): Promise<ChatResult>;
}
