// The permission matrix.
//
// Tested exhaustively rather than by example, because a permission bug is invisible from the inside:
// the app works, for the person who should not have been able to do that. Every role is checked
// against every capability, and every rule that keeps an instance from being taken over has a test
// naming the takeover it prevents.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROLES, asRole, atLeast, can, mayManage, mayRemove, neededFor, workbookAccess,
  type Actor, type Capability, type Role,
} from "./access.ts";

const who = (role: Role, over: Partial<Actor> = {}): Actor => ({ id: 1, role, disabled: false, ...over });
const CAPS: Capability[] = ["read", "write", "spend", "settings", "people", "own"];

test("the whole matrix, one row per role", () => {
  const table: Record<Role, Capability[]> = {
    viewer: ["read"],
    member: ["read", "write", "spend"],
    admin:  ["read", "write", "spend", "settings", "people"],
    owner:  ["read", "write", "spend", "settings", "people", "own"],
  };
  for (const role of ROLES) {
    for (const cap of CAPS) {
      assert.equal(
        can(who(role), cap), table[role].includes(cap),
        `a ${role} ${table[role].includes(cap) ? "should" : "must not"} be able to ${cap}`,
      );
    }
  }
});

test("a viewer cannot start a run — read-only that can still spend is not read-only", () => {
  // The rule this file exists for. Every other permission's worst case is an edit someone can undo;
  // this one's worst case is a bill.
  assert.equal(can(who("viewer"), "spend"), false);
  assert.equal(can(who("viewer"), "read"), true);
});

test("a suspended account can do nothing, whatever its role", () => {
  // Checked before the role, so a suspension bites someone whose session is still open. A suspension
  // that waits for the next sign-in is not a suspension.
  for (const role of ROLES) {
    for (const cap of CAPS) {
      assert.equal(can(who(role, { disabled: true }), cap), false, `disabled ${role} could still ${cap}`);
    }
  }
});

test("nobody at all is nobody, not an implied viewer", () => {
  for (const cap of CAPS) assert.equal(can(null, cap), false);
});

test("an unreadable role reads as the least privileged one", () => {
  // A row written by a newer version, or a corrupted one. "I do not recognise this" has exactly one
  // safe reading.
  assert.equal(asRole("superuser"), "viewer");
  assert.equal(asRole(null), "viewer");
  assert.equal(asRole("admin"), "admin");
});

test("the ladder is a ladder", () => {
  assert.ok(atLeast("owner", "admin"));
  assert.ok(atLeast("admin", "admin"));
  assert.ok(!atLeast("member", "admin"));
  assert.ok(!atLeast("viewer", "member"));
});

// ── Workbooks ────────────────────────────────────────────────────────────────────────────────────

const open = { restricted: false };
const shut = { restricted: true };

test("an ordinary workbook is open to the team, because asking for access to everything kills a tool", () => {
  assert.equal(workbookAccess(who("member"), open, null), "edit");
  assert.equal(workbookAccess(who("viewer"), open, null), "view");
});

test("a restricted workbook is invisible without a grant", () => {
  assert.equal(workbookAccess(who("member"), shut, null), "none");
  assert.equal(workbookAccess(who("member"), shut, "view"), "view");
  assert.equal(workbookAccess(who("member"), shut, "edit"), "edit");
});

test("a grant widens WHICH workbooks, never WHAT you may do", () => {
  // The inversion that hands a read-only account the ability to spend. A viewer listed with "edit"
  // is still a viewer.
  assert.equal(workbookAccess(who("viewer"), shut, "edit"), "view");
  assert.equal(workbookAccess(who("viewer"), open, "edit"), "view");
});

test("whoever made a restricted workbook keeps their own way in", () => {
  const mine = { restricted: true, createdBy: 7 };
  assert.equal(workbookAccess(who("member", { id: 7 }), mine, null), "edit");
  assert.equal(workbookAccess(who("member", { id: 8 }), mine, null), "none");
});

test("an admin is not locked out of a workbook on their own instance", () => {
  // They can already read the database and rotate the keys. A restriction that "hid" it from them
  // would be a fiction, and a fiction in a permission system is worse than an honest permission.
  assert.equal(workbookAccess(who("admin"), shut, null), "edit");
  assert.equal(workbookAccess(who("owner"), shut, null), "edit");
});

