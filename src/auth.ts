// Credentials and the auth preflight.
//
// The canary at the bottom of this file is the most important thing here, and it exists because of a
// measured failure: a headless run against an expired token returned 401 after **3 minutes and 11
// seconds**, because the CLI's internal retry backoff runs before the error surfaces. Two hundred
// cells against a dead token is ten hours of nothing, with no useful error until the end.
//
// So: every run start validates auth with a one-turn, no-tools ping under a HARD 20-second abort,
// and a failure refuses the run before a single job is enqueued.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { CREDENTIALS_PATH, SANDBOX_ROOT } from "./paths.ts";
import { getKv, setKv } from "./db.ts";

export type AuthMode = "subscription" | "api_key" | "none";

interface StoredCredential {
  mode: AuthMode;
  token: string;
  storedAt: string;
  label: string;
}

/** Canary results are cached briefly — a run start should not cost a round trip every time. */
const CANARY_TTL_MS = 5 * 60_000;
const CANARY_TIMEOUT_MS = 20_000;

// ─────────────────────────────────────────────────────────────── storage

export function saveCredential(token: string, mode: AuthMode = "subscription"): void {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("Empty token.");

  const cred: StoredCredential = {
    mode,
    token: trimmed,
    storedAt: new Date().toISOString(),
    // A stable, non-reversible label so the UI can show WHICH token is stored without showing it.
    //
    // The length guard is the "non-reversible" half, and it was missing: `slice(0,12)` plus
    // `slice(-4)` of a sixteen-character token IS the token, and this label is handed out over HTTP
    // by /api/health and /api/auth under a comment promising the token never is. `maskKey` in
    // providers/keys.ts draws the same line for the same reason. Anything too short to hide a middle
    // gets no label rather than a label that reconstructs it.
    label: trimmed.length > 20 ? `${trimmed.slice(0, 12)}…${trimmed.slice(-4)}` : "…",
  };
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(cred, null, 2), { encoding: "utf8", mode: 0o600 });

  try { chmodSync(CREDENTIALS_PATH, 0o600); } catch { /* Windows honours this only partially */ }
  // Windows ignores most of the POSIX mode, so strip inherited ACLs and grant only this user.
  if (process.platform === "win32") {
    try {
      spawnSync("icacls", [CREDENTIALS_PATH, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`], {
        stdio: "ignore", shell: false,
      });
    } catch { /* best effort — see the honesty note below */ }
  }

  setKv("auth.mode", mode);
  setKv("auth.label", cred.label);
  invalidateCanary();
}

export function loadCredential(): StoredCredential | null {
  if (!existsSync(CREDENTIALS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8")) as StoredCredential;
  } catch {
    return null;
  }
}

/**
 * What the UI is allowed to see. The token itself is NEVER returned over HTTP — a localhost bind is
 * not a reason to hand a year-long credential to anything that asks.
 *
 * Honest about the storage boundary: file ACLs are obfuscation, not encryption. Anything running as
 * this user can read it — the same threat model as the Claude CLI's own credential file.
 */
export function credentialStatus(): { mode: AuthMode; present: boolean; label: string | null; storedAt: string | null } {
  const c = loadCredential();
  return {
    mode: c?.mode ?? "none",
    present: !!c,
    label: c?.label ?? null,
    storedAt: c?.storedAt ?? null,
  };
}

// ─────────────────────────────────────────────────────────────── child environment

/**
 * The environment every agent subprocess gets. ONE shared function on purpose: if any code path
 * forgets to strip CLAUDECODE, cells fail with a nested-session error that looks nothing like an
 * auth problem and wastes an afternoon.
 */
export function sanitizedChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // Spawning the CLI from inside a Claude Code session is blocked unless these are cleared.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SSE_PORT;
  delete env.CLAUDE_CODE_SSE_TOKEN;

  const cred = loadCredential();
  if (cred?.mode === "api_key") {
    env.ANTHROPIC_API_KEY = cred.token;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  } else if (cred) {
    env.CLAUDE_CODE_OAUTH_TOKEN = cred.token;
    // An ambient API key would silently take precedence over the subscription token and bill the
    // wrong account.
    delete env.ANTHROPIC_API_KEY;
  }

  env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ??= "8192";
  return env;
}

// ─────────────────────────────────────────────────────────────── the canary

export interface CanaryResult {
  ok: boolean;
  ms: number;
  error?: string;
  /** Classified so the caller can distinguish "fix your token" from "try again later". */
  kind?: "auth" | "rate_limit" | "timeout" | "not_installed" | "unknown";
}

function classify(text: string): CanaryResult["kind"] {
  const t = text.toLowerCase();
  if (/oauth|401|authenticate|invalid api key|unauthorized|token has expired/.test(t)) return "auth";
  if (/rate limit|429|usage limit|quota/.test(t)) return "rate_limit";
  if (/enoent|not recognized|command not found/.test(t)) return "not_installed";
  return "unknown";
}

/**
 * A ~1s, no-tools, single-turn ping.
 *
 * The 20-second abort is the entire point. Without it this health check inherits the CLI's ~3-minute
 * internal backoff and becomes a hang rather than a check.
 */
export function runCanary(): CanaryResult {
  const started = Date.now();
  const cred = loadCredential();
  if (!cred) return { ok: false, ms: 0, error: "No token stored.", kind: "auth" };

  const res = spawnSync(
    "claude",
    [
      "-p", "Reply with exactly: ok",
      "--output-format", "json",
      "--model", "claude-haiku-4-5-20251001",
      "--tools", "",
      // No ambient CLAUDE.md, skills, or MCP servers — this must test AUTH, nothing else.
      "--setting-sources", "",
      "--max-budget-usd", "0.05",
    ],
    {
      env: sanitizedChildEnv(),
      cwd: SANDBOX_ROOT,
      encoding: "utf8",
      timeout: CANARY_TIMEOUT_MS,
      shell: false,
      windowsHide: true,
    },
  );

  const ms = Date.now() - started;

  if (res.error) {
    const msg = String(res.error.message ?? res.error);
    if (/ETIMEDOUT|timed out/i.test(msg) || res.signal) {
      return { ok: false, ms, error: `Timed out after ${Math.round(ms / 1000)}s.`, kind: "timeout" };
    }
    return { ok: false, ms, error: msg, kind: classify(msg) };
  }

  const raw = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  try {
    const parsed = JSON.parse(String(res.stdout ?? "").trim());
    if (parsed.is_error || parsed.subtype === "error") {
      const msg = String(parsed.result ?? "Unknown error");
      return { ok: false, ms, error: msg, kind: classify(msg) };
    }
    return { ok: true, ms };
  } catch {
    return { ok: false, ms, error: raw.slice(0, 400) || "No output.", kind: classify(raw) };
  }
}

export function cachedCanary(force = false): CanaryResult {
  const at = Number(getKv("auth.canary_at") ?? 0);
  const cached = getKv("auth.canary");
  if (!force && cached && Date.now() - at < CANARY_TTL_MS) {
    try { return JSON.parse(cached) as CanaryResult; } catch { /* fall through and re-run */ }
  }
  const result = runCanary();
  setKv("auth.canary", JSON.stringify(result));
  setKv("auth.canary_at", String(Date.now()));
  return result;
}

export function invalidateCanary(): void {
  setKv("auth.canary_at", "0");
}

/**
 * The gate every run start must pass through.
 *
 * Throws rather than returning a flag, so there is no path where a caller forgets to check and
 * enqueues 200,000 jobs against a dead token.
 */
export function assertAuthReady(): void {
  const c = cachedCanary();
  if (c.ok) return;
  if (c.kind === "auth") {
    throw new Error(
      "Authentication is not working, so this run was not started and nothing was queued. " +
      "Create a new token with `claude setup-token` and save it in Settings.",
    );
  }
  if (c.kind === "rate_limit") {
    throw new Error("The provider is rate limiting right now. The run was not started — try again shortly.");
  }
  throw new Error(`Authentication check failed: ${c.error ?? "unknown error"}. The run was not started.`);
}
