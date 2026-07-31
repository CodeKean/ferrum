// The MCP servers this workspace can talk to.
//
// Two transports, and they are not equally dangerous:
//
//   stdio — Ferrum SPAWNS A PROCESS on this machine. That is arbitrary local code execution, and it
//           is the reason every write path here is deliberately narrow. A server definition may only
//           ever arrive from a person typing it into Settings on a request that `provenLocal`
//           accepted. Not from a column, not from the AI setup assistant, and above all not from an
//           imported workbook — a `.ferrum` file that could introduce a command and then get it run
//           by opening a table would be a document format that executes code, which is the oldest
//           mistake in software. Workbooks therefore carry a server ID and nothing else: import
//           resolves it against what is already registered here, or the column fails.
//
//   http  — a remote server, so the risk is SSRF rather than execution. Every call goes through
//           `safeFetch`, which resolves the hostname and checks every address it gets back, on every
//           redirect hop. `allowPrivate` defaults to false.
//
// Localhost is the ordinary case for an MCP server, which is exactly why `allowPrivate` is a
// per-server switch a person sets rather than a default: "usually fine" is how a default that lets a
// remote answer point at 169.254.169.254 gets written.
//
// Stored in the data directory rather than SQLite, like `provider-keys.json` and `secrets.json`. The
// database is the file people copy, back up and hand to somebody else; a list of commands this
// machine will run is not something to carry along with it.

import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "../paths.ts";

export type McpTransport = "stdio" | "http";

export interface McpHeader {
  name: string;
  /** May be `{{secret:Name}}`. Resolved when the call is built, never stored resolved. */
  value: string;
}

export interface McpServer {
  id: string;
  name: string;
  transport: McpTransport;

  /** stdio only. */
  command?: string;
  args?: string[];
  /** Values may be `{{secret:Name}}`. */
  env?: Record<string, string>;

  /** http only. */
  url?: string;
  headers?: McpHeader[];
  /** http only. Off unless someone deliberately turns it on for a server they run themselves. */
  allowPrivate?: boolean;

  createdAt: string;
}

const PATH = join(DATA_DIR, "mcp-servers.json");

type ServerFile = Record<string, McpServer>;

function readAll(): ServerFile {
  if (!existsSync(PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(PATH, "utf8")) as ServerFile;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // A corrupt file reads as "no servers" rather than wedging the app. Every MCP column then fails
    // with "no such server", which is honest, and re-saving one rewrites the file.
    return {};
  }
}

function writeAll(all: ServerFile): void {
  writeFileSync(PATH, JSON.stringify(all, null, 2), { encoding: "utf8", mode: 0o600 });
  try { chmodSync(PATH, 0o600); } catch { /* Windows honours this only partially */ }
  if (process.platform === "win32") {
    try {
      spawnSync("icacls", [PATH, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`], {
        stdio: "ignore", shell: false,
      });
    } catch { /* best effort */ }
  }
}

/**
 * Validate a server definition arriving from the UI.
 *
 * Throws rather than coercing, matching `normalizeHttpConfig`. A silently corrected command is worse
 * than a rejected one: the user sees what they typed and the machine runs something else.
 */
export function normalizeMcpServer(raw: unknown, existingId?: string): McpServer {
  const r = (raw ?? {}) as Record<string, any>;

  const name = String(r.name ?? "").trim();
  if (!name) throw new Error("Give the server a name.");
  if (name.length > 80) throw new Error("That name is too long (80 characters max).");

  const transport = String(r.transport ?? "") as McpTransport;
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`Unknown transport "${r.transport}". Use "stdio" for a program on this computer, or "http" for a remote server.`);
  }

  const out: McpServer = {
    id: existingId ?? String(r.id ?? "").trim() ?? "",
    name,
    transport,
    createdAt: String(r.createdAt ?? new Date().toISOString()),
  };
  if (!out.id) out.id = randomUUID();

  if (transport === "stdio") {
    const command = String(r.command ?? "").trim();
    if (!command) throw new Error("Give the command that starts the server.");
    // No shell, ever — `spawn` is called with `shell: false`, so this is an executable name and not
    // a command line. Rejecting the metacharacters outright means a definition that would only work
    // through a shell fails here, where it is one clear message, rather than as a confusing
    // "command not found" the first time a run touches it.
    if (/[;&|><`$\n\r]/.test(command)) {
      throw new Error("The command cannot contain shell characters. Put each argument in the arguments list instead.");
    }
    out.command = command;
    out.args = Array.isArray(r.args) ? r.args.map((a: unknown) => String(a)) : [];

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries((r.env ?? {}) as Record<string, unknown>)) {
      const key = String(k).trim();
      if (!key) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`"${key}" is not a valid environment variable name.`);
      }
      env[key] = String(v ?? "");
    }
    out.env = env;
  } else {
    const url = String(r.url ?? "").trim();
    if (!url) throw new Error("Give the server's web address.");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`"${url}" is not a valid web address.`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("The address must start with http:// or https://.");
    }
    out.url = url;
    out.allowPrivate = r.allowPrivate === true;

    const headers: McpHeader[] = [];
    for (const h of (Array.isArray(r.headers) ? r.headers : []) as Array<Record<string, unknown>>) {
      const hName = String(h?.name ?? "").trim();
      if (!hName) continue;
      // The same token grammar the HTTP lane enforces. A header NAME is not user data in the way a
      // value is, and a newline in one is header injection.
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(hName)) {
        throw new Error(`"${hName}" is not a valid header name.`);
      }
      headers.push({ name: hName, value: String(h?.value ?? "") });
    }
    out.headers = headers;
  }

  return out;
}

export function listMcpServers(): McpServer[] {
  return Object.values(readAll()).sort((a, b) => a.name.localeCompare(b.name));
}

export function getMcpServer(id: string): McpServer | null {
  return readAll()[id] ?? null;
}

export function saveMcpServer(raw: unknown, existingId?: string): McpServer {
  const server = normalizeMcpServer(raw, existingId);
  const all = readAll();
  all[server.id] = server;
  writeAll(all);
  return server;
}

export function deleteMcpServer(id: string): boolean {
  const all = readAll();
  if (!all[id]) return false;
  delete all[id];
  writeAll(all);
  return true;
}
