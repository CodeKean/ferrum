// Connecting to an MCP server, and keeping that connection alive across a whole run.
//
// THE RULE THAT MAKES THIS VIABLE, and it is the same one `runtime/scriptRunner.ts` opens with: a
// connection is made ONCE PER SERVER PER RUN, never once per row. A stdio server is a spawned
// process; a spawn is 50-100ms, so a million rows would be 14-28 hours of pure process startup
// before any work happened, and a remote server would get a fresh TCP+TLS handshake and a fresh
// `initialize` round trip for every single cell.
//
// So the pool below is keyed by server id and shared by all six workers, exactly as `runs.ts` shares
// ONE `Pacer` per column rather than one per worker.
//
// What a wedged server must not do is take the run with it. Every call has its own timeout, and a
// server that fails to start fails the rows that needed it while the rest of the run continues.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { assertFetchable } from "../agent/safeFetch.ts";
import { getMcpServer, type McpServer } from "./servers.ts";
import { resolveSecrets, noteSecretsUsed } from "../secrets.ts";

/** A tool as the server describes it. */
export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** How long any single MCP operation may take before it is abandoned. */
export const MCP_CALL_TIMEOUT_MS = 30_000;
/** Connecting is slower than calling — a stdio server has a process to start and a handshake to do. */
const CONNECT_TIMEOUT_MS = 20_000;

export class McpError extends Error {
  constructor(message: string, readonly kind: "config" | "connect" | "timeout" | "call") {
    super(message);
    this.name = "McpError";
  }
}

interface Live {
  client: Client;
  close: () => Promise<void>;
}

/**
 * Substitute `{{secret:Name}}` across a set of values, refusing if any name is not stored.
 *
 * Refusing is the point. `resolveSecrets` leaves an unknown reference as written rather than
 * blanking it, so without this check a missing credential would be sent literally and come back as a
 * 401 — which reads as "your key is wrong" when the truth is "there is no key by that name".
 */
function resolveAll(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  const used: string[] = [];

  for (const [k, v] of Object.entries(values)) {
    const r = resolveSecrets(v);
    out[k] = r.text;
    missing.push(...r.missing);
    used.push(...r.used);
  }

  if (missing.length > 0) {
    const names = [...new Set(missing)].map((n) => `"${n}"`).join(", ");
    throw new McpError(`No saved key called ${names}. Add it in Settings under Keys.`, "config");
  }
  noteSecretsUsed([...new Set(used)]);
  return out;
}

/**
 * Open a connection. Callers should go through `McpPool` rather than calling this per row.
 *
 * Secrets are resolved HERE, at the last possible moment, and never written back to the registry —
 * the same discipline `executeHttp` applies to a request's headers.
 */
export async function connectMcp(server: McpServer): Promise<Live> {
  if (server.transport === "http") {
    if (!server.url) throw new McpError("This server has no web address.", "config");

    // The SSRF check, before a single byte leaves. `assertFetchable` resolves the hostname and
    // refuses if ANY address it gets back is private — one private answer among several is enough.
    try {
      await assertFetchable(server.url, server.allowPrivate === true);
    } catch (e) {
      throw new McpError(e instanceof Error ? e.message : String(e), "config");
    }

    const headers = resolveAll(
      Object.fromEntries((server.headers ?? []).map((h) => [h.name, h.value])),
    );

    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers },
    });
    const client = new Client({ name: "ferrum", version: "1.0.0" }, { capabilities: {} });
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "connect");
    return { client, close: async () => { try { await client.close(); } catch { /* already gone */ } } };
  }

  if (!server.command) throw new McpError("This server has no command.", "config");

  // `getDefaultEnvironment()` is the SDK's allow-list of variables that are safe to inherit (PATH and
  // friends). Starting from it rather than `process.env` means the child does not receive this
  // process's whole environment, which is where every API key in the app lives.
  const env: Record<string, string> = { ...getDefaultEnvironment(), ...resolveAll(server.env ?? {}) };

  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args ?? [],
    env,
    // Piped rather than inherited: a chatty server would otherwise write over the engine's own log.
    stderr: "pipe",
  });
  const client = new Client({ name: "ferrum", version: "1.0.0" }, { capabilities: {} });
  try {
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "connect");
  } catch (e) {
    try { await transport.close(); } catch { /* nothing started */ }
    throw e instanceof McpError
      ? e
      : new McpError(`Could not start "${server.command}": ${e instanceof Error ? e.message : String(e)}`, "connect");
  }
  return { client, close: async () => { try { await client.close(); } catch { /* already gone */ } } };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: "connect" | "call"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new McpError(
        what === "connect"
          ? `The server did not answer within ${Math.round(ms / 1000)} seconds.`
          : `The tool did not answer within ${Math.round(ms / 1000)} seconds.`,
        "timeout",
      ));
    }, ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * One connection per server, shared for the lifetime of a run.
 *
 * `connect` is memoised on the PROMISE, not the result, so six workers arriving at once on an empty
 * pool start one process between them rather than six. That race is not theoretical: it is the
 * normal case, because the workers all begin at the same instant.
 */
