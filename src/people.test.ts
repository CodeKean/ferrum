// Accounts, passwords, sessions and invitations.
//
// The tests here are about the things that go wrong QUIETLY: a suspension that does not take effect
// until the cookie expires, an invite link that works twice, a password change that leaves the old
// sessions alive. Each of those looks like it worked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import {
  MIN_PASSWORD, acceptInvite, claimInstance, countPeople, createInvite, createPerson, endAllSessions,
  endSession, findByEmail, getPerson, grantOf, hashPassword, isClaimed, listInvites, listPeople,
  listSessions, normalizeEmail, passwordProblem, peekInvite, purgeExpiredSessions, removePerson,
  revokeInvite, setDisabled, setGrant, setPassword, setRole, startSession, transferOwnership,
  verifyPassword, whoIs,
} from "./people.ts";

/** A fresh instance for each test — the "is it claimed?" switch is global, so it has to be reset. */
function blank() {
  db.exec("DELETE FROM sessions; DELETE FROM invites; DELETE FROM workbook_grants; DELETE FROM users;");
}

const PW = "correct horse battery staple";

// ── Passwords ────────────────────────────────────────────────────────────────────────────────────

test("a password is checked for length and nothing else", () => {
  // Composition rules push people toward "Password1!" — the thing every leaked list is full of.
  assert.equal(passwordProblem(PW), null);
  assert.equal(passwordProblem("all lowercase letters and no digits at all"), null);
  assert.match(passwordProblem("short") ?? "", new RegExp(String(MIN_PASSWORD)));
  assert.ok(passwordProblem("          "), "spaces are not a password");
});

test("a password verifies against its own hash and nothing else", () => {
  const h = hashPassword(PW);
  assert.ok(verifyPassword(PW, h));
  assert.ok(!verifyPassword(`${PW} `, h), "a trailing space is a different password");
  assert.ok(!verifyPassword("something else entirely", h));
});

test("two accounts with the same password get different hashes", () => {
  // Per-password salt. Without it, one cracked hash unlocks everyone who chose the same password.
  assert.notEqual(hashPassword(PW), hashPassword(PW));
});

test("a hash this code cannot read is a refusal, never a pass", () => {
  // The failure that turns a corrupt row into a skeleton key.
  for (const junk of ["", "x", "scrypt$$$$$", "bcrypt$2b$10$abc", "scrypt$notanumber$8$1$aa$bb"]) {
    assert.equal(verifyPassword(PW, junk), false, `"${junk}" must not verify`);
  }
});

// ── Claiming ─────────────────────────────────────────────────────────────────────────────────────

test("an unclaimed instance has nobody, and claiming it makes one owner", () => {
  blank();
  assert.equal(isClaimed(), false);
  const owner = claimInstance("SAM@Example.com ", PW, "Sam");
  assert.equal(isClaimed(), true);
  assert.equal(owner.role, "owner");
  assert.equal(owner.email, "sam@example.com", "the address is stored in one form");
});

test("the claim page stops working the moment there is an owner", () => {
  // Otherwise it stays a way to mint an owner for as long as anyone can reach the address.
  blank();
  claimInstance("first@x.com", PW);
  assert.throws(() => claimInstance("second@x.com", PW), /already has an owner/);
});

test("two people cannot share an address, whatever they capitalise", () => {
  blank();
  claimInstance("sam@x.com", PW);
  assert.throws(() => createPerson({ email: "SAM@X.com", password: PW, role: "member" }), /already using/);
  assert.equal(normalizeEmail(" Sam@X.COM "), "sam@x.com");
});

test("an account cannot be made with a password that would not be accepted later", () => {
  blank();
  assert.throws(() => claimInstance("sam@x.com", "short"), new RegExp(String(MIN_PASSWORD)));
  assert.equal(isClaimed(), false, "nothing was written");
});

// ── Sessions ─────────────────────────────────────────────────────────────────────────────────────

test("a session identifies its person, and a wrong token identifies nobody", () => {
  blank();
  const sam = claimInstance("sam@x.com", PW);
  const token = startSession(sam.id, { userAgent: "Chrome", ip: "10.0.0.2" });
  assert.equal(whoIs(token)?.id, sam.id);
  assert.equal(whoIs("not-a-real-token"), null);
  assert.equal(whoIs(undefined), null);
});

test("the raw token is never stored — a copy of the database is a list of hashes", () => {
  blank();
  const sam = claimInstance("sam@x.com", PW);
  const token = startSession(sam.id);
  const stored = (db.prepare("SELECT id FROM sessions WHERE user_id = ?").get(sam.id) as any).id;
  assert.notEqual(stored, token);
  assert.equal(String(stored).length, 64, "a sha-256, in hex");
});

