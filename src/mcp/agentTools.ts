// Connected-app tools, offered to the `agent` lane.
//
// The column lane asks ONE tool ONE question per row. This is the other half: an agent that can
// choose, mid-reasoning, to call any tool on the apps its column was given. Same servers, same pool,
// same registry — the difference is who decides when to call, and that difference is why the ceilings
// below exist.
//
// Modelled on `web_search` in `agent/tools.ts`, which is the only other tool in the app that spends
// money, and every awkward-looking decision here is copied from it deliberately:
//
//   - the counters are CLOSED OVER, per cell, so nothing inside the loop can reset them
//   - the ceiling is checked BEFORE the call, because a limit tested afterwards is a report
//   - the FIRST call is always allowed, or a ceiling below one call's price disables the app
//     silently and the column looks broken rather than capped
//   - a refusal is a NORMAL TOOL RESULT, never an abort: the model takes another turn and still
//     calls `finish`, so there is no truncated half-parsed output
//
// NAMES ARE NAMESPACED — `mcp:<serverId>:<tool>`. A server that published a tool called `finish` or
// `fetch_url` would otherwise shadow the loop's own, and the loop dispatches purely by name.

import type { AgentTool } from "../agent/loop.ts";
import { sanitize } from "../agent/loop.ts";
import { McpPool, type McpToolInfo } from "./client.ts";
import { getMcpServer } from "./servers.ts";

/** The prefix that separates a connected app's tools from the built-in ones. */
export const MCP_TOOL_PREFIX = "mcp:";

export function mcpToolName(serverId: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${serverId}:${tool}`;
}

/** The inverse. Returns null for anything that is not one of ours. */
export function parseMcpToolName(name: string): { serverId: string; tool: string } | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const cut = rest.indexOf(":");
  if (cut <= 0 || cut === rest.length - 1) return null;
  return { serverId: rest.slice(0, cut), tool: rest.slice(cut + 1) };
}

export interface McpToolOptions {
  pool: McpPool;
  /** What the tool describes itself as, from `tools/list`. */
  info: McpToolInfo;
  serverId: string;
  serverName: string;
  /** Most this CELL may spend across every connected-app call. Undefined means no ceiling. */
  maxSpendUsd?: number;
  /** Most calls this CELL may make. Undefined means no ceiling. */
  maxCalls?: number;
  /** What one call costs, when the column declares it. */
  perCallUsd?: number;
  /** Told what was actually spent, so the cell's total includes it. */
  onCost?: (usd: number) => void;
}

/**
 * Shared per-cell accounting.
 *
 * One of these per cell, handed to every tool the cell is given — the ceiling is on the CELL, not on
 * each app, so three apps cannot quietly cost three times the limit.
 */
export class McpSpend {
  spent = 0;
  calls = 0;
  constructor(readonly maxSpendUsd?: number, readonly maxCalls?: number) {}
}

const refuse = (why: string): string =>
  `${why} Do not call that app again for this row. Answer using what you already have. If that is ` +
  `not enough, say so plainly and report that the value could not be found — do not guess, and do ` +
  `not infer a plausible-looking answer from nothing.`;

export function mcpAgentTool(opts: McpToolOptions, spend: McpSpend): AgentTool {
  const perCall = opts.perCallUsd ?? 0;

  return {
    name: mcpToolName(opts.serverId, opts.info.name),
    // The server's own description, with the app named. A model choosing between two apps that both
    // offer "lookup" needs to know which is which, and the tool name is machine-shaped.
    description: `[${opts.serverName}] ${opts.info.description || opts.info.name}`,
    // Passed through untouched. It is the server's contract, and rewriting it here would be this
    // file guessing at a schema it did not author.
    parameters: (opts.info.inputSchema && typeof opts.info.inputSchema === "object"
      ? opts.info.inputSchema
      : { type: "object", properties: {} }) as Record<string, unknown>,

    async run(args) {
      if (spend.maxCalls != null && spend.calls >= spend.maxCalls) {
        return refuse(`This row has used its ${spend.maxCalls} allowed connected-app ${spend.maxCalls === 1 ? "call" : "calls"}.`);
      }
      // Priced before it runs. The first call is always allowed — see the header.
      if (spend.maxSpendUsd != null && spend.maxSpendUsd > 0 && spend.calls > 0 && perCall > 0) {
        if (spend.spent + perCall > spend.maxSpendUsd) {
          return refuse(
            `This row has spent $${spend.spent.toFixed(4)} of its $${spend.maxSpendUsd.toFixed(4)} connected-app allowance, ` +
            `and another call would take it over.`,
          );
        }
      }

      try {
        const result = await opts.pool.callTool(opts.serverId, opts.info.name, (args ?? {}) as Record<string, unknown>);
        spend.calls++;
        if (perCall > 0) {
          spend.spent += perCall;
          opts.onCost?.(perCall);
        }

        const text = typeof result === "string" ? result : JSON.stringify(result);
        // SANITIZED HERE, because the loop does not do it. Every built-in tool sanitizes its own
        // output, and this one carries the least trustworthy content in the app: whatever a third
        // party chose to return. `sanitize` neutralises the delimiters the system prompt uses, so a
        // server answering with `</task>` cannot end the task and start giving instructions.
        return sanitize(text, 8000);
      } catch (e) {
        // The call may well have been billed even though it failed, so it counts.
        spend.calls++;
        if (perCall > 0) {
          spend.spent += perCall;
          opts.onCost?.(perCall);
        }
        // Reported to the model as an ordinary tool result. It can try another approach; the row is
        // not failed by one app being unreachable.
        return `Error: ${sanitize(e instanceof Error ? e.message : String(e), 500)}`;
      }
    },
  };
}

/**
 * Every tool the given apps offer, as agent tools.
 *
 * Discovery is a live `tools/list` per server, because a tool list typed from memory goes stale the
 * first time the app is updated. A server that cannot be reached contributes NOTHING rather than
 * failing the cell — the same contract `buildToolset` already has, where a tool that is requested
 * but not configured is silently absent.
 */
export async function mcpToolsFor(
  serverIds: string[],
  pool: McpPool,
  spend: McpSpend,
  opts: { perCallUsd?: number; onCost?: (usd: number) => void } = {},
): Promise<AgentTool[]> {
  const out: AgentTool[] = [];
  for (const serverId of serverIds) {
    const server = getMcpServer(serverId);
    if (!server) continue;
    let infos: McpToolInfo[];
    try {
      infos = await pool.listTools(serverId);
    } catch {
      continue;
    }
    for (const info of infos) {
      out.push(mcpAgentTool({
        pool, info, serverId, serverName: server.name,
        maxSpendUsd: spend.maxSpendUsd, maxCalls: spend.maxCalls,
        perCallUsd: opts.perCallUsd, onCost: opts.onCost,
      }, spend));
    }
  }
  return out;
}
