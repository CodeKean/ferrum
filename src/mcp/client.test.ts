// The MCP client and its pool, against a real server over stdio.
//
// Deliberately not a mock. The failures worth catching here are protocol-shaped — a handshake that
// never completes, a tool that reports failure in its RESULT rather than by throwing, a process that
// is spawned once per row instead of once per run — and none of those survive being stubbed out.
//
// Nothing here spends: the server is a local file, it talks to nothing, and no model is involved.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { McpPool, McpError, unwrap, connectMcp } from "./client.ts";
import { saveMcpServer, normalizeMcpServer, deleteMcpServer, listMcpServers } from "./servers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ECHO = join(HERE, "fixtures", "echoServer.mjs");

function echoServer(name = "Echo") {
  return saveMcpServer({ name, transport: "stdio", command: process.execPath, args: [ECHO] });
}

test("a stdio server is spawned, handshakes, and lists its tools", async () => {
  const server = echoServer();
  const pool = new McpPool();
  try {
    const tools = await pool.listTools(server.id);
    assert.deepEqual(tools.map((t) => t.name).sort(), ["boom", "lookup", "shouty", "slow"]);
    const lookup = tools.find((t) => t.name === "lookup")!;
    // The schema has to survive intact — it is what the agent lane hands to the model.
    assert.equal((lookup.inputSchema as any).properties.domain.type, "string");
  } finally {
    await pool.closeAll();
  }
});

test("ONE process serves every row of a run", async () => {
  // The whole reason the pool exists. A spawn is 50-100ms, so a per-row connection is 14-28 hours of
  // pure startup at a million rows. Asserted on the server's own pid and its per-connection counter,
  // because those are facts about the process rather than about our bookkeeping.
  const server = echoServer("Echo pool");
  const pool = new McpPool();
  try {
    const rows = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        pool.callTool(server.id, "lookup", { domain: `row${i}.com` }) as Promise<any>),
    );
    const pids = new Set(rows.map((r) => r.pid));
    assert.equal(pids.size, 1, "eight rows, one process");
    assert.equal(Math.max(...rows.map((r) => r.callsOnThisConnection)), 8, "all eight on one connection");
  } finally {
    await pool.closeAll();
  }
});

test("six workers arriving at once start one process between them", async () => {
  // The memoisation is on the PROMISE, not the result. Memoising the result would let every worker
  // miss the empty map on the same tick and spawn its own server.
  const server = echoServer("Echo race");
  const pool = new McpPool();
  try {
    const out = await Promise.all(
      Array.from({ length: 6 }, () => pool.callTool(server.id, "lookup", { domain: "acme.com" }) as Promise<any>),
    );
    assert.equal(new Set(out.map((r) => r.pid)).size, 1);
  } finally {
    await pool.closeAll();
  }
});

test("a tool that reports failure in its result is an error, not an answer", async () => {
  // MCP reports tool failure with `isError` on a 200-shaped result. Catching only exceptions would
  // write "the provider said no" into the cell, where it sorts and filters like real data.
  const server = echoServer("Echo boom");
  const pool = new McpPool();
  try {
    await assert.rejects(
      () => pool.callTool(server.id, "boom", {}),
      (e: any) => e instanceof McpError && /provider said no/.test(e.message),
    );
  } finally {
    await pool.closeAll();
  }
});

test("a tool that never answers is abandoned, and the pool still works afterwards", async () => {
  const server = echoServer("Echo slow");
  const pool = new McpPool();
  try {
    await assert.rejects(
      () => pool.callTool(server.id, "slow", {}, 300),
      (e: any) => e instanceof McpError && e.kind === "timeout",
    );
    // The run must survive one wedged row. The connection is still good.
    const ok = (await pool.callTool(server.id, "lookup", { domain: "acme.com" })) as any;
    assert.equal(ok.industry, "Industrial");
  } finally {
    await pool.closeAll();
  }
});