test("suspending someone ends their sessions in the same breath", () => {
  // A suspension that waits for the cookie to expire is not a suspension, it is a note. This is the
  // one that matters when someone is being removed for a reason.
  blank();
  const owner = claimInstance("owner@x.com", PW);
  const sam = createPerson({ email: "sam@x.com", password: PW, role: "member" });
  const token = startSession(sam.id);
  assert.equal(whoIs(token)?.id, sam.id);

  setDisabled(sam.id, true);
  assert.equal(whoIs(token), null, "their live session stopped working immediately");
  assert.equal(listSessions(sam.id).length, 0);
  assert.ok(whoIs(startSession(owner.id)), "nobody else was affected");
});

test("changing a password ends every session, including the one that changed it", () => {
  // A password is changed because of somebody. Leaving the old sessions alive leaves them in.
  blank();
  const sam = claimInstance("sam@x.com", PW);
  const a = startSession(sam.id);
  const b = startSession(sam.id);
  setPassword(sam.id, "a completely different passphrase");
  assert.equal(whoIs(a), null);
  assert.equal(whoIs(b), null);
  assert.ok(verifyPassword("a completely different passphrase", (db.prepare("SELECT password_hash h FROM users WHERE id = ?").get(sam.id) as any).h));
});

test("signing out ends one session and leaves the others", () => {
  blank();
  const sam = claimInstance("sam@x.com", PW);
  const laptop = startSession(sam.id);
  const phone = startSession(sam.id);
  endSession(laptop);
  assert.equal(whoIs(laptop), null);
  assert.equal(whoIs(phone)?.id, sam.id);
  assert.equal(endAllSessions(sam.id), 1);
  assert.equal(whoIs(phone), null);
});

test("the session list marks the one you are using, so you cannot end it by mistake", () => {
  blank();
  const sam = claimInstance("sam@x.com", PW);
  const here = startSession(sam.id, { userAgent: "Chrome" });
  startSession(sam.id, { userAgent: "Firefox" });
  const list = listSessions(sam.id, here);
  assert.equal(list.length, 2);
  assert.equal(list.filter((s) => s.current).length, 1);
});

test("an expired session is refused, and can be swept up", () => {
  blank();
  const sam = claimInstance("sam@x.com", PW);
  const token = startSession(sam.id);
  db.prepare("UPDATE sessions SET expires_at = '2000-01-01 00:00:00' WHERE user_id = ?").run(sam.id);
  assert.equal(whoIs(token), null);
  assert.equal(purgeExpiredSessions(), 1);
});

test("using the app keeps you signed in", () => {
  // Sliding expiry. Without it a session dies mid-afternoon on day thirty for someone using it.
  blank();
  const sam = claimInstance("sam@x.com", PW);
  const token = startSession(sam.id);
  db.prepare("UPDATE sessions SET expires_at = datetime('now', '+1 hour') WHERE user_id = ?").run(sam.id);
  whoIs(token);
  const after = (db.prepare("SELECT expires_at e FROM sessions WHERE user_id = ?").get(sam.id) as any).e;
  assert.ok(after > new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10), "pushed back out to a month");
});

// ── Invitations ──────────────────────────────────────────────────────────────────────────────────

test("an invite becomes an account with the role it was sent for", () => {
  blank();
  const owner = claimInstance("owner@x.com", PW);
  const { token } = createInvite("New@Person.com", "viewer", owner.id);
  assert.deepEqual(peekInvite(token), { email: "new@person.com", role: "viewer" });

  const person = acceptInvite(token, PW, "New Person");
  assert.equal(person.email, "new@person.com");
  assert.equal(person.role, "viewer");
  assert.equal(countPeople().total, 2);
});

test("an invite link works exactly once", () => {
  // Opened twice quickly, it would otherwise make two accounts — and the second is a surprise
  // nobody audits.
  blank();
  const owner = claimInstance("owner@x.com", PW);
  const { token } = createInvite("new@x.com", "member", owner.id);
  acceptInvite(token, PW);
  assert.throws(() => acceptInvite(token, PW), /used already|expired/);
  assert.equal(countPeople().total, 2);
});

test("an expired invite is refused and does not appear on the list", () => {
  blank();
  const owner = claimInstance("owner@x.com", PW);
  const { token } = createInvite("new@x.com", "member", owner.id);
  db.prepare("UPDATE invites SET expires_at = '2000-01-01 00:00:00'").run();
  assert.equal(peekInvite(token), null);
  assert.throws(() => acceptInvite(token, PW), /used already|expired/);
  assert.equal(listInvites().length, 0);
});

