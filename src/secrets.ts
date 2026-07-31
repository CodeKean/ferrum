// Named keys, kept out of the columns that use them.
//
// Until now the only way to authenticate an HTTP column was to type the key into a header. That
// works and it is quietly the worst thing in the product, because the key then becomes part of the
// column's definition — so it travels into a duplicate, into a template, into anything the column is
// ever copied into, and it shows on screen to anyone who opens the column editor. Rotating it means
// finding every column that has it.
//
// So a key is stored ONCE under a name, and a column refers to it: `{{secret:Prospeo}}`. The
// reference travels; the value never does.
//
// ── What this is and is not ────────────────────────────────────────────────────────────────────
//
// The same honesty as the provider-key store next door: a file readable only by this user, NOT
// encryption. Anything running as this user can read it. Stating that plainly is worth more than
// implying a protection that is not there — the actual protections are the three below.
//
//   1. THE VALUE NEVER LEAVES THIS PROCESS. Every route returns a masked label. There is no route
//      that returns a value, not even to the screen that set it, because a route that can return a
//      key is a route that can leak one.
//   2. IT IS SUBSTITUTED AT THE LAST POSSIBLE MOMENT — when the request is built, on the server,
//      after everything that might be logged has already been written.
//   3. EVERY STORED VALUE IS FED TO THE REDACTOR, so a provider echoing the key back in an error
//      cannot land it in the database or on the live stream.
//
// ── Why categories are free text ───────────────────────────────────────────────────────────────
//
// A fixed list would be wrong within a week — the whole point is that these are keys for whatever
// the user calls, and nobody else knows what that is. Free text with the existing values offered as
// suggestions gets the grouping without pretending to know the taxonomy.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { DATA_DIR } from "./paths.ts";
import { registerSecretValues } from "./redact.ts";

const PATH = join(DATA_DIR, "secrets.json");

export interface StoredSecret {
  name: string;
  category: string;
  value: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  /** Bumped every time a request actually used it — the answer to "is this one still needed". */
  uses: number;
  lastUsedAt: string | null;
}

/** What a screen is allowed to know: everything except the value. */
export interface SecretInfo extends Omit<StoredSecret, "value"> {
  masked: string;
}

type File = { secrets: StoredSecret[] };

function readAll(): File {
  if (!existsSync(PATH)) return { secrets: [] };
  try {
    const parsed = JSON.parse(readFileSync(PATH, "utf8")) as File;
    return Array.isArray(parsed?.secrets) ? parsed : { secrets: [] };
  } catch {
    // A corrupt file must not wedge the app. It reads as "no keys", and saving one rewrites it.
    return { secrets: [] };
  }
}

