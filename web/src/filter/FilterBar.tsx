// The filter bar.
//
// The engine has supported the full operator set since the first phase and none of it was reachable:
// the toolbar offered status and sort, so "Country is US and Employees over 50" — the single most
// ordinary thing anyone does with a sheet like this — could not be expressed at all.
//
// Two properties this must not break, both already covered by tests on the other side:
//
//   The grid and a run narrow to the SAME rows. Both derive from `GridView` through one module, so
//   this component's only job is to edit that object. It must never build a request of its own.
//
//   A half-built condition narrows NOTHING. Picking a column before typing a value would otherwise
//   compile to a predicate matching nothing, and the grid would blank while the user was mid-edit —
//   indistinguishable from "no rows match". `usableFilter` drops incomplete conditions on the way
//   out, so the filter only takes effect once it means something.

import { useEffect, useRef, useState } from "react";
import { Popover } from "../ui/Popover.tsx";
import { Select } from "../ui/Select.tsx";
import { IconPlus } from "../ui/Icon.tsx";
import type { Column } from "../api.ts";
import type { Condition, FilterGroup, GridView } from "../view.ts";
import { defaultOp, operatorsFor, specFor, STATUS_VALUES } from "./operators.ts";
import "./FilterBar.css";

interface Props {
  columns: Column[];
  view: GridView;
  onChange: (v: GridView) => void;
  /**
   * "Filter on this column", asked for from somewhere else — the column's own menu.
   *
   * Carries a nonce rather than only a column id, because asking twice for the same column is a
   * real request: the popover may have been dismissed in between, and a bare id would compare equal
   * and do nothing the second time.
   */
  request?: { columnId: number; nonce: number } | null;
}

