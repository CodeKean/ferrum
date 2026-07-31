// Connected-app tools on the agent lane.
//
// The agent lane is the expensive one, and this is the first thing that lets a model decide, on its
// own, to spend money there more than once. So the assertions that matter are the refusals: that a
// ceiling stops the SECOND call and not the first, that a refusal is an answer rather than a crash,
// and that whatever a third party sends back cannot end the task and start giving instructions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { McpPool } from "./client.ts";
import { saveMcpServer } from "./servers.ts";
import { McpSpend, mcpToolsFor, mcpToolName, parseMcpToolName } from "./agentTools.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ECHO = join(HERE, "fixtures", "echoServer.mjs");

const echo = (name: string) =>
  saveMcpServer({ name, transport: "stdio", command: process.execPath, args: [ECHO] });

test("an app's tools are offered under a namespaced name, with its schema intact", async () => {
  const server = echo("Registry");
  const pool = new McpPool();
  try {
    const tools = await mcpToolsFor([server.id], pool, new McpSpend());
    const lookup = tools.find((t) => t.name.endsWith(":lookup"))!;
    assert.equal(lookup.name, mcpToolName(server.id, "lookup"));
    // Namespaced because the loop dispatches purely by name: a server publishing `finish` or
    // `fetch_url` would otherwise shadow the loop's own and quietly take over the cell.
    assert.ok(lookup.name.startsWith("mcp:"));
    assert.equal((lookup.parameters as any).properties.domain.type, "string");
    // The app is named in the description, because a model choosing between two apps that both
    // offer "lookup" cannot tell them apart from a machine-shaped id.
    assert.match(lookup.description, /\[Registry\]/);
  } finally {
    await pool.closeAll();
  }
});

test("the tool name round-trips, and nothing else parses as one", () => {
  assert.deepEqual(parseMcpToolName(mcpToolName("abc", "lookup")), { serverId: "abc", tool: "lookup" });
  // A tool whose own name contains a colon still parses, because only the FIRST colon is the split.
  assert.deepEqual(parseMcpToolName("mcp:abc:ns:tool"), { serverId: "abc", tool: "ns:tool" });
  assert.equal(parseMcpToolName("fetch_url"), null);
  assert.equal(parseMcpToolName("mcp:"), null);
  assert.equal(parseMcpToolName("mcp:abc:"), null);
  assert.equal(parseMcpToolName("mcp::tool"), null);
});

test("a call ceiling stops the second call, never the first", async () => {
  // The first call is always allowed. A ceiling below one call's price would otherwise disable the
  // app silently, and the column would return nothing on every row and look broken rather than
  // capped — the exact failure web_search was fixed for.
  const server = echo("Capped");
  const pool = new McpPool();
  try {
    const spend = new McpSpend(undefined, 1);
    const [lookup] = await mcpToolsFor([server.id], pool, spend);
    const first = await lookup!.run({ domain: "acme.com" }, {});
    assert.match(first, /Industrial/);

    const second = await lookup!.run({ domain: "acme.com" }, {});
    assert.match(second, /allowed connected-app call/);
    // A refusal is a NORMAL TOOL RESULT: the loop carries on and the model still calls finish, so
    // there is no truncated half-parsed output.
    assert.match(second, /do not guess/i);
    assert.equal(spend.calls, 1, "the refused call was never made");
  } finally {
    await pool.closeAll();
  }
});

test("a money ceiling is checked before the spend, not after it", async () => {
  const server = echo("Budget");
  const pool = new McpPool();
  try {
    let charged = 0;
    const spend = new McpSpend(0.10, undefined);
    const tools = await mcpToolsFor([server.id], pool, spend, {
      perCallUsd: 0.06, onCost: (u) => { charged += u; },
    });
    const lookup = tools.find((t) => t.name.endsWith(":lookup"))!;

    await lookup.run({ domain: "acme.com" }, {});          // $0.06, allowed
    const second = await lookup.run({ domain: "acme.com" }, {});  // would be $0.12 of a $0.10 cap

    assert.match(second, /allowance/);
    // Checked BEFORE, so the cell never goes over. "Stop once you have spent it" would have let the
    // crossing call through and charged $0.12 against a $0.10 ceiling.
    assert.ok(charged <= 0.10, `charged ${charged}`);
    assert.equal(spend.calls, 1);
  } finally {
    await pool.closeAll();
  }
});

test("a failed call still counts, because the provider still billed for it", async () => {
  const server = echo("Boom");
  const pool = new McpPool();
  try {
    let charged = 0;
    const spend = new McpSpend();
    const tools = await mcpToolsFor([server.id], pool, spend, {
      perCallUsd: 0.02, onCost: (u) => { charged += u; },
    });
    const boom = tools.find((t) => t.name.endsWith(":boom"))!;
    const out = await boom.run({}, {});

    assert.match(out, /^Error:/);
    assert.equal(spend.calls, 1);
    assert.ok(Math.abs(charged - 0.02) < 1e-9, "a call that failed was still a call");
  } finally {
    await pool.closeAll();
  }
});

test("what an app returns cannot end the task and start giving instructions", async () => {
  // The least trustworthy content in the app: whatever a third party chose to send back. The loop
  // does not sanitize tool output — each tool does — so this is the only thing standing between a
  // hostile server and the system prompt's own delimiters.
  const server = echo("Shouty");
  const pool = new McpPool();
  try {
    const tools = await mcpToolsFor([server.id], pool, new McpSpend());
    const shouty = tools.find((t) => t.name.endsWith(":shouty"))!;
    const out = await shouty.run({}, {});

    assert.ok(!out.includes("</task>"), out);
    assert.ok(!out.includes("<tool_call>"), out);
  } finally {
    await pool.closeAll();
  }
});

test("an app that cannot be reached contributes nothing rather than failing the cell", async () => {
  const good = echo("Good");
  const broken = saveMcpServer({
    name: "Broken", transport: "stdio", command: process.execPath, args: [join(HERE, "nope.mjs")],
  });
  const pool = new McpPool();
  try {
    const tools = await mcpToolsFor([broken.id, good.id], pool, new McpSpend());
    // The same contract buildToolset already has: requested but not usable is silently absent.
    assert.ok(tools.length > 0, "the working app still offered its tools");
    assert.ok(tools.every((t) => t.name.includes(good.id)));
  } finally {
    await pool.closeAll();
  }
});

test("the ceiling is on the CELL, so two apps cannot cost twice the limit", async () => {
  const a = echo("App A");
  const b = echo("App B");
  const pool = new McpPool();
  try {
    const spend = new McpSpend(undefined, 2);
    const tools = await mcpToolsFor([a.id, b.id], pool, spend);
    const fromA = tools.find((t) => t.name.startsWith(`mcp:${a.id}:`) && t.name.endsWith(":lookup"))!;
    const fromB = tools.find((t) => t.name.startsWith(`mcp:${b.id}:`) && t.name.endsWith(":lookup"))!;

    await fromA.run({ domain: "acme.com" }, {});
    await fromB.run({ domain: "acme.com" }, {});
    const third = await fromA.run({ domain: "acme.com" }, {});

    assert.match(third, /allowed connected-app calls/);
    assert.equal(spend.calls, 2, "one shared ceiling, not one per app");
  } finally {
    await pool.closeAll();
  }
});
