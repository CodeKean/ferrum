// The workspace: folders, and the things inside them.
//
// Once a machine holds more than a dozen tables, "which one was that" stops being answerable from a
// flat list, and the sheet switcher becomes a scrolling wall of near-identical names. A folder tree
// is the answer every file browser already settled on, so it needs no explaining.
//
// Two rules make it stay simple:
//
//   A thing is in exactly ONE place. Not tags, not multiple parents — so "where did I put it" has
//   one answer, and moving something cannot leave a copy behind.
//
//   A folder holds workbooks and loose tables, never cells. Nothing in here touches row data, which
//   is why moving a million-row table between folders is one UPDATE.

import { randomUUID } from "node:crypto";
import { db } from "./db.ts";

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  starred: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One row of the browser: a folder, a workbook, or a loose table. */
export interface Entry {
  kind: "folder" | "workbook" | "table";
  id: string;
  name: string;
  starred: boolean;
  /** Tables inside, for a workbook or folder. Rows, for a table. */
  count: number;
  /**
   * How wide a table is. Null for a folder or a workbook, which have no columns of their own.
   *
   * A table has two dimensions and the browser reported one, so a list of tables said nothing about
   * which of them held any structure — a 40-column table and a bare one both read as a row count.
   */
  columns: number | null;
  createdAt: string;
  updatedAt: string;
  /** Last time it was actually opened, which is a different question from last changed. */
  openedAt: string | null;
}

