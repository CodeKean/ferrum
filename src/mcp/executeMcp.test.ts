// The `mcp` column lane, against a real MCP server.
//
// The assertions worth having here are about WHERE a row stops, because that is what decides whether
// it was charged. A skip must not carry a charge; a failure must. Getting that backwards is the
// difference between a cost report that can be trusted and one that quietly under- or over-states a
// bill nobody can check against.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createSheet, addColumn, insertRows, getColumn, setColumnMcpConfig } from "../store.ts";
import { db } from "../db.ts";
import { saveMcpServer } from "./servers.ts";
import { normalizeMcpConfig } from "./mcpColumn.ts";
import { executeMcpCell } from "./executeMcp.ts";
import { McpPool } from "./client.ts";
import type { CellJob } from "../runs.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ECHO = join(HERE, "fixtures", "echoServer.mjs");

const rowIdsOf = (sheetId: string): number[] =>
  (db.prepare("SELECT id FROM rows WHERE sheet_id = ? ORDER BY position").all(sheetId) as Array<{ id: number }>)
    .map((r) => Number(r.id));

function setup(name: string, cfg: Record<string, unknown>) {
  const server = saveMcpServer({ name: `${name}-app`, transport: "stdio", command: process.execPath, args: [ECHO] });
  const sheet = createSheet(name);
  const domain = addColumn(sheet.id, { name: "Domain", valueType: "url" });
  const out = addColumn(sheet.id, { name: "Industry", kind: "mcp" });
  insertRows(sheet.id, [{ values: { [Number(domain.id)]: "acme.com" } }], 0, [Number(domain.id)]);
  const rowId = rowIdsOf(sheet.id)[0]!;

  setColumnMcpConfig(out.id, normalizeMcpConfig({ serverId: server.id, ...cfg }) as never);
  return { server, sheet, domain, out, rowId };
}

const job = (sheetId: string, rowId: number, columnId: number): CellJob => ({
  runId: `test-${columnId}`, sheetId, rowId, columnId, kind: "mcp", attempt: 0,
});

test("a row is filled from the tool's answer, through the column's chosen field", async () => {
  const f = setup("mcp-happy", {
    tool: "lookup",
    args: [{ name: "domain", value: "{{col:REPLACE}}" }],
    responsePath: "industry",
  });
  // The reference is written by id, which is what survives a rename.
  setColumnMcpConfig(f.out.id, normalizeMcpConfig({
    serverId: f.server.id, tool: "lookup", responsePath: "industry",
    args: [{ name: "domain", value: `{{col:${f.domain.id}}}` }],
  }) as never);

  const pool = new McpPool();
  try {
    const out = await executeMcpCell(job(f.sheet.id, f.rowId, Number(f.out.id)), getColumn(f.out.id)!, pool);
    assert.equal(out.status, "done");
    assert.equal(out.valueText, "Industrial");
  } finally {
    await pool.closeAll();
  }
});

test("a row with nothing in the referenced column is SKIPPED, and never charged", async () => {
  // The whole reason a reference can be required. A tool called with a blank domain still answers,
  // and the answer is about nothing — once per row, at whatever that tool charges.
  const f = setup("mcp-missing", {});
  const blank = addColumn(f.sheet.id, { name: "Blank" });
  setColumnMcpConfig(f.out.id, normalizeMcpConfig({
    serverId: f.server.id, tool: "lookup", responsePath: "industry",
    args: [{ name: "domain", value: `{{col:${blank.id}}}` }],
    cost: { unit: "credit", perCall: 2, packUnits: 1000, packUsd: 49 },
  }) as never);

  const pool = new McpPool();
  try {
    const out = await executeMcpCell(job(f.sheet.id, f.rowId, Number(f.out.id)), getColumn(f.out.id)!, pool);
    assert.equal(out.status, "skipped");
    assert.match(String(out.errorMsg), /\/Blank/);
    assert.equal(out.costUsd, undefined, "a row that was never called was never charged");
    assert.equal(out.units, undefined);
  } finally {
    await pool.closeAll();
  }
});

test("a tool that fails IS charged, because the provider bills for the call", async () => {
  const f = setup("mcp-boom", {});
  setColumnMcpConfig(f.out.id, normalizeMcpConfig({
    serverId: f.server.id, tool: "boom", args: [],
    cost: { unit: "credit", perCall: 2, packUnits: 1000, packUsd: 49 },
  }) as never);

  const pool = new McpPool();
  try {
    const out = await executeMcpCell(job(f.sheet.id, f.rowId, Number(f.out.id)), getColumn(f.out.id)!, pool);
    assert.equal(out.status, "error");
    assert.equal(out.errorType, "tool");
    // 2 credits at $49 per 1,000 = $0.098. A run against a broken tool that burned two thousand
    // credits has to SHOW two thousand credits.
    assert.ok(Math.abs((out.costUsd ?? 0) - 0.098) < 1e-9, `charged ${out.costUsd}`);
    assert.equal(out.units, 2);
  } finally {
    await pool.closeAll();
  }
});

