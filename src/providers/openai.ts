// The OpenAI-compatible adapter.
//
// This one adapter is most of the provider layer. OpenAI, OpenRouter, Groq, DeepSeek, Together,
// Fireworks, Z.ai, Ollama and LM Studio all expose /chat/completions with the same tool-calling
// shape, so they differ by a base URL, a model id, and whether a key is needed at all.
//
// `apiKey` is therefore OPTIONAL. A layer that assumes every provider needs one cannot talk to a
// local runtime, which is the whole free tier of this product.

import {
  ProviderError,
  type ChatRequest, type ChatResult, type ChatMessage, type Provider, type ToolCall,
} from "./types.ts";

export interface OpenAIConfig {
  id: string;
  baseUrl: string;
  apiKey?: string;
  /** Extra headers a specific host wants (OpenRouter's attribution headers, for example). */
  headers?: Record<string, string>;
  /**
   * This host understands `usage: {include: true}` and reports what the call actually billed.
   *
   * OpenRouter only, today. Off by default because the field is a rejection on stricter hosts, not
   * a harmless extra — see where it is sent.
   */
  reportsCost?: boolean;
  timeoutMs?: number;
}

/** Our message shape → the wire shape. */
function toWire(m: ChatMessage): Record<string, unknown> {
  switch (m.role) {
    case "assistant":
      return {
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((t) => ({
                id: t.id,
                type: "function",
                // Arguments go back as a STRING. Sending the object works on some hosts and is
                // rejected by others, and the ones that accept it are not the ones people run.
                function: { name: t.name, arguments: JSON.stringify(t.args) },
              })),
            }
          : {}),
      };
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, name: m.name, content: m.content };
    default:
      return { role: m.role, content: m.content };
  }
}

function parseToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCall[] = [];
  for (const c of raw as any[]) {
    const name = c?.function?.name;
    if (!name) continue;
    let args: Record<string, unknown> = {};
    const rawArgs = c.function.arguments;
    if (typeof rawArgs === "string" && rawArgs.trim()) {
      // A model can emit arguments that are not valid JSON. That is a SCHEMA failure for this one
      // call, not a crash for the run — the loop hands the parse error back as the tool result and
      // the model gets a chance to correct itself.
      try { args = JSON.parse(rawArgs); } catch { args = { __parseError: String(rawArgs).slice(0, 500) }; }
    } else if (rawArgs && typeof rawArgs === "object") {
      args = rawArgs as Record<string, unknown>;
    }
    out.push({ id: String(c.id ?? `call_${out.length}`), name: String(name), args });
  }
  return out;
}

/**
 * Fallback: pull a tool call out of the TEXT.
 *
 * Open models tuned for function calling — the Hermes family and most local 7-8B builds — frequently
 * emit `<tool_call>{"name":...,"arguments":{...}}</tool_call>` in the content instead of filling the
 * structured `tool_calls` field. Whether they do depends on the serving runtime's chat template, not
 * on the model, so the same weights behave differently under Ollama, vLLM and llama.cpp.
 *
 * An adapter that only reads the structured field sees an assistant turn with no calls and no answer,
 * and the loop ends having done nothing — which looks like the model being incapable rather than a
 * format mismatch. Reading both is the difference between "works with any tool-calling LLM" as a
 * claim and as a fact.
 */
const TOOL_CALL_TAG = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

export function extractTextToolCalls(text: string): { calls: ToolCall[]; text: string } {
  if (!text || !text.includes("<tool_call>")) return { calls: [], text };

  const calls: ToolCall[] = [];
  let i = 0;
  for (const m of text.matchAll(TOOL_CALL_TAG)) {
    try {
      const obj = JSON.parse(m[1]!);
      const name = obj?.name;
      if (!name) continue;
      // Both spellings appear in the wild; neither is more correct than the other.
      const args = obj.arguments ?? obj.parameters ?? obj.args ?? {};
      calls.push({
        id: `textcall_${i++}`,
        name: String(name),
        args: typeof args === "string" ? safeParse(args) : (args as Record<string, unknown>),
      });
    } catch { /* a malformed block is left in the text, where the model can see its own mistake */ }
  }

  return { calls, text: text.replace(TOOL_CALL_TAG, "").trim() };
}

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s); } catch { return { __parseError: s.slice(0, 500) }; }
}

/** HTTP status + payload → the error class the retry policy switches on. */
function classify(status: number, body: string): ProviderError {
  const snippet = body.slice(0, 300);
  // The one status class whose body is NOT echoed.
  //
  // This message becomes a cell's error_msg and is broadcast to every SSE subscriber, and a rejected
  // credential is exactly where a provider likes to quote back what it was sent — the key prefix,
  // the org, the account. `checkKey` in openrouter.ts already refuses to repeat a 401/403 body for
  // the same reason; the two paths must not disagree about it. The CLASS is unchanged, so the retry
  // policy still pauses the run rather than retrying a dead token.
  if (status === 401 || status === 403) {
    return new ProviderError(`Authentication failed (${status}) — check the provider key.`, "auth", status);
  }
  if (status === 429) return new ProviderError(`Rate limited: ${snippet}`, "rate_limit", status);
  if (status === 402) return new ProviderError(`Payment or quota required: ${snippet}`, "budget", status);
  if (status === 400 && /context|token|too long/i.test(body)) {
    return new ProviderError(`Request too large: ${snippet}`, "schema", status);
  }
  if (status >= 500) return new ProviderError(`Provider unavailable (${status}): ${snippet}`, "overloaded", status);
  return new ProviderError(`Provider error (${status}): ${snippet}`, "unknown", status);
}

