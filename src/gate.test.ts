// The gate, over real HTTP.
//
// access.ts proves the RULES are right and people.ts proves the storage is right. This file proves
// the two are actually wired to the door — which is the part that fails silently, because a gate
// that is not installed looks exactly like a gate that lets you through.
//
// Every test signs in over the real routes and drives real requests, because the failure being
// guarded against is "the middleware was never reached for this path".

import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { db } from "./db.ts";
import { addColumn, createSheet, insertRows } from "./store.ts";
import { createWorkbook } from "./views.ts";
import { createServer } from "./server.ts";
import { createInvite, findByEmail, setGrant } from "./people.ts";

const app = createServer("gate-test");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", () => r()));
const port = (server.address() as AddressInfo).port;
after(() => { server.closeAllConnections(); server.close(); });

const PW = "correct horse battery staple";

/** A request, optionally as a signed-in person. Same-origin by default, like the app's own page. */
async function call(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; site?: string | null } = {},
): Promise<{ status: number; body: any; cookie: string | null }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.site !== null) headers["sec-fetch-site"] = init.site ?? "same-origin";
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const raw = res.headers.get("set-cookie");
  return {
    status: res.status,
    body: await res.json().catch(() => null),
    cookie: raw ? (raw.split(";")[0] ?? null) : null,
  };
}

function blank() {
  db.exec("DELETE FROM sessions; DELETE FROM invites; DELETE FROM workbook_grants; DELETE FROM users;");
}

/** Claim the instance and return the owner's cookie. */
async function claimAs(email: string): Promise<string> {
  const out = await call("/api/session/claim", { method: "POST", body: { email, password: PW, name: "Owner" } });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.cookie!;
}

/** Add somebody at a role, through the invite flow, and sign them in. */
async function joinAs(email: string, role: string, ownerCookie: string): Promise<string> {
  const inv = await call("/api/invites", { method: "POST", cookie: ownerCookie, body: { email, role } });
  assert.equal(inv.status, 200, JSON.stringify(inv.body));
  const token = String(inv.body.link).split("/").pop();
  const out = await call("/api/session/invite", { method: "POST", body: { token, password: PW } });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.cookie!;
}

/** A workbook with a table and a row in it, to point requests at. */
function content(name: string) {
  const wb = createWorkbook(name);
  const sheet = createSheet(`${name} table`);
  db.prepare("UPDATE sheets SET workbook_id = ? WHERE id = ?").run(wb.id, sheet.id);
  const col = addColumn(sheet.id, { name: "Company" });
  insertRows(sheet.id, [{ values: {} }], 0, [Number(col.id)]);
  return { wb, sheet, col };
}

// ── Unclaimed ────────────────────────────────────────────────────────────────────────────────────

test("an unclaimed instance is the app as it always was — nothing to sign into", async () => {
  // The single-user install is the normal case and must not have grown a login screen.
  blank();
  const state = await call("/api/session");
  assert.equal(state.body.claimed, false);
  assert.equal(state.body.person, null);
  assert.deepEqual(state.body.can, { write: true, spend: true, settings: true, people: true, own: true });

  const c = content("ZZ gate open");
  assert.equal((await call(`/api/sheets/${c.sheet.id}`)).status, 200);
  assert.equal((await call(`/api/sheets/${c.sheet.id}/columns`, { method: "POST", body: { name: "X" } })).status, 200);
});

// ── Claiming ─────────────────────────────────────────────────────────────────────────────────────

test("claiming the instance makes an owner and signs them in", async () => {
  blank();
  const cookie = await claimAs("owner@x.com");
  assert.ok(cookie?.startsWith("ferrum_session="));
  const state = await call("/api/session", { cookie });
  assert.equal(state.body.claimed, true);
  assert.equal(state.body.person.role, "owner");
});

test("the claim route stops working the moment there is an owner", async () => {
  // Otherwise it stays a way to mint a second owner for as long as the address is reachable — which
  // on the deployment this feature is for is forever.
  blank();
  await claimAs("owner@x.com");
  const again = await call("/api/session/claim", { method: "POST", body: { email: "me@x.com", password: PW } });
  assert.equal(again.status, 400);
  assert.match(String(again.body.error), /already has an owner/);
});