test("a path that finds nothing is not_found, not a blank answer", async () => {
  const f = setup("mcp-path", {});
  setColumnMcpConfig(f.out.id, normalizeMcpConfig({
    serverId: f.server.id, tool: "lookup", responsePath: "no.such.field",
    args: [{ name: "domain", value: `{{col:${f.domain.id}}}` }],
  }) as never);

  const pool = new McpPool();
  try {
    const out = await executeMcpCell(job(f.sheet.id, f.rowId, Number(f.out.id)), getColumn(f.out.id)!, pool);
    assert.equal(out.status, "not_found");
  } finally {
    await pool.closeAll();
  }
});

test("a column with no app or no tool chosen is skipped, not errored", async () => {
  // An unconfigured column is not a failure of these rows. Marking a million of them as errors
  // buries every real failure underneath.
  const f = setup("mcp-unset", {});
  setColumnMcpConfig(f.out.id, normalizeMcpConfig({ serverId: f.server.id, tool: "" }) as never);
  const pool = new McpPool();
  try {
    const out = await executeMcpCell(job(f.sheet.id, f.rowId, Number(f.out.id)), getColumn(f.out.id)!, pool);
    assert.equal(out.status, "skipped");
  } finally {
    await pool.closeAll();
  }
});

test("an app that has been removed is a readable error, not a crash", async () => {
  const f = setup("mcp-gone", {});
  setColumnMcpConfig(f.out.id, normalizeMcpConfig({ serverId: "no-longer-here", tool: "lookup" }) as never);
  const pool = new McpPool();
  try {
    const out = await executeMcpCell(job(f.sheet.id, f.rowId, Number(f.out.id)), getColumn(f.out.id)!, pool);
    assert.equal(out.status, "error");
    assert.equal(out.errorType, "schema");
    assert.match(String(out.errorMsg), /not set up/);
  } finally {
    await pool.closeAll();
  }
});

test("a cell cannot smuggle a reference into another column", async () => {
  // Interpolation is single pass. If it were recursive, a cell holding `{{col:N}}` — trivially
  // achievable from any scraped page — would expand on the second pass and read a column this
  // column never named. One line of code, and the difference between a template engine and a
  // data-exfiltration primitive.
  const f = setup("mcp-inject", {});
  const secret = addColumn(f.sheet.id, { name: "Secret" });
  const evil = addColumn(f.sheet.id, { name: "Evil" });
  insertRows(f.sheet.id, [{
    values: { [Number(secret.id)]: "classified", [Number(evil.id)]: `{{col:${secret.id}}}` },
  }], 1, [Number(secret.id), Number(evil.id)]);
  const rowId = rowIdsOf(f.sheet.id)[1]!;

  setColumnMcpConfig(f.out.id, normalizeMcpConfig({
    serverId: f.server.id, tool: "lookup", responsePath: "domain",
    args: [{ name: "domain", value: `{{col:${evil.id}}}` }],
  }) as never);

  const pool = new McpPool();
  try {
    const out = await executeMcpCell(job(f.sheet.id, rowId, Number(f.out.id)), getColumn(f.out.id)!, pool);
    // The tool echoes back what it was sent. It must be the literal text, never "classified".
    assert.equal(out.valueText, `{{col:${secret.id}}}`);
    assert.notEqual(out.valueText, "classified");
  } finally {
    await pool.closeAll();
  }
});

// ── the config ──────────────────────────────────────────────────────────────────────────────────

test("the same argument set twice is refused rather than last-one-wins", () => {
  assert.throws(
    () => normalizeMcpConfig({ serverId: "s", tool: "t", args: [{ name: "domain", value: "a" }, { name: "Domain", value: "b" }] }),
    /set twice/,
  );
});

test("an all-zero price is dropped, so the estimate says unknown rather than free", () => {
  // "We cannot price this" and "this is free" are opposite statements, and only one is true.
  const cfg = normalizeMcpConfig({ serverId: "s", tool: "t", cost: { unit: "credit", perCall: 0, packUnits: 0, packUsd: 0 } });
  assert.equal(cfg.cost, undefined);
});

test("a negative price cannot make a running total go down", () => {
  const cfg = normalizeMcpConfig({ serverId: "s", tool: "t", cost: { unit: "credit", perCall: -5, packUnits: 100, packUsd: 10 } });
  assert.equal(cfg.cost!.perCall, 0);
});

test("the per-row timeout is clamped, because it multiplies against the row count", () => {
  assert.equal(normalizeMcpConfig({ serverId: "s", tool: "t", timeoutMs: 999_999 }).timeoutMs, 120_000);
  assert.equal(normalizeMcpConfig({ serverId: "s", tool: "t", timeoutMs: 1 }).timeoutMs, 1000);
});
