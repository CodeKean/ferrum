// Columns kept to be used again.
//
// Two screens in one file because they are two halves of one idea: keeping a column, and picking a
// kept one. Splitting them would put the same explanation in two places and let the two drift.
//
// ── What this screen has to be honest about ────────────────────────────────────────────────────
//
// A template's references travel as NAMES, so applying one to a table that has no "Website" gives a
// column whose instruction reads perfectly and is about nothing. That is the failure mode of this
// whole feature, and it is invisible unless the screen says so BEFORE the column is created — which
// is why every card is checked against the open table as the gallery loads, and why a template that
// would not fit is labelled rather than hidden.
//
// The other honest note is about scripts: a template can carry code, and the code arrives switched
// off until someone here reads it. The card says so rather than leaving it to be discovered when the
// column refuses to run.

import { useCallback, useEffect, useState } from "react";
import { Modal } from "../ui/Modal.tsx";
import { IconAlert, IconTrash } from "../ui/Icon.tsx";
import type { Column } from "../api.ts";
import "./Templates.css";

export interface ColumnTemplate {
  id: number;
  name: string;
  description: string;
  category: string;
  kind: string;
  valueType: string;
  requires: string[];
  scripts: Array<{ hook: string; runtime: string; intent: string; code: string }>;
  uses: number;
}

const KIND_LABEL: Record<string, string> = {
  ai: "Ask a model",
  agent: "Agent",
  http: "Call an API",
  mcp: "Ask a connected app",
  send: "Send to a table",
  script: "A rule",
  lookup: "Lookup",
  rollup: "Rollup",
  static: "Typed in",
};

// ── keeping one ────────────────────────────────────────────────────────────────────────────────