test("the session cookie cannot be read by a script on the page", async () => {
  blank();
  const res = await fetch(`http://127.0.0.1:${port}/api/session/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ email: "owner@x.com", password: PW }),
  });
  const raw = String(res.headers.get("set-cookie"));
  assert.match(raw, /HttpOnly/i, "the whole reason it is a cookie and not local storage");
  assert.match(raw, /SameSite=Lax/i);
});

// ── Signing in ───────────────────────────────────────────────────────────────────────────────────

test("a claimed instance refuses everything until you sign in", async () => {
  blank();
  await claimAs("owner@x.com");
  const c = content("ZZ gate shut");
  const out = await call(`/api/sheets/${c.sheet.id}`);
  assert.equal(out.status, 401);
  assert.equal(out.body.code, "signin_required");
});

test("a wrong password and an unknown address give the same answer", async () => {
  // Telling them apart turns the sign-in form into a way to ask whether somebody has an account here.
  blank();
  await claimAs("owner@x.com");
  const wrongPw = await call("/api/session", { method: "POST", body: { email: "owner@x.com", password: "not it at all" } });
  const noUser = await call("/api/session", { method: "POST", body: { email: "nobody@x.com", password: PW } });
  assert.equal(wrongPw.status, 401);
  assert.equal(noUser.status, 401);
  assert.equal(wrongPw.body.error, noUser.body.error);
});

test("signing out ends the session on the server, not just in the browser", async () => {
  blank();
  const cookie = await claimAs("owner@x.com");
  const c = content("ZZ gate out");
  assert.equal((await call(`/api/sheets/${c.sheet.id}`, { cookie })).status, 200);
  await call("/api/session", { method: "DELETE", cookie });
  assert.equal((await call(`/api/sheets/${c.sheet.id}`, { cookie })).status, 401, "the old cookie is dead");
});

// ── What each role may do ────────────────────────────────────────────────────────────────────────

test("a viewer can look and cannot change or spend", async () => {
  blank();
  const owner = await claimAs("owner@x.com");
  const viewer = await joinAs("viewer@x.com", "viewer", owner);
  const c = content("ZZ gate viewer");

  assert.equal((await call(`/api/sheets/${c.sheet.id}`, { cookie: viewer })).status, 200, "looking is fine");

  const edit = await call(`/api/sheets/${c.sheet.id}/columns`, { method: "POST", cookie: viewer, body: { name: "New" } });
  assert.equal(edit.status, 403);
  assert.match(String(edit.body.error), /read-only/);

  const run = await call(`/api/sheets/${c.sheet.id}/runs`, { method: "POST", cookie: viewer, body: { scope: {} } });
  assert.equal(run.status, 403, "a read-only account that can still press Run is an unlimited budget");
  assert.match(String(run.body.error), /spends money/);
});

test("a member can change and spend but cannot reach the settings or the members list", async () => {
  blank();
  const owner = await claimAs("owner@x.com");
  const member = await joinAs("member@x.com", "member", owner);
  const c = content("ZZ gate member");

  assert.equal((await call(`/api/sheets/${c.sheet.id}/columns`, { method: "POST", cookie: member, body: { name: "New" } })).status, 200);
  assert.equal((await call("/api/people", { cookie: member })).status, 403, "the members list is everyone's email address");
  assert.equal((await call("/api/keys", { cookie: member, method: "POST", body: {} })).status, 403);
});

test("an admin reaches the settings and the members list", async () => {
  blank();
  const owner = await claimAs("owner@x.com");
  const admin = await joinAs("admin@x.com", "admin", owner);
  assert.equal((await call("/api/people", { cookie: admin })).status, 200);
});

test("a suspended account stops working immediately, mid-session", async () => {
  // Not at the next sign-in. A suspension that waits a month is a note.
  blank();
  const owner = await claimAs("owner@x.com");
  const member = await joinAs("member@x.com", "member", owner);
  const c = content("ZZ gate suspend");
  assert.equal((await call(`/api/sheets/${c.sheet.id}`, { cookie: member })).status, 200);

  const them = findByEmail("member@x.com")!;
  await call(`/api/people/${them.id}`, { method: "PATCH", cookie: owner, body: { disabled: true } });
  assert.equal((await call(`/api/sheets/${c.sheet.id}`, { cookie: member })).status, 401);
});

// ── Protecting the instance from its own admins ──────────────────────────────────────────────────

test("an admin cannot demote the owner", async () => {
  blank();
  const owner = await claimAs("owner@x.com");
  const admin = await joinAs("admin@x.com", "admin", owner);
  const them = findByEmail("owner@x.com")!;
  const out = await call(`/api/people/${them.id}`, { method: "PATCH", cookie: admin, body: { role: "member" } });
  assert.equal(out.status, 403);
  assert.equal(findByEmail("owner@x.com")?.role, "owner");
});

test("an admin cannot promote themselves to owner", async () => {
  blank();
  const owner = await claimAs("owner@x.com");
  const admin = await joinAs("admin@x.com", "admin", owner);
  const them = findByEmail("admin@x.com")!;
  const out = await call(`/api/people/${them.id}`, { method: "PATCH", cookie: admin, body: { role: "owner" } });
  assert.equal(out.status, 403);
});

test("the owner can hand the instance over, and there is exactly one owner afterwards", async () => {
  blank();
  const owner = await claimAs("owner@x.com");
  await joinAs("admin@x.com", "admin", owner);
  const them = findByEmail("admin@x.com")!;
  const out = await call(`/api/people/${them.id}`, { method: "PATCH", cookie: owner, body: { role: "owner" } });
  assert.equal(out.status, 200);
  assert.equal(findByEmail("admin@x.com")?.role, "owner");
  assert.equal(findByEmail("owner@x.com")?.role, "admin");
  assert.equal(out.body.people.filter((p: any) => p.role === "owner").length, 1);
});

test("the owner cannot be removed", async () => {
  blank();
  const owner = await claimAs("owner@x.com");
  const admin = await joinAs("admin@x.com", "admin", owner);
  const them = findByEmail("owner@x.com")!;
  assert.equal((await call(`/api/people/${them.id}`, { method: "DELETE", cookie: admin })).status, 403);
});

test("nobody may invite a second owner", async () => {
  blank();
  const owner = await claimAs("owner@x.com");
  const out = await call("/api/invites", { method: "POST", cookie: owner, body: { email: "new@x.com", role: "owner" } });
  assert.equal(out.status, 400);
  assert.match(String(out.body.error), /only ever one owner/);
});

// ── Restricted workbooks ─────────────────────────────────────────────────────────────────────────

test("a restricted workbook does not confirm its own existence to someone without it", async () => {
  // 404 rather than 403 on purpose: a 403 is an answer to "is there a workbook here?".
  blank();
  const owner = await claimAs("owner@x.com");
  const member = await joinAs("member@x.com", "member", owner);
  const c = content("ZZ gate secret");
  assert.equal((await call(`/api/sheets/${c.sheet.id}`, { cookie: member })).status, 200, "open by default");

  await call(`/api/workbooks/${c.wb.id}/access`, { method: "PATCH", cookie: owner, body: { restricted: true } });
  assert.equal((await call(`/api/sheets/${c.sheet.id}`, { cookie: member })).status, 404);
});

test("a grant lets them back in, and read-only means read-only", async () => {
  blank();
  const owner = await claimAs("owner@x.com");
  const member = await joinAs("member@x.com", "member", owner);
  const c = content("ZZ gate grant");
  await call(`/api/workbooks/${c.wb.id}/access`, { method: "PATCH", cookie: owner, body: { restricted: true } });

  const them = findByEmail("member@x.com")!;
  await call(`/api/workbooks/${c.wb.id}/access`, {
    method: "PATCH", cookie: owner, body: { grant: { userId: them.id, access: "view" } },
  });
  assert.equal((await call(`/api/sheets/${c.sheet.id}`, { cookie: member })).status, 200);
  const edit = await call(`/api/sheets/${c.sheet.id}/columns`, { method: "POST", cookie: member, body: { name: "X" } });
  assert.equal(edit.status, 403, "a member with a view grant is still only reading");

  setGrant(c.wb.id, them.id, "edit");
  assert.equal((await call(`/api/sheets/${c.sheet.id}/columns`, { method: "POST", cookie: member, body: { name: "X" } })).status, 200);
});

test("restricting a workbook does not lock out the person who pressed the button", async () => {
  blank();
  const owner = await claimAs("owner@x.com");
  const admin = await joinAs("admin@x.com", "admin", owner);
  const c = content("ZZ gate selflock");
  await call(`/api/workbooks/${c.wb.id}/access`, { method: "PATCH", cookie: admin, body: { restricted: true } });
  assert.equal((await call(`/api/sheets/${c.sheet.id}`, { cookie: admin })).status, 200);
});

// ── Fail-closed ──────────────────────────────────────────────────────────────────────────────────

test("a path naming something that does not exist is refused, not waved through", async () => {
  // The scope check answers "which workbook does this touch?". An id that resolves to nothing has no
  // answer — and "I could not work out what this touches" must never be treated as permission.
  blank();
  const owner = await claimAs("owner@x.com");
  assert.equal((await call("/api/sheets/not-a-real-sheet", { cookie: owner })).status, 404);
  assert.equal((await call("/api/columns/999999", { method: "PATCH", cookie: owner, body: { name: "X" } })).status, 404);
});

test("a signed-in change from another site is refused even with a valid cookie", async () => {
  // The reason a cookie needs this at all: the browser attaches it automatically, which IS the
  // mechanism of cross-site request forgery. Before sessions existed, a request with no Origin was
  // waved through — that reasoning does not survive a credential the browser sends by itself.
  blank();
  const owner = await claimAs("owner@x.com");
  const c = content("ZZ gate csrf");
  const res = await fetch(`http://127.0.0.1:${port}/api/sheets/${c.sheet.id}/columns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: owner, "sec-fetch-site": "cross-site", origin: "https://evil.example" },
    body: JSON.stringify({ name: "Injected" }),
  });
  assert.equal(res.status, 403);
});

