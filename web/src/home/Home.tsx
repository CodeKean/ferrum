// The file browser.
//
// A full page, not a dialog. It was a dialog, and the dialog sized itself to its contents — so every
// navigation, search and filter resized the window under the pointer, which is both the worst
// version of this screen and the easiest one to build. A browser is somewhere you go, and the place
// you go should not move.
//
// The shape follows the data model rather than fighting it: a folder holds FOLDERS and FILES, a file
// holds TABLES. Navigating down goes folder → folder → workbook → table; the breadcrumb goes back
// up, one crumb at a time.
//
// Everything here is metadata — names, counts, dates, and where a thing sits. No cell is read, so a
// folder holding a million-row table opens exactly as fast as an empty one.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ContextMenu, useContextMenu, type MenuItem } from "../ui/ContextMenu.tsx";
import { Modal } from "../ui/Modal.tsx";
import { ShareWorkbook } from "../people/ShareWorkbook.tsx";
import { useSession } from "../people/SessionGate.tsx";
import { IconCaretDown, IconCaretUp, IconPlus, IconSearch, IconTable, IconUpload } from "../ui/Icon.tsx";
import { clickOrDouble } from "../ui/clickOrDouble.ts";
import {
  CopyDone, DuplicateWorkbook, ImportWorkbook, TemplatizeWorkbook, UseTemplate, type CopyResult,
} from "./CopyDialogs.tsx";
import "./Home.css";

export interface Entry {
  kind: "folder" | "workbook" | "table";
  id: string;
  name: string;
  starred: boolean;
  count: number;
  /** How wide a table is. Null for a folder or a workbook, which have no columns of their own. */
  columns: number | null;
  createdAt: string;
  updatedAt: string;
  openedAt: string | null;
}

export interface Crumb { kind: "folder" | "workbook" | "table"; id: string; name: string }

/** The sub-tabs. Exported because the app puts the open one in the URL. */
export type BrowserView = "files" | "recent" | "starred" | "templates";

/** Where the browser currently is. One object, so a navigation is one state change. */
export interface At {
  view: BrowserView;
  folderId: string | null;
  workbookId: string | null;
}

interface Props {
  /**
   * Where to open — a sub-tab, a folder, a workbook, or the root. Comes from the header's path
   * crumbs and from the URL on a reload.
   *
   * Re-read whenever the OBJECT changes, not only on mount: clicking the same crumb twice has to
   * navigate twice, and comparing by value would make the second click do nothing.
   */
  startAt?: { view?: BrowserView; folderId?: string; workbookId?: string } | null;
  /** Open a table in the grid. */
  onOpenTable: (id: string) => void;
  /** Start the build-a-table interview. */
  onBuildTable?: () => void;
  /** Back to the table that was open. Absent when there is nothing to go back to. */
  onClose?: () => void;
  /** Reports where the browser is, so the header's path shows it rather than the last open table. */
  onPathChange?: (path: Crumb[]) => void;
  /** Reports the same thing in addressable form, so the app can put it in the URL. */
  onNavigate?: (at: At) => void;
}

/** What a column sorts by. Every header offers one — the same rule the sheet grid follows. */
type SortKey = "name" | "count" | "columns" | "openedAt" | "createdAt" | "starred";