function toFolder(r: any): Folder {
  return {
    id: r.id, name: r.name, parentId: r.parent_id ?? null, starred: !!r.starred,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function createFolder(name: string, parentId: string | null = null): Folder {
  const id = randomUUID();
  db.prepare("INSERT INTO folders (id, name, parent_id) VALUES (?, ?, ?)")
    .run(id, name.trim() || "New folder", parentId);
  return getFolder(id)!;
}

export function getFolder(id: string): Folder | null {
  const r = db.prepare("SELECT * FROM folders WHERE id = ? AND deleted_at IS NULL").get(id) as any;
  return r ? toFolder(r) : null;
}

export function renameFolder(id: string, name: string): void {
  db.prepare("UPDATE folders SET name = ?, updated_at = datetime('now') WHERE id = ?")
    .run(name.trim() || "New folder", id);
}

/**
 * The path from the root down to this folder.
 *
 * Walks parents with a hard step limit rather than trusting the tree to be acyclic. `moveFolder`
 * refuses to create a cycle, but a breadcrumb that can hang the request is not worth the assumption.
 */
export function breadcrumb(folderId: string | null): Folder[] {
  const out: Folder[] = [];
  let cur = folderId;
  for (let i = 0; cur && i < 64; i++) {
    const f = getFolder(cur);
    if (!f) break;
    out.unshift(f);
    cur = f.parentId;
  }
  return out;
}

/** Every folder at or below this one, including itself. Used to refuse a move into own subtree. */
function subtree(folderId: string): Set<string> {
  const seen = new Set<string>([folderId]);
  const queue = [folderId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const r of db.prepare("SELECT id FROM folders WHERE parent_id = ? AND deleted_at IS NULL").all(id) as any[]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      queue.push(r.id);
    }
  }
  return seen;
}

export function moveFolder(id: string, parentId: string | null): void {
  if (parentId === id) throw new Error("A folder cannot be put inside itself.");
  // Into its own subtree would detach the whole branch from the root: it would still exist, be
  // reachable from nothing, and look exactly like data loss.
  if (parentId && subtree(id).has(parentId)) {
    throw new Error("A folder cannot be put inside one of its own folders.");
  }
  db.prepare("UPDATE folders SET parent_id = ?, updated_at = datetime('now') WHERE id = ?").run(parentId, id);
}

/**
 * Trash a folder.
 *
 * Its contents move UP to the parent rather than disappearing with it. Deleting a folder is a
 * statement about the folder, not about the twelve tables inside — and a delete that silently takes
 * a million rows with it is the one mistake nobody recovers from quickly.
 */
export function trashFolder(id: string): { movedUp: number } {
  const f = getFolder(id);
  if (!f) return { movedUp: 0 };
  const parent = f.parentId;
  let movedUp = 0;
  movedUp += db.prepare("UPDATE folders SET parent_id = ? WHERE parent_id = ?").run(parent, id).changes as number;
  movedUp += db.prepare("UPDATE workbooks SET folder_id = ? WHERE folder_id = ?").run(parent, id).changes as number;
  movedUp += db.prepare("UPDATE sheets SET folder_id = ? WHERE folder_id = ?").run(parent, id).changes as number;
  db.prepare("UPDATE folders SET deleted_at = datetime('now') WHERE id = ?").run(id);
  return { movedUp };
}

export function setStarred(kind: Entry["kind"], id: string, starred: boolean): void {
  const table = kind === "folder" ? "folders" : kind === "workbook" ? "workbooks" : "sheets";
  db.prepare(`UPDATE ${table} SET starred = ? WHERE id = ?`).run(starred ? 1 : 0, id);
}

/** Put a workbook or a loose table into a folder. `null` is the root. */
export function moveEntry(kind: Entry["kind"], id: string, folderId: string | null): void {
  if (kind === "folder") { moveFolder(id, folderId); return; }
  const table = kind === "workbook" ? "workbooks" : "sheets";
  db.prepare(`UPDATE ${table} SET folder_id = ?, updated_at = datetime('now') WHERE id = ?`).run(folderId, id);
}

/** Record that something was opened. Distinct from updated_at, which is about content. */
export function markOpened(kind: Entry["kind"], id: string): void {
  const table = kind === "workbook" ? "workbooks" : "sheets";
  if (kind === "folder") return;
  db.prepare(`UPDATE ${table} SET opened_at = datetime('now') WHERE id = ?`).run(id);
}

/**
 * What is inside a folder — or at the root, when `folderId` is null.
 *
 * Folders first, then everything else by name. Folders first because they are containers: mixing
 * them into an alphabetical run means the shape of the place changes every time something is
 * renamed.
 */
export function listFolder(folderId: string | null): Entry[] {
  const where = folderId ? "= ?" : "IS NULL";
  const args = folderId ? [folderId] : [];

  const folders = (db
    .prepare(
      `SELECT f.*, (SELECT COUNT(*) FROM workbooks w WHERE w.folder_id = f.id AND w.archived = 0)
                 + (SELECT COUNT(*) FROM sheets s WHERE s.folder_id = f.id AND s.workbook_id IS NULL AND s.deleted_at IS NULL)
                 + (SELECT COUNT(*) FROM folders c WHERE c.parent_id = f.id AND c.deleted_at IS NULL) AS n
         FROM folders f
        WHERE f.parent_id ${where} AND f.deleted_at IS NULL
        ORDER BY f.name COLLATE NOCASE`,
    )
    .all(...args) as any[]).map((r): Entry => ({
      kind: "folder", id: r.id, name: r.name, starred: !!r.starred, count: Number(r.n), columns: null,
      createdAt: r.created_at, updatedAt: r.updated_at, openedAt: null,
    }));

  const workbooks = (db
    .prepare(
      `SELECT w.*, (SELECT COUNT(*) FROM sheets s WHERE s.workbook_id = w.id AND s.deleted_at IS NULL) AS n
         FROM workbooks w
        WHERE w.folder_id ${where} AND w.archived = 0 AND w.is_template = 0
        ORDER BY w.name COLLATE NOCASE`,
    )
    .all(...args) as any[]).map((r): Entry => ({
      kind: "workbook", id: r.id, name: r.name, starred: !!r.starred, count: Number(r.n), columns: null,
      createdAt: r.created_at, updatedAt: r.updated_at, openedAt: r.opened_at ?? null,
    }));

  // No table branch: every table lives in a workbook, so a folder holds folders and files and
  // nothing else. Tables are reached by opening the file they are in — `listWorkbook`.
  return [...folders, ...workbooks];
}

/**
 * The tables inside a workbook, in tab order.
 *
 * Ordered by position rather than by name, because that order is the tab bar's order and the two
 * disagreeing would make the browser and the tabs describe the same file differently.
 */
export function listWorkbook(workbookId: string): Entry[] {
  return (db
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM rows r WHERE r.sheet_id = s.id) AS n,
                     (SELECT COUNT(*) FROM columns c WHERE c.sheet_id = s.id) AS c
         FROM sheets s
        WHERE s.workbook_id = ? AND s.archived = 0 AND s.deleted_at IS NULL
        ORDER BY s.position, s.created_at`,
    )
    .all(workbookId) as any[]).map((r): Entry => ({
      kind: "table", id: r.id, name: r.name, starred: !!r.starred, count: Number(r.n), columns: Number(r.c ?? 0),
      createdAt: r.created_at, updatedAt: r.updated_at, openedAt: r.opened_at ?? null,
    }));
}

/**
 * Where a table sits, root-first: folders, then its workbook, then itself.
 *
 * One request, because the header renders the whole path and a breadcrumb assembled from three
 * round trips appears one crumb at a time.
 */
export function pathToSheet(sheetId: string): Array<{ kind: "folder" | "workbook" | "table"; id: string; name: string }> {
  const sheet = db
    .prepare("SELECT id, name, workbook_id FROM sheets WHERE id = ? AND deleted_at IS NULL")
    .get(sheetId) as any;
  if (!sheet) return [];

  const out: Array<{ kind: "folder" | "workbook" | "table"; id: string; name: string }> = [];
  if (sheet.workbook_id) {
    const wb = db.prepare("SELECT id, name, folder_id FROM workbooks WHERE id = ?").get(sheet.workbook_id) as any;
    if (wb) {
      for (const f of breadcrumb(wb.folder_id ?? null)) out.push({ kind: "folder", id: f.id, name: f.name });
      out.push({ kind: "workbook", id: wb.id, name: wb.name });
    }
  }
  out.push({ kind: "table", id: sheet.id, name: sheet.name });
  return out;
}

/** Everything starred, wherever it lives. */
export function listStarred(): Entry[] {
  return everything().filter((e) => e.starred);
}

/** Most recently opened first. Things never opened do not appear — this is history, not a list. */
export function listRecent(limit = 20): Entry[] {
  return everything()
    .filter((e) => e.openedAt)
    .sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)))
    .slice(0, limit);
}

function everything(): Entry[] {
  const folders = (db.prepare("SELECT * FROM folders WHERE deleted_at IS NULL").all() as any[]).map((r): Entry => ({
    kind: "folder", id: r.id, name: r.name, starred: !!r.starred, count: 0, columns: null,
    createdAt: r.created_at, updatedAt: r.updated_at, openedAt: null,
  }));
  const workbooks = (db
    .prepare(`SELECT w.*, (SELECT COUNT(*) FROM sheets s WHERE s.workbook_id = w.id AND s.deleted_at IS NULL) AS n
                FROM workbooks w WHERE w.archived = 0 AND w.is_template = 0`)
    .all() as any[]).map((r): Entry => ({
      kind: "workbook", id: r.id, name: r.name, starred: !!r.starred, count: Number(r.n), columns: null,
      createdAt: r.created_at, updatedAt: r.updated_at, openedAt: r.opened_at ?? null,
    }));
  const tables = (db
    .prepare(`SELECT s.*, (SELECT COUNT(*) FROM rows r WHERE r.sheet_id = s.id) AS n,
                     (SELECT COUNT(*) FROM columns c WHERE c.sheet_id = s.id) AS c
                FROM sheets s WHERE s.archived = 0 AND s.deleted_at IS NULL`)
    .all() as any[]).map((r): Entry => ({
      kind: "table", id: r.id, name: r.name, starred: !!r.starred, count: Number(r.n), columns: Number(r.c ?? 0),
      createdAt: r.created_at, updatedAt: r.updated_at, openedAt: r.opened_at ?? null,
    }));
  return [...folders, ...workbooks, ...tables];
}

/** Name search across the whole workspace, so finding something never requires knowing where it is. */
export function search(query: string): Entry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return everything().filter((e) => e.name.toLowerCase().includes(q)).slice(0, 50);
}
