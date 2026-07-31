// A field where a reference is a THING, not a piece of text.
//
// NOT a plain textarea holding `/Website` with the required/optional switches listed underneath in
// a strip of their own. Everything wrong with that shape follows from references being characters:
// you have to match a chip in that list to a name in the sentence by reading, a real
// slash in a URL needed a `//` escape so it would not be read as a reference, and there was nothing
// on the reference itself to click.
//
// Now a reference is an inline chip inside the flow of the text. It carries its own controls — its
// name, whether a row missing it should still run, and a way to remove it — and hovering it shows
// what that column actually CONTAINS in the first few rows, which is the only way to check that
// `/Domain` really holds domains before a prompt runs over a million of them.
//
// ── Why contenteditable rather than a textarea with an overlay ─────────────────────────────────
//
// The overlay trick — a textarea with chips painted on top, positioned by measuring text — breaks
// the moment the text wraps or scrolls, and it cannot give a chip a hit area, so the toggle would
// have to live somewhere else again, which is the thing being fixed. A chip has to be a real element
// in the flow.
//
// ── How this stays safe with React ─────────────────────────────────────────────────────────────
//
// React NEVER renders the content. It renders an empty editable div; the DOM inside is written by
// hand, and only when the value arrives from OUTSIDE. Letting React re-render this subtree on every
// keystroke would move the caret on every keystroke — the classic contenteditable failure. So React
// owns the frame, an effect owns the content, and the only bridge is one serialise on input.

import { useCallback, useEffect, useRef, useState } from "react";
import { RefMenu, type RefOption } from "./RefMenu.tsx";
import { parseRefNodes, serializeRefNodes, type RefNode } from "../../../src/refNodes.ts";
import { RefPreview } from "./RefPreview.tsx";
import type { Column } from "../api.ts";
import "./RefField.css";

interface Props {
  /** Stored form. */
  value: string;
  /** Stored form. */
  onChange: (next: string) => void;
  onBlur?: () => void;
  columns: Column[];
  options: RefOption[];
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  /** Taller when set. A soft minimum, not a fixed height — the field grows with its content. */
  rows?: number;
  /**
   * Whether a reference here can be marked optional.
   *
   * Off where the decision is meaningless — a header value, say, where a blank is simply a blank and
   * no row is skipped. The chip still draws and still previews; it just has no switch.
   */
  showChips?: boolean;
  spellCheck?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
}

/**
 * Where the caret actually is, so the insert menu hangs off the text cursor.
 *
 * Read straight from the selection rather than mirrored from a measured textarea, which is what the
 * old field had to do. A collapsed range can report a zero rect in some engines, so it falls back to
 * the field itself — a menu slightly off the caret beats a menu in the top-left corner of the page.
 */
function selectionRect(fallback: HTMLElement | null): DOMRect | null {
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (r.width || r.height || r.top) return r;
  }
  return fallback?.getBoundingClientRect() ?? null;
}

/** A single-line field must not accept newlines, whatever is pressed or pasted. */
const isMultiline = (rows?: number) => (rows ?? 1) > 1;

