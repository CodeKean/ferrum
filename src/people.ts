// Accounts, passwords and sessions.
//
// The half of teams that touches the database. The RULES about who may do what live in access.ts,
// which imports nothing and can be reasoned about on its own; this file is the storage under them.
//
// ── The switch ───────────────────────────────────────────────────────────────────────────────────
//
// One row in `users` turns the instance from single-user to shared. There is no separate "enable
// authentication" setting, because a setting is a thing that can be off — and an instance on a
// public address with auth switched off is not a misconfiguration anybody notices until it is too
// late. Claiming the instance IS turning it on.
//
// ── Passwords ────────────────────────────────────────────────────────────────────────────────────
//
// scrypt from node:crypto, with the parameters stored alongside each hash. No dependency, no native
// build, and memory-hard — which is the property that matters, because the attack on a leaked hash
// list is a GPU, and scrypt is the one primitive here that a GPU is bad at.

import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { db, tx } from "./db.ts";
import { asRole, type Actor, type Role } from "./access.ts";

/**
 * scrypt cost. N must be a power of two; 2^15 with r=8 is roughly 32 MB and ~100 ms here.
 *
 * Stored in every hash rather than read from this constant at verify time, so raising it later
 * re-hashes new passwords without locking out everyone who set theirs before.
 */
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

/** How long a session lasts without being used. Long enough not to nag, short enough to expire. */
const SESSION_DAYS = 30;
/** An invite link is a credential until it is used, so it does not sit valid forever. */
const INVITE_DAYS = 7;

/** The shortest password accepted. Length is the only property that reliably survives a leak. */
export const MIN_PASSWORD = 10;

export interface Person {
  id: number;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}

const toPerson = (r: any): Person => ({
  id: Number(r.id),
  email: String(r.email),
  name: String(r.name ?? ""),
  role: asRole(r.role),
  disabled: Number(r.disabled ?? 0) === 1,
  createdAt: String(r.created_at),
  lastSeenAt: r.last_seen_at == null ? null : String(r.last_seen_at),
});

/** An address, in the one form it is ever stored or compared in. */
export const normalizeEmail = (v: unknown): string => String(v ?? "").trim().toLowerCase();

/**
 * What is wrong with this password, or null.
 *
 * Length and nothing else. Composition rules ("one capital, one symbol") measurably push people
 * toward `Password1!` and are the reason so many leaked lists look alike; a long passphrase beats a
 * short scrambled one and is the thing worth asking for.
 */
export function passwordProblem(password: unknown): string | null {
  const p = String(password ?? "");
  if (p.length < MIN_PASSWORD) return `A password needs at least ${MIN_PASSWORD} characters.`;
  if (p.length > 1024) return "That password is too long.";
  if (p.trim().length === 0) return "A password cannot be only spaces.";
  return null;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 256 * 1024 * 1024 });
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64"), key.toString("base64")].join("$");
}

/**
 * Whether a password matches a stored hash.
 *
 * Compared with `timingSafeEqual`, and never short-circuits on a malformed hash by returning true.
 * Any parse failure is a `false` — a row this code cannot read is not a row anyone gets to sign in
 * against.
 */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, n, r, p, salt, key] = String(stored).split("$");
    if (scheme !== "scrypt" || !salt || !key) return false;
    const expect = Buffer.from(key, "base64");
    const got = scryptSync(password, Buffer.from(salt, "base64"), expect.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024,
    });
    return expect.length === got.length && timingSafeEqual(expect, got);
  } catch {
    return false;
  }
}

// ── The instance ─────────────────────────────────────────────────────────────────────────────────

/** True once anyone has an account here. The single switch between single-user and shared. */
export function isClaimed(): boolean {
  return Number((db.prepare("SELECT COUNT(*) c FROM users").get() as any).c) > 0;
}

export function countPeople(): { total: number; active: number } {
  const r = db.prepare("SELECT COUNT(*) t, SUM(CASE WHEN disabled = 0 THEN 1 ELSE 0 END) a FROM users").get() as any;
  return { total: Number(r.t ?? 0), active: Number(r.a ?? 0) };
}

/**
 * The first account, which becomes the owner.
 *
 * Refuses once anyone exists — otherwise the "claim this instance" page stays a way to mint an owner
 * for as long as anybody can reach the address, which on a server is forever.
 */
export function claimInstance(email: string, password: string, name = ""): Person {
  return tx(() => {
    if (isClaimed()) throw new Error("This instance already has an owner. Ask them for an invitation.");
    return createPerson({ email, password, name, role: "owner" });
  });
}

export function createPerson(input: {
  email: string; password: string; name?: string; role: Role;
}): Person {
  const email = normalizeEmail(input.email);
  if (!email.includes("@") || email.length < 3) throw new Error("That does not look like an email address.");
  const bad = passwordProblem(input.password);
  if (bad) throw new Error(bad);
  return tx(() => {
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) {
      throw new Error("Someone is already using that email address here.");
    }
    const res = db
      .prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)")
      .run(email, String(input.name ?? "").trim(), hashPassword(input.password), input.role);
    return getPerson(Number(res.lastInsertRowid))!;
  });
}