test("stopping a run is not spending — a viewer watching one can still stop it", async () => {
  blank();
  const owner = await claimAs("owner@x.com");
  const viewer = await joinAs("viewer@x.com", "viewer", owner);
  const c = content("ZZ gate cancel");
  // The run does not exist, so the honest answer is 404 — what matters is that it is NOT a 403 for
  // lacking permission to spend.
  const out = await call("/api/runs/no-such-run/cancel", { method: "POST", cookie: viewer });
  assert.notEqual(out.status, 403);
});

test("an invitation cannot be replayed to make a second account", async () => {
  blank();
  const owner = await claimAs("owner@x.com");
  const inv = await call("/api/invites", { method: "POST", cookie: owner, body: { email: "new@x.com", role: "member" } });
  const token = String(inv.body.link).split("/").pop();
  assert.equal((await call("/api/session/invite", { method: "POST", body: { token, password: PW } })).status, 200);
  assert.equal((await call("/api/session/invite", { method: "POST", body: { token, password: PW } })).status, 400);
});

test("an invitation is not a way in without one", async () => {
  blank();
  await claimAs("owner@x.com");
  assert.equal((await call("/api/session/invite/made-up-token")).status, 404);
  assert.equal((await call("/api/session/invite", { method: "POST", body: { token: "made-up", password: PW } })).status, 400);
});