/** Dates read as "how long ago", which is the only thing anyone wants from this column. */
function ago(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso.replace(" ", "T") + (iso.endsWith("Z") ? "" : "Z")).getTime();
  if (!Number.isFinite(then)) return "—";
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 90) return "just now";
  const mins = secs / 60;
  if (mins < 60) return `${Math.round(mins)}m ago`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d ago`;
  return new Date(then).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function IconFolder() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.75 4.25A1.5 1.5 0 0 1 3.25 2.75h2.4a1.5 1.5 0 0 1 1.06.44l.83.83h5.21a1.5 1.5 0 0 1 1.5 1.5v6.23a1.5 1.5 0 0 1-1.5 1.5H3.25a1.5 1.5 0 0 1-1.5-1.5Z" />
    </svg>
  );
}

export function IconBook() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.75 3.25h4a2 2 0 0 1 2 2v8a1.5 1.5 0 0 0-1.5-1.5h-4.5Z" />
      <path d="M13.25 3.25h-4a2 2 0 0 0-2 2v8a1.5 1.5 0 0 1 1.5-1.5h4.5Z" />
    </svg>
  );
}

function IconStar({ filled }: { filled: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
      <path d="M8 2.25l1.76 3.57 3.94.57-2.85 2.78.67 3.92L8 11.24l-3.52 1.85.67-3.92L2.3 6.39l3.94-.57Z" />
    </svg>
  );
}

const ROOT: At = { view: "files", folderId: null, workbookId: null };

/** The place a `startAt` names. One function, so the initial state and a later crumb agree. */
function atFrom(startAt: Props["startAt"]): At {
  const view = startAt?.view ?? "files";
  if (startAt?.workbookId) return { view: "files", folderId: null, workbookId: startAt.workbookId };
  if (startAt?.folderId) return { view: "files", folderId: startAt.folderId, workbookId: null };
  return { view, folderId: null, workbookId: null };
}

export function Home({ startAt, onOpenTable, onBuildTable, onClose, onPathChange, onNavigate }: Props) {
  // Only used to decide whether sharing is a thing that exists here. On a single-user install it
  // is not, and the menu item is absent rather than disabled.
  const { me } = useSession();
  const [at, setAt] = useState<At>(() => atFrom(startAt));
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" } | null>(null);
  const [path, setPath] = useState<Crumb[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [moving, setMoving] = useState<Entry | null>(null);
  /**
   * What is being dragged, and the row it is currently over.
   *
   * The payload lives in a REF, not in state. `dragover` can fire in the same task as `dragstart`,
   * and React has not committed the state update by then — so a state-only version reads `null` on
   * the first pass, decides the drop is illegal, and never marks the row as a drop zone. The state
   * copy exists only to drive the highlight, where being one frame late is invisible.
   */
  const draggingRef = useRef<Entry | null>(null);
  /**
   * The pending single-click, shared by every row.
   *
   * One is enough: only one gesture can be in flight, and clicking a second row while the first is
   * still deciding is a new gesture that replaces it.
   */
  const gestureTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (gestureTimer.current) clearTimeout(gestureTimer.current); }, []);
  const [dragging, setDragging] = useState<Entry | null>(null);
  const [dropInto, setDropInto] = useState<Entry | null>(null);
  /** What is about to be thrown away, waiting to be confirmed. */
  const [trashing, setTrashing] = useState<Entry | null>(null);
  const [allFolders, setAllFolders] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  /** Which copy dialog is open, and what it is about. One slot — only one can be open at a time. */
  /** The workbook whose sharing is open. Null when it is not. */
  const [sharing, setSharing] = useState<{ id: string; name: string } | null>(null);
  /** Columns carrying a typed-in credential, held while the user decides whether to send the file. */
  const [exportWarn, setExportWarn] = useState<{
    id: string;
    secrets: Array<{ table: string; column: string }>;
    droppedRelations: Array<{ table: string; otherTable: string }>;
  } | null>(null);

  /**
   * Download the file, ASKING FIRST if anything credential-shaped would leave with it.
   *
   * A download is the point of no return — once the file is in a chat message a key inside it has to
   * be rotated, not deleted. If the check finds nothing, or cannot run, the export proceeds: a
   * safety prompt that blocks the feature when the engine hiccups is a worse trade than the warning
   * it exists to give.
   */
  const startExport = useCallback(async (id: string) => {
    const go = () => { window.location.href = `/api/workbooks/${id}/export.json`; };
    try {
      const r = await fetch(`/api/workbooks/${id}/export-check`).then((x) => x.json());
      const secrets = Array.isArray(r?.secrets) ? r.secrets : [];
      const droppedRelations = Array.isArray(r?.droppedRelations) ? r.droppedRelations : [];
      if (secrets.length || droppedRelations.length) {
        setExportWarn({ id, secrets, droppedRelations });
        return;
      }
    } catch { /* fall through — see above */ }
    go();
  }, []);
  const [copying, setCopying] = useState<
    | { how: "duplicate" | "templatize" | "use"; entry: Entry }
    | { how: "import" }
    | null
  >(null);
  /** The receipt from whichever one just finished. */
  const [copied, setCopied] = useState<CopyResult | null>(null);
  const ctx = useContextMenu();

  /**
   * The place the rows currently on screen belong to.
   *
   * The skeleton is gated on this rather than shown for every `load()`. A star, a rename, a move or
   * a trash all refetch the SAME place, and blanking the whole list to skeletons for one of them is
   * the full-surface flash the reactive rule forbids — you star a row and the list you were reading
   * disappears. When the place itself changes the rows really are unknown, and the skeleton is
   * honest; that is the only time it shows.
   */
  const loadedFor = useRef<string | null>(null);

  const load = useCallback(async () => {
    // Templates are not part of the folder tree — they have no place, they are a library — so the
    // sub-tab reads a different endpoint and maps the result into the same row shape. The alternative
    // was a second list component beside this one, which is a second set of sort headers, a second
    // context menu and a second empty state to keep in step.
    if (at.view === "templates" && !at.workbookId && !query.trim()) {
      if (loadedFor.current !== "templates") setLoading(true);
      try {
        const res = await fetch("/api/workbooks").then((r) => r.json());
        if (res.error) { setError(res.error); return; }
        setEntries(((res.templates ?? []) as any[]).map((t) => ({
          kind: "workbook" as const,
          id: t.id, name: t.name, starred: false,
          count: Number(t.tableCount ?? 0),
          // A template is a workbook, and a workbook has no columns of its own.
          columns: null,
          createdAt: t.createdAt, updatedAt: t.updatedAt, openedAt: null,
        })));
        setPath([]);
        onPathChange?.([]);
        setError(null);
      } catch {
        setError("Could not reach the engine.");
      } finally {
        loadedFor.current = "templates";
        setLoading(false);
      }
      return;
    }

    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    else {
      params.set("view", at.view);
      if (at.workbookId) params.set("workbook", at.workbookId);
      else if (at.folderId) params.set("folder", at.folderId);
    }
    const key = params.toString();
    if (loadedFor.current !== key) setLoading(true);
    try {
      const res = await fetch(`/api/workspace?${params}`).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      setEntries(res.entries ?? []);
      setPath(res.path ?? []);
      onPathChange?.(query.trim() ? [] : (res.path ?? []));
      setError(null);
    } catch {
      setError("Could not reach the engine.");
    } finally {
      loadedFor.current = key;
      setLoading(false);
    }
  }, [at, query, onPathChange]);

  useEffect(() => {
    // Debounced while typing, because every keystroke would otherwise scan the whole workspace.
    const t = setTimeout(() => { void load(); }, query.trim() ? 200 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  /**
   * Follow the header's crumbs while this is already open.
   *
   * `startAt` was read ONCE, in the useState initializer, and nothing gave this component a key —
   * so clicking a folder crumb from inside the browser changed the prop and moved nothing. The
   * crumbs looked live and were inert.
   *
   * Skipped on the first run because the initializer has already applied it; re-running would
   * replace `at` with an equal-but-new object and cost a second fetch of the same place.
   */
  const firstStart = useRef(true);
  useEffect(() => {
    if (firstStart.current) { firstStart.current = false; return; }
    setQuery("");
    setAt(atFrom(startAt));
  }, [startAt]);

  /** Where this is, in the shape the app puts in the URL. */
  useEffect(() => { onNavigate?.(at); }, [at, onNavigate]);

  // Every create, star, move and trash on this screen goes through here, and none of them was
  // catching: with the engine unreachable the fetch rejected, the row did not change, and the only
  // trace was an unhandled rejection in a console nobody is reading.
  const post = async (url: string, body?: unknown) => {
    let res: any;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then((r) => r.json());
    } catch {
      setError("Could not reach the engine.");
      return null;
    }
    if (res.error) { setError(res.error); return null; }
    await load();
    return res;
  };

  /**
   * Can `what` be dropped onto `onto`?
   *
   * Two legal moves, and they are the two the workspace model allows: anything can go into a
   * FOLDER, and a table can go into a WORKBOOK. A table cannot sit loose in a folder, and a folder
   * cannot go inside a workbook — a workbook is a file, not a container of files.
   *
   * A folder dropped into itself is refused here as well as by the engine: offering the move and
   * then erroring is a worse way to say no than not offering it.
   */
  /**
   * Would moving `what` out leave the workbook you are standing in with no tables?
   *
   * A workbook with nothing in it is a row in the browser that opens onto nothing, and the engine's
   * own route comment names it as the one state a file browser must never produce. The tab bar
   * already refuses the same move — `SheetTabs` disables "Move to trash" on the last table — and
   * this path had no guard at all, so the gesture that could produce it was the one nobody checked.
   *
   * Only answerable while listing a workbook: in search results and at the root the source
   * workbook's other tables are not on screen to count.
   */
  const emptiesWorkbook = (what: Entry): boolean =>
    what.kind === "table" &&
    !!at.workbookId &&
    !query.trim() &&
    entries.filter((e) => e.kind === "table").length <= 1;

  const canDrop = (what: Entry | null, onto: Entry): boolean => {
    if (!what || what.id === onto.id) return false;
    if (onto.kind === "folder") return what.kind !== "table";
    if (onto.kind === "workbook") return what.kind === "table" && !emptiesWorkbook(what);
    return false;
  };

  const moveInto = async (what: Entry, onto: Entry) => {
    if (onto.kind === "workbook") {
      // A table lives in a workbook, and that relation is on the sheet itself rather than in the
      // folder tree — so it is a different route from the folder move below.
      const res = await fetch(`/api/sheets/${what.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workbookId: onto.id }),
      }).then((r) => r.json()).catch(() => ({ error: "Could not reach the engine." }));
      if (res.error) { setError(res.error); return; }
      await load();
      return;
    }
    await post("/api/workspace/move", { kind: what.kind, id: what.id, folderId: onto.id });
  };

  const open = (e: Entry) => {
    setQuery("");
    if (e.kind === "folder") { setAt({ view: "files", folderId: e.id, workbookId: null }); return; }
    // Looking inside a template stays on the Templates tab, so backing out returns to the library
    // rather than dumping you at the root of All files.
    if (e.kind === "workbook") {
      setAt((a) => ({ view: a.view === "templates" ? "templates" : "files", folderId: null, workbookId: e.id }));
      return;
    }
    onOpenTable(e.id);
  };

  // No second "jump to a crumb" helper here. `atFrom` above is the one mapping from a place to a
  // location, used by both the initial state and the header's
  // crumbs, so keeping a duplicate that nothing calls is just a second version to drift out of step.

  const commitRename = async (e: Entry) => {
    const next = draft.trim();
    setRenaming(null);
    if (!next || next === e.name) return;
    const url =
      e.kind === "folder" ? `/api/folders/${e.id}`
      : e.kind === "workbook" ? `/api/workbooks/${e.id}`
      : `/api/sheets/${e.id}`;
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: next }),
      }).then((r) => r.json());
      // A refused rename comes back as 200 carrying the reason. Unread, the field closed and the old
      // name came back, which reads as the rename having worked and then reverted.
      if (res.error) { setError(res.error); return; }
    } catch {
      setError("Could not reach the engine.");
      return;
    }
    await load();
  };

  const isTemplate = at.view === "templates" && !at.workbookId && !query.trim();

  const menu = (e: Entry): MenuItem[] => [
    ...(isTemplate
      ? [{ label: "Start a workbook from this", onSelect: () => setCopying({ how: "use", entry: e }) } as MenuItem]
      : []),
    { label: e.kind === "table" ? "Open table" : isTemplate ? "Look inside" : "Open", onSelect: () => open(e) },
    { label: "Rename", hint: "dbl-click", onSelect: () => { setDraft(e.name); setRenaming(e.id); } },
    // A workbook is the only thing here that can be copied whole, kept as a template, or written to
    // a file — a folder is a place, and a table already has its own duplicate on the tab bar.
    ...(e.kind === "workbook" && !isTemplate
      ? ([
          { separator: true },
          ...(me.claimed ? [{ label: "Who can open this…", title: "Everyone here, or only certain people", onSelect: () => setSharing({ id: e.id, name: e.name }) } as MenuItem] : []),
          { label: "Duplicate…", onSelect: () => setCopying({ how: "duplicate", entry: e }) },
          { label: "Keep as a template…", onSelect: () => setCopying({ how: "templatize", entry: e }) },
          {
            label: "Export to a file",
            hint: ".ferrum.json",
            // This used to end "and never a key", which was false and false in the one direction a
            // safety claim must never be wrong in: a key TYPED INTO A HEADER is part of the column's
            // definition, so it travels. Saved keys are referenced by name and genuinely do not.
            title: "The tables, columns and prompts — never the rows. A key typed into a column travels with it; a saved key does not.",
            onSelect: () => { void startExport(e.id); },
          },
        ] as MenuItem[])
      : []),
    ...(e.kind === "workbook" && isTemplate
      ? ([
          { separator: true },
          {
            label: "Export to a file",
            hint: ".ferrum.json",
            onSelect: () => { window.location.href = `/api/workbooks/${e.id}/export.json`; },
          },
        ] as MenuItem[])
      : []),
    {
      label: e.starred ? "Remove from starred" : "Star",
      onSelect: () => void post("/api/workspace/star", { kind: e.kind, id: e.id, starred: !e.starred }),
    },
    {
      // A table moves into a WORKBOOK; a folder or a workbook moves into a FOLDER. Same gesture,
      // different destination list, because those are the two relations the workspace has.
      label: e.kind === "table" ? "Move to workbook…" : "Move to folder…",
      hint: "drag",
      // Refused for the same reason the drop is, and said rather than silently missing: the last
      // table of a workbook cannot leave it.
      disabled: emptiesWorkbook(e),
      title: emptiesWorkbook(e) ? "This is the only table in this workbook." : undefined,
      onSelect: async () => {
        setAllFolders(e.kind === "table" ? await collectWorkbooks() : await collectFolders());
        setMoving(e);
      },
    },
    { separator: true },
    {
      label: e.kind === "folder" ? "Delete folder" : "Move to trash",
      danger: true,
      title: e.kind === "folder" ? "What is inside moves up a level rather than being deleted" : undefined,
      // Asked, not done. A workbook holding twelve tables and a folder holding half the workspace
      // were both one stray click from disappearing, and the menu item that did it sat directly
      // under "Move to folder…". The dialog also states what happens to the CONTENTS, which is the
      // part nobody can guess.
      onSelect: () => setTrashing(e),
    },
  ];

  const inWorkbook = !!at.workbookId && !query.trim();

  /**
   * The rows as they are shown.
   *
   * Every column sorts, the same rule the sheet grid follows — the headers here were inert text.
   * Sorting is done in the client on purpose and not as a shortcut: the workspace endpoint returns
   * a whole folder in ONE response with no paging, so this sorts the entire set rather than a page
   * of it. Text folds case-insensitively; name is the tie-break so a sort is never arbitrary.
   */
  const shown = useMemo(() => {
    if (!sort) return entries;
    const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    const rank = (a: Entry, b: Entry): number => {
      switch (sort.key) {
        case "name": return byName(a, b);
        case "count": return a.count - b.count;
        // A folder or workbook has no columns of its own; null sorts below every real width rather
        // than as a zero-column table, which would read as an empty table.
        case "columns": return (a.columns ?? -1) - (b.columns ?? -1);
        case "starred": return Number(a.starred) - Number(b.starred);
        // Never opened sorts as the earliest, which is what the "—" in that cell means.
        case "openedAt": return String(a.openedAt ?? "").localeCompare(String(b.openedAt ?? ""));
        case "createdAt": return String(a.createdAt).localeCompare(String(b.createdAt));
      }
    };
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...entries].sort((a, b) => rank(a, b) * dir || byName(a, b));
  }, [entries, sort]);

  /**
   * One sortable header. Clicking the active column flips the direction.
   *
   * `name` is the spoken one — the star column's label is a glyph, so it has no text of its own to
   * be announced, and `scope` is what tells a screen reader which cells each of these heads.
   */
  const th = (key: SortKey, label: ReactNode, name: string, className?: string) => {
    const active = sort?.key === key;
    return (
      <th
        scope="col"
        className={className}
        aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}
      >
        <button
          className={`cc-fx__sort${active ? " cc-fx__sort--on" : ""}`}
          aria-label={`Sort by ${name}`}
          title={`Sort by ${name}`}
          onClick={() => setSort((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }))}
        >
          <span className="truncate">{label}</span>
          {/* Always in the DOM at a fixed width, so turning a sort on cannot resize its header. */}
          <span className="cc-fx__caret" aria-hidden>
            {active ? (sort!.dir === "asc" ? <IconCaretUp /> : <IconCaretDown />) : null}
          </span>
        </button>
      </th>
    );
  };

  const heading = useMemo(() => {
    if (query.trim()) return "Search";
    if (at.view === "recent") return "Recent";
    if (at.view === "starred") return "Starred";
    if (at.view === "templates" && !at.workbookId) return "Templates";
    return path.length > 0 ? path[path.length - 1]!.name : "All files";
  }, [at.view, path, query]);

  return (
    <div className="cc-fx">
      {/* The path is NOT repeated here, one line under the app bar's copy of it — the same crumbs,
          the same names, the same clicks, twice. The app bar's path is the one that is always on
          screen and it already drives this browser, so this row holds only
          other job, the way back, has moved into the bar below. */}

      {/* Row 1: what you are looking at, search, the create actions, and the way out. */}
      <div className="cc-fx__bar">
        <div className="cc-seg" role="tablist">
          {(["files", "recent", "starred", "templates"] as BrowserView[]).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={at.view === v && !query.trim()}
              className={`cc-seg__btn${at.view === v && !query.trim() ? " cc-seg__btn--on" : ""}`}
              onClick={() => { setQuery(""); setAt({ view: v, folderId: null, workbookId: null }); }}
            >
              {v === "files" ? "All files" : v === "recent" ? "Recent" : v === "starred" ? "Starred" : "Templates"}
            </button>
          ))}
        </div>

        <label className="cc-search cc-fx__search">
          <span className="cc-search__icon" aria-hidden="true"><IconSearch /></span>
          <input
            type="search"
            value={query}
            placeholder="Search everything"
            aria-label="Search the workspace"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>

        {/* Inside a file, the thing you make is a TABLE. Outside one, a folder or a file. The
            actions follow the place rather than always offering all three. */}
        {inWorkbook ? (
          <button
            className="cc-btn cc-btn--primary cc-btn--xs"
            onClick={() => void post("/api/sheets", { name: "Untitled table", workbookId: at.workbookId })}
          >
            <IconPlus /> <span>Table</span>
          </button>
        ) : (
          <>
            <button
              className="cc-btn cc-btn--xs"
              onClick={() => void post("/api/folders", { name: "New folder", parentId: at.folderId })}
              title="Create a folder here"
            >
              <IconPlus /> <span>Folder</span>
            </button>
            <button
              className="cc-btn cc-btn--xs"
              onClick={async () => {
                const res = await post("/api/workbooks", { name: "Untitled workbook", folderId: at.folderId });
                if (res?.sheet?.id) onOpenTable(res.sheet.id);
              }}
              title="A file, holding one or more tables"
            >
              <IconPlus /> <span>Workbook</span>
            </button>
            <button
              className="cc-btn cc-btn--xs"
              onClick={() => setCopying({ how: "import" })}
              title="Open a .ferrum.json workbook someone sent you"
            >
              <IconUpload /> <span>Import</span>
            </button>
            {onBuildTable && (
              <button className="cc-btn cc-btn--primary cc-btn--xs" onClick={onBuildTable} title="Describe what you want and answer a few questions">
                <IconPlus /> <span>Build with AI</span>
              </button>
            )}
          </>
        )}

        {/* The way back, now that the row above it is gone. Last, and set apart by a divider —
            it leaves this screen rather than doing something on it. */}
        {onClose && (
          <>
            <span className="cc-fx__divider" aria-hidden />
            <button className="cc-btn cc-btn--xs" onClick={onClose} title="Back to the table you had open">
              Back to table
            </button>
          </>
        )}
      </div>

      {error && <div className="cc-fx__error" role="alert">{error}</div>}

      <div className="cc-fx__listwrap">
        <table className="cc-fx__table">
          <thead>
            <tr>
              {th("name", "Name", "name")}
              {th("count", inWorkbook ? "Rows" : "Holds", inWorkbook ? "rows" : "what it holds", "cc-fx__num")}
              {/* Only inside a workbook, where every row IS a table. At the root the list is folders
                  and workbooks, and a width column would be a column of dashes. */}
              {inWorkbook && th("columns", "Columns", "columns", "cc-fx__num")}
              {th("openedAt", "Last opened", "last opened")}
              {th("createdAt", "Created", "created")}
              {th("starred", <IconStar filled={false} />, "starred", "cc-fx__starhead")}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              // Fixed count and fixed row height: the list occupies the same space loading as
              // loaded, so arriving data cannot shift what is under the pointer.
              Array.from({ length: 8 }, (_, i) => (
                <tr key={i} className="cc-fx__row">
                  <td colSpan={inWorkbook ? 6 : 5}><span className="cc-skel" style={{ width: `${35 + ((i * 13) % 40)}%` }} /></td>
                </tr>
              ))
            ) : shown.length === 0 ? (
              <tr className="cc-fx__row cc-fx__row--empty">
                <td colSpan={inWorkbook ? 6 : 5}>
                  <span className="cc-fx__empty">
                    {query.trim() ? "Nothing matches that."
                      : at.view === "recent" ? "Nothing opened yet. Tables you open show up here."
                      : at.view === "starred" ? "Nothing starred yet. Star a file to keep it here."
                      : isTemplate ? "No templates yet. Right-click a workbook and choose “Keep as a template”, or import one someone sent you."
                      : inWorkbook ? "This workbook has no tables yet."
                      : "Nothing here yet. Make a workbook, or build one with AI."}
                  </span>
                </td>
              </tr>
            ) : (
              shown.map((e) => (
                <tr
                  key={`${e.kind}:${e.id}`}
                  className={`cc-fx__row${dropInto?.id === e.id ? " cc-fx__row--drop" : ""}${dragging?.id === e.id ? " cc-fx__row--dragging" : ""}`}
                  /* The whole row opens it, and a double-click anywhere on the row renames it.
                     The two used to be split: only the name button opened, and double-clicking that
                     name ran BOTH — it navigated into the workbook and then opened a rename box on
                     the screen it had just left. */
                  {...clickOrDouble(
                    gestureTimer,
                    () => open(e),
                    () => { setDraft(e.name); setRenaming(e.id); },
                  )}
                  // The kind goes with the name, so the same-shaped list of verbs says which of the
                  // three things it is about. A folder, a workbook and a table opened menus that
                  // looked identical.
                  onContextMenu={(ev) => ctx.open(ev, e.name, menu(e), e.kind === "workbook" ? "Workbook" : e.kind === "folder" ? "Folder" : "Table")}
                  /* Filing by hand, the way a file manager does it. The right-click route stays —
                     it is the only one that works from a search result, where the destination is
                     not on screen to drop onto. */
                  draggable={renaming !== e.id}
                  onDragStart={(ev) => {
                    draggingRef.current = e;
                    setDragging(e);
                    ev.dataTransfer.effectAllowed = "move";
                    // Something has to be set or Firefox refuses to start the drag at all.
                    ev.dataTransfer.setData("text/plain", e.name);
                  }}
                  onDragEnd={() => { draggingRef.current = null; setDragging(null); setDropInto(null); }}
                  onDragOver={(ev) => {
                    if (!canDrop(draggingRef.current, e)) return;
                    // Only preventDefault on a legal target: the browser reads that as "this is a
                    // drop zone", so doing it unconditionally would advertise every row.
                    ev.preventDefault();
                    ev.dataTransfer.dropEffect = "move";
                    if (dropInto?.id !== e.id) setDropInto(e);
                  }}
                  onDragLeave={() => setDropInto((d) => (d?.id === e.id ? null : d))}
                  onDrop={(ev) => {
                    ev.preventDefault();
                    const from = draggingRef.current;
                    draggingRef.current = null;
                    setDragging(null);
                    setDropInto(null);
                    if (canDrop(from, e)) void moveInto(from!, e);
                  }}
                >
                  <td>
                    {renaming === e.id ? (
                      <input
                        className="cc-fx__rename"
                        value={draft}
                        autoFocus
                        aria-label={`Rename ${e.name}`}
                        onChange={(ev) => setDraft(ev.target.value)}
                        onBlur={() => void commitRename(e)}
                        onKeyDown={(ev) => {
                          ev.stopPropagation();
                          if (ev.key === "Enter") { ev.preventDefault(); void commitRename(e); }
                          if (ev.key === "Escape") { ev.preventDefault(); setRenaming(null); }
                        }}
                      />
                    ) : (
                      /* Still a button, for the keyboard and for the accessible name — the row it
                         sits in is not focusable. Its click is left to bubble to the row rather
                         than handled here, so one gesture cannot be counted twice. */
                      <button className="cc-fx__name">
                        <span className={`cc-fx__glyph cc-fx__glyph--${e.kind}`} aria-hidden>
                          {e.kind === "folder" ? <IconFolder /> : e.kind === "workbook" ? <IconBook /> : <IconTable size={15} />}
                        </span>
                        <span className="truncate">{e.name}</span>
                        {/* Searching spans everywhere, so a result has to say what it is. */}
                        {query.trim() && <span className="cc-fx__kind">{e.kind}</span>}
                      </button>
                    )}
                  </td>
                  <td className="cc-fx__num mono">
                    {e.kind === "table"
                      ? `${e.count.toLocaleString()} ${e.count === 1 ? "row" : "rows"}`
                      : `${e.count.toLocaleString()} ${e.count === 1 ? "item" : "items"}`}
                  </td>
                  {inWorkbook && (
                    <td className="cc-fx__num mono">
                      {e.columns == null
                        ? "—"
                        : `${e.columns.toLocaleString()} ${e.columns === 1 ? "column" : "columns"}`}
                    </td>
                  )}
                  <td className="cc-fx__when">{e.kind === "folder" ? "—" : ago(e.openedAt)}</td>
                  <td className="cc-fx__when">{ago(e.createdAt)}</td>
                  <td>
                    <button
                      className={`hk-icon-btn cc-fx__star${e.starred ? " cc-fx__star--on" : ""}`}
                      aria-label={e.starred ? `Remove ${e.name} from starred` : `Star ${e.name}`}
                      title={e.starred ? "Starred" : "Star this"}
                      onClick={() => void post("/api/workspace/star", { kind: e.kind, id: e.id, starred: !e.starred })}
                    >
                      <IconStar filled={e.starred} />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <footer className="cc-fx__foot">
        <span className="cc-fx__count">
          {heading} · {entries.length} {entries.length === 1 ? "item" : "items"}
        </span>
      </footer>

      {moving && (
        <MoveTo
          entry={moving}
          folders={allFolders}
          onCancel={() => setMoving(null)}
          onMove={async (destination) => {
            const what = moving;
            setMoving(null);
            // A table's destination is a WORKBOOK, and that relation lives on the sheet rather than
            // in the folder tree — the same split `moveInto` makes for a drop.
            if (what.kind === "table") {
              if (!destination) return;
              await moveInto(what, { ...what, kind: "workbook", id: destination });
              return;
            }
            await post("/api/workspace/move", { kind: what.kind, id: what.id, folderId: destination });
          }}
        />
      )}

      {/* States what happens to the CONTENTS, which is the part nobody can guess and the only part
          that matters: a folder lets its contents up a level, a workbook takes its tables with it. */}
      <Modal
        open={!!trashing}
        onClose={() => setTrashing(null)}
        title={trashing?.kind === "folder" ? `Delete "${trashing?.name}"?` : `Move "${trashing?.name}" to the trash?`}
        footNote={trashing?.kind === "folder" ? "The folder itself is removed." : "Recoverable from the trash."}
        footer={
          <>
            <button className="cc-btn" onClick={() => setTrashing(null)}>Keep it</button>
            <button
              className="cc-btn cc-btn--danger"
              onClick={() => {
                const e = trashing;
                setTrashing(null);
                if (!e) return;
                void post(
                  e.kind === "folder" ? `/api/folders/${e.id}/trash`
                  : e.kind === "workbook" ? `/api/workbooks/${e.id}/trash`
                  : `/api/sheets/${e.id}/trash`,
                );
              }}
            >
              {trashing?.kind === "folder" ? "Delete folder" : "Move to trash"}
            </button>
          </>
        }
      >
        <p className="cc-modal__summary">
          {trashing?.kind === "folder" ? (
            <>
              {trashing.count > 0
                ? `The ${trashing.count} ${trashing.count === 1 ? "thing" : "things"} inside move up a level rather than being deleted.`
                : "It is empty."}
            </>
          ) : trashing?.kind === "workbook" ? (
            <>
              Its {trashing.count} {trashing.count === 1 ? "table goes" : "tables go"} with it, rows and
              all. You can get it back from the trash.
            </>
          ) : (
            <>The table and its rows go to the trash. You can get it back.</>
          )}
        </p>
      </Modal>

      {/* Every one of these ends the same way: reload the list, then show the receipt. The reload is
          not optional — a duplicate that does not appear until you navigate away and back reads as
          having failed. */}
      {copying?.how === "duplicate" && (
        <DuplicateWorkbook
          id={copying.entry.id}
          name={copying.entry.name}
          folderId={at.folderId}
          onClose={() => setCopying(null)}
          onDone={(r) => { setCopying(null); setCopied(r); void load(); }}
        />
      )}
      {copying?.how === "templatize" && (
        <TemplatizeWorkbook
          id={copying.entry.id}
          name={copying.entry.name}
          onClose={() => setCopying(null)}
          onDone={(r) => { setCopying(null); setCopied(r); void load(); }}
        />
      )}
      {copying?.how === "use" && (
        <UseTemplate
          id={copying.entry.id}
          name={copying.entry.name}
          folderId={null}
          onClose={() => setCopying(null)}
          onDone={(r) => { setCopying(null); setCopied(r); void load(); }}
        />
      )}
      {copying?.how === "import" && (
        <ImportWorkbook
          folderId={at.folderId}
          onClose={() => setCopying(null)}
          onDone={(r) => { setCopying(null); setCopied(r); void load(); }}
        />
      )}

      {copied && (
        <CopyDone
          result={copied}
          onClose={() => setCopied(null)}
          onOpen={() => {
            const id = copied.workbook.id;
            setCopied(null);
            setQuery("");
            setAt({ view: "files", folderId: null, workbookId: id });
          }}
        />
      )}

      {sharing && (
        <ShareWorkbook
          workbookId={sharing.id}
          workbookName={sharing.name}
          myId={me.person?.id ?? null}
          onClose={() => setSharing(null)}
        />
      )}

      <Modal
        open={!!exportWarn}
        onClose={() => setExportWarn(null)}
        title={
          exportWarn?.secrets.length
            ? "This file would carry a key"
            : "Some links cannot travel in this file"
        }
        footNote="Names only — no value is shown here, and nothing has been downloaded yet."
        footer={
          <>
            <button className="cc-btn" onClick={() => setExportWarn(null)}>Cancel</button>
            {/* The dangerous action is NOT the primary button. Somebody who opened this dialog by
                reflex should land on the safe side of it. */}
            <button
              className="cc-btn"
              onClick={() => {
                const id = exportWarn!.id;
                setExportWarn(null);
                window.location.href = `/api/workbooks/${id}/export.json`;
              }}
            >
              Export anyway
            </button>
          </>
        }
      >
        {!!exportWarn?.secrets.length && (
          <>
            <p>
              These columns have something that looks like a key written directly into them. A key
              typed into a column is part of that column, so it travels inside the file — to whoever
              you send it, and to anyone they forward it to.
            </p>
            <ul className="cc-fx__leaks">
              {exportWarn.secrets.map((s) => (
                <li key={`${s.table}.${s.column}`}>
                  <strong>{s.column}</strong> <span className="cc-fx__note">in {s.table}</span>
                </li>
              ))}
            </ul>
            <p>
              To share this safely: save the key under a name in <strong>Settings → Keys</strong>,
              put <code>{"{{secret:Name}}"}</code> in the column where the key is now, and export
              again. A saved key is referenced by name, so the name travels and the value never does.
            </p>
            <p className="cc-fx__note">
              If it is already in a file you have sent, changing it here is not enough — rotate it
              with whoever issued it.
            </p>
          </>
        )}

        {!!exportWarn?.droppedRelations.length && (
          <>
            <p>
              {exportWarn.secrets.length ? "Separately: these" : "These"} tables are linked to a
              table in a different workbook. A file describes links by name, and the name of a table
              this file does not contain means nothing to whoever opens it — so these links are left
              out, and the copy will not read across.
            </p>
            <ul className="cc-fx__leaks">
              {exportWarn.droppedRelations.map((r) => (
                <li key={`${r.table}.${r.otherTable}`}>
                  <strong>{r.table}</strong>{" "}
                  <span className="cc-fx__note">is linked to {r.otherTable}, which is not in this workbook</span>
                </li>
              ))}
            </ul>
            <p className="cc-fx__note">
              Moving a linked table out of its workbook is refused now, so this is a link made before
              that. Move both tables into one workbook and link them again to keep it.
            </p>
          </>
        )}
      </Modal>

      <ContextMenu menu={ctx.menu} onClose={ctx.close} />
    </div>
  );
}

/** Every folder, flattened with its path, so a destination reads unambiguously. */
async function collectFolders(): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = [];
  const walk = async (id: string | null, prefix: string) => {
    const params = new URLSearchParams({ view: "files" });
    if (id) params.set("folder", id);
    const res = await fetch(`/api/workspace?${params}`).then((r) => r.json()).catch(() => null);
    for (const e of (res?.entries ?? []) as Entry[]) {
      if (e.kind !== "folder") continue;
      const label = prefix ? `${prefix} / ${e.name}` : e.name;
      out.push({ id: e.id, name: label });
      await walk(e.id, label);
    }
  };
  await walk(null, "");
  return out;
}

