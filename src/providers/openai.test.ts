// The OpenAI-compatible adapter, against a real HTTP server.
//
// The unit tests exercise the loop with a fake provider; these exercise the WIRE — the request we
// actually send, the shapes we accept back, and the error classification the retry policy depends
// on. A server on an ephemeral port costs nothing and catches the things a hand-written fake cannot,
// because a fake agrees with whatever the code does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createOpenAIProvider } from "./openai.ts";
import { ProviderError } from "./types.ts";
import { runAgent, finishTool, type AgentTool } from "../agent/loop.ts";
import { webSearchTool, buildToolset } from "../agent/tools.ts";

/** Start a server that answers /chat/completions with scripted bodies. */
async function serve(handler: (body: any, n: number) => { status?: number; json: unknown }): Promise<{
  url: string; close: () => Promise<void>; requests: any[];
}> {
  const requests: any[] = [];
  let n = 0;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body: any = null;
      try { body = JSON.parse(raw || "{}"); } catch { /* leave null */ }
      requests.push({ url: req.url, headers: req.headers, body });
      const out = handler(body, n++);
      res.writeHead(out.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.json));
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const msg = (m: Record<string, unknown>) => ({
  model: "test-model",
  choices: [{ index: 0, message: m, finish_reason: m.tool_calls ? "tool_calls" : "stop" }],
  usage: { prompt_tokens: 11, completion_tokens: 7 },
});

test("a standard tool call round-trips over the wire", async () => {
  const s = await serve((_b, n) =>
    n === 0
      ? { json: msg({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: '{"s":"hi"}' } }] }) }
      : { json: msg({ role: "assistant", content: "all done" }) },
  );

  try {
    const echo: AgentTool = {
      name: "echo", description: "", parameters: { type: "object", properties: {} },
      async run(a) { return `echoed:${a.s}`; },
    };
    const res = await runAgent({
      provider: createOpenAIProvider({ id: "t", baseUrl: s.url }),
      model: "test-model", system: "s", task: "t", tools: [echo],
    });

    assert.equal(res.stoppedBy, "answered");
    assert.equal(res.text, "all done");
    assert.equal(res.usage.inputTokens, 22, "usage accumulates across turns");

    // The tool result must go back in the shape servers expect, or the second turn is incoherent.
    const second = s.requests[1]!.body;
    const toolMsg = second.messages.find((m: any) => m.role === "tool");
    assert.equal(toolMsg.tool_call_id, "c1");
    assert.equal(toolMsg.content, "echoed:hi");
    // Arguments go back as a STRING; some hosts reject the object form.
    const asst = second.messages.find((m: any) => m.role === "assistant" && m.tool_calls);
    assert.equal(typeof asst.tool_calls[0].function.arguments, "string");
  } finally {
    await s.close();
  }
});

test("a Hermes-style call in the text drives the loop just like a structured one", async () => {
  const s = await serve((_b, n) =>
    n === 0
      ? {
          // No tool_calls field at all — the call is prose. This is what several local runtimes
          // return, and it is the case that silently produced an empty turn before the fallback.
          json: msg({
            role: "assistant",
            content: 'Checking.\n<tool_call>\n{"name": "finish", "arguments": {"found": true, "value": "29", "confidence": "high"}}\n</tool_call>',
          }),
        }
      : { json: msg({ role: "assistant", content: "unused" }) },
  );

  try {
    const res = await runAgent({
      provider: createOpenAIProvider({ id: "local", baseUrl: s.url }),
      model: "hermes-style", system: "s", task: "t", tools: [finishTool("the price")],
    });

    assert.equal(res.stoppedBy, "finish_tool");
    assert.deepEqual(res.structured, { found: true, value: "29", confidence: "high" });
    assert.equal(s.requests.length, 1, "it answered in one turn, not by stalling into another");
  } finally {
    await s.close();
  }
});

test("no key is sent when there is none, so a local runtime is reachable", async () => {
  const s = await serve(() => ({ json: msg({ role: "assistant", content: "ok" }) }));
  try {
    await createOpenAIProvider({ id: "ollama", baseUrl: s.url }).chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
    // `Bearer undefined` is rejected outright by Ollama and LM Studio.
    assert.equal(s.requests[0]!.headers.authorization, undefined);
  } finally {
    await s.close();
  }
});

test("failures are classified, because the retry policy switches on the class", async () => {
  const cases: Array<[number, unknown, string]> = [
    [401, { error: { message: "bad key" } }, "auth"],
    [429, { error: { message: "slow down" } }, "rate_limit"],
    [402, { error: { message: "no credit" } }, "budget"],
    [503, { error: { message: "overloaded" } }, "overloaded"],
  ];

  for (const [status, json, expected] of cases) {
    const s = await serve(() => ({ status, json }));
    try {
      const p = createOpenAIProvider({ id: "t", baseUrl: s.url });
      await assert.rejects(
        () => p.chat({ model: "m", messages: [] }),
        (e: unknown) => {
          assert.ok(e instanceof ProviderError);
          // Getting this wrong is the difference between one paused run and three minutes of
          // pointless backoff on every cell of a hundred thousand.
          assert.equal(e.cls, expected, `HTTP ${status} must classify as ${expected}`);
          return true;
        },
      );
    } finally {
      await s.close();
    }
  }
});

test("a 200 carrying an error object is still an error", async () => {
  // Several hosts answer 200 with {"error": ...} rather than a non-2xx status. Trusting the status
  // alone yields an empty answer written into the cell as though it succeeded.
  const s = await serve(() => ({ status: 200, json: { error: { message: "model not found" } } }));
  try {
    const p = createOpenAIProvider({ id: "t", baseUrl: s.url });
    await assert.rejects(() => p.chat({ model: "nope", messages: [] }), /model not found/);
  } finally {
    await s.close();
  }
});