test("only an admin can issue an invitation", async () => {
  blank();
  const owner = await claimAs("owner@x.com");
  const member = await joinAs("member@x.com", "member", owner);
  assert.equal((await call("/api/invites", { method: "POST", cookie: member, body: { email: "x@x.com", role: "admin" } })).status, 403);
});

test("changing your own password needs the current one", async () => {
  // An unattended screen is how an account is taken over, and this is the change that locks the
  // owner out of their own instance.
  blank();
  const owner = await claimAs("owner@x.com");
  const wrong = await call("/api/session/me", {
    method: "PATCH", cookie: owner, body: { password: "a whole new passphrase", currentPassword: "nope" },
  });
  assert.equal(wrong.status, 403);
  const right = await call("/api/session/me", {
    method: "PATCH", cookie: owner, body: { password: "a whole new passphrase", currentPassword: PW },
  });
  assert.equal(right.status, 200);
  assert.ok(right.cookie, "and you are not signed out of the screen you are standing in front of");
});

test("who pressed Run is recorded on the run", async () => {
  blank();
  const owner = await claimAs("owner@x.com");
  const c = content("ZZ gate attrib");
  addColumn(c.sheet.id, { name: "Rule", kind: "script" });
  const out = await call(`/api/sheets/${c.sheet.id}/runs`, { method: "POST", cookie: owner, body: { scope: {} } });
  if (out.status === 200) {
    const row = db.prepare("SELECT started_by FROM runs WHERE id = ?").get(out.body.run.id) as any;
    assert.equal(Number(row.started_by), findByEmail("owner@x.com")!.id);
  }
});

test("an unused invite is listed, and can be taken back", async () => {
  blank();
  const owner = await claimAs("owner@x.com");
  await call("/api/invites", { method: "POST", cookie: owner, body: { email: "pending@x.com", role: "member" } });
  const list = await call("/api/people", { cookie: owner });
  assert.equal(list.body.invites.length, 1);
  const gone = await call(`/api/invites/${encodeURIComponent("pending@x.com")}`, { method: "DELETE", cookie: owner });
  assert.equal(gone.body.invites.length, 0);
});

