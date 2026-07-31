// On-design select. Never a bare native <select>.
//
// A styled trigger plus a portalled popover listbox, with the keyboard behaviour a native select
// has and a custom one usually loses: arrows move, Enter commits, Escape cancels, and the open menu
// starts on the current value rather than at the top.
//
// ── Why it filters ──────────────────────────────────────────────────────────────────────────────
//
// Measured on the live app: the model dropdown rendered 303 options as 9,098 pixels of scroll with
// no way to search. Every option was technically reachable and the control was, in practice, a wall.
// The specific thing it made impossible is the thing this app is supposed to be good at — a model
// running on your own machine is ONE row in that list, and finding it meant scrolling past three
// hundred hosted ones.
//
// So past a threshold the menu grows a search box, and options may declare a group. Both are
// automatic: a control does not get to be unusable because whoever added the twentieth option did
// not think to turn searching on.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "./Popover.tsx";
import "./Select.css";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** Optional right-aligned detail — a count, a hint. */
  hint?: string;
  /**
   * Heading this option sits under.
   *
   * Groups keep their given order and options keep theirs within a group, so a caller that has
   * already sorted by price does not have that undone. Ungrouped options come first, unheaded —
   * which is what keeps "Engine default" at the top where it belongs.
   */
  group?: string;
}

interface Props<T extends string> {
  /** Rendered as "<label>: <selected>" so the trigger says what it controls even when set. */
  label: string;
  value: T;
  options: Array<SelectOption<T>>;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  /**
   * Show "<label>: <value>" on the trigger. Right in a toolbar, where the control has to say what it
   * controls. Wrong inside a form field that already carries a heading — "Search engine" above and
   * "Engine: Automatic" inside it says the same word twice and eats the width.
   */
  showLabel?: boolean;
  /** Scrollport whose scrolling should dismiss the menu. */
  scrollContainer?: HTMLElement | null;
  /**
   * Force the search box on or off. Left alone it appears past `SEARCH_AT`, which is the honest
   * default: a list you can take in at a glance does not need one, and a list you cannot does.
   */
  searchable?: boolean;
}

/**
 * Where a list stops being scannable.
 *
 * Twelve is about a screen of options — beyond that you are hunting rather than choosing, and the
 * cost of a search box (one more thing on screen) is smaller than the cost of hunting.
 */
const SEARCH_AT = 12;

/** Case-insensitive substring over both the label and the value, so a model id matches too. */
function matches<T extends string>(o: SelectOption<T>, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return o.label.toLowerCase().includes(needle) || String(o.value).toLowerCase().includes(needle);
}

