// Duplicating, templatizing, exporting and importing a workbook — the four dialogs.
//
// They share a file because they share a shape: each one asks a small number of questions, does an
// irreversible-ish thing, and then has something to SAY about what did not come across faithfully.
// That last part is the reason these are dialogs at all rather than menu items that just act.
//
// A copy is never a perfect copy. Scripts arrive unapproved, schedules arrive off, a send column
// whose destination was outside the workbook arrives with no destination. Every one of those is a
// thing the copy will not do that the original did, and every one of them is silent — the copy opens
// and looks complete. So the engine returns `notes`, and this screen is where they are read.

import { useEffect, useRef, useState } from "react";
import { Modal, useModalDismiss } from "../ui/Modal.tsx";
import { IconAlert, IconCheck, IconUpload } from "../ui/Icon.tsx";
import "./CopyDialogs.css";

export interface CopyResult {
  workbook: { id: string; name: string; isTemplate: boolean };
  tables: number;
  columns: number;
  rows: number;
  scriptsPending: number;
  notes: string[];
}

const post = async (url: string, body: unknown): Promise<any> => {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    return res;
  } catch {
    return { error: "Could not reach the engine." };
  }
};

/** The count, with a thousands separator. A six-figure row count read as a wall of digits. */
const n = (x: number) => x.toLocaleString();

// ─────────────────────────────────────────────────────────────── duplicate

/**
 * Duplicate a workbook.
 *
 * The row count is fetched BEFORE the question is asked, so the checkbox can say what it will
 * actually copy. "Bring the rows too" against an unknown number is a question nobody can answer;
 * against "1,000,047 rows" it answers itself.
 */