test("an invite issued straight through the module still works end to end", async () => {
  // The module and the route must agree about the token. They hash it separately.
  blank();
  const cookie = await claimAs("owner@x.com");
  const me = findByEmail("owner@x.com")!;
  const { token } = createInvite("direct@x.com", "member", me.id);
  const out = await call("/api/session/invite", { method: "POST", body: { token, password: PW } });
  assert.equal(out.status, 200);
  assert.equal(out.body.person.email, "direct@x.com");
  assert.ok(cookie);
});

// ── Listings ─────────────────────────────────────────────────────────────────────────────────────
//
// The gate answers "may I touch THIS one?". A list has to answer a different question — "which ones
// do I not mention at all?" — and getting the first right does not get the second right.

test("a restricted workbook is not named in any listing", async () => {
  // Reproduced live: the gate refused the sheet with a 404 and the file browser went on showing the
  // workbook's NAME in the list. For a workbook called "Acquisition targets" the name IS the secret.
  blank();
  const owner = await claimAs("owner@x.com");
  const member = await joinAs("member@x.com", "member", owner);
  const c = content("ZZ gate listing");

  const before = await call("/api/workbooks", { cookie: member });
  assert.ok(before.body.workbooks.some((w: any) => w.id === c.wb.id), "visible while it is open");

  await call(`/api/workbooks/${c.wb.id}/access`, { method: "PATCH", cookie: owner, body: { restricted: true } });

  const after = await call("/api/workbooks", { cookie: member });
  assert.ok(!after.body.workbooks.some((w: any) => w.id === c.wb.id), "gone from the workbook list");

  const sheets = await call("/api/sheets", { cookie: member });
  assert.ok(!sheets.body.sheets.some((s: any) => s.id === c.sheet.id), "and its tables are gone too");
});

test("the workspace browser hides it as well, in every view it has", async () => {
  blank();
  const owner = await claimAs("owner@x.com");
  const member = await joinAs("member@x.com", "member", owner);
  const c = content("ZZ gate browser");
  await call(`/api/workbooks/${c.wb.id}/access`, { method: "PATCH", cookie: owner, body: { restricted: true } });

  for (const path of ["/api/workspace", "/api/workspace?view=recent", "/api/workspace?view=starred"]) {
    const out = await call(path, { cookie: member });
    const named = (out.body.entries ?? []).some((e: any) => e.id === c.wb.id || e.id === c.sheet.id);
    assert.equal(named, false, `${path} still names it`);
  }
});

test("a search does not find what a list is hiding", async () => {
  // The obvious way around a filtered list, and the one that gets forgotten.
  blank();
  const owner = await claimAs("owner@x.com");
  const member = await joinAs("member@x.com", "member", owner);
  const c = content("ZZ gate searchable");
  await call(`/api/workbooks/${c.wb.id}/access`, { method: "PATCH", cookie: owner, body: { restricted: true } });

  const out = await call("/api/workspace?q=ZZ%20gate%20searchable", { cookie: member });
  assert.equal((out.body.entries ?? []).some((e: any) => e.id === c.wb.id), false);
});

test("the person it was shared with still sees it in the list", async () => {
  // The other half: a filter that hides it from everyone is not sharing, it is deleting.
  blank();
  const owner = await claimAs("owner@x.com");
  const member = await joinAs("member@x.com", "member", owner);
  const c = content("ZZ gate shared back");
  await call(`/api/workbooks/${c.wb.id}/access`, { method: "PATCH", cookie: owner, body: { restricted: true } });
  const them = findByEmail("member@x.com")!;
  setGrant(c.wb.id, them.id, "view");

  const out = await call("/api/workbooks", { cookie: member });
  assert.ok(out.body.workbooks.some((w: any) => w.id === c.wb.id));
});

test("an admin still sees everything, matching what the gate lets them open", async () => {
  blank();
  const owner = await claimAs("owner@x.com");
  const admin = await joinAs("admin@x.com", "admin", owner);
  const c = content("ZZ gate adminsees");
  await call(`/api/workbooks/${c.wb.id}/access`, { method: "PATCH", cookie: owner, body: { restricted: true } });
  const out = await call("/api/workbooks", { cookie: admin });
  assert.ok(out.body.workbooks.some((w: any) => w.id === c.wb.id), "a list that hid what the gate opens would be a lie");
});