test("web search: the plugin is sent, and the citations are what comes back", async () => {
  const s = await serve(() => ({
    json: msg({
      role: "assistant",
      content: "Their starter plan looks like £29.",
      annotations: [
        { type: "url_citation", url_citation: { url: "https://acme.com/pricing", title: "Pricing — Acme", content: "Starter £29/mo" } },
        { type: "url_citation", url_citation: { url: "https://acme.com/plans", title: "Plans" } },
        { type: "something_else", other: {} },
      ],
    }),
  }));

  try {
    const provider = createOpenAIProvider({ id: "openrouter", baseUrl: s.url, apiKey: "k" });
    const tool = webSearchTool({ provider, model: "cheap", settings: { maxResults: 5 } });
    const out = await tool.run({ query: "acme pricing" }, {});

    const sent = s.requests[0]!.body;
    // Only what was actually configured. Defaults are left off so OpenRouter applies its own.
    assert.deepEqual(sent.plugins, [{ id: "web", max_results: 5 }]);

    // The citations are the payload. A search that returned only the model's prose about the results
    // would have thrown away both the sources and the text worth quoting.
    assert.match(out, /https:\/\/acme\.com\/pricing/);
    assert.match(out, /Starter £29\/mo/);
    assert.match(out, /2 result\(s\)/, "the non-citation annotation is ignored");
  } finally {
    await s.close();
  }
});

test("a search with no results says so, rather than looking like a failure", async () => {
  const s = await serve(() => ({ json: msg({ role: "assistant", content: "I found nothing." }) }));
  try {
    const provider = createOpenAIProvider({ id: "openrouter", baseUrl: s.url, apiKey: "k" });
    const out = await webSearchTool({ provider, model: "cheap" }).run({ query: "nothing at all" }, {});
    // Treated as an error, the model would retry a search that will return nothing again.
    assert.match(out, /No results/);
  } finally {
    await s.close();
  }
});

test("search cost is reported so a run's spend is not under-counted", async () => {
  const s = await serve(() => ({ json: msg({ role: "assistant", content: "x" }) }));
  try {
    const spent: number[] = [];
    const provider = createOpenAIProvider({ id: "openrouter", baseUrl: s.url, apiKey: "k" });
    await webSearchTool({ provider, model: "cheap", settings: { maxResults: 5 }, onCost: (u) => spent.push(u) })
      .run({ query: "q" }, {});
    assert.deepEqual(spent, [0.005]);
  } finally {
    await s.close();
  }
});

test("asking for web_search without a configured provider yields no tool, not a broken one", () => {
  const without = buildToolset(["fetch_url", "web_search"]);
  assert.deepEqual(without.map((t) => t.name), ["fetch_url"]);
});

test("the model that ANSWERED is reported, not the one that was asked for", async () => {
  const s = await serve(() => ({ json: { ...msg({ role: "assistant", content: "hi" }), model: "actually-served-this" } }));
  try {
    const r = await createOpenAIProvider({ id: "t", baseUrl: s.url }).chat({ model: "asked-for-this", messages: [] });
    // Providers substitute. Pricing against the requested model is how an estimate drifts from
    // the invoice.
    assert.equal(r.model, "actually-served-this");
  } finally {
    await s.close();
  }
});

test("the caller giving up is reported as a cancellation, not as a timeout", async () => {
  // A server that accepts the request and never answers, so the only way out is an abort.
  const server = createServer(() => { /* hang */ });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;

  try {
    const ac = new AbortController();
    // Far longer than the test takes, so if this comes back as a timeout the message is reporting a
    // ceiling nobody reached — which is exactly what the assistant panel showed: "Timed out after
    // 180000ms" twenty-five seconds after the request started.
    const provider = createOpenAIProvider({ id: "t", baseUrl: `http://127.0.0.1:${port}/v1`, timeoutMs: 180_000 });
    const call = provider.chat({ model: "m", system: "s", messages: [{ role: "user", content: "hi" }], signal: ac.signal } as any);
    setTimeout(() => ac.abort(new Error("superseded")), 50);

    const err = await call.then(() => null, (e) => e);
    assert.ok(err instanceof ProviderError, "an abort must still arrive classified");
    assert.equal(err.cls, "cancelled", "the caller stopped it; the provider did nothing wrong");
    assert.doesNotMatch(err.message, /timed out/i, "must not name a timeout that did not happen");
    assert.doesNotMatch(err.message, /180000/, "must not quote a ceiling nobody waited for");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("a real timeout reports how long it actually waited, not the ceiling", async () => {
  const server = createServer(() => { /* hang */ });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;

  try {
    const provider = createOpenAIProvider({ id: "t", baseUrl: `http://127.0.0.1:${port}/v1`, timeoutMs: 120 });
    const err = await provider
      .chat({ model: "m", system: "s", messages: [{ role: "user", content: "hi" }] } as any)
      .then(() => null, (e) => e);

    assert.ok(err instanceof ProviderError);
    assert.equal(err.cls, "timeout");
    const ms = Number(/(\d+)ms/.exec(err.message)?.[1]);
    // STRICTLY greater than the ceiling. Elapsed time always overshoots the timer it fired from —
    // the abort has to propagate and the rejection has to be handled — whereas printing the ceiling
    // back gives exactly 120. `>= 120` would pass on both and prove nothing.
    assert.ok(ms > 120, `reported exactly the ${ms}ms ceiling, so this is the setting and not elapsed time`);
    assert.ok(ms < 30_000, `reported ${ms}ms for a 120ms ceiling`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