export function DuplicateWorkbook({ id, name, folderId, onClose, onDone }: {
  id: string;
  name: string;
  folderId: string | null;
  onClose: () => void;
  onDone: (r: CopyResult) => void;
}) {
  const [open, dismiss] = useModalDismiss(onClose);
  const [draft, setDraft] = useState(`${name} (copy)`);
  const [withRows, setWithRows] = useState(false);
  const [size, setSize] = useState<{ rows: number; tables: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void fetch(`/api/workbooks/${id}/copy-size`)
      .then((r) => r.json())
      .then((r) => { if (!r.error) setSize({ rows: Number(r.rows ?? 0), tables: Number(r.tables ?? 0) }); })
      .catch(() => { /* the dialog still works; only the number is missing */ });
  }, [id]);

  // The name is the one thing anyone changes here, and it arrives pre-filled and selected so the
  // common case — type a new name, press Enter — is two actions.
  useEffect(() => {
    const t = setTimeout(() => { field.current?.focus(); field.current?.select(); }, 40);
    return () => clearTimeout(t);
  }, []);

  const go = async () => {
    if (busy) return;
    setBusy(true);
    const res = await post(`/api/workbooks/${id}/duplicate`, { name: draft.trim() || `${name} (copy)`, withRows, folderId });
    setBusy(false);
    if (res.error) { setError(res.error); return; }
    dismiss();
    onDone(res as CopyResult);
  };

  return (
    <Modal
      open={open}
      onClose={dismiss}
      title={`Duplicate “${name}”`}
      width={460}
      footNote={size ? `${n(size.tables)} ${size.tables === 1 ? "table" : "tables"}` : ""}
      footer={
        <>
          <button className="cc-btn" onClick={dismiss} disabled={busy}>Cancel</button>
          <button className="cc-btn cc-btn--primary" onClick={() => void go()} disabled={busy}>
            {busy ? "Copying…" : "Duplicate"}
          </button>
        </>
      }
    >
      <label className="cc-cpy__field">
        <span className="cc-cpy__label">Name</span>
        <input
          ref={field}
          className="cc-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void go(); } }}
        />
      </label>

      <label className="cc-cpy__check">
        <input
          type="checkbox"
          checked={withRows}
          disabled={busy || size?.rows === 0}
          onChange={(e) => setWithRows(e.target.checked)}
        />
        <span>
          Bring the rows too
          <span className="cc-cpy__hint">
            {size == null ? "Counting…"
              : size.rows === 0 ? "There are no rows to bring — this workbook is empty."
              : withRows
                ? `Copies ${n(size.rows)} ${size.rows === 1 ? "row" : "rows"} and everything in them. On a table this size that is a large write, and it runs in one go.`
                : `Off, so you get the same tables and columns with nothing in them. Leave it off unless you want the ${n(size.rows)} ${size.rows === 1 ? "row" : "rows"} as well.`}
          </span>
        </span>
      </label>

      <p className="cc-cpy__note">
        Links between the tables, saved views and prompts all come across pointing at the copy rather
        than at the original. Scripts come across unapproved, and any schedules arrive switched off.
      </p>

      {error && <p className="cc-cpy__error" role="alert">{error}</p>}
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────── save as a template

export function TemplatizeWorkbook({ id, name, onClose, onDone }: {
  id: string;
  name: string;
  onClose: () => void;
  onDone: (r: CopyResult) => void;
}) {
  const [open, dismiss] = useModalDismiss(onClose);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    if (busy) return;
    setBusy(true);
    const res = await post(`/api/workbooks/${id}/templatize`, { name: draft.trim() || name });
    setBusy(false);
    if (res.error) { setError(res.error); return; }
    dismiss();
    onDone(res as CopyResult);
  };

  return (
    <Modal
      open={open}
      onClose={dismiss}
      title="Keep this as a template"
      width={440}
      footer={
        <>
          <button className="cc-btn" onClick={dismiss} disabled={busy}>Cancel</button>
          <button className="cc-btn cc-btn--primary" onClick={() => void go()} disabled={busy}>
            {busy ? "Saving…" : "Save template"}
          </button>
        </>
      }
    >
      <label className="cc-cpy__field">
        <span className="cc-cpy__label">Template name</span>
        <input
          className="cc-input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void go(); } }}
        />
      </label>
      <p className="cc-cpy__note">
        A template holds the tables, columns, prompts and links — never the rows. It sits under
        Templates, and starting a new workbook from it leaves the template itself untouched.
        {" "}Nothing in a template runs on its own.
      </p>
      {error && <p className="cc-cpy__error" role="alert">{error}</p>}
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────── use a template

export function UseTemplate({ id, name, folderId, onClose, onDone }: {
  id: string;
  name: string;
  folderId: string | null;
  onClose: () => void;
  onDone: (r: CopyResult) => void;
}) {
  const [open, dismiss] = useModalDismiss(onClose);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    if (busy) return;
    setBusy(true);
    const res = await post(`/api/templates/${id}/use`, { name: draft.trim() || name, folderId });
    setBusy(false);
    if (res.error) { setError(res.error); return; }
    dismiss();
    onDone(res as CopyResult);
  };

  return (
    <Modal
      open={open}
      onClose={dismiss}
      title={`Start from “${name}”`}
      width={440}
      footer={
        <>
          <button className="cc-btn" onClick={dismiss} disabled={busy}>Cancel</button>
          <button className="cc-btn cc-btn--primary" onClick={() => void go()} disabled={busy}>
            {busy ? "Creating…" : "Create workbook"}
          </button>
        </>
      }
    >
      <label className="cc-cpy__field">
        <span className="cc-cpy__label">Name the new workbook</span>
        <input
          className="cc-input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void go(); } }}
        />
      </label>
      <p className="cc-cpy__note">The template stays where it is. This makes a working copy of it.</p>
      {error && <p className="cc-cpy__error" role="alert">{error}</p>}
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────── import a file

interface Preview {
  name: string;
  description: string | null;
  version: number;
  exportedAt: string | null;
  tables: Array<{ name: string; columns: number }>;
  relations: number;
  columns: number;
  scripts: Array<{ table: string; column: string; hook: string; intent: string; code: string }>;
}

/**
 * Read a file, show what is in it, and only then offer to import it.
 *
 * The preview is not a courtesy. A workbook file can carry SCRIPTS — real code, written on someone
 * else's machine — and the whole point of the approval gate is that code is read before it runs. A
 * dialog that imported first and listed the scripts afterwards would be asking the user to review
 * code that is already installed.
 */
export function ImportWorkbook({ folderId, onClose, onDone }: {
  folderId: string | null;
  onClose: () => void;
  onDone: (r: CopyResult) => void;
}) {
  const [open, dismiss] = useModalDismiss(onClose);
  const [doc, setDoc] = useState<unknown>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [name, setName] = useState("");
  const [showing, setShowing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (file: File) => {
    setError(null);
    setPreview(null);
    setDoc(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setError("That file is not readable as JSON. A Ferrum workbook file ends in .ferrum.json.");
      return;
    }
    const res = await post("/api/workbooks/import/preview", { doc: parsed });
    if (res.error) { setError(res.error); return; }
    setDoc(parsed);
    setPreview(res as Preview);
    setName(String(res.name ?? "Imported workbook"));
  };

  const go = async () => {
    if (busy || !doc) return;
    setBusy(true);
    const res = await post("/api/workbooks/import", { doc, name: name.trim() || undefined, folderId });
    setBusy(false);
    if (res.error) { setError(res.error); return; }
    dismiss();
    onDone(res as CopyResult);
  };

  return (
    <Modal
      open={open}
      onClose={dismiss}
      title="Import a workbook file"
      width={560}
      footNote={preview ? `${preview.tables.length} ${preview.tables.length === 1 ? "table" : "tables"} · ${preview.columns} columns` : ""}
      footer={
        <>
          <button className="cc-btn" onClick={dismiss} disabled={busy}>Cancel</button>
          <button className="cc-btn cc-btn--primary" onClick={() => void go()} disabled={busy || !doc}>
            {busy ? "Importing…" : "Import"}
          </button>
        </>
      }
    >
      <label className="cc-cpy__drop">
        <input
          type="file"
          accept=".json,application/json"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void choose(f); }}
        />
        <span className="cc-cpy__dropicon" aria-hidden><IconUpload size={18} /></span>
        <span className="cc-cpy__droptext">
          {preview ? `${preview.name} — choose a different file` : "Choose a .ferrum.json file"}
        </span>
      </label>

      {error && <p className="cc-cpy__error" role="alert">{error}</p>}

      {preview && (
        <>
          <label className="cc-cpy__field">
            <span className="cc-cpy__label">Name it</span>
            <input className="cc-input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          <ul className="cc-cpy__tables">
            {preview.tables.map((t) => (
              <li key={t.name}>
                <span className="truncate">{t.name}</span>
                <span className="cc-cpy__num">{t.columns} {t.columns === 1 ? "column" : "columns"}</span>
              </li>
            ))}
          </ul>

          {preview.scripts.length > 0 ? (
            <div className="cc-cpy__scripts">
              <p className="cc-cpy__warn">
                <span aria-hidden><IconAlert /></span>
                <span>
                  This file carries {preview.scripts.length} piece{preview.scripts.length === 1 ? "" : "s"} of
                  code written somewhere else. {preview.scripts.length === 1 ? "It arrives" : "They arrive"}
                  {" "}switched off and cannot run until you read {preview.scripts.length === 1 ? "it" : "each one"}
                  {" "}and approve it here. Read {preview.scripts.length === 1 ? "it" : "them"} now.
                </span>
              </p>
              {preview.scripts.map((s, i) => (
                <div key={i} className="cc-cpy__script">
                  <button
                    className="cc-cpy__scriptbtn"
                    aria-expanded={showing === i}
                    onClick={() => setShowing(showing === i ? null : i)}
                  >
                    <span className="truncate">{s.table} · {s.column}</span>
                    <span className="cc-cpy__hook">{s.hook}</span>
                  </button>
                  {showing === i && (
                    <>
                      {s.intent && <p className="cc-cpy__intent">{s.intent}</p>}
                      <pre className="cc-cpy__code">{s.code}</pre>
                    </>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="cc-cpy__note">
              <span aria-hidden><IconCheck /></span> No code in this file — it is tables, columns and prompts only.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────── what did not come across

/**
 * The receipt.
 *
 * Shown after any of the four, because every one of them can silently leave something behind. It is
 * dismissible and says nothing when there is nothing to say beyond the counts — a dialog that
 * appears after every successful action and only ever says "done" trains people to close it unread,
 * which is exactly when it matters that they do not.
 */
export function CopyDone({ result, onClose, onOpen }: {
  result: CopyResult;
  onClose: () => void;
  onOpen?: () => void;
}) {
  const [open, dismiss] = useModalDismiss(onClose);
  return (
    <Modal
      open={open}
      onClose={dismiss}
      title={result.workbook.isTemplate ? "Template saved" : `“${result.workbook.name}” is ready`}
      width={480}
      footNote={
        `${n(result.tables)} ${result.tables === 1 ? "table" : "tables"} · ` +
        `${n(result.columns)} ${result.columns === 1 ? "column" : "columns"}` +
        (result.rows > 0 ? ` · ${n(result.rows)} ${result.rows === 1 ? "row" : "rows"}` : "")
      }
      footer={
        <>
          {onOpen && !result.workbook.isTemplate && (
            <button className="cc-btn" onClick={() => { dismiss(); onOpen(); }}>Open it</button>
          )}
          <button className="cc-btn cc-btn--primary" onClick={dismiss}>Done</button>
        </>
      }
    >
      {result.notes.length === 0 ? (
        <p className="cc-cpy__note">Everything came across.</p>
      ) : (
        <ul className="cc-cpy__notes">
          {result.notes.map((note, i) => (
            <li key={i}><span aria-hidden><IconAlert /></span><span>{note}</span></li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