test("inviting the same address twice leaves one live link, not two", () => {
  blank();
  const owner = claimInstance("owner@x.com", PW);
  const first = createInvite("new@x.com", "member", owner.id);
  const second = createInvite("new@x.com", "admin", owner.id);
  assert.equal(peekInvite(first.token), null, "the first link stopped working");
  assert.equal(peekInvite(second.token)?.role, "admin");
  assert.equal(listInvites().length, 1);
});

test("you cannot invite someone who already has an account", () => {
  blank();
  const owner = claimInstance("owner@x.com", PW);
  assert.throws(() => createInvite("owner@x.com", "member", owner.id), /already has an account/);
});

test("an invite can be taken back before it is used", () => {
  blank();
  const owner = claimInstance("owner@x.com", PW);
  const { token } = createInvite("new@x.com", "member", owner.id);
  assert.equal(revokeInvite("NEW@x.com"), 1, "revoking is not case-sensitive either");
  assert.equal(peekInvite(token), null);
});

// ── Roles, removal, handover ─────────────────────────────────────────────────────────────────────

test("a role can be changed, and the list puts the owner first", () => {
  blank();
  claimInstance("owner@x.com", PW);
  const sam = createPerson({ email: "sam@x.com", password: PW, role: "viewer" });
  setRole(sam.id, "admin");
  assert.equal(getPerson(sam.id)?.role, "admin");
  assert.deepEqual(listPeople().map((p) => p.role), ["owner", "admin"]);
});

test("handing the instance over leaves exactly one owner", () => {
  // Both writes in one transaction. Two owners, or none, is a state this app has no rules for.
  blank();
  const owner = claimInstance("owner@x.com", PW);
  const sam = createPerson({ email: "sam@x.com", password: PW, role: "admin" });
  transferOwnership(owner.id, sam.id);
  assert.equal(getPerson(sam.id)?.role, "owner");
  assert.equal(getPerson(owner.id)?.role, "admin");
  assert.equal(listPeople().filter((p) => p.role === "owner").length, 1);
});

test("the instance cannot be handed to a suspended account", () => {
  blank();
  const owner = claimInstance("owner@x.com", PW);
  const sam = createPerson({ email: "sam@x.com", password: PW, role: "admin" });
  setDisabled(sam.id, true);
  assert.throws(() => transferOwnership(owner.id, sam.id), /suspended/);
  assert.equal(getPerson(owner.id)?.role, "owner", "nothing moved");
});

test("removing someone takes their sessions and grants with them", () => {
  blank();
  claimInstance("owner@x.com", PW);
  const sam = createPerson({ email: "sam@x.com", password: PW, role: "member" });
  const token = startSession(sam.id);
  db.prepare("INSERT OR IGNORE INTO workbooks (id, name) VALUES ('wb-people-test', 'ZZ grants')").run();
  setGrant("wb-people-test", sam.id, "edit");
  removePerson(sam.id);
  assert.equal(whoIs(token), null);
  assert.equal(grantOf("wb-people-test", sam.id), null);
  db.prepare("DELETE FROM workbooks WHERE id = 'wb-people-test'").run();
});

test("finding someone by address is not case-sensitive", () => {
  blank();
  claimInstance("Sam@X.com", PW);
  assert.ok(findByEmail("sam@x.com"));
  assert.ok(findByEmail("  SAM@X.COM "));
});

// ── Workbook grants ──────────────────────────────────────────────────────────────────────────────

test("a grant can be given, changed and taken away", () => {
  blank();
  claimInstance("owner@x.com", PW);
  const sam = createPerson({ email: "sam@x.com", password: PW, role: "member" });
  db.prepare("INSERT OR IGNORE INTO workbooks (id, name) VALUES ('wb-grant-2', 'ZZ grants')").run();
  assert.equal(grantOf("wb-grant-2", sam.id), null);
  setGrant("wb-grant-2", sam.id, "view");
  assert.equal(grantOf("wb-grant-2", sam.id), "view");
  setGrant("wb-grant-2", sam.id, "edit");
  assert.equal(grantOf("wb-grant-2", sam.id), "edit", "granting again replaces rather than duplicates");
  setGrant("wb-grant-2", sam.id, null);
  assert.equal(grantOf("wb-grant-2", sam.id), null);
  db.prepare("DELETE FROM workbooks WHERE id = 'wb-grant-2'").run();
});
