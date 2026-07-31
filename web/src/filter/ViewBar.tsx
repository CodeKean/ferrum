// Saved views.
//
// A view is a named filter + sort + search. The engine has stored them since Phase 1 with no way to
// make one, which mattered little while there was no filter builder — and matters a great deal now
// that there is, because a filter worth building twice is a filter worth saving.
//
// The design decision that shapes this: a view is APPLIED, not entered. Picking one writes its
// filter into the same `GridView` the toolbar edits, so there is exactly one description of what the
// grid is showing and a run keeps covering the rows on screen. A view that had its own parallel
// state would be a second way to narrow the grid, and the two would eventually disagree.
//
// The consequence, which the UI has to be honest about: once applied, the view can be edited like
// anything else, so "Sales prospects" can be showing something Sales prospects does not mean. That
// is signalled rather than prevented — blocking edits would make views a cage.

import { useCallback, useEffect, useRef, useState } from "react";
import { Popover } from "../ui/Popover.tsx";
import { Modal } from "../ui/Modal.tsx";
import { IconMore, IconPlus } from "../ui/Icon.tsx";
import { EMPTY_VIEW, usableFilter, type GridView } from "../view.ts";
import "./ViewBar.css";

interface SavedView {
  id: number;
  name: string;
  filter: { conj: "and" | "or"; children: any[] };
  sorts: Array<{ columnId: number; dir: "asc" | "desc" }>;
  search: string | null;
}

interface Props {
  sheetId: string;
  view: GridView;
  onChange: (v: GridView) => void;
  /** Bumped so the undo bar re-reads after a view is deleted. */
  onMutated: () => void;
}

/** Same shape on both sides of the comparison, so key order cannot make an identical view look edited. */
const fingerprint = (v: GridView) =>
  JSON.stringify({
    filter: usableFilter(v.filter),
    sort: v.sort,
    search: v.search.trim(),
  });

const viewToGrid = (s: SavedView): GridView => ({
  search: s.search ?? "",
  status: [],
  sort: s.sorts?.[0] ?? null,
  filter: s.filter?.children?.length ? s.filter : null,
});

export function ViewBar({ sheetId, view, onChange, onMutated }: Props) {
  const [views, setViews] = useState<SavedView[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  // The trigger itself, so the menu follows it when something scrolls rather than closing on the user.
  const trigger = useRef<HTMLButtonElement>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sheets/${sheetId}/views`).then((r) => r.json());
      setViews(res.views ?? []);
    } catch { /* the bar degrades to "save this view" rather than blocking the toolbar */ }
  }, [sheetId]);

  useEffect(() => { void load(); setActiveId(null); }, [load]);

  const active = views.find((v) => v.id === activeId) ?? null;
  // Whether what is on screen still matches the view that was applied. Compared by value, because
  // the point is "does this still show what the name promises", not "was the object replaced".
  const drifted = active ? fingerprint(viewToGrid(active)) !== fingerprint(view) : false;

  const apply = (v: SavedView | null) => {
    setOpen(false);
    setActiveId(v?.id ?? null);
    onChange(v ? viewToGrid(v) : EMPTY_VIEW);
  };

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        name: name.trim() || "Untitled view",
        filter: usableFilter(view.filter) ?? { conj: "and", children: [] },
        sorts: view.sort ? [view.sort] : [],
        search: view.search.trim() || null,
      };
      const res = await fetch(`/api/sheets/${sheetId}/views`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json());
      if (res.view) { setActiveId(res.view.id); await load(); }
      setNaming(false);
      setName("");
    } finally {
      setBusy(false);
    }
  };

  /** Overwrite the applied view with what is on screen. Only offered when it has actually drifted. */
  const update = async () => {
    if (!active) return;
    setBusy(true);
    try {
      await fetch(`/api/views/${active.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: active.name,
          filter: usableFilter(view.filter) ?? { conj: "and", children: [] },
          sorts: view.sort ? [view.sort] : [],
          search: view.search.trim() || null,
        }),
      });
      await load();
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  const remove = async (v: SavedView) => {
    setOpen(false);
    await fetch(`/api/views/${v.id}`, { method: "DELETE" });
    // Deleting is undoable, so this is not a confirm-dialog moment — the undo bar is the safety net,
    // and a dialog in front of a reversible action is the speed bump people click through.
    if (activeId === v.id) setActiveId(null);
    await load();
    onMutated();
  };

  // "All rows" named the state, not the control, so the feature read as a row filter and saved
  // views looked like they did not exist. The trigger now says what it IS when nothing is applied,
  // and what is APPLIED when something is — which is the only time the state matters.
  const label = active ? active.name : "Views";

  return (
    <div className="cc-vb">
      <button
        ref={trigger}
        className="cc-vb__trigger"
        onClick={(e) => { setRect(e.currentTarget.getBoundingClientRect()); setOpen((o) => !o); }}
        aria-haspopup="menu"
        aria-expanded={open}
        title={drifted ? `${label} — the grid no longer matches this view` : label}
      >
        <span className="cc-vb__name truncate">{label}</span>
        {/* A dot, not a word: the label is the thing being read, and "(edited)" inside it would make
            the trigger change width every time a filter is touched. */}
        {drifted && <span className="cc-vb__dot" aria-label="edited" />}
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="m4 6.5 4 4 4-4" />
        </svg>
      </button>

      <Popover open={open} anchor={rect ? { rect } : null} anchorEl={trigger} onClose={() => setOpen(false)} width={260} role="menu" label="Views">
        <div className="cc-vb__menu">
          <button className={`cc-vb__item${activeId === null ? " cc-vb__item--on" : ""}`} onClick={() => apply(null)}>
            All rows — no view
          </button>

          {views.map((v) => (
            <div key={v.id} className={`cc-vb__row${activeId === v.id ? " cc-vb__row--on" : ""}`}>
              <button className="cc-vb__item truncate" onClick={() => apply(v)}>{v.name}</button>
              <button
                className="hk-icon-btn cc-vb__del"
                onClick={() => void remove(v)}
                aria-label={`Delete view ${v.name}`}
                title="Delete — undoable"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </div>
          ))}

          <div className="cc-vb__sep" role="separator" />

          {active && drifted && (
            <button className="cc-vb__item" onClick={() => void update()} disabled={busy}>
              Update “{active.name}” to match
            </button>
          )}
          <button
            className="cc-vb__item"
            onClick={() => { setOpen(false); setNaming(true); }}
            disabled={!usableFilter(view.filter) && !view.sort && !view.search.trim()}
            // Disabled with a reason: saving the unnarrowed grid produces a view identical to
            // "All rows", which is a menu entry that does nothing.
            title={
              !usableFilter(view.filter) && !view.sort && !view.search.trim()
                ? "Filter, sort or search first — there is nothing to save yet."
                : undefined
            }
          >
            <IconPlus /> Save this as a view
          </button>
        </div>
      </Popover>

      <Modal
        open={naming}
        onClose={() => setNaming(false)}
        title="Save this view"
        footNote="Filters, sort and search are saved. Column widths are not."
        footer={
          <>
            <button className="cc-btn" onClick={() => setNaming(false)}>Cancel</button>
            <button className="cc-btn cc-btn--primary" onClick={() => void save()} disabled={busy || !name.trim()}>
              Save view
            </button>
          </>
        }
      >
        <label className="cc-field">
          <span className="cc-field__label">Name</span>
          <input
            className="cc-input"
            value={name}
            autoFocus
            placeholder="US companies over 500"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) void save(); }}
          />
        </label>
      </Modal>
    </div>
  );
}
