// The "/" column reference menu.
//
// Two things make this worth building properly rather than as a plain autocomplete:
//
//   1. It shows a LIVE SAMPLE VALUE from a real row beside every column. That is the thing that
//      actually prevents mistakes — you see immediately whether Website holds "acme.com" or
//      "https://acme.com/about" before you write a rule that assumes one of them.
//
//   2. Columns that would create a CYCLE are listed but DISABLED, with the cycle path named. Hiding
//      them makes the user think the column vanished; showing them enabled lets them build a loop
//      that only fails later. Disabled-with-a-reason is the only honest option.
//
// It inserts `/Column name`, which the field converts to an id before storing — so renaming a
// column later cannot break the rule, and the user never sees the id form.
//
// It offers COLUMNS ONLY. There was a "Built in" section here — row number, row id, today's date —
// and the engine has no such variables: picking one wrote the literal text `/Row number` into the
// prompt or the request, which nothing resolves, so an HTTP column sent that string as part of its
// address on every row. A billed request per row against a broken URL. It stays out until the engine
// grows real variables to insert.

import { useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "../ui/Popover.tsx";
import { IconTable } from "../ui/Icon.tsx";
import type { Column } from "../api.ts";

export interface RefOption {
  column: Column;
  /** A real value from the anchor row, already truncated by the caller. */
  sample: string | null;
  /** Set when choosing this column would create a cycle — the human-readable path. */
  cyclePath?: string;
  /** True for the column being edited. */
  isSelf?: boolean;
}

interface Props {
  open: boolean;
  /** Caret rect, so the menu hangs off the text cursor rather than the whole textarea. */
  anchorRect: DOMRect | null;
  options: RefOption[];
  /** What the user has typed after the trigger character. */
  query: string;
  onPick: (column: Column) => void;
  onClose: () => void;
  /**
   * The id of the option the arrow keys are currently on, so the field that owns the caret can point
   * `aria-activedescendant` at it. Without it the highlight is purely visual and a screen-reader
   * user cannot tell which column they are about to insert.
   */
  onActiveChange?: (optionId: string | null) => void;
}

/** Stable per-option element id, shared with whatever field is pointing at it. */
const optionId = (columnId: string) => `cc-refopt-${columnId}`;

/** Subsequence match, so "cn" finds "Company name". Prefix matches rank first. */
function score(name: string, q: string): number | null {
  if (!q) return 0;
  const n = name.toLowerCase();
  const query = q.toLowerCase();
  if (n.startsWith(query)) return 0;
  const idx = n.indexOf(query);
  if (idx >= 0) return 1 + idx / 100;

  let qi = 0;
  for (let i = 0; i < n.length && qi < query.length; i++) if (n[i] === query[qi]) qi++;
  return qi === query.length ? 50 : null;
}

export function RefMenu({ open, anchorRect, options, query, onPick, onClose, onActiveChange }: Props) {
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const scored = options
      .map((o) => ({ o, s: score(o.column.name, query) }))
      .filter((x) => x.s !== null)
      .sort((a, b) => (a.s! - b.s!) || a.o.column.position - b.o.column.position);
    return scored.map((x) => x.o);
  }, [options, query]);

  // Reset the highlight whenever the candidate set changes, so Enter can't fire on a stale row.
  useEffect(() => { setActive(0); }, [query, options]);

  // Tell the field which option is highlighted, so it can name it in aria-activedescendant.
  const activeColumnId = open ? filtered[active]?.column.id ?? null : null;
  useEffect(() => {
    onActiveChange?.(activeColumnId ? optionId(activeColumnId) : null);
  }, [activeColumnId, onActiveChange]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => {
          const next = e.key === "ArrowDown" ? a + 1 : a - 1;
          return Math.max(0, Math.min(filtered.length - 1, next));
        });
      } else if (e.key === "Enter" || e.key === "Tab") {
        const opt = filtered[active];
        // Enter on a disabled option does nothing rather than silently picking a different one.
        if (opt && !opt.cyclePath && !opt.isSelf) {
          e.preventDefault();
          onPick(opt.column);
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, filtered, active, onPick]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <Popover
      open={open}
      anchor={anchorRect ? { rect: anchorRect } : null}
      onClose={onClose}
      width={380}
      role="listbox"
      label="Insert a column reference"
    >
      <div className="cc-menu" ref={listRef}>
        {filtered.length === 0 ? (
          <div className="cc-menu__empty">
            No column matches “{query}”. References are inserted as a chip, so the rule keeps working
            if you rename the column later.
          </div>
        ) : (
          filtered.map((o, i) => {
            const disabled = !!o.cyclePath || !!o.isSelf;
            return (
              <button
                key={o.column.id}
                id={optionId(o.column.id)}
                type="button"
                // The popover is the listbox, so these have to be its options — as plain buttons the
                // arrow-key highlight existed only in the styling, and nothing announced which
                // column was about to be inserted. Mirrors ui/Select.tsx.
                role="option"
                aria-selected={i === active}
                aria-disabled={disabled || undefined}
                className="cc-menu__item"
                data-active={i === active}
                disabled={disabled}
                title={o.cyclePath ? `Circular reference: ${o.cyclePath}` : o.isSelf ? "A column cannot reference itself" : undefined}
                onMouseEnter={() => setActive(i)}
                onClick={() => !disabled && onPick(o.column)}
              >
                <span className="cc-menu__icon"><IconTable size={14} /></span>
                <span className="cc-menu__label">{o.column.name}</span>
                {o.isSelf ? (
                  <span className="cc-menu__note">this column</span>
                ) : o.cyclePath ? (
                  <span className="cc-menu__note">circular</span>
                ) : (
                  <span className="cc-menu__sample">{o.sample ?? "—"}</span>
                )}
              </button>
            );
          })
        )}
      </div>
    </Popover>
  );
}

/**
 * Detect a "/" or "{{" trigger immediately before the caret in a textarea, and return the query
 * typed since. Returns null when the trigger is not active.
 *
 * Requires the trigger to start a word — otherwise every URL in a prompt ("https://…") would open
 * the menu.
 */
/**
 * Approximate the caret's viewport rect inside a textarea by mirroring its text into a hidden div.
 * A textarea exposes no caret geometry, and anchoring the menu to the whole textarea instead would
 * put it far from where the user is typing on a multi-line prompt.
 */
export function caretRect(ta: HTMLTextAreaElement, caret: number): DOMRect {
  const style = getComputedStyle(ta);
  const mirror = document.createElement("div");
  for (const p of [
    "fontFamily", "fontSize", "fontWeight", "letterSpacing", "lineHeight", "textTransform",
    "wordSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "boxSizing",
  ] as const) {
    mirror.style[p] = style[p];
  }
  Object.assign(mirror.style, {
    position: "absolute", visibility: "hidden", whiteSpace: "pre-wrap", wordWrap: "break-word",
    width: `${ta.clientWidth}px`, top: "0", left: "0",
  });

  mirror.textContent = ta.value.slice(0, caret);
  const marker = document.createElement("span");
  marker.textContent = "​";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  const m = marker.getBoundingClientRect();
  const box = ta.getBoundingClientRect();
  const top = box.top + m.top - ta.scrollTop;
  const left = box.left + m.left;
  document.body.removeChild(mirror);

  const lineH = parseFloat(style.lineHeight) || 18;
  return new DOMRect(left, top, 1, lineH);
}
