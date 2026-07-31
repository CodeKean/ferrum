// Portal-rendered popover.
//
// Rendered into document.body and fixed-positioned from the anchor's rect, so it can never be
// clipped by an ancestor's overflow — which in a grid is guaranteed, because the scrollport clips
// everything. It flips when it would cross a viewport edge, and it animates in AND out.
//
// SCROLLING. A popover left pinned in place while its trigger slides away is a defect. There are two
// honest answers to that and this file used to pick the wrong one for both cases:
//
//   - anchored to an ELEMENT (a dropdown on a button): it FOLLOWS. Closing a menu because the page
//     moved four pixels is the behaviour people were reporting as "the dropdowns close when
//     scrolling" — you reach for the list, the grid nudges, the list is gone. It only closes once the
//     trigger has actually left the screen, where there is nothing left to point at.
//   - anchored to a POINT (a right-click menu, a caret): it dismisses, because there is no element to
//     re-measure and a menu hanging over a paragraph that has moved on is meaningless.
//
// A scroll INSIDE the popover — a long option list — is neither, and is ignored.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./Popover.css";

export interface Anchor {
  /** Viewport rect to position against — an element rect, or a caret rect. */
  rect: DOMRect | { top: number; left: number; bottom: number; right: number; width: number; height: number };
}

interface Props {
  anchor: Anchor | null;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Preferred side; flips automatically when there is not enough room. */
  placement?: "bottom-start" | "bottom-end" | "top-start";
  width?: number;
  /** Element that scrolling should dismiss against. Defaults to any scroll. */
  scrollContainer?: HTMLElement | null;
  /**
   * The element the popover is anchored to.
   *
   * Its presence is what turns "dismiss on scroll" into "follow on scroll" — with an element there is
   * something to re-measure, so the popover can stay with its trigger instead of vanishing. Without
   * it (a caret, a right-click point) there is nothing to track and scrolling dismisses.
   */
  anchorEl?: { current: HTMLElement | null };
  role?: "dialog" | "listbox" | "menu";
  label?: string;
}

const GAP = 4;
const MARGIN = 8;

export function Popover({
  anchor, open, onClose, children, placement = "bottom-start", width, scrollContainer, anchorEl, role = "dialog", label,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  // Kept mounted through the exit animation, then unmounted.
  const [mounted, setMounted] = useState(open);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (open) { setMounted(true); setLeaving(false); return; }
    if (!mounted) return;
    setLeaving(true);
    const t = setTimeout(() => { setMounted(false); setLeaving(false); }, 140);
    return () => clearTimeout(t);
  }, [open, mounted]);

  /**
   * Bumped by the scroll handler to re-run the positioning effect.
   *
   * A counter rather than the measured rect: storing the rect would set state on every scroll frame
   * with a new object every time, and the effect below already re-measures from the live element. The
   * counter says "something moved", the effect works out where to.
   */
  const [tick, setTick] = useState(0);

  useLayoutEffect(() => {
    if (!mounted || !anchor || !ref.current) return;
    const el = ref.current;
    // The LIVE rect when there is an element to read it from, so a scroll repositions against where
    // the trigger is now rather than where it was when the menu opened. `anchor.rect` is the fallback
    // for a point anchor, which cannot move because nothing is holding it.
    const r = anchorEl?.current?.getBoundingClientRect() ?? anchor.rect;
    const w = width ?? el.offsetWidth;
    const h = el.offsetHeight;

    let top = placement === "top-start" ? r.top - h - GAP : r.bottom + GAP;
    let left = placement === "bottom-end" ? r.right - w : r.left;

    // Flip rather than overflow. A menu half off-screen is unusable.
    if (top + h > window.innerHeight - MARGIN) {
      const above = r.top - h - GAP;
      if (above >= MARGIN) top = above;
      else top = Math.max(MARGIN, window.innerHeight - h - MARGIN);
    }
    if (top < MARGIN) top = MARGIN;
    if (left + w > window.innerWidth - MARGIN) left = window.innerWidth - w - MARGIN;
    if (left < MARGIN) left = MARGIN;

    setPos({ top, left });
  }, [mounted, anchor, anchorEl, placement, width, children, tick]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    /**
     * Follow the anchor, or dismiss when there is nothing to follow.
     *
     * The listener is at the DOCUMENT in the CAPTURE phase, which is what sees every scroll in the
     * page. `scroll` does not bubble, but capture still reaches the document on the way down —
     * verified in the page against the real grid scrollport. Binding to `scrollContainer ?? window`
     * instead, as this once did, missed everything else that scrolls: a drawer body, a dialog, a
     * panel with its own overflow, a grid the caller forgot to name.
     *
     * With an anchor ELEMENT the popover repositions rather than closing. It used to close on two
     * pixels of movement, which is why dropdowns disappeared the moment the grid nudged under them —
     * the correct response to "the trigger moved" is to move with it. It closes only when the trigger
     * has left the viewport entirely, where following it would leave a menu floating over nothing.
     *
     * With no anchor element there is nothing to re-measure, so the old scroll-distance dismissal
     * still applies, on BOTH axes — a grid scrolls sideways far more than down while a header menu is
     * open, and watching only scrollTop left one pinned while its column slid out from under it.
     */
    const startY = scrollContainer?.scrollTop ?? window.scrollY;
    const startX = scrollContainer?.scrollLeft ?? window.scrollX;
    let frame = 0;
    const onScroll = (e: Event) => {
      // A scroll INSIDE the popover is the user reading a long option list. It is not the page moving
      // and it must neither reposition nor dismiss — without this, every wheel tick over a 300-model
      // dropdown ran the whole measure-and-flip pass for nothing.
      const target = e.target as Node | null;
      if (target && ref.current && (target === ref.current || ref.current.contains(target))) return;

      const el = anchorEl?.current;
      if (el) {
        const now = el.getBoundingClientRect();
        // Gone from the screen — including scrolled out of a nested scrollport, since a rect measured
        // there is still viewport-relative and reads as off-screen once the port has moved past it.
        if (now.bottom < 0 || now.top > window.innerHeight || now.right < 0 || now.left > window.innerWidth) {
          onClose();
          return;
        }
        // Coalesced to one reposition per frame. A scroll fires far faster than the browser paints,
        // and re-measuring per event is how a followed popover starts to lag behind its trigger.
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; setTick((t) => t + 1); });
        return;
      }

      const y = scrollContainer?.scrollTop ?? window.scrollY;
      const x = scrollContainer?.scrollLeft ?? window.scrollX;
      if (Math.abs(y - startY) > 4 || Math.abs(x - startX) > 4) onClose();
    };

    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    // Resizing MOVES a trigger rather than removing it, so a followed popover repositions for the
    // same reason it does on scroll. Only a point-anchored one has to give up.
    const onResize = anchorEl?.current ? () => setTick((t) => t + 1) : onClose;
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onResize);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [open, onClose, scrollContainer, anchor, anchorEl]);

  if (!mounted) return null;

  return createPortal(
    <div
      ref={ref}
      className={`cc-pop${leaving ? " cc-pop--leaving" : ""}`}
      role={role}
      aria-label={label}
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width,
        // Hidden until measured, so it never flashes at the wrong position.
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