export class McpPool {
  private live = new Map<string, Promise<Live>>();
  private closed = false;

  async client(serverId: string): Promise<Client> {
    if (this.closed) throw new McpError("This run has finished.", "connect");

    let entry = this.live.get(serverId);
    if (!entry) {
      const server = getMcpServer(serverId);
      if (!server) {
        throw new McpError("That connected app is not set up any more. Add it again in Settings.", "config");
      }
      entry = connectMcp(server);
      this.live.set(serverId, entry);
      // A failed connection must not be cached, or every remaining row reuses the failure instead of
      // retrying a server that may since have come back.
      entry.catch(() => this.live.delete(serverId));
    }
    return (await entry).client;
  }

  async listTools(serverId: string): Promise<McpToolInfo[]> {
    const client = await this.client(serverId);
    const res = await withTimeout(client.listTools(), MCP_CALL_TIMEOUT_MS, "call");
    return (res.tools ?? []).map((t: any) => ({
      name: String(t.name),
      description: String(t.description ?? ""),
      inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
    }));
  }

  async callTool(
    serverId: string,
    name: string,
    args: Record<string, unknown>,
    timeoutMs = MCP_CALL_TIMEOUT_MS,
  ): Promise<unknown> {
    const client = await this.client(serverId);
    const res: any = await withTimeout(
      client.callTool({ name, arguments: args }),
      timeoutMs,
      "call",
    );

    // A tool that failed reports it in the RESULT rather than by throwing, so a caller that only
    // catches exceptions would write the error text into the cell as if it were an answer.
    if (res?.isError) {
      throw new McpError(textOf(res) || `The tool "${name}" reported an error.`, "call");
    }
    return unwrap(res);
  }

  /** Close everything. Safe to call twice; the run's `finally` and a cancel can both reach it. */
  async closeAll(): Promise<void> {
    this.closed = true;
    const all = [...this.live.values()];
    this.live.clear();
    await Promise.all(all.map(async (p) => {
      try { (await p).close(); } catch { /* never connected */ }
    }));
  }
}

/**
 * One pool per run.
 *
 * Keyed by run id rather than passed down through the executor's signature, because the executor is
 * shared by every lane and threading an MCP-only argument through it would put this lane's
 * plumbing in the model lane's way. The run closes its pool in the same `finally` that un-sticks
 * `running` cells, so a cancelled run kills its processes rather than leaving them parented to the
 * engine until it exits.
 */
const runPools = new Map<string, McpPool>();

export function poolForRun(runId: string): McpPool {
  let pool = runPools.get(runId);
  if (!pool) {
    pool = new McpPool();
    runPools.set(runId, pool);
  }
  return pool;
}

export async function closeRunPool(runId: string): Promise<void> {
  const pool = runPools.get(runId);
  if (!pool) return;
  runPools.delete(runId);
  await pool.closeAll();
}

/** The text an MCP result carries, joined. Used for error messages and for text-only answers. */
export function textOf(res: any): string {
  const content = Array.isArray(res?.content) ? res.content : [];
  return content
    .filter((c: any) => c?.type === "text")
    .map((c: any) => String(c.text ?? ""))
    .join("\n")
    .trim();
}

/**
 * Turn an MCP result into the value a cell or a tool result should see.
 *
 * Order matters. `structuredContent` is what a server returns when it has real data, so it is
 * preferred — a JSON path like `industry` should read the field, not go hunting through prose. Only
 * when there is none do we fall back to the text blocks, and a text block that happens to parse as
 * JSON is parsed, because that is how most servers return structure today.
 */
export function unwrap(res: any): unknown {
  if (res?.structuredContent !== undefined) return res.structuredContent;
  const text = textOf(res);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
