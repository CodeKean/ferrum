// Right-click menus.
//
// One component for every surface, because a context menu that exists on some things and not others
// is worse than none: the user learns the gesture, tries it somewhere it is missing, and gets the
// browser's own menu instead — which offers Reload and Save As on a spreadsheet cell.
//
// Anchored to the POINTER, not to the element. Right-clicking the middle of a wide row should open
// the menu under the cursor, not at the row's corner half a screen away.

import { useCallback, useEffect, useRef, useState } from "react";
import { Popover } from "./Popover.tsx";
import "./ContextMenu.css";

export interface MenuItem {
  /** Omit everything else for a separator. */
  separator?: boolean;
  label?: string;
  /** Right-aligned shortcut hint. Display only — the binding lives with the surface. */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Explains a disabled item. A greyed row with no reason is a dead end. */
  title?: string;
  onSelect?: () => void;
}

export interface MenuState {
  /** Viewport coordinates of the click. */
  x: number;
  y: number;
  items: MenuItem[];
  label: string;
  /**
   * What KIND of thing this menu is about — "Table", "Workbook", "Folder", "Column".
   *
   * Optional, and only where the same-looking menu can be opened on more than one kind of thing.
   * With it the heading reads "Workbook · Growth Ops"; without it the menu is unchanged.
   */
  scope?: string;
}

/**
 * Owns one menu for a whole surface.
 *
 * Returned `open` is passed to a container's onContextMenu. Per-element menu state would put two
 * hooks on every cell in a virtualized grid, which is the one place in this app where per-element
 * cost actually matters.
 */
export function useContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Where focus was when the menu opened, so closing it puts focus back rather than dropping it on
  // <body>. A keyboard user who presses Shift+F10 on a cell and then Escape has to end up on that
  // cell again; landing at the top of the document means starting the whole traversal over.
  const restoreTo = useRef<HTMLElement | null>(null);

  const open = useCallback((e: React.MouseEvent, label: string, items: MenuItem[], scope?: string) => {
    // No items means nothing to offer, so the browser's own menu is left alone rather than replaced
    // with an empty box.
    if (items.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    restoreTo.current = document.activeElement as HTMLElement | null;
    setMenu({ x: e.clientX, y: e.clientY, items, label, scope });
  }, []);

  /**
   * The same menu, opened from a point rather than from a mouse event.
   *
   * Shift+F10 and the Menu key are the keyboard's right-click, and they carry no pointer position —
   * so the caller aims the menu at the focused element's own rect. Without this the entire per-cell
   * and per-row action set was mouse-only.
   */
  const openAt = useCallback((x: number, y: number, label: string, items: MenuItem[], scope?: string) => {
    if (items.length === 0) return;
    restoreTo.current = document.activeElement as HTMLElement | null;
    setMenu({ x, y, items, label, scope });
  }, []);

  const close = useCallback(() => {
    const back = restoreTo.current;
    restoreTo.current = null;
    // Only reclaim focus if the menu is what is holding it. A dismissal caused by clicking something
    // else must not yank the caret back out of whatever was just clicked.
    const held = document.activeElement as HTMLElement | null;
    const fromMenu = !held || held === document.body || !!held.closest?.(".cc-ctx");
    setMenu(null);
    if (back && fromMenu && document.body.contains(back)) back.focus({ preventScroll: true });
  }, []);

  return { menu, open, openAt, close };
}

export function ContextMenu({ menu, onClose, scrollContainer }: {
  menu: MenuState | null;
  onClose: () => void;
  scrollContainer?: HTMLElement | null;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // The last menu, kept while the popover animates out. `menu` clears the instant an item is picked,
  // so rendering straight from it played the 140ms exit on an empty box.
  const lastMenu = useRef<MenuState | null>(null);
  if (menu) lastMenu.current = menu;
  const shown = menu ?? lastMenu.current;

  // A zero-size rect at the pointer. Popover already flips near edges, so a right-click at the
  // bottom of the window opens upward without this needing to know anything about it.
  const anchor = shown
    ? { rect: { top: shown.y, bottom: shown.y, left: shown.x, right: shown.x, width: 0, height: 0 } }
    : null;

  // Focus goes INTO the menu on open. Without it the menu was announced and then left behind: the
  // virtual cursor stayed outside, and every action that lives only here was unreachable.
  //
  // A timer, not requestAnimationFrame — rAF does not fire in a background tab, and the same trap
  // already cost this app a menu that silently did nothing (see the note on onClick below). The
  // delay also lets Popover finish measuring: it renders at `visibility: hidden` until it has a
  // position, and a hidden element cannot take focus.
  useEffect(() => {
    if (!menu) return;
    const t = setTimeout(() => {
      listRef.current?.querySelector<HTMLButtonElement>(".cc-ctx__item:not(:disabled)")?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [menu]);

  /** Arrow keys walk the enabled items and wrap; Home/End jump to the ends. Escape is Popover's. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(".cc-ctx__item:not(:disabled)")];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => {
      e.preventDefault();
      items[((n % items.length) + items.length) % items.length]?.focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at < 0 ? items.length - 1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
  };

  return (
    <Popover
      open={!!menu}
      anchor={anchor}
      onClose={onClose}
      width={220}
      role="menu"
      label={shown?.label ?? "Menu"}
      scrollContainer={scrollContainer}
    >
      <div className="cc-ctx" ref={listRef} onKeyDown={onKeyDown}>
        {/*
          What this menu is about, shown rather than only announced.

          `label` was already being passed on every call and was reaching nothing but `aria-label`, so
          a sighted user opened an identical-looking list of verbs on a folder, a workbook and a table
          with nothing saying which they had right-clicked. The scope of a menu is the first thing you
          need from it and the one thing it was not saying.
        */}
        {shown?.scope && (
          <div className="cc-ctx__scope">
            <span className="cc-ctx__scope-kind">{shown.scope}</span>
            <span className="cc-ctx__scope-name truncate" title={shown.label}>{shown.label}</span>
          </div>
        )}
        {shown?.items.map((item, i) =>
          item.separator ? (
            <div key={i} className="cc-ctx__sep" role="separator" />
          ) : (
            <button
              key={i}
              className={`cc-ctx__item${item.danger ? " cc-ctx__item--danger" : ""}`}
              role="menuitem"
              disabled={item.disabled}
              title={item.title}
              // Synchronous, deliberately.
              //
              // Deferring the action by a frame to dodge a focus race was tried and is WRONG:
              // requestAnimationFrame does not fire in a background tab, so every menu action became
              // a no-op the moment the window lost focus. A menu that silently does nothing is a far
              // worse defect than the one it was working around, and the focus race belongs to
              // whatever the action opens — see the re-assert in ColumnName.
              onClick={() => { onClose(); item.onSelect?.(); }}
            >
              <span className="cc-ctx__label truncate">{item.label}</span>
              {item.hint && <span className="cc-ctx__hint mono">{item.hint}</span>}
            </button>
          ),
        )}
      </div>
    </Popover>
  );
}