export function SaveTemplate(
  { column, onClose, onSaved }:
  { column: Column; onClose: () => void; onSaved: (name: string) => void },
) {
  const [name, setName] = useState(column.name);
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/columns/${column.id}/save-template`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim(), category: category.trim() }),
      }).then((x) => x.json());
      if (r.error) { setError(r.error); return; }
      onSaved(r.template.name);
    } catch {
      setError("Could not save that template.");
    } finally { setBusy(false); }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Keep this column as a template"
      width={480}
      footNote="What the column DOES is kept — the instruction, the model, the request. Its values, its history and what it cost are not."
      footer={
        <>
          <button
            className="cc-btn cc-btn--primary"
            onClick={() => void save()}
            disabled={busy || !name.trim()}
            title={name.trim() ? "Keep this column’s setup so another table can start from it." : "Give the template a name first."}
          >
            {busy ? "Keeping…" : "Keep it"}
          </button>
          <button className="cc-btn" onClick={onClose} disabled={busy}>Cancel</button>
        </>
      }
    >
      <div className="cc-tpl__form">
        <div className="cc-field cc-field--tight">
          <span className="cc-field__label">Called</span>
          <input className="cc-input" value={name} disabled={busy} aria-label="Template name" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="cc-field cc-field--tight">
          <span className="cc-field__label">Grouped under</span>
          <input
            className="cc-input"
            value={category}
            placeholder="Enrichment, Scoring, …"
            disabled={busy}
            aria-label="Category"
            onChange={(e) => setCategory(e.target.value)}
          />
        </div>
        <div className="cc-field cc-field--tight cc-tpl__wide">
          <span className="cc-field__label">What it is for</span>
          <textarea
            className="cc-input cc-tpl__area"
            rows={3}
            value={description}
            placeholder="Reads the website and returns the careers page, or blank when there is not one."
            disabled={busy}
            aria-label="What this template is for"
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {/* Said here rather than discovered later. A key typed straight into a header is part of the
            column's definition, so it is part of the template. */}
        <p className="cc-tpl__warn">
          <IconAlert /> Anything typed into this column travels with it, including a key written
          directly into a header. Keep keys in Settings and reference them instead.
        </p>

        {error && <div className="cc-errors" role="alert"><div className="cc-errors__row">{error}</div></div>}
      </div>
    </Modal>
  );
}

// ── picking one ────────────────────────────────────────────────────────────────────────────────

interface Fit { missing: string[]; matched: string[] }

export function TemplateGallery(
  { sheetId, onClose, onApplied }:
  { sheetId: string; onClose: () => void; onApplied: (msg: string) => void },
) {
  const [list, setList] = useState<ColumnTemplate[] | null>(null);
  const [fits, setFits] = useState<Record<number, Fit>>({});
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/column-templates").then((x) => x.json());
      const templates: ColumnTemplate[] = r.templates ?? [];
      setList(templates);
      // Every card is checked against THIS table as the gallery loads, so "would not fit here" is on
      // screen while the choice is still a choice — see the header.
      const out: Record<number, Fit> = {};
      await Promise.all(templates.map(async (t) => {
        try {
          out[t.id] = await fetch(`/api/column-templates/${t.id}/check?sheetId=${encodeURIComponent(sheetId)}`).then((x) => x.json());
        } catch { /* a card with no verdict simply shows none, rather than a wrong one */ }
      }));
      setFits(out);
    } catch {
      setError("Could not read your templates.");
    }
  }, [sheetId]);

  useEffect(() => { void load(); }, [load]);

  const apply = async (t: ColumnTemplate) => {
    setBusy(t.id); setError(null);
    try {
      const r = await fetch(`/api/column-templates/${t.id}/apply`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sheetId }),
      }).then((x) => x.json());
      if (r.error) { setError(r.error); return; }
      const notes: string[] = [];
      if (r.missing?.length) {
        notes.push(
          `This table has no ${r.missing.join(" or ")}, so ${r.missing.length === 1 ? "that reference is" : "those references are"} left unresolved — fix the instruction before running it.`,
        );
      }
      if (r.scriptsPending > 0) {
        notes.push(`${r.scriptsPending} script${r.scriptsPending === 1 ? "" : "s"} came with it and will not run until you read and approve ${r.scriptsPending === 1 ? "it" : "them"}.`);
      }
      onApplied([`Added “${r.column.name}”.`, ...notes].join(" "));
    } catch {
      setError("Could not add that column.");
    } finally { setBusy(null); }
  };

  const remove = async (id: number) => {
    await fetch(`/api/column-templates/${id}`, { method: "DELETE" });
    await load();
  };

  const shown = (list ?? []).filter((t) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return `${t.name} ${t.description} ${t.category}`.toLowerCase().includes(q);
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Your columns"
      width={680}
      footNote="A template keeps what a column does, not what it holds. References travel by column name, so one works on any table with the same columns."
      footer={<button className="cc-btn" onClick={onClose}>Close</button>}
    >
      {list != null && list.length > 3 && (
        <input
          className="cc-input cc-tpl__search"
          value={query}
          placeholder="Search your templates"
          aria-label="Search templates"
          onChange={(e) => setQuery(e.target.value)}
        />
      )}

      {list == null && <div className="cc-tpl__skel" />}

      {list && list.length === 0 && (
        <div className="cc-tpl__empty">
          <p className="cc-tpl__empty__h">You have not kept any columns yet.</p>
          <p className="cc-tpl__empty__p">
            Right-click any column and choose “Keep as a template”. It can then be added to any table
            in one click, with its references pointed at that table's own columns.
          </p>
        </div>
      )}

      {list && list.length > 0 && shown.length === 0 && (
        <div className="cc-tpl__empty">
          <p className="cc-tpl__empty__h">Nothing matches “{query}”.</p>
        </div>
      )}

      {shown.length > 0 && (
        <ul className="cc-tpl__list">
          {shown.map((t) => {
            const fit = fits[t.id];
            const missing = fit?.missing ?? [];
            return (
              <li key={t.id} className="cc-tpl__card">
                <div className="cc-tpl__body">
                  <span className="cc-tpl__name">{t.name}</span>
                  <span className="cc-tpl__meta">
                    {KIND_LABEL[t.kind] ?? t.kind}
                    {t.category ? ` · ${t.category}` : ""}
                    {t.uses > 0 ? ` · used ${t.uses} time${t.uses === 1 ? "" : "s"}` : ""}
                  </span>
                  {/* Reserved whether or not there is a description, so cards in a row stay the
                      same height and adding one cannot shift the ones beside it. */}
                  <span className="cc-tpl__desc">{t.description || " "}</span>
                  <span className={`cc-tpl__fit${missing.length > 0 ? " cc-tpl__fit--bad" : ""}`}>
                    {missing.length > 0
                      ? `Needs ${missing.join(", ")} — this table has ${fit?.matched.length ? "only some of that" : "none of that"}.`
                      : t.requires.length > 0
                        ? `Uses ${t.requires.join(", ")} — all present here.`
                        : t.scripts.length > 0
                          ? "Carries a script, which arrives switched off until you read it."
                          : "Reads nothing from the table, so it fits anywhere."}
                  </span>
                </div>
                <div className="cc-tpl__acts">
                  <button className="cc-btn cc-btn--sm" disabled={busy === t.id} onClick={() => void apply(t)}>
                    {busy === t.id ? "Adding…" : "Add to this table"}
                  </button>
                  <button
                    className="cc-icon-btn"
                    title="Forget this template"
                    aria-label={`Forget ${t.name}`}
                    onClick={() => void remove(t.id)}
                  >
                    <IconTrash />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="cc-tpl__msg" role="status" aria-live="polite">
        {error && <span className="cc-tpl__err"><IconAlert /> {error}</span>}
      </div>
    </Modal>
  );
}
