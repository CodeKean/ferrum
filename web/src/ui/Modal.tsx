// The one modal shell.
//
// Extracted when a second dialog needed the same scrim, because two hand-rolled scrims drift: the
// first one had no exit animation and no Escape key, and the copy would have inherited both gaps.
//
// A modal is for the small set of moments that genuinely block — confirming a spend, confirming a
// discard. Anything that should leave the grid live and visible behind it is a Popover or the
// drawer, not this.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./Modal.css";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Accessible name, and the heading shown in the header. */
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Text shown at the left of the footer — a status line, not an action. */
  footNote?: string;
  /** Wider than the default, for content that is a table rather than a sentence. */
  width?: number;
}

/** Matches the CSS exit duration. Kept in one place so the two cannot drift apart. */
const EXIT_MS = 140;

/**
 * Local dismissal, for a dialog whose PARENT decides whether it exists.
 *
 * `<Modal open>` under a conditional mount means closing removes the node immediately and the exit
 * above never plays — measured at 6.3ms against the 140ms declared here. This keeps the component
 * on screen for the exit and only then tells the parent to unmount it.
 *
 *   const [open, dismiss] = useModalDismiss(onClose);
 *   <Modal open={open} onClose={dismiss} … >
 */
export function useModalDismiss(onClose: () => void): [boolean, () => void] {
  const [open, setOpen] = useState(true);
  // Callers pass a fresh arrow every render; an identity dependency below would restart the timer
  // on every parent render and the parent would never be told.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (open) return;
    const t = setTimeout(() => closeRef.current(), EXIT_MS + 20);
    return () => clearTimeout(t);
  }, [open]);

  return [open, useCallback(() => setOpen(false), [])];
}

/** Everything the browser will hand focus to, in document order. */
const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function Modal({ open, onClose, title, children, footer, footNote, width }: Props) {
  // Kept mounted through the exit animation, then unmounted. An overlay that vanishes instantly on
  // dismiss reads as a glitch even when the entrance was animated.
  const [mounted, setMounted] = useState(open);
  const [leaving, setLeaving] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  /** Where focus was before this opened, so closing puts it back on the control that opened it. */
  const restoreTo = useRef<HTMLElement | null>(null);
  // Callers pass a fresh inline arrow every render. Held in a ref so the focus effect below can
  // depend on `open` ALONE — depending on onClose would tear the trap down and restore focus on
  // every parent render, which is a focus jump per keystroke on any dialog with a field in it.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (open) { setMounted(true); setLeaving(false); return; }
    if (!mounted) return;
    setLeaving(true);
    const t = setTimeout(() => { setMounted(false); setLeaving(false); }, EXIT_MS);
    return () => clearTimeout(t);
  }, [open, mounted]);

  // Focus management. `aria-modal="true"` is a PROMISE that the rest of the page is unreachable, and
  // this component was making it while doing none of it: focus stayed on the trigger, Tab walked
  // straight out behind the scrim, and Escape dropped focus on <body>. Three parts, all required —
  // move in, keep in, put back.
  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement | null;

    // A timer rather than requestAnimationFrame: rAF does not fire in a background tab, and a
    // dialog opened in one would never become typeable. Same reasoning as ColumnName's re-assert.
    const t = setTimeout(() => {
      const box = boxRef.current;
      if (!box || box.contains(document.activeElement)) return;
      (box.querySelector<HTMLElement>(FOCUSABLE) ?? box).focus();
    }, 0);

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Tab") return;
      const box = boxRef.current;
      if (!box) return;
      // Only the TOPMOST dialog reacts. These listeners sit on the document in capture phase, so
      // with two open the outer one runs first — it would take the Escape meant for the inner one,
      // and two competing Tab traps are a genuine keyboard trap. Portals append in mount order, so
      // the last .cc-modal in the document is the one on top.
      const stack = document.querySelectorAll(".cc-modal");
      if (stack.length > 1 && stack[stack.length - 1] !== box) return;

      if (e.key === "Escape") {
        // Stopped here so a modal opened from inside a drawer does not also dismiss the drawer
        // behind it — one Escape, one layer.
        e.stopPropagation();
        closeRef.current();
        return;
      }
      const stops = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (stops.length === 0) { e.preventDefault(); box.focus(); return; }
      const first = stops[0]!;
      const last = stops[stops.length - 1]!;
      // Wrap at the ends, and pull focus back in if it has escaped the dialog entirely.
      if (!box.contains(document.activeElement)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };

    document.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey, true);
      const back = restoreTo.current;
      restoreTo.current = null;
      // Only if the dialog still holds focus. A modal closed because the user clicked something
      // else must not steal the caret back out of whatever they clicked. Tested with closest()
      // rather than boxRef, because the ref is already detached by the time an UNMOUNTING modal
      // runs this — and seven call sites close by unmounting.
      const held = document.activeElement as HTMLElement | null;
      const ours = !held || held === document.body || !!held.closest?.(".cc-modal");
      if (back && ours && document.body.contains(back)) back.focus({ preventScroll: true });
    };
  }, [open]);

  if (!mounted) return null;

  return createPortal(
    <div
      className={`cc-modal-scrim${leaving ? " cc-modal-scrim--leaving" : ""}`}
      // mousedown, not click: a click that STARTED inside the dialog and ended on the scrim (a
      // drag-select that overshoots) would otherwise dismiss it and throw the work away.
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div ref={boxRef} className={`cc-modal${leaving ? " cc-modal--leaving" : ""}`}
        style={width ? { maxWidth: width } : undefined} role="dialog" aria-modal="true" aria-label={title}
        // Never a tab stop of its own; it is the fallback target when the dialog has no controls.
        tabIndex={-1}>
        <header className="cc-modal__head">
          <h2 className="cc-modal__title">{title}</h2>
        </header>
        <div className="cc-modal__body">{children}</div>
        {(footer || footNote) && (
          <footer className="cc-modal__foot">
            <span className="cc-modal__foot-note">{footNote ?? ""}</span>
            <div className="cc-modal__actions">{footer}</div>
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
