// The cell sidebar.
//
// It replaces a 320px popover that showed a cell's value as a wall of raw JSON. That was the wrong
// shape twice over: a research result is a structure, not a string, and the actions you want are per
// FIELD — turn this one into a column, send that list to another table — which a single blob of text
// cannot offer.
//
// Right-docked and full height, so a value with fifteen fields and a three-sentence reasoning entry
// has somewhere to go. No backdrop, like the column editor: the grid stays live behind it, and
// turning a field into a column is something you want to watch land.

import { useEffect, useMemo, useRef, useState } from "react";
import { arrayItems, buildTree, filterTree, humanise, JsonTree, type TreeNode } from "./JsonTree.tsx";
import { starPath } from "./starPath.ts";
import { Popover } from "../ui/Popover.tsx";
import { IconPlay, IconPlus, IconSearch } from "../ui/Icon.tsx";
import { ColumnKindIcon } from "../ui/ColumnKindIcon.tsx";
import { columnBadge, sourceNameOf } from "../ui/columnBadge.ts";
import { attemptCost, attemptTook, explainCell, retryNote, statusWord, type Attempt } from "./explainCell.ts";
import { errorFacts } from "@shared/errorClass.ts";
import { CellFix } from "./CellFix.tsx";
import { addAllLabel, objectOffer } from "./objectFields.ts";
import type { Column } from "../api.ts";
import "./CellPanel.css";

export interface OpenCell {
  cellId: string;
  rect: DOMRect;
}

interface Detail {
  status: string;
  valueText: string | null;
  errorType?: string;
  errorMsg?: string;
  stale?: boolean;
  pinned?: boolean;
  /** How sure the model said it was — the finish tool requires it, so every run records one. */
  confidence?: "high" | "medium" | "low" | null;
  /** Where the answer came from, when a page was used. */
  sourceUrl?: string | null;
  attempt?: number;
  durationMs?: number;
  costUsd?: number;
}

interface Props {
  open: OpenCell | null;
  columns: Column[];
  onClose: () => void;
  onRunCell: (cellId: string) => void;
  /** Fired after a column is created or filled, so the grid picks it up. */
  onColumnsChanged: () => void;
  /** Open the fan-out screen for a list at this path. */
  onExpandList: (columnId: string, path: string) => void;
  /**
   * Deliberately write over a value this column produced. Absent on a column that is already
   * editable, where typing into the grid is the ordinary way and an "override" would be a second,
   * stranger one.
   */
  onOverride?: (current: string) => void;
  /** Go to a settings section — for the failures whose fix is a key or a cap, not the column. */
  onOpenSettings?: (section: "providers" | "keys") => void;
  /** Open this column's own editor, for the failures whose fix is one of its settings. */
  onEditColumn?: () => void;
}

