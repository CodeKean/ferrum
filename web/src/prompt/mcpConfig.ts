// The shape of an MCP column's settings, on the browser side.
//
// A plain module rather than part of McpSettings.tsx, for the same reason `httpConfig.ts` is: the
// test runner imports these types, and importing a component pulls in `import "./X.css"`, which the
// runner cannot parse. Anything a test or a preset needs to see lives here.
//
// Mirrors `src/mcp/mcpColumn.ts`. The server is the authority — it normalises on save and refuses
// what it cannot accept — so nothing here enforces, it only explains.

export interface Pair {
  name: string;
  value: string;
}

export interface McpCost {
  unit: string;
  perCall: number;
  packUnits: number;
  packUsd: number;
}

export interface McpConfig {
  serverId: string;
  tool: string;
  args: Pair[];
  responsePath: string;
  cost?: McpCost;
  timeoutMs: number;
}

export const DEFAULT_MCP: McpConfig = {
  serverId: "",
  tool: "",
  args: [],
  responsePath: "",
  timeoutMs: 30_000,
};

/** A registered app, as `GET /api/mcp/servers` returns it. */
export interface McpServer {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Pair[];
  allowPrivate?: boolean;
  createdAt: string;
}

/** A tool, as the discovery route returns it. */
export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The argument names a tool's schema declares, and which of them are required.
 *
 * Used to pre-fill the argument rows when a tool is picked, so the form starts from what the tool
 * actually takes rather than from a blank box the user has to guess at.
 */
export function argsFromSchema(schema: Record<string, unknown> | undefined): { name: string; required: boolean }[] {
  const props = (schema?.properties ?? {}) as Record<string, unknown>;
  const required = new Set(Array.isArray(schema?.required) ? (schema!.required as string[]) : []);
  return Object.keys(props).map((name) => ({ name, required: required.has(name) }));
}

/**
 * What one call costs, mirroring `callCost` on the server.
 *
 * Shown beside the price fields so the number the user is agreeing to is visible while they type it,
 * rather than only appearing in a confirmation dialog later.
 */
export function perCallUsd(cost: McpCost | undefined): number {
  if (!cost) return 0;
  if (cost.packUnits <= 0) return 0;
  return (cost.perCall * cost.packUsd) / cost.packUnits;
}

/** The price as text, at enough precision that a fraction of a cent is not shown as $0.00. */
export function money(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