/** Every workbook, with the folder it sits in — a table's possible homes. */
async function collectWorkbooks(): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = [];
  const walk = async (id: string | null, prefix: string) => {
    const params = new URLSearchParams({ view: "files" });
    if (id) params.set("folder", id);
    const res = await fetch(`/api/workspace?${params}`).then((r) => r.json()).catch(() => null);
    for (const e of (res?.entries ?? []) as Entry[]) {
      const label = prefix ? `${prefix} / ${e.name}` : e.name;
      if (e.kind === "workbook") { out.push({ id: e.id, name: label }); continue; }
      if (e.kind === "folder") await walk(e.id, label);
    }
  };
  await walk(null, "");
  return out;
}

function MoveTo({ entry, folders, onCancel, onMove }: {
  entry: Entry;
  /** Folders, or workbooks when the thing being moved is a table. */
  folders: Array<{ id: string; name: string }>;
  onCancel: () => void;
  onMove: (folderId: string | null) => void;
}) {
  const toWorkbook = entry.kind === "table";
  return (
    <Modal
      open
      onClose={onCancel}
      title={`Move “${entry.name}”`}
      width={420}
      footNote={
        folders.length === 0
          ? toWorkbook ? "There are no other workbooks yet." : "There are no folders yet."
          : "Pick where it should live."
      }
      footer={<button className="cc-btn" onClick={onCancel}>Cancel</button>}
    >
      <div className="cc-fx__movelist">
        {/* A table always lives in some workbook — there is no "loose" for it to go back to, so
            the top-level escape hatch is only offered to the things that can sit at the root. */}
        {!toWorkbook && (
          <button className="cc-fx__moveitem" onClick={() => onMove(null)}>
            <span className="cc-fx__glyph" aria-hidden><IconFolder /></span>
            <span>All files</span>
          </button>
        )}
        {folders
          // A folder cannot be moved into itself; the engine refuses it too, but offering the
          // option and then erroring is a worse way to say so.
          .filter((f) => !(entry.kind === "folder" && f.id === entry.id))
          .map((f) => (
            <button key={f.id} className="cc-fx__moveitem" onClick={() => onMove(f.id)}>
              <span className="cc-fx__glyph" aria-hidden>{toWorkbook ? <IconBook /> : <IconFolder />}</span>
              <span className="truncate">{f.name}</span>
            </button>
          ))}
      </div>
    </Modal>
  );
}