export function RefField({
  value, onChange, onBlur, columns, options, placeholder, ariaLabel, className, rows,
  spellCheck, disabled, showChips, autoFocus,
}: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [trigger, setTrigger] = useState<{ query: string } | null>(null);
  const [caret, setCaret] = useState<DOMRect | null>(null);
  const [activeOption, setActiveOption] = useState<string | null>(null);
  /** The chip being hovered, and where it is, for the value preview. */
  const [preview, setPreview] = useState<{ columnId: string; name: string; rect: DOMRect } | null>(null);
  const [empty, setEmpty] = useState(!value);

  /** What this field last emitted, so an echo of our own value cannot rewrite the DOM under the caret. */
  const emitted = useRef(value);

  /**
   * The caret, remembered.
   *
   * Picking from the insert menu is a CLICK, and by the time it fires the selection may no longer be
   * in this field at all — pressing a button moves focus, and reading `window.getSelection()` then
   * gives a range inside the menu or nothing. Acting on that put the chip at the start of the field
   * and, worse, ran a delete against a range that no longer meant what it did when the user typed
   * "/". So the position is captured while the caret is genuinely here, and the insert uses that.
   */
  const savedRange = useRef<Range | null>(null);
  const remember = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !box.current) return;
    const r = sel.getRangeAt(0);
    if (box.current.contains(r.startContainer)) savedRange.current = r.cloneRange();
  }, []);

  // ── DOM ⇄ nodes ──────────────────────────────────────────────────────────────────────────────

  const chipEl = useCallback((n: Extract<RefNode, { type: "ref" }>): HTMLElement => {
    const el = document.createElement("span");
    el.className = `cc-ref${n.optional ? " cc-ref--opt" : ""}${n.columnId ? "" : " cc-ref--gone"}`;
    // Inert to editing, which is what makes it behave as ONE character to the caret: arrow keys step
    // over it, backspace removes all of it, and its interior cannot be typed into and left in a
    // half-edited state that no longer parses.
    el.contentEditable = "false";
    el.dataset.ref = "1";
    el.dataset.columnId = n.columnId ?? "";
    el.dataset.name = n.name;
    el.dataset.path = n.path;
    el.dataset.optional = n.optional ? "1" : "";
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", `${n.name}${n.path}, ${n.optional ? "optional" : "required to run"}`);

    const label = document.createElement("span");
    label.className = "cc-ref__name";
    label.textContent = n.name + n.path;
    el.append(label);

    if (showChips && n.columnId) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "cc-ref__toggle";
      toggle.dataset.act = "toggle";
      toggle.tabIndex = -1;
      // The wording says which way costs money. The two failures are not symmetric: a skipped row
      // says so in the cell, where a row run against a blank comes back with a confident wrong
      // answer that was paid for.
      toggle.title = n.optional
        ? `Optional — a row with nothing in ${n.name} still runs, with this left blank.`
        : `Required to run — a row with nothing in ${n.name} is skipped, so nothing is spent on it.`;
      toggle.setAttribute("aria-label", toggle.title);
      toggle.setAttribute("aria-pressed", n.optional ? "false" : "true");
      el.append(toggle);
    }

    const kill = document.createElement("button");
    kill.type = "button";
    kill.className = "cc-ref__x";
    kill.dataset.act = "remove";
    kill.tabIndex = -1;
    kill.title = `Remove ${n.name}`;
    kill.setAttribute("aria-label", `Remove ${n.name}`);
    kill.textContent = "×";
    el.append(kill);

    return el;
  }, [showChips]);

  /** Write the whole content. Only ever called for a value that came from OUTSIDE this field. */
  const paint = useCallback((stored: string) => {
    const el = box.current;
    if (!el) return;
    el.replaceChildren();
    for (const n of parseRefNodes(stored, columns)) {
      if (n.type === "text") {
        // Newlines are real nodes, not characters: a "\n" inside a text node renders as a space in
        // contenteditable and the break is lost on the next round trip.
        const parts = n.text.split("\n");
        parts.forEach((p, i) => {
          if (i > 0) el.append(document.createElement("br"));
          if (p) el.append(document.createTextNode(p));
        });
      } else {
        el.append(chipEl(n));
      }
    }
    setEmpty(!stored);
  }, [columns, chipEl]);

  /** Read the whole content back. The one bridge from the DOM to React. */
  const read = useCallback((): string => {
    const el = box.current;
    if (!el) return "";
    const nodes: RefNode[] = [];
    const walk = (parent: Node) => {
      for (const child of Array.from(parent.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
          nodes.push({ type: "text", text: child.textContent ?? "" });
          continue;
        }
        if (!(child instanceof HTMLElement)) continue;
        if (child.dataset.ref) {
          nodes.push({
            type: "ref",
            columnId: child.dataset.columnId || null,
            name: child.dataset.name ?? "",
            path: child.dataset.path ?? "",
            optional: !!child.dataset.optional,
          });
          continue;
        }
        if (child.tagName === "BR") { nodes.push({ type: "text", text: "\n" }); continue; }
        // A DIV or P is what some engines insert on Enter. Its contents are the next line, so it
        // contributes a break and then whatever is inside it.
        if (child.tagName === "DIV" || child.tagName === "P") {
          nodes.push({ type: "text", text: "\n" });
          walk(child);
          continue;
        }
        walk(child);
      }
    };
    walk(el);
    return serializeRefNodes(nodes);
  }, []);

  const emit = useCallback(() => {
    const next = read();
    emitted.current = next;
    setEmpty(!next);
    onChange(next);
  }, [read, onChange]);

  // Adopt an outside change only. Repainting on every render would rewrite the DOM — and move the
  // caret — on every keystroke, and on every unrelated re-render of the drawer around it.
  useEffect(() => {
    // Compare against what the DOM actually holds, not only against the last thing emitted. An
    // unrelated re-seed of the same value — which the drawer does on every autosave round trip —
    // would otherwise repaint the field, and a repaint mid-edit destroys both the caret and any
    // keystrokes not yet echoed back.
    if (value === emitted.current && value === read()) return;
    emitted.current = value;
    paint(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, paint]);

  useEffect(() => {
    if (autoFocus) box.current?.focus();
  }, [autoFocus]);

  // ── the "/" menu ─────────────────────────────────────────────────────────────────────────────

  /**
   * The text node the caret sits in, which is the only place a trigger can be.
   *
   * Prefers the live selection and falls back to the remembered one, so it answers correctly both
   * while typing (live) and from the menu's click handler (remembered), and returns null rather
   * than a stale node if that node has since been detached from the field.
   */
  const beforeCaret = (): { node: Text; offset: number } | null => {
    const sel = window.getSelection();
    const live = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    const r = live && box.current?.contains(live.startContainer) ? live : savedRange.current;
    if (!r || !box.current?.contains(r.startContainer)) return null;
    if (r.startContainer.nodeType !== Node.TEXT_NODE) return null;
    return { node: r.startContainer as Text, offset: r.startOffset };
  };

  const refreshTrigger = useCallback(() => {
    const at = beforeCaret();
    if (!at) { setTrigger(null); return; }
    const upto = at.node.textContent?.slice(0, at.offset) ?? "";
    // A slash opens the menu only at a word boundary. Mid-word — and in `https://` — it is just a
    // slash. There is no escape syntax any more, precisely because a slash is never consumed.
    const m = /(^|\s)\/([^/\s]*)$/.exec(upto);
    if (!m) { setTrigger(null); return; }
    setTrigger({ query: m[2] ?? "" });
    setCaret(selectionRect(box.current));
  }, []);

  /** Replace the `/query` before the caret with a chip, and put the caret after it. */
  const insert = useCallback((column: Column) => {
    const el = box.current;
    if (!el) return;
    const at = beforeCaret();

    if (at) {
      const upto = at.node.textContent?.slice(0, at.offset) ?? "";
      const m = /(^|\s)\/([^/\s]*)$/.exec(upto);
      if (m) {
        const start = at.offset - (m[0].length - m[1]!.length);
        const range = document.createRange();
        range.setStart(at.node, start);
        range.setEnd(at.node, at.offset);
        range.deleteContents();

        const chip = chipEl({ type: "ref", columnId: String(column.id), name: column.name, path: "", optional: false });
        range.insertNode(chip);
        // A trailing space, so the next thing typed is not glued to the chip and the caret lands in
        // real text rather than in the gap between two inert elements — where some engines refuse to
        // place it at all.
        const after = document.createTextNode(" ");
        chip.after(after);
        const sel = window.getSelection();
        const put = document.createRange();
        put.setStart(after, 1);
        put.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(put);
      }
    }
    setTrigger(null);
    emit();
    el.focus();
  }, [chipEl, emit]);

  // ── chip interaction, by delegation ──────────────────────────────────────────────────────────
  //
  // One listener rather than React props per chip, because the chips are DOM an effect wrote. It
  // also means a handler cannot go stale: it reads the element it was actually given.

  const onClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const act = target?.dataset?.act;
    if (!act) return;
    const chip = target.closest<HTMLElement>("[data-ref]");
    if (!chip) return;
    e.preventDefault();
    e.stopPropagation();

    if (act === "remove") {
      chip.remove();
    } else {
      const wasOptional = !!chip.dataset.optional;
      chip.dataset.optional = wasOptional ? "" : "1";
      chip.classList.toggle("cc-ref--opt", !wasOptional);
      const name = chip.dataset.name ?? "";
      const t = chip.querySelector<HTMLElement>('[data-act="toggle"]');
      const title = wasOptional
        ? `Required to run — a row with nothing in ${name} is skipped, so nothing is spent on it.`
        : `Optional — a row with nothing in ${name} still runs, with this left blank.`;
      if (t) {
        t.title = title;
        t.setAttribute("aria-label", title);
        t.setAttribute("aria-pressed", wasOptional ? "true" : "false");
      }
      chip.setAttribute("aria-label", `${name}${chip.dataset.path ?? ""}, ${wasOptional ? "required to run" : "optional"}`);
    }
    emit();
  };

  const onOver = (e: React.MouseEvent) => {
    const chip = (e.target as HTMLElement)?.closest?.<HTMLElement>("[data-ref]");
    if (!chip || !chip.dataset.columnId) { setPreview(null); return; }
    setPreview({ columnId: chip.dataset.columnId, name: chip.dataset.name ?? "", rect: chip.getBoundingClientRect() });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // While the menu is open it owns the arrows, Enter and Tab through the window listener it
    // installs — this must not also act on them.
    if (trigger && ["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(e.key)) return;
    if (e.key === "Escape" && trigger) { e.preventDefault(); e.stopPropagation(); setTrigger(null); return; }
    // A single-line field refuses Enter outright rather than accepting a newline the stored value
    // then carries into a URL.
    if (e.key === "Enter" && !isMultiline(rows)) { e.preventDefault(); (e.target as HTMLElement).blur(); }
  };

  /** Paste arrives as plain text. Pasted markup in a contenteditable is how a field becomes a page. */
  const onPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const raw = e.clipboardData.getData("text/plain");
    const text = isMultiline(rows) ? raw : raw.replace(/[\r\n]+/g, " ");
    document.execCommand("insertText", false, text);
  };

  return (
    <div className={`cc-reffield${disabled ? " cc-reffield--off" : ""}${className ? ` ${className}` : ""}`}>
      <div
        ref={box}
        className={`cc-reffield__box${isMultiline(rows) ? " cc-reffield__box--multi" : ""}`}
        style={isMultiline(rows) ? { minHeight: `${(rows ?? 3) * 1.55}em` } : undefined}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline={isMultiline(rows)}
        aria-label={ariaLabel}
        aria-activedescendant={trigger ? activeOption ?? undefined : undefined}
        spellCheck={spellCheck ?? false}
        data-placeholder={placeholder}
        data-empty={empty ? "1" : undefined}
        onInput={() => { emit(); remember(); refreshTrigger(); }}
        onKeyUp={() => { remember(); refreshTrigger(); }}
        onMouseUp={remember}
        onClick={onClick}
        onMouseOver={onOver}
        onMouseLeave={() => setPreview(null)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => { setTrigger(null); onBlur?.(); }}
      />

      <RefMenu
        open={!!trigger}
        anchorRect={caret}
        options={options}
        query={trigger?.query ?? ""}
        onPick={insert}
        onClose={() => setTrigger(null)}
        onActiveChange={setActiveOption}
      />

      {/* What that column actually holds. The reason a reference can be checked without leaving the
          editor — the name says what you picked, the values say whether it was the right one. */}
      {preview && <RefPreview columnId={preview.columnId} name={preview.name} rect={preview.rect} />}
    </div>
  );
}