test("a suspended account reaches nothing, restricted or not", () => {
  assert.equal(workbookAccess(who("admin", { disabled: true }), open, "edit"), "none");
});

// ── Managing people ──────────────────────────────────────────────────────────────────────────────

const target = (id: number, role: Role) => ({ id, role });

test("a member cannot change anyone", () => {
  assert.equal(mayManage(who("member"), target(2, "viewer"), "admin").ok, false);
});

test("an admin cannot demote the owner, so an instance always has someone in charge", () => {
  const out = mayManage(who("admin", { id: 1 }), target(2, "owner"), "member");
  assert.equal(out.ok, false);
  assert.match(out.ok === false ? out.because : "", /Only the owner/);
});

test("an admin cannot promote anyone to owner — that is a transfer, and it is the owner's to make", () => {
  assert.equal(mayManage(who("admin"), target(2, "member"), "owner").ok, false);
  assert.equal(mayManage(who("owner"), target(2, "member"), "owner").ok, true);
});

test("nobody changes their own role, including the owner", () => {
  // Always an accident, and the accident is an instance with nobody who can add anyone.
  assert.equal(mayManage(who("owner", { id: 5 }), target(5, "owner"), "member").ok, false);
  assert.equal(mayManage(who("admin", { id: 5 }), target(5, "admin"), "member").ok, false);
});

test("an admin can promote and demote everyone below the owner", () => {
  assert.equal(mayManage(who("admin", { id: 1 }), target(2, "viewer"), "member").ok, true);
  assert.equal(mayManage(who("admin", { id: 1 }), target(2, "admin"), "viewer").ok, true);
});

test("the owner cannot be removed, not even by the owner", () => {
  assert.equal(mayRemove(who("owner", { id: 1 }), target(1, "owner")).ok, false);
  assert.equal(mayRemove(who("admin", { id: 2 }), target(1, "owner")).ok, false);
});

test("you cannot remove your own account", () => {
  assert.equal(mayRemove(who("admin", { id: 3 }), target(3, "admin")).ok, false);
  assert.equal(mayRemove(who("admin", { id: 3 }), target(4, "admin")).ok, true);
});

// ── Which capability a request needs ─────────────────────────────────────────────────────────────

test("reading is reading and writing is writing, by default", () => {
  assert.equal(neededFor("GET", "/api/sheets/abc/rows"), "read");
  assert.equal(neededFor("POST", "/api/sheets/abc/columns"), "write");
  assert.equal(neededFor("DELETE", "/api/columns/12"), "write");
});

test("starting a run is a spend, wherever the route lives", () => {
  // It is a POST to a SHEET, not to /api/runs — the one path where the method alone gets it wrong.
  assert.equal(neededFor("POST", "/api/sheets/abc/runs"), "spend");
  assert.equal(neededFor("POST", "/api/runs/9/resume"), "spend");
  assert.equal(neededFor("PATCH", "/api/schedules/3"), "spend");
});

test("stopping a run needs no more than being able to see it", () => {
  // A viewer classified as write-forbidden could WATCH a run burning money and not be allowed to
  // stop it. Cancelling destroys nothing; its best case is somebody catching a mistake.
  assert.equal(neededFor("POST", "/api/runs/9/cancel"), "read");
  assert.equal(neededFor("POST", "/api/runs/9/pause"), "read");
});

test("the settings that affect everyone need an admin, but only to CHANGE them", () => {
  assert.equal(neededFor("POST", "/api/keys"), "settings");
  assert.equal(neededFor("DELETE", "/api/keys/3"), "settings");
  assert.equal(neededFor("POST", "/api/auth/token"), "settings");
  assert.equal(neededFor("GET", "/api/auth"), "read", "seeing THAT a key is set is not reading the key");
});

test("the members list is admin-only to read as well as to change", () => {
  // Unlike the settings routes: this one hands back everyone's email address.
  assert.equal(neededFor("GET", "/api/people"), "people");
  assert.equal(neededFor("POST", "/api/invites"), "people");
});

test("a route nobody thought about is still gated", () => {
  // The whole reason this is a table and not a check per handler: the check you forget to write is
  // invisible, because the route works — for everyone.
  assert.equal(neededFor("POST", "/api/something-invented-tomorrow"), "write");
  assert.equal(neededFor("GET", "/api/something-invented-tomorrow"), "read");
});
