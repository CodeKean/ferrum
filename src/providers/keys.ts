// Provider API keys.
//
// Same shape as the Claude credential store in auth.ts, and the same honesty about what it is: a
// file readable only by this user, NOT encryption. Anything running as this user can read it. That
// is worth stating plainly rather than implying a protection that is not there.
//
// The rules that matter:
//   1. the key never leaves this process — the HTTP layer returns a masked label and nothing else,
//   2. it lives in the data directory, which is outside the repository and gitignored, and
//   3. a key is verified before it is trusted, because a stored key that does not work is worse
//      than no key: the UI then looks configured.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { DATA_DIR } from "../paths.ts";
import { setKv } from "../db.ts";

export type ProviderId = "openrouter";

interface StoredKey {
  key: string;
  storedAt: string;
  /** Enough to recognise WHICH key is stored, not enough to use it. */
  label: string;
}

const KEYS_PATH = join(DATA_DIR, "provider-keys.json");

type KeyFile = Partial<Record<ProviderId, StoredKey>>;

function readAll(): KeyFile {
  if (!existsSync(KEYS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(KEYS_PATH, "utf8")) as KeyFile;
  } catch {
    // A corrupt file must not wedge the app. It reads as "no keys", and saving one rewrites it.
    return {};
  }
}

function writeAll(all: KeyFile): void {
  writeFileSync(KEYS_PATH, JSON.stringify(all, null, 2), { encoding: "utf8", mode: 0o600 });
  try { chmodSync(KEYS_PATH, 0o600); } catch { /* Windows honours this only partially */ }
  if (process.platform === "win32") {
    // Windows ignores most of the POSIX mode, so strip inherited ACLs and grant this user only.
    try {
      spawnSync("icacls", [KEYS_PATH, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`], {
        stdio: "ignore", shell: false,
      });
    } catch { /* best effort */ }
  }
}

/** Masked identifier. Shows enough of the ends to tell two keys apart, never enough to use one. */
export function maskKey(key: string): string {
  const k = key.trim();
  if (k.length <= 12) return "…";
  return `${k.slice(0, 10)}…${k.slice(-4)}`;
}

export function saveProviderKey(provider: ProviderId, key: string): { label: string } {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("Empty key.");
  // Checked here rather than only at call time: a mistyped or truncated key produces a 401 per cell
  // otherwise, which reads as "the provider is down" rather than "the key is wrong".
  if (provider === "openrouter" && !/^sk-or-v1-[a-f0-9]{16,}$/i.test(trimmed)) {
    throw new Error("That does not look like an OpenRouter key — they start with sk-or-v1-.");
  }

  const all = readAll();
  const label = maskKey(trimmed);
  all[provider] = { key: trimmed, storedAt: new Date().toISOString(), label };
  writeAll(all);

  // The LABEL goes in the database so the UI can render it without touching the key file. The key
  // itself never goes near the database, which is the thing that gets copied, backed up and shared.
  setKv(`provider.${provider}.label`, label);
  setKv(`provider.${provider}.stored_at`, all[provider]!.storedAt);
  return { label };
}

/** The real key. Server-side callers only — this must never reach a response body. */
export function getProviderKey(provider: ProviderId): string | null {
  return readAll()[provider]?.key ?? null;
}

export function deleteProviderKey(provider: ProviderId): void {
  const all = readAll();
  delete all[provider];
  writeAll(all);
  setKv(`provider.${provider}.label`, "");
  setKv(`provider.${provider}.stored_at`, "");
}

export interface ProviderKeyStatus {
  provider: ProviderId;
  present: boolean;
  label: string | null;
  storedAt: string | null;
}

/**
 * Refuse a run before it starts when the model provider is not configured.
 *
 * The same reasoning as the Claude canary, and the reason that one exists at all: a missing or wrong
 * credential discovered per row costs a failure on every row of the run and reads like the provider
 * being down. Discovered here it costs one clear sentence and nothing is enqueued.
 */
export function assertModelProviderReady(): void {
  if (!getProviderKey("openrouter")) {
    throw new Error(
      "No OpenRouter key is configured, so AI and agent columns cannot run. Add one in Settings first.",
    );
  }
}

export function providerKeyStatus(provider: ProviderId): ProviderKeyStatus {
  const stored = readAll()[provider];
  return {
    provider,
    present: !!stored,
    label: stored?.label ?? null,
    storedAt: stored?.storedAt ?? null,
  };
}