function writeAll(all: File): void {
  writeFileSync(PATH, JSON.stringify(all, null, 2), { encoding: "utf8", mode: 0o600 });
  try { chmodSync(PATH, 0o600); } catch { /* Windows honours this only partially */ }
  if (process.platform === "win32") {
    // Windows ignores most of the POSIX mode, so strip inherited ACLs and grant this user only.
    try {
      spawnSync("icacls", [PATH, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`], {
        stdio: "ignore", shell: false,
      });
    } catch { /* best effort */ }
  }
  syncRedactor(all);
}

/**
 * Hand every stored value to the redactor.
 *
 * The redactor is pattern-based on purpose and catches the shapes that are recognisable. A key from
 * a small API is often a bare hex blob with no prefix and no `key=` beside it, and no pattern can
 * see that. These we KNOW, so they are matched exactly — which closes the one gap patterns cannot.
 */
function syncRedactor(all: File): void {
  registerSecretValues(all.secrets.map((s) => s.value).filter((v) => v && v.length >= 8));
}

/** Names are matched case-insensitively, so `{{secret:prospeo}}` finds `Prospeo`. */
const norm = (s: string): string => s.trim().toLowerCase();

/** Enough to recognise WHICH key is stored, never enough to use one. */
export function mask(value: string): string {
  const v = String(value ?? "").trim();
  if (v.length <= 8) return "…";
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

const info = (s: StoredSecret): SecretInfo => {
  const { value, ...rest } = s;
  return { ...rest, masked: mask(value) };
};

export function listSecrets(): SecretInfo[] {
  return readAll().secrets
    .slice()
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
    .map(info);
}

/** The categories already in use, for the suggestions on the form. */
export function listCategories(): string[] {
  return [...new Set(readAll().secrets.map((s) => s.category).filter(Boolean))].sort();
}

export interface SaveSecret {
  name: string;
  value?: string;
  category?: string;
  note?: string;
}

/**
 * Store a key under a name, or update the one already there.
 *
 * An existing name with NO value is a rename/recategorise, not a wipe. Leaving the value out has to
 * mean "leave it alone", because the screen cannot show it back — a form that submitted an empty
 * field as an empty key would silently destroy the credential every time someone fixed a typo in
 * its category.
 */
export function saveSecret(input: SaveSecret): SecretInfo {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("A key needs a name — that is what a column refers to it by.");
  if (name.length > 60) throw new Error("That name is too long. Keep it short: it is typed into columns.");
  // The reference syntax is `{{secret:NAME}}`, so a name holding a brace or a colon would produce a
  // reference nothing can parse. Refused at the door rather than stored and mysteriously ignored.
  if (/[{}:]/.test(name)) throw new Error("A key's name cannot contain { } or :.");

  const all = readAll();
  const at = all.secrets.findIndex((s) => norm(s.name) === norm(name));
  const now = new Date().toISOString();

  if (at === -1) {
    const value = String(input.value ?? "").trim();
    if (!value) throw new Error("Paste the key itself as well.");
    all.secrets.push({
      name, value,
      category: String(input.category ?? "").trim().slice(0, 40),
      note: String(input.note ?? "").trim().slice(0, 200),
      createdAt: now, updatedAt: now, uses: 0, lastUsedAt: null,
    });
  } else {
    const cur = all.secrets[at]!;
    const value = String(input.value ?? "").trim();
    all.secrets[at] = {
      ...cur,
      name,
      value: value || cur.value,
      category: input.category === undefined ? cur.category : String(input.category).trim().slice(0, 40),
      note: input.note === undefined ? cur.note : String(input.note).trim().slice(0, 200),
      updatedAt: now,
    };
  }

  writeAll(all);
  return info(all.secrets.find((s) => norm(s.name) === norm(name))!);
}

export function deleteSecret(name: string): void {
  const all = readAll();
  all.secrets = all.secrets.filter((s) => norm(s.name) !== norm(name));
  writeAll(all);
}

/** Load the stored values into the redactor at boot, before anything can fail and be logged. */
export function primeSecrets(): number {
  const all = readAll();
  syncRedactor(all);
  return all.secrets.length;
}

// ── substitution ───────────────────────────────────────────────────────────────────────────────

/**
 * `{{secret:Name}}` — deliberately its OWN syntax, not part of the column-reference grammar.
 *
 * Column references are resolved in several places, some of which produce text that is shown,
 * stored or sent to a model. A secret must be substituted in exactly one place and nowhere else, so
 * it gets a token no other resolver knows how to expand. Anything that renders a column reference
 * leaves this one untouched, and it stays visible as `{{secret:Prospeo}}` on every screen.
 */
export const SECRET_RE = /\{\{\s*secret:([^{}:]+?)\s*\}\}/g;

export interface Resolved {
  text: string;
  /** Names referenced that are not stored — the request is refused rather than sent without them. */
  missing: string[];
  /** Names actually substituted, so their use counters can be bumped once per request. */
  used: string[];
}

/** Substitute every `{{secret:Name}}`. Server-side only, at request-build time. */
export function resolveSecrets(text: string): Resolved {
  if (!text || !text.includes("{{")) return { text: text ?? "", missing: [], used: [] };
  const all = readAll().secrets;
  const byName = new Map(all.map((s) => [norm(s.name), s]));
  const missing: string[] = [];
  const used: string[] = [];

  const out = text.replace(SECRET_RE, (whole, rawName: string) => {
    const hit = byName.get(norm(rawName));
    if (!hit) {
      missing.push(rawName.trim());
      // Left as written. Substituting an empty string would send a request with a blank credential
      // and get a 401 that reads like the key being wrong rather than absent.
      return whole;
    }
    used.push(hit.name);
    return hit.value;
  });

  return { text: out, missing, used: [...new Set(used)] };
}

/**
 * One stored value, by name.
 *
 * Every other reader here goes through `{{secret:Name}}` substitution, which is right for anything
 * the USER wrote: it keeps the credential out of the saved config and out of anything that logs it.
 * A search backend has no user-written template to substitute into — the key goes in an
 * `Authorization` header the adapter builds — so it needs the value itself.
 *
 * Deliberately narrow, and named so its call sites are greppable. It returns the raw secret, so the
 * rule for using it is the same rule the HTTP lane follows: fetch it at the last possible moment,
 * pass it straight to the request, never put it anywhere that is stored, logged or returned. The
 * value is already registered with the redactor, so an error message that happens to contain it
 * still cannot print it.
 */
export function getSecretValue(name: string): string | null {
  const hit = readAll().secrets.find((s) => norm(s.name) === norm(name));
  if (!hit) return null;
  noteSecretsUsed([hit.name]);
  return hit.value;
}

/** Does this text reference a secret at all? Used to decide whether resolution is needed. */
export const hasSecretRef = (text: string): boolean => {
  SECRET_RE.lastIndex = 0;
  return SECRET_RE.test(text ?? "");
};

/** Which names a piece of text refers to, for the "where is this used" answer and for validation. */
export function secretNamesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text ?? "").matchAll(SECRET_RE)) out.push(m[1]!.trim());
  return [...new Set(out)];
}

/** Recorded once per request, not once per substitution — a key used twice in one call is one use. */
export function noteSecretsUsed(names: string[]): void {
  if (names.length === 0) return;
  const all = readAll();
  const now = new Date().toISOString();
  let touched = false;
  for (const n of names) {
    const hit = all.secrets.find((s) => norm(s.name) === norm(n));
    if (hit) { hit.uses += 1; hit.lastUsedAt = now; touched = true; }
  }
  if (touched) writeAll(all);
}