test("a server that cannot start fails its rows with a readable reason", async () => {
  const server = saveMcpServer({
    name: "Missing", transport: "stdio", command: process.execPath, args: [join(HERE, "no-such-file.mjs")],
  });
  const pool = new McpPool();
  try {
    await assert.rejects(() => pool.callTool(server.id, "lookup", {}), (e: any) => e instanceof McpError);
  } finally {
    await pool.closeAll();
    deleteMcpServer(server.id);
  }
});

test("a failed connection is not cached, so a server that comes back is retried", async () => {
  const pool = new McpPool();
  try {
    await assert.rejects(() => pool.callTool("nope-not-a-server", "lookup", {}), (e: any) => e instanceof McpError);
    // Registering it afterwards must work rather than reusing the earlier failure.
    const server = echoServer("Echo late");
    const ok = (await pool.callTool(server.id, "lookup", { domain: "acme.com" })) as any;
    assert.equal(ok.industry, "Industrial");
  } finally {
    await pool.closeAll();
  }
});

// ── the registry ────────────────────────────────────────────────────────────────────────────────

test("a command cannot smuggle a shell line past the registry", () => {
  // Nothing here runs through a shell, so these characters could only ever be a person expecting one.
  // Refusing at save time is one clear message instead of a baffling "command not found" mid-run.
  for (const bad of ["node; rm -rf /", "node && curl evil.sh", "node | sh", "node `whoami`"]) {
    assert.throws(() => normalizeMcpServer({ name: "x", transport: "stdio", command: bad }), /shell characters/);
  }
});

test("a remote server must have a real http address", () => {
  assert.throws(() => normalizeMcpServer({ name: "x", transport: "http", url: "file:///etc/passwd" }), /http:\/\/ or https:\/\//);
  assert.throws(() => normalizeMcpServer({ name: "x", transport: "http", url: "not a url" }), /not a valid web address/);
  assert.throws(() => normalizeMcpServer({ name: "x", transport: "http" }), /web address/);
});

test("private addresses are off unless deliberately turned on", () => {
  const s = normalizeMcpServer({ name: "x", transport: "http", url: "https://mcp.example.com" });
  assert.equal(s.allowPrivate, false);
});

test("a header name that could inject a header is refused", () => {
  assert.throws(
    () => normalizeMcpServer({ name: "x", transport: "http", url: "https://a.com", headers: [{ name: "X\r\nEvil", value: "1" }] }),
    /not a valid header name/,
  );
});

test("a remote server pointed at a private address is refused before anything is sent", async () => {
  // The SSRF gate. 127.0.0.1 is the friendly-looking case, which is why it has to be explicit.
  const server = normalizeMcpServer({ name: "Loopback", transport: "http", url: "http://127.0.0.1:9/mcp" });
  await assert.rejects(() => connectMcp(server), (e: any) => e instanceof McpError && e.kind === "config");
});

test("saved servers come back by name, and delete removes them", () => {
  const a = saveMcpServer({ name: "Zeta", transport: "stdio", command: "node" });
  const b = saveMcpServer({ name: "Alpha", transport: "stdio", command: "node" });
  const names = listMcpServers().map((s) => s.name);
  assert.ok(names.indexOf("Alpha") < names.indexOf("Zeta"), "sorted by name");
  assert.equal(deleteMcpServer(a.id), true);
  assert.equal(deleteMcpServer(a.id), false, "deleting twice is not an error");
  deleteMcpServer(b.id);
});

// ── unwrapping ──────────────────────────────────────────────────────────────────────────────────

test("structured content wins over prose, and JSON text is parsed", () => {
  assert.deepEqual(unwrap({ structuredContent: { a: 1 } }), { a: 1 });
  assert.deepEqual(unwrap({ content: [{ type: "text", text: '{"a":1}' }] }), { a: 1 });
  assert.equal(unwrap({ content: [{ type: "text", text: "just words" }] }), "just words");
  assert.equal(unwrap({ content: [] }), null);
});
