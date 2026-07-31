// The sheets of a workbook, as tabs along the bottom.
//
// Why the bottom, and why tabs at all: a workbook is a set of tables that reference each other, and
// the question "what else is in here" is asked constantly — on every fan-out, every lookup, every
// "put the results in another table". A dropdown answers that question one item at a time and only
// when you go looking. A tab bar answers it permanently, at no cost, in the place every spreadsheet
// anyone has used puts it.
//
// It replaces nothing: the switcher at the top still spans every workbook. This is the inner
// dimension — the tables of the workbook you are already inside.

import { useCallback, useEffect, useRef, useState } from "react";
import { ContextMenu, useContextMenu, type MenuItem } from "./ui/ContextMenu.tsx";
import { Modal } from "./ui/Modal.tsx";
import { IconPlus } from "./ui/Icon.tsx";
import type { Sheet } from "./api.ts";
import "./SheetTabs.css";

interface Props {
  sheetId: string;
  /** Bumped by the app when sheets are created, renamed or removed elsewhere. */
  revision?: number;
  onOpen: (id: string) => void;
  onChanged: () => void;
}

export function SheetTabs({ sheetId, revision, onOpen, onChanged }: Props) {
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [workbookId, setWorkbookId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  /** The table about to be trashed, waiting to be confirmed. */
  const [trashing, setTrashing] = useState<Sheet | null>(null);
  /**
   * The last action that did not work.
   *
   * Every action on this strip creates or destroys a whole TABLE, and each one used to fail
   * silently — the engine's refusal was parsed and dropped, and a network failure was not caught at
   * all — so "Duplicate with rows" on a table the engine would not copy looked exactly like a menu
   * item that does nothing.
   */
  const [error, setError] = useState<string | null>(null);
  const ctx = useContextMenu();
  const stripRef = useRef<HTMLElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sheets/${sheetId}/siblings`).then((r) => r.json());
      // An empty answer is kept OFF the screen rather than rendered. The only way to get one is to
      // ask about a sheet that has just been trashed, and the honest next state is the tab bar for
      // whatever gets opened instead — which is one request away. Showing the empty version in
      // between unmounted the whole bar, which resized the grid and snapped its scroll position.
      if (!res.sheets?.length) return;
      setSheets(res.sheets);
      setWorkbookId(res.workbookId ?? null);
    } catch {
      // A failed load leaves the last known tabs rather than blanking the bar — losing your place
      // is worse than a stale label.
    }
  }, [sheetId]);

  useEffect(() => { void load(); }, [load, revision]);

  // Keep the open sheet's tab on screen. With twenty tables the active one is regularly outside the
  // strip after a switch, and a tab bar that does not show where you are is just decoration.
  useEffect(() => {
    stripRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [sheetId, sheets.length]);

  const post = async (url: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then((r) => r.json());
      if (res.error) { setError(res.error); return null; }
      await load();
      onChanged();
      return res;
    } catch {
      setError("Could not reach the engine.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const res = await post("/api/sheets", { name: "Untitled table", workbookId });
    if (res?.sheet?.id) {
      onOpen(res.sheet.id);
      // Straight into rename. A new tab called "Untitled table" that you then have to find the
      // rename affordance for is two steps where one will do.
      setDraft(res.sheet.name);
      setRenaming(res.sheet.id);
    }
  };

  const commitRename = async (id: string) => {
    const next = draft.trim();
    setRenaming(null);
    const current = sheets.find((s) => s.id === id)?.name;
    if (!next || next === current) return;
    await fetch(`/api/sheets/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: next }),
    });
    await load();
    onChanged();
  };

  const menu = (s: Sheet): MenuItem[] => [
    { label: "Rename", hint: "dbl-click", onSelect: () => { setDraft(s.name); setRenaming(s.id); } },
    { label: "Duplicate structure", title: "Same columns, no rows", onSelect: () => void post(`/api/sheets/${s.id}/duplicate`, { withRows: false }) },
    {
      label: "Duplicate with rows",
      // Said in the label, because on a large table this is the difference between instant and not.
      title: s.rowCount > 0 ? `Copies all ${s.rowCount.toLocaleString()} rows` : "This table has no rows yet",
      onSelect: () => void post(`/api/sheets/${s.id}/duplicate`, { withRows: true }),
    },
    { separator: true },
    { label: "Move left", disabled: sheets.indexOf(s) === 0, onSelect: () => void post(`/api/sheets/${s.id}/move`, { toIndex: sheets.indexOf(s) - 1 }) },
    { label: "Move right", disabled: sheets.indexOf(s) === sheets.length - 1, onSelect: () => void post(`/api/sheets/${s.id}/move`, { toIndex: sheets.indexOf(s) + 1 }) },
    { separator: true },
    {
      label: "Move to trash",
      danger: true,
      // The last table of a workbook is not deletable from here: it would leave the tab bar empty
      // with no way back to anything.
      disabled: sheets.length <= 1,
      title: sheets.length <= 1 ? "This is the only table here." : "Recoverable from the trash",
      // Asked, not done. This item sits two rows under "Move right" on a strip people click through
      // all day, and it took a whole table's rows off the screen on one stray selection.
      onSelect: () => setTrashing(s),
    },
  ];

  const doTrash = async (s: Sheet) => {
    setTrashing(null);
    setError(null);
    try {
      const res = await fetch(`/api/sheets/${s.id}/trash`, { method: "POST" }).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
    } catch {
      // The dialog has already closed by here, so without this the table simply stays on the strip
      // and the confirmation reads as having been ignored.
      setError("Could not move that table to the trash.");
      return;
    }
    const rest = sheets.filter((x) => x.id !== s.id);
    await load();
    onChanged();
    if (s.id === sheetId && rest[0]) onOpen(rest[0].id);
  };

  if (sheets.length === 0) return null;

  return (
    <div className="cc-wbtabs">
      {/* Navigation, not a tab set.

          It declared `role="tablist"` with `aria-selected` on every tab, and delivered none of what
          that promises: there is no `role="tabpanel"` anywhere in the app, no `aria-controls`, no
          roving tabindex and no arrow-key movement. A screen reader announced "tab, selected" for a
          control that points at nothing and does not answer the arrow keys the announcement invites.
          What these actually do is open a different table — a navigation, which `aria-current` was
          already saying correctly all along. */}
      <nav className="cc-wbtabs__strip" ref={stripRef} aria-label="Tables in this workbook">
        {sheets.map((s) => {
          const active = s.id === sheetId;
          if (renaming === s.id) {
            return (
              <input
                key={s.id}
                className="cc-wbtabs__rename"
                value={draft}
                autoFocus
                aria-label={`Rename ${s.name}`}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => void commitRename(s.id)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") { e.preventDefault(); void commitRename(s.id); }
                  if (e.key === "Escape") { e.preventDefault(); setRenaming(null); }
                }}
              />
            );
          }
          return (
            <button
              key={s.id}
              aria-current={active ? "page" : undefined}
              className={`cc-wbtabs__tab${active ? " cc-wbtabs__tab--on" : ""}`}
              onClick={() => onOpen(s.id)}
              onDoubleClick={() => { setDraft(s.name); setRenaming(s.id); }}
              onContextMenu={(e) => ctx.open(e, s.name, menu(s))}
              title={`${s.name} — ${s.rowCount.toLocaleString()} ${s.rowCount === 1 ? "row" : "rows"}`}
            >
              <span className="truncate">{s.name}</span>
              {/* Reserved width, so a table going from 9 to 10,000 rows cannot resize its own tab
                  and shuffle every tab to the right of it. */}
              <span className="cc-wbtabs__count mono">{s.rowCount.toLocaleString()}</span>
            </button>
          );
        })}
      </nav>

      {/* Labelled, not a bare icon.

          It was a 24px "+" with no word next to it, and "how do I make a second table in this
          workbook?" turned out to be unanswerable from the screen — which is the whole job of a tab
          bar's plus. The noun alone is the label; the plus carries the verb.

          `aria-label` as well, because at 768px and below the stylesheet hides `.cc-btn span` and
          the visible noun goes with it. */}
      <button
        className="cc-wbtabs__add cc-btn cc-btn--ghost cc-btn--xs"
        onClick={() => void add()}
        disabled={busy}
        aria-label="Add a table to this workbook"
        title="Add a table to this workbook"
      >
        <IconPlus /> <span>Table</span>
      </button>

      {/* Shrink-to-content and only when there is something to say — the strip has no room to
          reserve for a message that is almost never there. Truncated, with the whole sentence on
          hover, so a long engine message cannot widen the bar. */}
      {error && (
        <span className="cc-wbtabs__error truncate" role="alert" title={error}>{error}</span>
      )}

      <Modal
        open={!!trashing}
        onClose={() => setTrashing(null)}
        title={`Move "${trashing?.name}" to the trash?`}
        footNote="Recoverable — nothing is deleted."
        footer={
          <>
            <button className="cc-btn" onClick={() => setTrashing(null)}>Keep it</button>
            <button className="cc-btn cc-btn--danger" onClick={() => { if (trashing) void doTrash(trashing); }}>
              Move to trash
            </button>
          </>
        }
      >
        <p className="cc-modal__summary">
          {(trashing?.rowCount ?? 0) > 0
            ? <>Its {trashing!.rowCount.toLocaleString()} {trashing!.rowCount === 1 ? "row goes" : "rows go"} with it. You can get it back from the trash.</>
            : <>It has no rows. You can get it back from the trash.</>}
        </p>
      </Modal>

      <ContextMenu menu={ctx.menu} onClose={ctx.close} />
    </div>
  );
}