export function getPerson(id: number): Person | null {
  const r = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(id)) as any;
  return r ? toPerson(r) : null;
}

export function findByEmail(email: string): Person | null {
  const r = db.prepare("SELECT * FROM users WHERE email = ?").get(normalizeEmail(email)) as any;
  return r ? toPerson(r) : null;
}

export function listPeople(): Person[] {
  return (db.prepare("SELECT * FROM users ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, email").all() as any[])
    .map(toPerson);
}

export function setRole(id: number, role: Role): void {
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, Number(id));
}

/**
 * Suspend or restore an account.
 *
 * Suspending ends every one of their sessions in the same statement. Leaving them signed in until
 * the cookie expires would make a suspension take up to a month to bite, which is not a suspension —
 * it is a note.
 */
export function setDisabled(id: number, disabled: boolean): void {
  tx(() => {
    db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(disabled ? 1 : 0, Number(id));
    if (disabled) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(Number(id));
  });
}

export function setPassword(id: number, password: string): void {
  const bad = passwordProblem(password);
  if (bad) throw new Error(bad);
  tx(() => {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), Number(id));
    // Every other session ends. A password change that leaves the old sessions working does not
    // remove whoever the password was changed because of.
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(Number(id));
  });
}

export function removePerson(id: number): void {
  db.prepare("DELETE FROM users WHERE id = ?").run(Number(id));
}

/**
 * Hand the instance over.
 *
 * Both writes in one transaction, because the state between them — two owners, or none — is one this
 * app has no rules for.
 */
export function transferOwnership(fromId: number, toId: number): void {
  tx(() => {
    const to = getPerson(toId);
    if (!to) throw new Error("That person no longer has an account here.");
    if (to.disabled) throw new Error("You cannot hand the instance to a suspended account.");
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(Number(toId));
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(Number(fromId));
  });
}

// ── Sessions ─────────────────────────────────────────────────────────────────────────────────────

/** The cookie's name. Prefixed so it is obvious in a browser's storage what it belongs to. */
export const SESSION_COOKIE = "ferrum_session";

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export interface SessionRow {
  id: string;
  userId: number;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  userAgent: string;
  ip: string;
}

/**
 * Sign in, returning the raw token ONCE.
 *
 * The caller puts it in a cookie and forgets it; only its hash is stored, so a copy of this database
 * is a list of hashes rather than a set of working logins.
 */
export function startSession(userId: number, meta: { userAgent?: string; ip?: string } = {}): string {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString().replace("T", " ").slice(0, 19);
  db.prepare(
    "INSERT INTO sessions (id, user_id, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?)",
  ).run(hashToken(token), Number(userId), expires, String(meta.userAgent ?? "").slice(0, 300), String(meta.ip ?? "").slice(0, 64));
  return token;
}

/**
 * Who a cookie belongs to, or null.
 *
 * Joins the account in, so a suspended or deleted person's cookie stops working immediately rather
 * than at expiry. Sliding expiry: using the app keeps you signed in, and walking away does not.
 */