export function CellPanel({
  open, columns, onClose, onRunCell, onColumnsChanged, onExpandList, onOverride, onOpenSettings, onEditColumn,
}: Props) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  /** The rendered prompt is long, so it starts folded and opens on request. */
  const [showPrompt, setShowPrompt] = useState(false);
  /** Same for the per-attempt history: a summary line, opened when the summary is not enough. */
  const [showTries, setShowTries] = useState(false);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  /** Which row's action menu is open, and where. */
  const [menu, setMenu] = useState<{ node: TreeNode; rect: DOMRect; mode: "leaf" | "list" } | null>(null);
  // The last menu, kept after `menu` clears so the popover's exit animation has something to render
  // against. A dismissed menu that unmounts on the same tick cannot animate out.
  const lastMenu = useRef<{ node: TreeNode; rect: DOMRect; mode: "leaf" | "list" } | null>(null);
  if (menu) lastMenu.current = menu;
  const shownMenu = menu ?? lastMenu.current;

  const columnId = open?.cellId.split(":")[1] ?? null;
  const rootRef = useRef<HTMLElement>(null);
  /** Where focus was when the panel opened, so closing hands it back rather than dropping it. */
  const restoreTo = useRef<HTMLElement | null>(null);

  // Focus goes into the panel on open and back to the grid on close.
  //
  // This declares role="dialog" and did neither: the trigger kept focus, and Escape left the caret
  // on <body> — a keyboard user was returned to the top of the document from a cell halfway down a
  // million rows. NOT trapped, deliberately: the grid stays live behind this panel, so Tab out of
  // it is a legitimate move. Keyed on whether the panel is open at all rather than on `open`'s
  // identity, because clicking another cell re-anchors it and must not re-steal focus.
  const isOpen = !!open;
  useEffect(() => {
    if (!isOpen) return;
    restoreTo.current = document.activeElement as HTMLElement | null;
    // A timer, not requestAnimationFrame — rAF does not fire in a background tab.
    const t = setTimeout(() => {
      const el = rootRef.current;
      if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    }, 0);
    return () => {
      clearTimeout(t);
      const back = restoreTo.current;
      restoreTo.current = null;
      const held = document.activeElement as HTMLElement | null;
      const ours = !held || held === document.body || !!held.closest?.(".cc-cs, .cc-pop");
      if (back && ours && document.body.contains(back)) back.focus({ preventScroll: true });
    };
  }, [isOpen]);

  // Dismissed the way every other surface here is dismissed. It had NO way out except the close
  // button — clicking the grid, pressing Escape, nothing. A panel that ignores both reads as stuck.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const el = rootRef.current;
      if (!el || el.contains(e.target as Node)) return;
      const t = e.target as HTMLElement;
      // The action menu is portalled — visually ours, not a DOM descendant. And a click on another
      // CELL is a navigation, not a dismissal: it re-anchors this panel rather than closing it.
      if (t.closest?.(".cc-pop, .cc-modal-scrim, .cc-cell")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // An open action menu owns Escape; the panel takes the next one.
      if (document.querySelector(".cc-pop")) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  useEffect(() => {
    setQuery("");
    setDone(new Set());
    setError(null);
    setMenu(null);
    setAttempts([]);
    setShowPrompt(false);
    setShowTries(false);
    if (!open) { setDetail(null); return; }
    let live = true;
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch(`/api/cells/${encodeURIComponent(open.cellId)}`).then((r) => r.json());
        if (!live) return;
        setDetail(res.cell ?? null);
        // This was fetched and dropped on the floor. The route returns up to twenty attempts, each
        // carrying the prompt that was actually sent, which model answered, what it cost and how
        // long it took — the four things somebody opens this panel to find — and the panel read
        // `res.cell` and ignored the rest, which is why it looked empty for every kind of cell.
        setAttempts(Array.isArray(res.attempts) ? res.attempts : []);
      } catch {
        if (live) setError("Could not load this cell.");
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [open]);

  const parsed = useMemo(() => {
    const t = detail?.valueText?.trim();
    if (!t || (!t.startsWith("{") && !t.startsWith("["))) return null;
    try { return JSON.parse(t) as unknown; } catch { return null; }
  }, [detail?.valueText]);

  const tree = useMemo(() => {
    if (parsed == null) return null;
    // A bare list at the top level has no fields of its own — it is one thing, and the thing you do
    // with it is expand it into rows. Wrapping it in a synthetic node says that plainly.
    if (Array.isArray(parsed)) {
      return [{
        path: "", label: "Items", kind: "array" as const,
        preview: String(parsed.length), count: parsed.length, value: parsed,
        children: arrayItems(parsed, ""),
      }];
    }
    return buildTree(parsed);
  }, [parsed]);

  const shown = useMemo(() => (tree ? filterTree(tree, query) : null), [tree, query]);

  const post = async (url: string, body: unknown, key: string) => {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json());
      if (res.error) { setError(res.error); return false; }
      setDone((p) => new Set(p).add(key));
      onColumnsChanged();
      return true;
    } catch {
      setError("Could not reach the engine.");
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (!open) return null;
  const status = detail?.status ?? "empty";
  const canRun = status !== "running" && status !== "queued";
  const column = columns.find((c) => String(c.id) === String(columnId));

  const facts = explainCell({
    kind: column?.kind ?? "static",
    status,
    message: detail?.errorMsg ?? null,
    pinned: detail?.pinned,
    stale: detail?.stale,
    // Whether the column has a run condition changes what "skipped" is allowed to claim: with one,
    // either explanation is possible and the sentence must say so instead of picking.
    hasCondition: !!column?.conditionScriptId,
    // The class was sitting in `detail` and was never passed, so every failure got the same
    // generic treatment no matter what had actually gone wrong.
    errorType: detail?.errorType ?? null,
    // Named here rather than inferred from `kind`, which for a projection says "script" and would
    // have the panel describe it as a rule.
    derivedFrom: column?.sourceColumnId != null && column.jsonPath
      ? sourceNameOf(column, columns)
      : null,
  });

  /** The column this one projects out of, by name, when it is a projection. */
  const derivedOf = column?.sourceColumnId != null && column.jsonPath
    ? sourceNameOf(column, columns)
    : null;

  /** Hand this cell back to whatever fills it, discarding an override. */
  const restore = async () => {
    if (!open) return;
    setBusy("restore");
    setError(null);
    try {
      const res = await fetch(`/api/cells/${open.cellId}/restore`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.error) {
        setError(String(body?.error ?? "Could not restore that cell."));
        return;
      }
      setDetail(body.cell ?? null);
      // The grid holds its own copy, and a panel that fixed the cell while the row behind it went on
      // showing the old value would look like the button had not worked.
      onColumnsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  // Newest first from the route, so [0] is the run that produced what is on screen.
  const last = attempts[0] ?? null;
  const took = attemptTook(last?.duration_ms ?? detail?.durationMs ?? null);
  const cost = facts.costs ? attemptCost(last?.cost_usd ?? detail?.costUsd ?? null) : null;
  const ran = last?.finished_at ? new Date(last.finished_at).toLocaleString() : null;
  const retries = retryNote(attempts);
  // The most recent attempt that actually recorded one — a retry can fail before a prompt is built,
  // and falling back through the list beats showing nothing on the run that matters.
  const promptText = attempts.find((a) => a.rendered_prompt)?.rendered_prompt ?? null;

  return (
    <aside
      className="cc-cs"
      role="dialog"
      aria-label={column ? `Cell details — ${column.name}` : "Cell details"}
      ref={rootRef}
      // Focusable programmatically, never a tab stop of its own.
      tabIndex={-1}
    >
      <header className="cc-cs__head">
        {/* The same mark the grid header carries, next to the same name.
            This panel opens FROM that header, and arriving without the mark you clicked breaks the
            thread between the two. It also carries the sentence explaining what the mark means, on
            hover, at the moment someone is looking at exactly that column. */}
        {column && (() => {
          const b = columnBadge(column, sourceNameOf(column, columns));
          return <ColumnKindIcon kind={b.kind} title={b.title} />;
        })()}
        {/* The column's name, because "Cell details" answers a question nobody asked. With five JSON
            columns on a sheet, which one you are looking inside is the whole orientation. */}
        <h2 className="cc-cs__title truncate">
          {column?.name ?? "Cell details"}
          <span className="cc-cs__subtitle">Cell details</span>
        </h2>
        <span className={`cc-pill cc-pill--${status === "error" ? "error" : status === "done" ? "done" : "idle"}`}>
          {statusWord(column?.kind ?? "static", status)}
        </span>
        <button className="hk-icon-btn" onClick={onClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>

      {tree && (
        <div className="cc-cs__search">
          <span className="cc-search__icon" aria-hidden><IconSearch /></span>
          <input
            value={query}
            placeholder="Search fields and values"
            aria-label="Search this cell"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      <div className="cc-cs__body">
        {loading ? (
          <div className="cc-cs__skel">
            {[0, 1, 2, 3].map((i) => <span key={i} className="cc-skel" style={{ width: `${45 + i * 12}%` }} />)}
          </div>
        ) : (
          <>
            {/* The failure, in that order: what it means, then what the provider actually said.
                Not the raw message followed by the bare class as a muted mono token —
                "· schema" — which means nothing to the person this panel exists for, and left the
                whole box saying what happened and nothing about what to do. The class is kept as the
                title, for anyone who wants the machine word. */}
            {(detail?.errorMsg || status === "error") && (
              <div className="cc-cs__error" role="alert">
                {facts.cause && (
                  <strong className="cc-cs__errcause" title={detail?.errorType ? `Failure class: ${detail.errorType}` : undefined}>
                    {facts.cause}
                  </strong>
                )}
                {detail?.errorMsg && <span className="cc-cs__errraw">{detail.errorMsg}</span>}
              </div>
            )}
            {error && <div className="cc-cs__error" role="alert">{error}</div>}

            {detail && (detail.stale || detail.pinned) && (
              <div className="cc-cs__flags">
                {/* A derived cell that has been overridden gets its OWN sentence. "An upstream column
                    changed after this ran" is true of the generic case and useless here — the useful
                    fact is that your typed value and the answer it is supposed to be a projection of
                    no longer agree, which is a thing you can act on. */}
                {detail.stale && (
                  <span className="cc-cs__flag">
                    {detail.pinned && derivedOf
                      ? `Your value no longer matches what "${derivedOf}" produces`
                      : "Stale — an upstream column changed after this ran"}
                  </span>
                )}
                {detail.pinned && (
                  <span className="cc-cs__flag">
                    {column?.editable === false
                      ? "Overridden by you — a run will not replace it"
                      : "Edited by you — a run will not overwrite it"}
                  </span>
                )}
                {/* The way back, offered exactly where the divergence is reported. Without it the
                    warning shown when overriding — "you can put it back at any time" — would be a
                    promise with nothing behind it. */}
                {detail.pinned && column?.editable === false && (
                  <button
                    className="cc-btn cc-btn--ghost cc-btn--xs cc-cs__restore"
                    disabled={busy === "restore"}
                    onClick={() => void restore()}
                  >
                    {busy === "restore"
                      ? "Restoring…"
                      : derivedOf ? `Restore from "${derivedOf}"` : "Give this cell back to the column"}
                  </button>
                )}
              </div>
            )}

            {shown ? (
              shown.length === 0 ? (
                <p className="cc-cs__none">Nothing here matches “{query}”.</p>
              ) : (
                <JsonTree
                  nodes={shown}
                  expandAll={!!query.trim()}
                  leafAction={(n) => {
                    // A field inside a list used to offer nothing, with no reason given. It could
                    // not be `contacts.0.email` — index 0 is a different person on every row — but
                    // it can be `contacts.*.email`, which is the same question on every row and
                    // therefore a perfectly good column. So the action is offered, and its label
                    // says which of the two it is.
                    const path = n.inArray ? starPath(n.path) : n.path;
                    return (
                      <button
                        className="cc-btn cc-btn--ghost cc-btn--xs"
                        disabled={!!busy}
                        title={n.inArray ? "Takes this field from every item in the list, into one column" : undefined}
                        onClick={(e) => setMenu({
                          node: { ...n, path, label: n.inArray ? `Every ${n.label.toLowerCase()}` : n.label },
                          rect: (e.currentTarget as HTMLElement).getBoundingClientRect(),
                          mode: "leaf",
                        })}
                      >
                        {done.has(`leaf:${path}`) ? "Added" : n.inArray ? "Add from every item" : "Add to column"}
                      </button>
                    );
                  }}
                  objectAction={(n) => {
                    // An object row used to render nothing at all, with nothing said about why —
                    // and a control withheld on purpose looks exactly like one that was forgotten.
                    const offer = objectOffer(n as never);
                    if (offer.reason) {
                      // Stated, not greyed out. `contacts.0` genuinely cannot be a column, and the
                      // sentence points at the one that can: the field inside, taken from every item.
                      return <span className="cc-cs__nowhy" title={offer.reason}>{offer.reason}</span>;
                    }
                    const key = `obj:${n.path}`;
                    return (
                      <button
                        className="cc-btn cc-btn--ghost cc-btn--xs"
                        disabled={!!busy}
                        title={offer.fields.map((f) => f.name).join(", ")}
                        onClick={() => void post(
                          `/api/columns/${columnId}/expand`,
                          { fields: offer.fields },
                          key,
                        )}
                      >
                        {done.has(key) ? "Added" : busy === key ? "Adding…" : addAllLabel(offer.fields.length)}
                      </button>
                    );
                  }}
                  listAction={(n) => {
                    const path = n.inArray ? starPath(n.path) : n.path;
                    return (
                      <button
                        className="cc-btn cc-btn--ghost cc-btn--xs"
                        disabled={!!busy}
                        onClick={(e) => setMenu({
                          node: { ...n, path },
                          rect: (e.currentTarget as HTMLElement).getBoundingClientRect(),
                          mode: "list",
                        })}
                      >
                        Use this list
                      </button>
                    );
                  }}
                />
              )
            ) : (
              detail?.valueText != null && detail.valueText !== "" && (
                <pre className="cc-cs__raw mono">{detail.valueText}</pre>
              )
            )}

            {/* ── what this is, and why it looks like this ─────────────────────
                The panel used to end here, with three optional rows that were
                all absent on the cells people actually click: a never-run one,
                a skipped one, a static one. Those show something now. */}
            <section className="cc-cs__explain">
              <p className="cc-cs__what">{facts.what}</p>
              {facts.why && <p className="cc-cs__why">{facts.why}</p>}
            </section>

            {last && (
              <dl className="cc-cs__meta">
                {last.model && <Row k="Model" v={last.model} />}
                {took && <Row k="Took" v={took} />}
                {/* "free" is only shown for a lane that genuinely bills nothing. An unknown price
                    shows no row at all rather than a zero, which would read as free. */}
                {cost && <Row k="Cost" v={cost} />}
                {ran && <Row k="Ran" v={ran} />}
                {/* The shape of the bill. An agent that answers in one turn and one that grinds to
                    eight cost wildly different amounts for the same cell, and nothing else on this
                    panel distinguishes them — the cost line shows the total, not why it is that. */}
                {typeof last.num_turns === "number" && last.num_turns > 0 && (
                  <Row k="Turns" v={String(last.num_turns)} />
                )}
              </dl>
            )}

            {/* How sure it was, and where it looked.
                Both have been required of the model and discarded on arrival since the first row this
                app ever ran. "It answered, and it was not sure" is a different cell from "it
                answered" — it is the one to check by hand — and a cell that names its source is the
                difference between a value you can defend and one you can only hope about. */}
            {(detail?.confidence || detail?.sourceUrl) && (
              <dl className="cc-cs__meta">
                {detail.confidence && (
                  <div className="cc-cs__row">
                    <dt>How sure</dt>
                    <dd>
                      <span className={`cc-conf cc-conf--${detail.confidence}`}>
                        {detail.confidence === "high"
                          ? "Sure"
                          : detail.confidence === "medium"
                            ? "Fairly sure"
                            : "Not sure — worth checking"}
                      </span>
                    </dd>
                  </div>
                )}
                {detail.sourceUrl && (
                  <div className="cc-cs__row">
                    <dt>From</dt>
                    <dd className="truncate">
                      {/* New tab, and rel-guarded: this URL came back from a model, which makes it
                          the least trusted link in the product. */}
                      <a href={detail.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">
                        {detail.sourceUrl}
                      </a>
                    </dd>
                  </div>
                )}
              </dl>
            )}

            {/* The attempts, one line each — fetched since this panel was built and never shown.
                "Tries" is every attempt, not a single summary row: a summary is the wrong shape for
                this: "rate_limit twice, then schema" is a column being throttled and then answering
                badly, "schema three times" is a column that is simply wrong, and both rendered as
                the identical sentence "Succeeded after 3 tries". So the summary stays as the label
                and the sequence is one click behind it. */}
            {attempts.length > 1 && (
              <div className="cc-cs__tries">
                <button
                  className="cc-btn cc-btn--ghost cc-btn--xs"
                  aria-expanded={showTries}
                  onClick={() => setShowTries((v) => !v)}
                >
                  {retries ?? `${attempts.length} tries`}
                </button>
                {showTries && (
                  <ol className="cc-cs__trylist">
                    {attempts.map((a) => (
                      <li key={a.id} className={`cc-cs__try${a.status === "error" ? " cc-cs__try--bad" : ""}`}>
                        <span className="cc-cs__tryn mono">#{a.attempt}</span>
                        <span className="cc-cs__tryw truncate">
                          {statusWord(column?.kind ?? "static", a.status)}
                        </span>
                        {/* The machine word, because comparing attempts is exactly what the classes
                            are for. The sentence version is on hover — the box above already spells
                            out the one that matters, the last one. */}
                        {a.error_type && (
                          <span
                            className="cc-cs__trycls mono"
                            title={errorFacts(a.error_type as never, column?.kind ?? "static").cause}
                          >
                            {a.error_type}
                          </span>
                        )}
                        {a.finished_at && (
                          <time className="cc-cs__tryat" dateTime={a.finished_at}>
                            {new Date(a.finished_at).toLocaleTimeString()}
                          </time>
                        )}
                        {a.error_msg && <span className="cc-cs__trymsg">{a.error_msg}</span>}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}

            {/* The way out, for the failures a re-run cannot fix but a change to the column can.
                Without this the footer's only offer on a wrong-shaped answer was "Re-run anyway",
                labelled with the reason it would not work — a dead end on the page somebody came to
                for a way forward. It sits in the BODY rather than the footer because it grows: a
                diagnosis, then a before/after, then one row to try it on. */}
            {status === "error" && facts.rerunHelps === false && facts.aiCanHelp && columnId && open && (
              <CellFix
                cellId={open.cellId}
                columnId={columnId}
                sheetId={column?.sheetId ?? ""}
                rowId={open.cellId.split(":")[0] ?? ""}
                onApplied={onColumnsChanged}
                onRunCell={() => { onRunCell(open.cellId); onClose(); }}
                onEditColumn={onEditColumn ? () => { onEditColumn(); onClose(); } : undefined}
              />
            )}

            {/* The single most useful thing on this panel, and it was being thrown away: the
                instruction as it was ACTUALLY sent, with this row's values already substituted.
                Folded by default because it is long, and no use at all until you want it. */}
            {promptText && (
              <div className="cc-cs__prompt">
                <button
                  className="cc-btn cc-btn--ghost cc-btn--xs"
                  aria-expanded={showPrompt}
                  onClick={() => setShowPrompt((v) => !v)}
                >
                  {showPrompt ? "Hide what was sent" : "Show what was sent"}
                </button>
                {showPrompt && <pre className="cc-cs__raw mono">{promptText}</pre>}
              </div>
            )}
          </>
        )}
      </div>

      {/*
        The footer used to offer ONE action, always: "Re-run this cell". On a rejected key, a hit
        spending cap or a wrong-shaped answer that is the single action the engine has already
        refused — so the button did nothing but cost a wait, and on a paid lane a bill, and it did it
        from the one screen that exists to explain the failure.

        So it branches. A re-run stays primary where a re-run could genuinely differ; where it could
        not, it is demoted and says why, and the thing that WOULD help takes its place — a link to
        the settings that hold the key or the cap. A disabled button with no alternative would be
        worse than a wrong one: it is a dead end on the page someone came to for a way out.
      */}
      <footer className="cc-cs__foot">
        {status === "error" && facts.rerunHelps === false ? (
          <>
            {facts.fixWhere === "settings_keys" && (
              <button className="cc-btn cc-btn--xs cc-btn--primary" onClick={() => { onOpenSettings?.("providers"); onClose(); }}>
                Open provider settings
              </button>
            )}
            {facts.fixWhere === "settings_budget" && (
              <button className="cc-btn cc-btn--xs cc-btn--primary" onClick={() => { onEditColumn?.(); onClose(); }}>
                Open this column's limits
              </button>
            )}
            <button
              className="cc-btn cc-btn--xs cc-btn--ghost"
              disabled={!canRun}
              title="This one fails the same way every time — the engine has already used every retry it was going to."
              onClick={() => { onRunCell(open.cellId); onClose(); }}
            >
              <IconPlay /> <span>Re-run anyway</span>
            </button>
          </>
        ) : (
          <button
            className="cc-btn cc-btn--xs"
            disabled={!canRun}
            onClick={() => { onRunCell(open.cellId); onClose(); }}
          >
            <IconPlay /> <span>{status === "empty" ? "Run this cell" : "Re-run this cell"}</span>
          </button>
        )}

        {/* Available on any locked cell whatever its status — the reason to write over a computed
            value is just as often "this answer is wrong" as "this one failed". */}
        {column?.editable === false && onOverride && (
          <button
            className="cc-btn cc-btn--xs cc-btn--ghost"
            onClick={() => { onOverride(detail?.valueText ?? ""); onClose(); }}
          >
            Override this value
          </button>
        )}
      </footer>

      {/* Rendered from the LAST menu, not from the live one, and told whether it is open.
          Unmounting it on dismiss took the Popover's leaving state with it, so the exit animation
          the shared component implements could never play here. The key resets the name field when
          a different field's menu opens. */}
      {shownMenu && columnId && (
        <ActionMenu
          key={`${shownMenu.mode}:${shownMenu.node.path}`}
          open={!!menu}
          node={shownMenu.node}
          rect={shownMenu.rect}
          mode={shownMenu.mode}
          columns={columns}
          sourceColumnId={columnId}
          busy={busy}
          onClose={() => setMenu(null)}
          onCreate={async (name) => {
            const ok = await post(`/api/columns/${columnId}/expand`, { fields: [{ path: shownMenu.node.path, name }] }, `leaf:${shownMenu.node.path}`);
            if (ok) setMenu(null);
          }}
          onMap={async (targetColumnId) => {
            const ok = await post(`/api/columns/${columnId}/map-field`, { path: shownMenu.node.path, targetColumnId: Number(targetColumnId) }, `leaf:${shownMenu.node.path}`);
            if (ok) setMenu(null);
          }}
          onExpandList={() => { onExpandList(columnId, shownMenu.node.path); setMenu(null); onClose(); }}
          onJoin={async () => {
            const ok = await post(`/api/columns/${columnId}/expand`, { fields: [{ path: shownMenu.node.path, name: `${humanise(shownMenu.node.path.split(".").pop() ?? "Items")}` }] }, `list:${shownMenu.node.path}`);
            if (ok) setMenu(null);
          }}
        />
      )}
    </aside>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="cc-cs__row"><dt>{k}</dt><dd className="mono">{v}</dd></div>;
}


// ─────────────────────────────────────────────────────────────── the per-row action menu

interface MenuProps {
  /** Stays mounted through the exit animation, which is what this distinguishes from `node`. */
  open: boolean;
  node: TreeNode;
  rect: DOMRect;
  mode: "leaf" | "list";
  columns: Column[];
  sourceColumnId: string;
  busy: string | null;
  onClose: () => void;
  onCreate: (name: string) => void;
  onMap: (targetColumnId: string) => void;
  onExpandList: () => void;
  onJoin: () => void;
}

function ActionMenu({ open, node, rect, mode, columns, sourceColumnId, busy, onClose, onCreate, onMap, onExpandList, onJoin }: MenuProps) {
  const [name, setName] = useState(() =>
    node.path.includes("*") ? node.label : humanise(node.path.split(".").pop() ?? node.label),
  );
  // Only columns that can actually receive a value. Offering the source column, or one already
  // running a rule, would produce an error after the click rather than before it.
  const mappable = columns.filter((c) => String(c.id) !== sourceColumnId);
  const scalarList = Array.isArray(node.value) && node.value.every((v) => v == null || typeof v !== "object");

  return (
    <Popover open={open} anchor={{ rect }} onClose={onClose} width={300} label={`Actions for ${node.label}`}>
      <div className="cc-act">
        {mode === "leaf" ? (
          <>
            <div className="cc-act__title">Add “{node.label}” as a new column</div>
            <div className="cc-act__new">
              <input
                className="cc-input"
                value={name}
                aria-label="New column name"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onCreate(name.trim()); }}
              />
              <button className="cc-btn cc-btn--primary cc-btn--xs" disabled={!!busy || !name.trim()} onClick={() => onCreate(name.trim())}>
                <IconPlus /> <span>Create</span>
              </button>
            </div>

            <div className="cc-act__or"><span>or fill a column that already exists</span></div>
            <div className="cc-act__list">
              {mappable.length === 0 && <p className="cc-act__none">There is no other column on this table yet.</p>}
              {mappable.map((c) => (
                <button key={c.id} className="cc-act__item" disabled={!!busy} onClick={() => onMap(c.id)}>
                  <span className="cc-act__glyph mono" aria-hidden>T</span>
                  <span className="truncate">{c.name}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="cc-act__title">This list has {node.count} item{node.count === 1 ? "" : "s"}</div>
            <div className="cc-act__list">
              <button className="cc-act__item" onClick={onExpandList}>
                <span className="cc-act__glyph" aria-hidden>≡</span>
                <span>
                  Write each item to a row in another table
                  <span className="cc-act__hint">One row per item, linked back to this one.</span>
                </span>
              </button>
              <button className="cc-act__item" disabled={!!busy} onClick={onJoin}>
                <span className="cc-act__glyph" aria-hidden>▤</span>
                <span>
                  Put them in one column, separated by commas
                  <span className="cc-act__hint">
                    {scalarList
                      ? "Good for a short list you want to read or filter on."
                      : "These items are objects, so this column will hold their raw text. Writing them to rows is almost certainly what you want."}
                  </span>
                </span>
              </button>
            </div>
          </>
        )}
      </div>
    </Popover>
  );
}
