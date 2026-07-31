// Anthropic's messages API, behind the same `Provider` interface as everything else.
//
// The one vendor here that does not speak OpenAI's shape, and the differences are not cosmetic —
// each one is a place where a naive adapter produces a loop that runs, costs money, and never calls
// a tool:
//
//   the system prompt is a TOP-LEVEL FIELD, not a message with `role: "system"`. Sent as a message
//   it is rejected outright.
//
//   a tool call arrives as a CONTENT BLOCK of type `tool_use` inside the assistant's content array,
//   not as a sibling `tool_calls` field. An adapter reading the OpenAI place finds nothing and the
//   loop ends having done nothing, which looks like the model being incapable.
//
//   a tool RESULT goes back as a `tool_result` block inside a USER message, not as a message with
//   `role: "tool"`.
//
//   `max_tokens` is REQUIRED. Omitting it is a 400 rather than a default.
//
// Everything above this adapter — the loop, the tools, the budget, the search backends — is
// unchanged by any of that, which is the whole point of the interface.

import { ProviderError } from "./types.ts";
import type { ChatMessage, ChatRequest, ChatResult, Provider, ToolCall } from "./types.ts";

const VERSION = "2023-06-01";
/** Anthropic requires this. A cell that hits it is truncated, so it is generous rather than tight. */
const DEFAULT_MAX_TOKENS = 4096;

interface Config {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * OpenAI-shaped messages in, Anthropic-shaped blocks out.
 *
 * Exported for its tests. Every difference it handles fails SILENTLY when got wrong — the loop runs,
 * bills, and never calls a tool — so it is checked against the real function rather than a copy that
 * can drift away from it.
 */
export function toWire(messages: ChatMessage[]): { system: string; msgs: any[] } {
  const system: string[] = [];
  const msgs: any[] = [];

  for (const m of messages) {
    if (m.role === "system") { system.push(m.content ?? ""); continue; }

    if (m.role === "tool") {
      // A tool result is a USER turn carrying a `tool_result` block. Consecutive results are merged
      // into one user message, because Anthropic rejects two user turns in a row.
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content ?? "" };
      const last = msgs[msgs.length - 1];
      if (last?.role === "user" && Array.isArray(last.content)) last.content.push(block);
      else msgs.push({ role: "user", content: [block] });
      continue;
    }

    if (m.role === "assistant") {
      const content: any[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) {
        content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} });
      }
      // An assistant turn with neither text nor a tool call is not a legal message. It happens when
      // a provider returns an empty turn, and sending it back rejects the whole conversation rather
      // than the one empty part.
      if (content.length > 0) msgs.push({ role: "assistant", content });
      continue;
    }

    msgs.push({ role: "user", content: m.content ?? "" });
  }

  return { system: system.join("\n\n"), msgs };
}

function classify(status: number, body: string): ProviderError {
  const snippet = body.slice(0, 300);
  if (status === 401 || status === 403) return new ProviderError("Anthropic rejected the key.", "auth", status);
  if (status === 429) return new ProviderError(`Rate limited: ${snippet}`, "rate_limit", status);
  if (status === 529 || status === 503) return new ProviderError(`Overloaded: ${snippet}`, "overloaded", status);
  if (status === 400 && /max_tokens|context|too long/i.test(body)) {
    return new ProviderError(`Too long for this model: ${snippet}`, "schema", status);
  }
  return new ProviderError(`Anthropic error ${status}: ${snippet}`, "unknown", status);
}

export function createAnthropicProvider(cfg: Config): Provider {
  return {
    id: "anthropic",

    async chat(req: ChatRequest): Promise<ChatResult> {
      const base = (cfg.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "");
      const { system, msgs } = toWire(req.messages);

      const body: Record<string, unknown> = {
        model: req.model,
        messages: msgs,
        // Required by the API, so it is always sent rather than only when the caller asked.
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      };
      if (system) body.system = system;
      if (req.temperature != null) body.temperature = req.temperature;
      if (req.tools?.length) {
        body.tools = req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          // Anthropic calls it `input_schema`; the object inside is the same JSON Schema.
          input_schema: t.parameters,
        }));
        if (req.toolChoice === "required") body.tool_choice = { type: "any" };
      }

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error("provider timeout")), cfg.timeoutMs ?? 120_000);
      const onAbort = () => ac.abort(req.signal?.reason);
      req.signal?.addEventListener("abort", onAbort, { once: true });

      let res: Response;
      try {
        res = await fetch(`${base}/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": cfg.apiKey,
            "anthropic-version": VERSION,
          },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
      }

      if (!res.ok) throw classify(res.status, await res.text().catch(() => ""));

      const json: any = await res.json();

      // Tool calls live INSIDE the content array, interleaved with the text.
      const toolCalls: ToolCall[] = [];
      let text = "";
      for (const block of json?.content ?? []) {
        if (block?.type === "text") text += String(block.text ?? "");
        else if (block?.type === "tool_use") {
          toolCalls.push({ id: String(block.id), name: String(block.name), args: block.input ?? {} });
        }
      }

      const stop = json?.stop_reason === "tool_use"
        ? "tool_calls"
        : json?.stop_reason === "max_tokens"
          ? "length"
          : json?.stop_reason === "end_turn"
            ? "stop"
            : "other";

      return {
        text,
        toolCalls,
        stop,
        usage: {
          inputTokens: Number(json?.usage?.input_tokens ?? 0),
          outputTokens: Number(json?.usage?.output_tokens ?? 0),
          // Anthropic reports cache reads separately, and they are billed at a tenth of the rate —
          // so counting them as ordinary input would overstate a repeated prompt by an order of
          // magnitude, on exactly the lane that repeats a prompt a million times.
          cachedInputTokens: Number(json?.usage?.cache_read_input_tokens ?? 0) || undefined,
        },
        // What answered, not what was asked for.
        model: String(json?.model ?? req.model),
      };
    },
  };
}