export function Select<T extends string>({
  label, value, options, onChange, size = "sm", showLabel = true, scrollContainer, searchable,
}: Props<T>) {
  const ref = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState("");

  const canSearch = searchable ?? options.length > SEARCH_AT;
  const selected = useMemo(() => options.find((o) => o.value === value) ?? options[0], [options, value]);

  /** What is actually on screen — every index below is into THIS, never into `options`. */
  const shown = useMemo(() => (canSearch ? options.filter((o) => matches(o, query)) : options), [options, query, canSearch]);

  /**
   * The visible list broken into runs, preserving the order it was given.
   *
   * A Map keyed on the group name rather than a sort, because sorting here would silently reorder a
   * list the caller had already put in a meaningful order — the model list is cheapest-first, and
   * alphabetising its groups would throw that away.
   */
  const groups = useMemo(() => {
    const m = new Map<string, Array<SelectOption<T>>>();
    for (const o of shown) {
      const k = o.group ?? "";
      const at = m.get(k);
      if (at) at.push(o);
      else m.set(k, [o]);
    }
    return [...m.entries()];
  }, [shown]);

  const show = useCallback(() => {
    if (!ref.current) return;
    setRect(ref.current.getBoundingClientRect());
    setQuery("");
    // Open ON the current value. Starting at index 0 makes the first arrow-press jump somewhere
    // unrelated to what is selected.
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  }, [options, value]);

  // Focus the search box on open, so typing goes where it is expected. Without this the menu opens,
  // you type, and the keystrokes land on the page behind it.
  useEffect(() => {
    if (!open || !canSearch) return;
    const t = setTimeout(() => searchRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open, canSearch]);

  // Filtering moves the ground under the highlight: the third match of one query is not the third of
  // the next, and leaving the index alone points it at whatever happens to be there — or past the
  // end, where Enter commits nothing and reads as a broken control.
  useEffect(() => { setActive(0); }, [query]);

  // The menu is portalled, so it does not receive key events through the trigger's subtree. Bound at
  // the document while open instead.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(shown.length - 1, i + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
      else if (e.key === "Enter") {
        e.preventDefault();
        const o = shown[active];
        if (o) { onChange(o.value); setOpen(false); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, active, shown, onChange]);

  // Keep the highlighted row on screen while arrowing through a long list — the whole point of
  // filtering is defeated if the selection walks off the bottom of the visible area.
  useEffect(() => {
    if (!open) return;
    document.querySelector<HTMLElement>('.cc-sel__item[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  return (
    <>
      <button
        ref={ref}
        className={`cc-select${size === "sm" ? " cc-select--sm" : ""}`}
        aria-haspopup="listbox"
        // Named in its own right. It used to lean on a wrapping <label> for that, and a <label>
        // around a BUTTON is why clicking anywhere near one of these opened it: button is a
        // labelable element, so the label forwarded every click in its whole box — padding, caption
        // and all — to the trigger.
        aria-label={label}
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show())}
        title={`${label}: ${selected?.label ?? ""}`}
      >
        <span className="cc-select__value truncate">
          {showLabel ? `${label}: ` : ""}{selected?.label ?? ""}
        </span>
        <span className="cc-select__caret" aria-hidden="true">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6.5l4 4 4-4" />
          </svg>
        </span>
      </button>

      <Popover
        open={open}
        anchor={rect ? { rect } : null}
        anchorEl={ref}
        onClose={() => setOpen(false)}
        width={Math.max(200, rect?.width ?? 200)}
        role="listbox"
        label={label}
        scrollContainer={scrollContainer}
      >
        {canSearch && (
          <div className="cc-sel__search">
            <input
              ref={searchRef}
              className="cc-sel__searchbox"
              type="text"
              value={query}
              placeholder="Search…"
              spellCheck={false}
              autoComplete="off"
              aria-label={`Search ${label}`}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}

        <div className="cc-sel">
          {groups.map(([name, items]) => (
            <div key={name || "__"} className="cc-sel__group">
              {name && <div className="cc-sel__grouphead">{name}</div>}
              {items.map((o) => {
                // Index into the flat visible list, so arrow keys and mouse agree across groups.
                const i = shown.indexOf(o);
                return (
                  <button
                    key={o.value}
                    role="option"
                    aria-selected={o.value === value}
                    data-active={i === active}
                    className={`cc-sel__item${o.value === value ? " cc-sel__item--on" : ""}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => { onChange(o.value); setOpen(false); }}
                  >
                    <span className="cc-sel__tick" aria-hidden="true">
                      {o.value === value ? (
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3.5 8.5l3 3 6-7" />
                        </svg>
                      ) : null}
                    </span>
                    <span className="cc-sel__label truncate">{o.label}</span>
                    {o.hint && <span className="cc-sel__hint mono">{o.hint}</span>}
                  </button>
                );
              })}
            </div>
          ))}

          {/* An empty result is a state, not an absence. Without this the menu just goes blank and
              reads as a control that broke rather than a search that matched nothing. */}
          {shown.length === 0 && (
            <p className="cc-sel__empty" role="status">
              Nothing matches “{query}”.
            </p>
          )}
        </div>
      </Popover>
    </>
  );
}
