// Where Ferrum keeps state on disk.
//
// The DB deliberately does NOT live in the project folder. SQLite in WAL mode keeps a -wal sidecar
// that a file-sync client (OneDrive, Dropbox, iCloud) will happily upload mid-write and then restore
// out of step with the main file — which corrupts the database. C:\Users\<name>\ is a OneDrive-risky
// root on Windows, so state goes under LOCALAPPDATA, which sync clients leave alone.

import { existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Root for everything Ferrum writes: DB, credentials, sandboxes, generated scripts.
 *
 * Both env var names are honoured, new one first. The app was called ClayCode and renaming the
 * variable outright would point an existing install at an empty directory — which does not look like
 * a misconfiguration, it looks like every sheet you ever made has vanished.
 */
export const DATA_DIR = process.env.FERRUM_DATA_DIR
  ? resolve(process.env.FERRUM_DATA_DIR)
  : process.env.CLAYCODE_DATA_DIR
    ? resolve(process.env.CLAYCODE_DATA_DIR)
    : join(process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share"), "ferrum");

/**
 * The database file.
 *
 * An existing `claycode.db` in the data directory keeps being used. Renaming the FILE on an upgrade
 * would silently start a brand-new empty database beside the real one, and the first symptom would
 * be an empty app — so the old name wins wherever it already exists, and only a fresh install gets
 * the new one.
 */
const LEGACY_DB = join(DATA_DIR, "claycode.db");
export const DB_PATH =
  process.env.FERRUM_DB ??
  process.env.CLAYCODE_DB ??
  (existsSync(LEGACY_DB) ? LEGACY_DB : join(DATA_DIR, "ferrum.db"));
export const CREDENTIALS_PATH = join(DATA_DIR, "credentials.json");
/** Per-run, per-cell scratch dirs. Agent cells get an EMPTY cwd here so no CLAUDE.md is discovered
 *  and file tools cannot reach the user's real projects. */
export const SANDBOX_ROOT = join(DATA_DIR, "sandbox");
/** Generated scripts, written out so a shell runtime can execute them by path. */
export const SCRIPTS_DIR = join(DATA_DIR, "scripts");

export function ensureDirs(): void {
  for (const d of [DATA_DIR, SANDBOX_ROOT, SCRIPTS_DIR]) mkdirSync(d, { recursive: true });
}

/** Folder names that indicate a file-sync client owns this path. Case-insensitive substring match on
 *  a path SEGMENT, so "C:\Users\x\OneDrive - Acme\..." is caught but "C:\dev\onedriveclone" is not. */
const SYNC_ROOTS = ["onedrive", "dropbox", "google drive", "googledrive", "icloud", "iclouddrive", "box sync", "creative cloud files"];

/**
 * True when `p` sits under a known sync root. Surfaced by the health check rather than thrown:
 * a user with a deliberately relocated LOCALAPPDATA should be warned, not blocked.
 */
export function isUnderSyncRoot(p: string): boolean {
  return resolve(p)
    .split(sep)
    .some((seg) => SYNC_ROOTS.some((r) => seg.toLowerCase().includes(r)));
}

/**
 * True when `child` resolves to a location inside `parent`.
 *
 * This is a containment check, not a string prefix test, and the difference is the whole point:
 * `"C:\\tmp\\claycode-evil".startsWith("C:\\tmp\\claycode")` is true, and treating that as "inside"
 * is exactly how a directory-traversal guard gets walked around. `relative()` answers the real
 * question — it returns a path starting with `..` when the child is outside — and on Windows it
 * compares case-insensitively, which matches how the filesystem actually behaves.
 *
 * A child equal to the parent returns false. Nothing here wants to accept the directory itself.
 */
export function isUnder(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Scratch space for CSV import staging — large, disposable, never synced.
 *
 *  Renamed with the project. Unlike the data directory and the database file, this one has no
 *  legacy fallback and does not need one: it holds half-finished CSV uploads, so the worst an
 *  existing install loses is an upload that was already abandoned. An empty `claycode` directory
 *  may be left behind in the OS temp folder and is safe to delete. */
export const TMP_DIR = join(tmpdir(), "ferrum");
