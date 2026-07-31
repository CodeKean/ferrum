// What an `mcp` column is configured with.
//
// The twin of `src/http/httpColumn.ts`, and it reuses that file's interpolation, its cost block and
// its escaping rather than growing its own. The two lanes ask a third party a question once per row;
// they differ only in how the question travels.
//
// The one shape that is genuinely different: an HTTP request has a URL, a method and a body, while
// an MCP call has a tool name and a bag of named arguments matching a schema the SERVER publishes.
// So the config is a server, a tool, and the arguments — and the arguments carry `{{col:N}}`
// references exactly as query parameters do.

import { DEFAULT_HTTP, type HttpCost, type Pair } from "../http/httpColumn.ts";

export interface McpConfig {
  /** Which registered server. An id, never a command — see `servers.ts` for why. */
  serverId: string;
  /** The tool on that server. */
  tool: string;
  /** Arguments, whose values may carry `{{col:N}}` references. */
  args: Pair[];
  /**
   * Where in the tool's answer the value is. Blank keeps the whole answer, which is right for a tool
   * that returns one thing and wrong for one that returns a record.
   */
  responsePath: string;
  /**
   * What one call costs, when the user knows. Same shape and same reasoning as the HTTP lane: a
   * provider publishes "N units per call" and "M units cost $X", not a per-call dollar figure.
   *
   * Absent means the price is unknown, which is NOT the same as free — `estimate.ts` reports the
   * lane as `external` so the run says "this bills a third party" rather than quoting $0.00.
   */
  cost?: HttpCost;
  timeoutMs: number;
}

export const DEFAULT_MCP: McpConfig = {
  serverId: "",
  tool: "",
  args: [],
  responsePath: "",
  timeoutMs: 30_000,
};

function int(v: unknown, dflt: number, lo: number, hi: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

function pairs(raw: unknown): Pair[] {
  if (!Array.isArray(raw)) return [];
  const out: Pair[] = [];
  for (const p of raw as Array<Record<string, unknown>>) {
    const name = String(p?.name ?? "").trim();
    if (!name) continue;
    out.push({ name, value: String(p?.value ?? "") });
  }
  return out;
}

/**
 * Validate a saved configuration.
 *
 * Normalised on SAVE, not on run, for the reason `normalizeHttpConfig` states: a bad tool name
 * discovered per row is discovered mid-run, having already spent whatever the earlier rows cost.
 */
export function normalizeMcpConfig(raw: unknown): McpConfig {
  const r = (raw ?? {}) as Record<string, any>;

  const cfg: McpConfig = {
    ...DEFAULT_MCP,
    serverId: String(r.serverId ?? "").trim(),
    tool: String(r.tool ?? "").trim(),
    args: pairs(r.args),
    responsePath: String(r.responsePath ?? "").trim(),
    // Bounded by the pool's own ceiling. A per-row wait longer than this multiplies against the row
    // count into a run nobody can sit through.
    timeoutMs: int(r.timeoutMs, DEFAULT_MCP.timeoutMs, 1000, 120_000),
  };

  // Duplicate argument names are refused rather than last-one-wins. A tool called with the wrong
  // argument silently answers about the wrong thing, which is the failure this whole app exists to
  // stop being invisible.
  const seen = new Set<string>();
  for (const a of cfg.args) {
    const key = a.name.toLowerCase();
    if (seen.has(key)) throw new Error(`The argument "${a.name}" is set twice.`);
    seen.add(key);
  }

  const cost = r.cost as Record<string, any> | undefined;
  if (cost) {
    const c: HttpCost = {
      unit: String(cost.unit ?? "").trim() || "call",
      // A negative price would make a table's running total go DOWN as it spent.
      perCall: Math.max(0, Number(cost.perCall) || 0),
      packUnits: Math.max(0, Number(cost.packUnits) || 0),
      packUsd: Math.max(0, Number(cost.packUsd) || 0),
    };
    // All-zero means "not priced". Kept off the config entirely so `callCost` reports no units and
    // the estimate says "we cannot price this" rather than "this is free".
    if (c.perCall > 0 || c.packUnits > 0 || c.packUsd > 0) cfg.cost = c;
  }

  return cfg;
}

/** Everything in the config that can carry a `{{col:N}}` reference. */
export function refTemplates(cfg: McpConfig): string[] {
  return cfg.args.map((a) => a.value);
}

// Re-exported so the settings panel and the executor have one import for the lane, matching how
// `HttpSettings` re-exports `httpConfig`.
export { DEFAULT_HTTP, type HttpCost, type Pair };