export function createOpenAIProvider(cfg: OpenAIConfig): Provider {
  const timeoutMs = cfg.timeoutMs ?? 120_000;

  return {
    id: cfg.id,

    async chat(req: ChatRequest): Promise<ChatResult> {
      const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";

      const body: Record<string, unknown> = {
        model: req.model,
        messages: req.messages.map(toWire),
        stream: false,
      };
      if (req.tools?.length) {
        body.tools = req.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
        body.tool_choice = req.toolChoice === "required" ? "required" : "auto";
      }
      if (req.maxTokens != null) body.max_tokens = req.maxTokens;
      if (req.temperature != null) body.temperature = req.temperature;
      // Passed straight through. Hosts that do not know the field ignore it; OpenRouter uses it to
      // run a web search before answering.
      if (req.plugins?.length) body.plugins = req.plugins;

      // Ask for the real charge back.
      //
      // OpenRouter returns `usage.cost` — what the generation actually billed, the web plugin
      // included — when this is set. It is the only way to know what a SEARCH cost: a search is a
      // flat per-call charge that never appears in a token count, and it varies by a factor of
      // fourteen depending on which engine ran. Everything else in this app can be estimated from
      // tokens; that one cannot.
      //
      // OPT-IN, because "an unknown field is harmless" is false. OpenAI rejects an unrecognised
      // top-level argument outright — `400 Unrecognized request argument supplied: usage` — and so do
      // several of the stricter compatible hosts. While this adapter served only OpenRouter and the
      // local runtimes that never showed; sending it to OpenAI, Mistral or Google's compatible
      // endpoint would fail every call on those providers, at the request layer, before a model ran.
      // The reader below already treats the field as optional, so a host that does not report a cost
      // simply falls back to pricing tokens.
      if (cfg.reportsCost) body.usage = { include: true };

      // Our own timeout, chained to the caller's cancellation. Without this a hung provider holds a
      // worker slot until the process dies — and a stalled connection is a far more common failure
      // than an error response.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error("provider timeout")), timeoutMs);
      const onAbort = () => ac.abort(req.signal?.reason);
      req.signal?.addEventListener("abort", onAbort, { once: true });

      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Only sent when there IS a key: Ollama and LM Studio reject a bearer of "undefined".
            ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
            ...cfg.headers,
          },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new ProviderError(
          /abort/i.test(msg) ? `Timed out after ${timeoutMs}ms` : `Could not reach ${cfg.id}: ${msg}`,
          /abort/i.test(msg) ? "timeout" : "overloaded",
        );
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
      }

      const raw = await res.text();
      if (!res.ok) throw classify(res.status, raw);

      let json: any;
      try { json = JSON.parse(raw); } catch {
        throw new ProviderError(`Provider returned non-JSON: ${raw.slice(0, 200)}`, "schema", res.status);
      }

      // Some hosts answer 200 with an error object in the body rather than a non-2xx status.
      if (json?.error) {
        throw new ProviderError(String(json.error.message ?? json.error), "unknown", 200);
      }

      const choice = json?.choices?.[0];
      const msg = choice?.message ?? {};
      let toolCalls = parseToolCalls(msg.tool_calls);
      let text = typeof msg.content === "string" ? msg.content : "";

      // Only when the structured field came back empty. A model that filled it properly is never
      // second-guessed by a regex over its prose.
      if (toolCalls.length === 0 && text) {
        const fromText = extractTextToolCalls(text);
        if (fromText.calls.length > 0) {
          toolCalls = fromText.calls;
          text = fromText.text;
        }
      }

      const finish = String(choice?.finish_reason ?? "");
      const stop: ChatResult["stop"] =
        toolCalls.length > 0 || finish === "tool_calls" ? "tool_calls"
        : finish === "length" ? "length"
        : finish === "stop" ? "stop"
        : "other";

      // url_citation annotations — how OpenRouter returns what its web plugin found. The snippets
      // are the real result of a search; the model's prose about them is incidental, and reading
      // only the prose throws away both the sources and the text worth quoting.
      const citations = Array.isArray(msg.annotations)
        ? (msg.annotations as any[])
            .filter((a) => a?.type === "url_citation" && a.url_citation?.url)
            .map((a) => ({
              url: String(a.url_citation.url),
              title: a.url_citation.title ? String(a.url_citation.title) : undefined,
              content: a.url_citation.content ? String(a.url_citation.content) : undefined,
            }))
        : undefined;

      return {
        text,
        toolCalls,
        ...(citations?.length ? { citations } : {}),
        stop,
        usage: {
          inputTokens: Number(json?.usage?.prompt_tokens ?? 0),
          outputTokens: Number(json?.usage?.completion_tokens ?? 0),
          cachedInputTokens: json?.usage?.prompt_tokens_details?.cached_tokens ?? undefined,
          // Only when the provider actually reports a number. A host that omits it leaves this
          // undefined and the caller falls back to pricing tokens — which is right for every lane
          // except search, and search is exactly where a fallback would be a fabrication.
          costUsd: Number.isFinite(Number(json?.usage?.cost)) ? Number(json.usage.cost) : undefined,
        },
        // What ANSWERED, not what was asked for. Providers substitute, and pricing the wrong model
        // is how a cost estimate drifts from the invoice.
        model: String(json?.model ?? req.model),
      };
    },
  };
}