export function FilterBar({ columns, view, onChange, request }: Props) {
  /**
   * The conditions live in a POPOVER, not inline.
   *
   * They were inline, and the result was a broken toolbar: this component is a vertical stack, the
   * toolbar row it sits in is horizontal, so adding a filter grew that row from 34px to 111px,
   * threw the trigger up onto the line above, squeezed every condition into a 467px slot, and left
   * "Add condition" and "Remove all" rendered underneath the grid where they could not be clicked.
   *
   * A popover fixes all of it at once and is the house pattern anyway — it is portalled, so it
   * cannot deform the row it is triggered from, it flips near the edges, and the toolbar's height
   * is now the same whether a filter exists or not.
   */
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  const filter: FilterGroup = view.filter ?? { conj: "and", children: [] };
  const set = (next: FilterGroup) => onChange({ ...view, filter: next.children.length ? next : null });

  /**
   * A stable key per condition row, held here rather than in the view.
   *
   * The rows were keyed by array index and each one has its own delete button, so removing the
   * first of three handed row 0's key to what had been row 1: React reused the elements, and the
   * focus ring — and any open Select popover — stayed put while a DIFFERENT condition slid under
   * it. The key cannot live on the condition itself because a `GridView` is serialised into the
   * request and a saved view, and anything extra on it would travel with them. Same pattern as the
   * pair rows in HttpSettings.tsx.
   */
  const rowKeys = useRef<number[]>([]);
  const nextRowKey = useRef(1);
  const keysFor = (n: number): number[] => {
    while (rowKeys.current.length < n) rowKeys.current.push(nextRowKey.current++);
    if (rowKeys.current.length > n) rowKeys.current.length = n;
    return rowKeys.current;
  };

  const typeOf = (columnId: number) =>
    columns.find((c) => Number(c.id) === columnId)?.valueType ?? "text";

  const add = () => {
    const first = columns[0];
    if (!first) return;
    const columnId = Number(first.id);
    set({ ...filter, children: [...filter.children, { columnId, op: defaultOp(first.valueType) }] });
  };

  const update = (i: number, patch: Partial<Condition>) => {
    const children = filter.children.map((c, j) => (j === i ? { ...c, ...patch } : c));
    set({ ...filter, children });
  };

  const remove = (i: number) => {
    // The key goes with the row, so the rows below keep the elements they already had.
    rowKeys.current.splice(i, 1);
    set({ ...filter, children: filter.children.filter((_, j) => j !== i) });
  };

  // Adds a condition on the asked-for column and opens the popover on it. Only ADDS — an existing
  // filter is a thing someone built, and replacing it because they right-clicked a header would be
  // a destructive answer to a mild request.
  const lastRequest = useRef(0);
  useEffect(() => {
    if (!request || request.nonce === lastRequest.current) return;
    lastRequest.current = request.nonce;
    const col = columns.find((c) => Number(c.id) === request.columnId);
    if (!col) return;
    const already = filter.children.some((c) => c.columnId === request.columnId);
    if (!already) {
      set({ ...filter, children: [...filter.children, { columnId: request.columnId, op: defaultOp(col.valueType) }] });
    }
    setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const count = filter.children.length;
  const keys = keysFor(count);

  return (
    <div className="cc-fb">
      <button
        ref={trigger}
        className={`cc-btn${count ? " cc-fb__toggle--on" : ""}`}
        // Adding a condition always OPENS, it never toggles. The popover only renders on
        // `open && count > 0`, so after "Remove all" the state was left open with a count of zero:
        // the next click added a condition and then toggled `open` back to false, closing something
        // that was not on screen. Clicking Filter with no filter means "show me the filter".
        onClick={() => {
          if (count === 0) { add(); setOpen(true); return; }
          setOpen((o) => !o);
        }}
        aria-expanded={open && count > 0}
        aria-haspopup="dialog"
      >
        {/* The count is part of the label, so a collapsed bar still says the grid is narrowed. A
            filter you cannot see and cannot tell is active is how someone concludes their data is
            missing. */}
        {count === 0 ? "Filter" : `${count} ${count === 1 ? "filter" : "filters"}`}
      </button>

      <Popover
        open={open && count > 0}
        anchor={trigger.current ? { rect: trigger.current.getBoundingClientRect() } : null}
        anchorEl={trigger}
        onClose={() => setOpen(false)}
        label="Filter conditions"
      >
        <div className="cc-fb__rows">
          {filter.children.map((c, i) => {
            const vt = typeOf(c.columnId);
            const ops = operatorsFor(vt);
            const spec = specFor(vt, c.op);
            const arity = spec?.arity ?? 1;
            const isStatus = c.op === "status_is" || c.op === "status_is_not";

            return (
              <div key={keys[i]} className="cc-fb__row">
                {/* "Where" then "and"/"or" — the first row reads as a sentence, and only the second
                    row onwards needs a conjunction, which is also the only place it is editable. */}
                {i === 0 ? (
                  <span className="cc-fb__lead">Where</span>
                ) : i === 1 ? (
                  <Select
                    label="Combine with"
                    value={filter.conj}
                    options={[{ value: "and", label: "and" }, { value: "or", label: "or" }]}
                    size="sm"
                    showLabel={false}
                    onChange={(v) => set({ ...filter, conj: v as "and" | "or" })}
                  />
                ) : (
                  <span className="cc-fb__lead cc-fb__lead--muted">{filter.conj}</span>
                )}

                <Select
                  label="Column"
                  value={String(c.columnId)}
                  options={columns.map((col) => ({ value: String(col.id), label: col.name }))}
                  size="sm"
                  showLabel={false}
                  onChange={(v) => {
                    const nextType = typeOf(Number(v));
                    // The operator is reset when the type changes, because an operator valid for the
                    // old column may not exist for the new one — leaving `gt` on a text column would
                    // produce a condition the engine cannot compile.
                    const keep = specFor(nextType, c.op) ? c.op : defaultOp(nextType);
                    update(i, { columnId: Number(v), op: keep, value: keep === c.op ? c.value : undefined });
                  }}
                />

                <Select
                  label="Condition"
                  value={c.op}
                  options={ops.map((o) => ({ value: o.op, label: o.label }))}
                  size="sm"
                  showLabel={false}
                  onChange={(v) => {
                    const next = specFor(vt, v);
                    // Dropping the value when the arity changes: a `between` carrying a two-element
                    // array would otherwise stay an array after switching to `is`, and the engine
                    // would bind an array where it expects a scalar.
                    update(i, { op: v, value: next?.arity === (spec?.arity ?? 1) ? c.value : undefined });
                  }}
                />

                {arity === 0 ? (
                  // Reserved, so a row does not change width when the operator stops needing a value.
                  <span className="cc-fb__novalue" aria-hidden="true" />
                ) : isStatus ? (
                  <Select
                    label="Status"
                    value={String(c.value ?? "")}
                    options={[{ value: "", label: "pick one…" }, ...STATUS_VALUES]}
                    size="sm"
                    showLabel={false}
                    onChange={(v) => update(i, { value: v })}
                  />
                ) : arity === 2 ? (
                  <span className="cc-fb__pair">
                    <input
                      className="cc-input cc-fb__val"
                      value={String((c.value as any[])?.[0] ?? "")}
                      placeholder="from"
                      aria-label="From"
                      onChange={(e) => update(i, { value: [e.target.value, (c.value as any[])?.[1] ?? ""] })}
                    />
                    <input
                      className="cc-input cc-fb__val"
                      value={String((c.value as any[])?.[1] ?? "")}
                      placeholder="to"
                      aria-label="To"
                      onChange={(e) => update(i, { value: [(c.value as any[])?.[0] ?? "", e.target.value] })}
                    />
                  </span>
                ) : (
                  <input
                    className="cc-input cc-fb__val"
                    value={String(c.value ?? "")}
                    placeholder={c.op === "is_any_of" || c.op === "is_none_of" ? "a, b, c" : "value"}
                    aria-label="Value"
                    onChange={(e) =>
                      update(i, {
                        // The multi-value operators take a list; typed as comma-separated because a
                        // tag input for a filter row is more ceremony than the job needs.
                        value:
                          c.op === "is_any_of" || c.op === "is_none_of"
                            ? e.target.value.split(",").map((s) => s.trim()).filter(Boolean)
                            : e.target.value,
                      })
                    }
                  />
                )}

                <button
                  className="hk-icon-btn cc-fb__x"
                  onClick={() => remove(i)}
                  aria-label="Remove this filter"
                  title="Remove"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <path d="M4 4l8 8M12 4l-8 8" />
                  </svg>
                </button>
              </div>
            );
          })}

          <div className="cc-fb__actions">
            <button className="cc-btn cc-btn--ghost cc-btn--xs" onClick={add}>
              <IconPlus /> <span>Condition</span>
            </button>
            <button className="cc-btn cc-btn--ghost cc-btn--xs" onClick={() => set({ conj: "and", children: [] })}>
              Remove all
            </button>
          </div>
        </div>
      </Popover>
    </div>
  );
}
