// Folders.
//
// The failures worth guarding are the ones that look like data loss: a folder moved inside itself
// detaches its whole branch from the root, and a folder delete that takes its contents with it
// removes tables nobody meant to remove.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSheet } from "./store.ts";
import { createWorkbook } from "./views.ts";
import {
  breadcrumb, createFolder, listFolder, listRecent, listStarred, listWorkbook, markOpened, moveEntry,
  moveFolder, pathToSheet, search, setStarred, trashFolder,
} from "./workspace.ts";

test("a folder holds folders and files; a file holds tables", () => {
  // The model, stated as a test. It used to allow a table to sit in a folder beside a workbook, so
  // a "file" and a "tab inside a file" appeared as the same kind of thing and a table had no
  // workbook name to show. Tables now live in files, and files live in folders.
  const clients = createFolder("Clients");
  const acme = createFolder("Acme", clients.id);
  const wb = createWorkbook("Acme outbound");
  moveEntry("workbook", wb.id, acme.id);

  const prospects = createSheet("Prospects", wb.id);
  const outreach = createSheet("Outreach", wb.id);

  // The folder shows the FILE, not its tables.
  assert.deepEqual(listFolder(acme.id).map((e) => `${e.kind}:${e.name}`), ["workbook:Acme outbound"]);

  // The tables are one level down, in tab order rather than alphabetical — the browser and the tab
  // bar must describe the same file the same way.
  assert.deepEqual(listWorkbook(wb.id).map((e) => `${e.kind}:${e.name}`), ["table:Prospects", "table:Outreach"]);
  assert.equal(listWorkbook(wb.id)[0]!.id, prospects.id);
  assert.ok(outreach.id);

  // Folders sort before everything else: they are containers, and mixing them into an alphabetical
  // run means the shape of the place changes every time something is renamed.
  const top = listFolder(clients.id);
  assert.equal(top[0]!.kind, "folder");
  assert.equal(top[0]!.name, "Acme");
  assert.equal(top[0]!.count, 1, "a folder counts what is inside it");
});

test("the path to a table reads root-first: folders, its file, then itself", () => {
  // What the header renders. Assembled server-side in one request, because a breadcrumb built from
  // three round trips appears one crumb at a time.
  const folder = createFolder("Outbound");
  const sub = createFolder("Q3", folder.id);
  const wb = createWorkbook("UK agencies");
  moveEntry("workbook", wb.id, sub.id);
  const sheet = createSheet("Firms", wb.id);

  assert.deepEqual(
    pathToSheet(sheet.id).map((c) => `${c.kind}:${c.name}`),
    ["folder:Outbound", "folder:Q3", "workbook:UK agencies", "table:Firms"],
  );
  assert.deepEqual(pathToSheet("no-such-table"), []);
});

test("a folder cannot be moved inside itself, or inside its own subtree", () => {
  // Allowed, it detaches the whole branch from the root: still there, reachable from nothing, and
  // indistinguishable from having been deleted.
  const a = createFolder("A");
  const b = createFolder("B", a.id);
  const c = createFolder("C", b.id);

  assert.throws(() => moveFolder(a.id, a.id), /inside itself/i);
  assert.throws(() => moveFolder(a.id, c.id), /its own folders/i);

  // Moving the other way is fine, and is the ordinary case.
  moveFolder(c.id, a.id);
  assert.deepEqual(breadcrumb(c.id).map((f) => f.name), ["A", "C"]);
});

test("trashing a folder moves its contents up rather than deleting them", () => {
  // A delete is a statement about the folder, not about the tables inside it.
  const parent = createFolder("Parent");
  const doomed = createFolder("Doomed", parent.id);
  const wb = createWorkbook("Kept workbook");
  const child = createFolder("Kept folder", doomed.id);
  moveEntry("workbook", wb.id, doomed.id);
  // A table inside that file must survive too — it is two levels down from the folder being
  // deleted, and nothing about deleting a folder is a statement about it.
  const table = createSheet("Kept table", wb.id);

  const res = trashFolder(doomed.id);
  assert.equal(res.movedUp, 2);

  const survived = listFolder(parent.id).map((e) => e.name).sort();
  assert.deepEqual(survived, ["Kept folder", "Kept workbook"]);
  assert.deepEqual(listWorkbook(wb.id).map((e) => e.name), ["Kept table"]);
  assert.ok(child.id);
});

test("the breadcrumb reads root-first and stops at the root", () => {
  const a = createFolder("Outbound");
  const b = createFolder("Q3", a.id);
  const c = createFolder("UK", b.id);
  assert.deepEqual(breadcrumb(c.id).map((f) => f.name), ["Outbound", "Q3", "UK"]);
  assert.deepEqual(breadcrumb(null), []);
});

test("starred spans the whole workspace, and recents are opens rather than edits", () => {
  const f = createFolder("Starred folder");
  const wb = createWorkbook("Starred file holder");
  const t = createSheet("Starred table", wb.id);
  setStarred("folder", f.id, true);
  setStarred("table", t.id, true);

  const names = listStarred().map((e) => e.name);
  assert.ok(names.includes("Starred folder"));
  assert.ok(names.includes("Starred table"), "a table inside a file is still starrable");

  // Never opened means absent from recents. A "recent" list that is really "recently changed"
  // fills up with things a background run touched, which is not what anyone is looking for.
  const fresh = createSheet("Never opened", wb.id);
  assert.ok(!listRecent().some((e) => e.name === "Never opened"));
  markOpened("table", fresh.id);
  assert.equal(listRecent()[0]?.name, "Never opened");
});

test("search finds things without knowing where they are", () => {
  const buried = createFolder("Deep");
  const inner = createFolder("Deeper", buried.id);
  const wb = createWorkbook("Buried file");
  moveEntry("workbook", wb.id, inner.id);
  const t = createSheet("Findable list", wb.id);

  assert.ok(search("findable").some((e) => e.id === t.id));
  assert.equal(search("   ").length, 0, "an empty query lists nothing rather than everything");
});