export function whoIs(token: string | undefined | null): Person | null {
  if (!token) return null;
  const id = hashToken(token);
  const row = db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > datetime('now') AND u.disabled = 0`,
  ).get(id) as any;
  if (!row) return null;
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString().replace("T", " ").slice(0, 19);
  db.prepare("UPDATE sessions SET last_seen_at = datetime('now'), expires_at = ? WHERE id = ?").run(expires, id);
  db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(Number(row.id));
  return toPerson(row);
}

export function endSession(token: string | undefined | null): void {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE id = ?").run(hashToken(token));
}

export function endAllSessions(userId: number): number {
  return Number(db.prepare("DELETE FROM sessions WHERE user_id = ?").run(Number(userId)).changes ?? 0);
}

/** Where someone is signed in. The current session is marked so nobody ends the one they are using by mistake. */
export function listSessions(userId: number, currentToken?: string | null): Array<SessionRow & { current: boolean }> {
  const current = currentToken ? hashToken(currentToken) : "";
  return (db.prepare(
    "SELECT * FROM sessions WHERE user_id = ? AND expires_at > datetime('now') ORDER BY last_seen_at DESC",
  ).all(Number(userId)) as any[]).map((r) => ({
    id: String(r.id),
    userId: Number(r.user_id),
    createdAt: String(r.created_at),
    expiresAt: String(r.expires_at),
    lastSeenAt: String(r.last_seen_at),
    userAgent: String(r.user_agent ?? ""),
    ip: String(r.ip ?? ""),
    current: String(r.id) === current,
  }));
}

/** Housekeeping. Expired rows are already refused by `whoIs`; this stops the table growing forever. */
export function purgeExpiredSessions(): number {
  return Number(db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run().changes ?? 0);
}

// ── Invitations ──────────────────────────────────────────────────────────────────────────────────

export interface Invite {
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
  accepted: boolean;
}

/**
 * Invite someone, returning the link's token ONCE.
 *
 * There is no mail server here, so the admin copies the link and sends it however they already talk
 * to that person. That is a feature rather than a shortfall: it means the instance needs no outbound
 * credentials, and an invite cannot be intercepted by a mailbox nobody checks.
 */
export function createInvite(email: string, role: Role, byUserId: number): { token: string; invite: Invite } {
  const addr = normalizeEmail(email);
  if (!addr.includes("@")) throw new Error("That does not look like an email address.");
  return tx(() => {
    if (findByEmail(addr)) throw new Error("That person already has an account here.");
    // Any older unused invite for the same address is replaced. Two live links to one account is two
    // credentials to revoke and one to forget.
    db.prepare("DELETE FROM invites WHERE email = ? AND accepted_at IS NULL").run(addr);
    const token = randomBytes(24).toString("base64url");
    const expires = new Date(Date.now() + INVITE_DAYS * 86_400_000).toISOString().replace("T", " ").slice(0, 19);
    db.prepare(
      "INSERT INTO invites (token_hash, email, role, created_by, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).run(hashToken(token), addr, role, Number(byUserId), expires);
    return { token, invite: { email: addr, role, createdAt: "", expiresAt: expires, accepted: false } };
  });
}

/** What an invite link is for, so the sign-up page can say whose instance this is and as what. */
export function peekInvite(token: string): { email: string; role: Role } | null {
  const r = db.prepare(
    "SELECT email, role FROM invites WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > datetime('now')",
  ).get(hashToken(token)) as any;
  return r ? { email: String(r.email), role: asRole(r.role) } : null;
}

/**
 * Turn an invite into an account.
 *
 * One transaction, and the invite is marked accepted in it — otherwise a link that is opened twice
 * quickly makes two accounts, and the second one is a surprise nobody audits.
 */
export function acceptInvite(token: string, password: string, name = ""): Person {
  return tx(() => {
    const found = peekInvite(token);
    if (!found) throw new Error("That invitation has been used already, or it has expired. Ask for a new one.");
    const person = createPerson({ email: found.email, password, name, role: found.role });
    db.prepare(
      "UPDATE invites SET accepted_at = datetime('now'), accepted_user_id = ? WHERE token_hash = ?",
    ).run(person.id, hashToken(token));
    return person;
  });
}

export function listInvites(): Invite[] {
  return (db.prepare(
    "SELECT email, role, created_at, expires_at, accepted_at FROM invites WHERE accepted_at IS NULL AND expires_at > datetime('now') ORDER BY created_at DESC",
  ).all() as any[]).map((r) => ({
    email: String(r.email),
    role: asRole(r.role),
    createdAt: String(r.created_at),
    expiresAt: String(r.expires_at),
    accepted: r.accepted_at != null,
  }));
}

export function revokeInvite(email: string): number {
  return Number(
    db.prepare("DELETE FROM invites WHERE email = ? AND accepted_at IS NULL").run(normalizeEmail(email)).changes ?? 0,
  );
}

// ── Workbook sharing ─────────────────────────────────────────────────────────────────────────────

export function grantsFor(workbookId: string): Array<{ userId: number; access: "view" | "edit" }> {
  return (db.prepare("SELECT user_id, access FROM workbook_grants WHERE workbook_id = ?").all(workbookId) as any[])
    .map((r) => ({ userId: Number(r.user_id), access: r.access === "edit" ? "edit" : "view" }));
}

export function grantOf(workbookId: string, userId: number): "view" | "edit" | null {
  const r = db.prepare("SELECT access FROM workbook_grants WHERE workbook_id = ? AND user_id = ?")
    .get(workbookId, Number(userId)) as any;
  return r ? (r.access === "edit" ? "edit" : "view") : null;
}

export function setGrant(workbookId: string, userId: number, access: "view" | "edit" | null): void {
  if (access == null) {
    db.prepare("DELETE FROM workbook_grants WHERE workbook_id = ? AND user_id = ?").run(workbookId, Number(userId));
    return;
  }
  db.prepare(
    `INSERT INTO workbook_grants (workbook_id, user_id, access) VALUES (?, ?, ?)
       ON CONFLICT(workbook_id, user_id) DO UPDATE SET access = excluded.access`,
  ).run(workbookId, Number(userId), access);
}

/**
 * The person as the permission rules want them.
 *
 * A separate shape from `Person` on purpose: access.ts must never be handed an email address or a
 * password hash, because a rule that CAN read those is a rule that eventually does.
 */
export const actorOf = (p: Person | null): Actor | null =>
  p ? { id: p.id, role: p.role, disabled: p.disabled } : null;

/** A one-off identifier for an audit note where a person is not signed in. Kept for parity with runs. */
export const anonId = (): string => randomUUID();
