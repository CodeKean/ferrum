// A real agent run against the configured provider.
//
// Not a unit test: it spends a fraction of a cent and needs the network, so it is a script you run
// deliberately rather than something in `npm test`. It exists because everything up to this point
// was verified against mocks, and a mock agrees with whatever the code already does. This is the
// first time the loop, the adapter, the tools and a real model meet.
//
//   node scripts/smoke-agent.mjs [model]

import { createOpenRouterProvider } from "../src/providers/openrouter.ts";
import { getProviderKey } from "../src/providers/keys.ts";
import { runAgent, finishTool, buildTaskPrompt } from "../src/agent/loop.ts";
import { buildToolset } from "../src/agent/tools.ts";

const model = process.argv[2] ?? "openai/gpt-4o-mini";

const apiKey = getProviderKey("openrouter");
if (!apiKey) {
  console.error("No OpenRouter key stored. POST it to /api/providers/openrouter/key first.");
  process.exit(1);
}

const provider = createOpenRouterProvider({ apiKey });
const tools = [
  ...buildToolset(["fetch_url"]),
  finishTool("the answer, as plain text"),
];

const task = buildTaskPrompt(
  "Find out what this company does, in one short sentence. Look at their website, then call finish.",
  { Company: "Example Domain", Website: "https://example.com" },
);

console.log(`model: ${model}`);
console.log(`tools: ${tools.map((t) => t.name).join(", ")}\n`);

const started = Date.now();
const res = await runAgent({
  provider,
  model,
  system:
    "You are a research assistant filling one cell of a spreadsheet. Use the tools to find the " +
    "answer, then call finish. Be brief. If you cannot find it, call finish with found=false.",
  task,
  tools,
  maxTurns: 6,
  onDenied: (call, why) => console.log(`  [denied] ${call.name}: ${why}`),
});

console.log(`stopped by : ${res.stoppedBy}`);
console.log(`turns      : ${res.turns}, tool calls: ${res.toolCalls}`);
console.log(`tokens     : ${res.usage.inputTokens} in / ${res.usage.outputTokens} out`);
console.log(`model used : ${res.model}`);
console.log(`elapsed    : ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`answer     : ${JSON.stringify(res.structured ?? res.text, null, 2)}`);

console.log("\ntranscript:");
for (const m of res.messages) {
  const label = m.role.padEnd(9);
  if (m.role === "assistant" && m.toolCalls?.length) {
    console.log(`  ${label} -> ${m.toolCalls.map((t) => `${t.name}(${JSON.stringify(t.args).slice(0, 90)})`).join(", ")}`);
  } else if (m.role === "tool") {
    console.log(`  ${label} <- ${String(m.content).replace(/\s+/g, " ").slice(0, 110)}`);
  } else {
    console.log(`  ${label}    ${String(m.content).replace(/\s+/g, " ").slice(0, 110)}`);
  }
}

// A run that ends without calling finish is not a failure of the provider — it means the caps, the
// prompt or the model's tool-calling is off, and that is worth surfacing loudly here.
if (res.stoppedBy !== "finish_tool") {
  console.error(`\nWARNING: expected the agent to call finish; it stopped by "${res.stoppedBy}".`);
  process.exit(2);
}
