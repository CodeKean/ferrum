// Where a `send` column writes to — the Destination tab.
//
// This was a modal: pick a table, press Send, done. That shape was wrong for the job. Sending rows
// somewhere is not a one-off command, it is a thing a column DOES — it belongs in the dependency
// graph, it should be re-runnable, and above all it should be gateable by a run condition, so
// "send the qualified leads to the CRM table" is a setting rather than a filter you have to remember
// to apply by hand every time. As a mode it inherits all of that from the machinery every other
// column already uses.
//
// Three rules shape it, unchanged from the modal, because they were the right rules:
//
//   PLAN BEFORE WRITE. This is the only mode that creates data somewhere you are not looking. A
//   mistake does not show up as a wrong cell; it shows up as ten thousand rows in another table. So
//   Preview runs the identical resolution the run uses.
//
//   MATCHING IS THE DIFFERENCE BETWEEN A TOOL AND A MESS. Without a match key, running twice writes
//   everything twice.
//
//   NOTHING IS CREATED BEHIND YOUR BACK. Columns that do not exist over there are listed and made on
//   a button, never as a silent side effect of ticking a checkbox.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Select } from "../ui/Select.tsx";
import { Section } from "../ui/Section.tsx";
import { IconPlay, IconPlus } from "../ui/Icon.tsx";
import { RefField } from "./RefField.tsx";
import { findRefs, fromDisplay, refText } from "./refs.ts";
import type { RefOption } from "./RefMenu.tsx";
import { api, type Column, type Sheet } from "../api.ts";
import "./SendSettings.css";

export type FieldSource = { from: "item"; path: string } | { from: "row"; columnId: number };

export interface SendConfig {
  targetSheetId: string;
  method: "row" | "per_item";
  listColumnId?: number;
  listPath?: string;
  mapping: Record<string, FieldSource>;
  keySource?: FieldSource;
  onConflict: "upsert" | "insert" | "skip";
  withBackRef: boolean;
  cap: number;
}

/**
 * Mirrors DEFAULT_SEND in src/writeTarget.ts, and the value that matters is `onConflict`.
 *
 * It said "upsert" here while the server's honest default is "insert", and because every change
 * posts the whole config, that word was written into the stored configuration of every send column.
 * With no match key there is nothing to compare a row against, so every policy inserts — the config
 * claimed an idempotency it could not deliver, the Advanced summary read "update", and the
 * destination grew by the full row count on every run. A default has to describe what actually
 * happens; "upsert" becomes true the moment a match key is picked, which is where it is now set.
 */
export const DEFAULT_SEND: SendConfig = {
  targetSheetId: "",
  method: "row",
  mapping: {},
  onConflict: "insert",
  withBackRef: true,
  cap: 50,
};

interface Field { path: string; valueType: string; coverage: number; sample: string | null }

interface Plan {
  inserts: number;
  updates: number;
  skips: number;
  sampledRows?: number;
  sheetRows?: number;
  preview: Array<{ action: string; key: string | null; values: Record<string, string | null> }>;
  errors: string[];
  /**
   * Things this write will really do that were probably not meant — a keyless config that adds
   * every row again on every run, or rows whose match key is blank.
   *
   * The server has always returned these (`WritePlan.warnings`) and this screen did not read them,
   * so the one thing a dry run exists to say was the one thing it could not say. Distinct from
   * `errors`: an error refuses the whole send, a warning describes what a working config will do.
   */
  warnings?: string[];
}

interface Props {
  column: Column;
  /** This table's columns — what can be sent, and where a value can come from. */
  columns: Column[];
  refOptions: RefOption[];
  sheets: Sheet[];
  value: SendConfig;
  onChange: (next: SendConfig) => void;
  busy?: boolean;
  error?: string | null;
}

/** Names match case- and punctuation-insensitively: "Work email" and "work_email" are one column. */
const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, " ");

export function SendSettings({ column, columns, refOptions, sheets, value, onChange, busy, error }: Props) {
  const cfg = { ...DEFAULT_SEND, ...value };
  const set = (patch: Partial<SendConfig>) => onChange({ ...cfg, ...patch });

  const [fields, setFields] = useState<Field[] | null>(null);
  const [targetColumns, setTargetColumns] = useState<Column[]>([]);
  /**
   * Whether the destination's columns have actually been read for the CURRENT destination.
   *
   * The mapping write-back below is derived from them, so running it before they land computes an
   * empty mapping and saves it over the real one — silently unmapping every column. False on a
   * failed read too: a mapping must never be rewritten from an answer we did not get.
   */
  const [targetLoaded, setTargetLoaded] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [working, setWorking] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  /**
   * Which columns are being sent, held as a tick set derived from the saved mapping.
   *
   * Local, because the mapping it produces depends on the destination's columns, and those arrive
   * asynchronously — deriving the ticks straight from the mapping would make every column silently
   * untick itself for a moment each time the destination reloaded.
   */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());
  const [seeded, setSeeded] = useState(false);

  // Sending a table into itself would append rows to the table being read: at best it doubles it,
  // at worst it never terminates. The engine refuses it too; not offering it is the better way to
  // say so.
  const targets = sheets.filter((s) => s.id !== column.sheetId);

  const listRef = useMemo(() => {
    const c = columns.find((x) => Number(x.id) === Number(cfg.listColumnId));
    return c ? fromDisplay(refText(c), columns) : "";
  }, [cfg.listColumnId, columns]);

  /** Where the lists are inside the chosen column. Null until asked, empty when there are none. */
  const [listPaths, setListPaths] = useState<Array<{ path: string; label: string; rows: number; items: number; objects: boolean }> | null>(null);

  useEffect(() => {
    if (cfg.method !== "per_item" || !cfg.listColumnId) { setListPaths(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/columns/${cfg.listColumnId}/list-paths`).then((r) => r.json());
        if (cancelled) return;
        const paths = res.paths ?? [];
        setListPaths(paths);
        // Default to the best candidate rather than leaving it unset, because unset means "the whole
        // cell" and on a column whose list is nested that is the one value guaranteed to be wrong.
        if (paths.length > 0 && cfg.listPath === undefined && paths[0].path !== "") {
          set({ listPath: paths[0].path });
        }
      } catch {
        // The picker just does not appear; the whole-cell default still works for a plain list column.
        if (!cancelled) setListPaths(null);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.method, cfg.listColumnId]);

  const listCandidates = useMemo(
    () => columns.filter((c) => c.valueType === "json" || c.valueType === "array"),
    [columns],
  );

  const invalidate = () => setPlan(null);

  // ── what is inside the list ───────────────────────────────────
  useEffect(() => {
    if (cfg.method !== "per_item" || !cfg.listColumnId) { setFields(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const q = cfg.listPath ? `&path=${encodeURIComponent(cfg.listPath)}` : "";
        const res = await fetch(`/api/columns/${cfg.listColumnId}/list-fields?cap=${cfg.cap}${q}`).then((r) => r.json());
        if (cancelled) return;
        setFields(res.fields ?? []);
      } catch {
        if (!cancelled) { setLocalError("Could not read that column's values."); setFields([]); }
      }
    })();
    return () => { cancelled = true; };
  }, [cfg.method, cfg.listColumnId, cfg.listPath, cfg.cap]);

  // ── what is over there ────────────────────────────────────────
  const loadTarget = useCallback(async (id: string) => {
    const { columns: cols } = await api.getSheet(id);
    setTargetColumns(cols);
    setTargetLoaded(true);
    return cols;
  }, []);

  useEffect(() => {
    setTargetLoaded(false);
    if (!cfg.targetSheetId) { setTargetColumns([]); return; }
    let cancelled = false;
    void (async () => {
      try { if (!cancelled) await loadTarget(cfg.targetSheetId); }
      catch { if (!cancelled) setLocalError("Could not load that table's columns."); }
    })();
    return () => { cancelled = true; };
  }, [cfg.targetSheetId, loadTarget]);

  /**
   * Seed the ticks from what is already saved, ONCE.
   *
   * It used to wait for the destination's columns, and on a fresh send column there are none — so
   * nothing was ever ticked, `sending` stayed empty, and "New table… — one column per thing you
   * send" made an EMPTY table: `createTable` loops over `sending` to add the columns and had
   * nothing to loop over. The other half of the same bug: picking an existing destination let the
   * seed finally run and tick every column, overwriting a selection the user had already made.
   *
   * The mapping is keyed by TARGET column id but its values are all source-side, so this never
   * needed the destination at all. What does need it is the write-back below, which is gated on
   * `targetLoaded` instead.
   */
  useEffect(() => {
    if (seeded) return;
    const cols = new Set<string>();
    const paths = new Set<string>();
    for (const src of Object.values(cfg.mapping ?? {})) {
      if (src.from === "row") cols.add(String(src.columnId));
      else paths.add(src.path);
    }
    if (cols.size === 0 && paths.size === 0) {
      setSelected(new Set(columns.map((c) => c.id)));
    } else {
      setSelected(cols);
      setSelectedFields(paths);
    }
    setSeeded(true);
  }, [seeded, cfg.mapping, columns]);

  const byTargetName = useMemo(
    () => new Map(targetColumns.map((c) => [norm(c.name), c])),
    [targetColumns],
  );

  interface Send { key: string; label: string; source: FieldSource; target: Column | null }

  /**
   * What each ticked thing is called over there, and whether it already exists.
   *
   * Derived rather than stored. A stored pairing goes stale the moment a column is created or
   * renamed on either side, and the failure mode is silent: values land in the wrong column.
   */
  const sending: Send[] = useMemo(() => {
    const out: Send[] = [];
    if (cfg.method === "per_item") {
      for (const f of fields ?? []) {
        if (!selectedFields.has(f.path)) continue;
        const leaf = f.path.split(".").pop() ?? f.path;
        out.push({ key: `item:${f.path}`, label: f.path, source: { from: "item", path: f.path }, target: byTargetName.get(norm(leaf)) ?? null });
      }
    }
    for (const c of columns) {
      if (!selected.has(c.id)) continue;
      if (cfg.method === "per_item" && Number(c.id) === Number(cfg.listColumnId)) continue;
      // The send column itself holds the result of the send. Sending it would write "sent" into the
      // destination as though it were data.
      if (c.id === column.id) continue;
      out.push({ key: `row:${c.id}`, label: c.name, source: { from: "row", columnId: Number(c.id) }, target: byTargetName.get(norm(c.name)) ?? null });
    }
    return out;
  }, [cfg.method, cfg.listColumnId, fields, selectedFields, columns, selected, byTargetName, column.id]);

  const matched = sending.filter((s) => s.target);
  const missing = sending.filter((s) => !s.target);

  // The mapping is what gets SAVED, and it is a pure function of the ticks and the destination's
  // columns — so it is written back whenever either changes rather than maintained by hand.
  const mappingKey = JSON.stringify(matched.map((s) => [s.target!.id, s.source]));
  useEffect(() => {
    // Never write a mapping derived from a destination we have not read. Before `targetLoaded`
    // existed, the ticks could not be seeded until the destination arrived — which was the guard,
    // and which cost the "New table…" path entirely.
    if (!seeded || !targetLoaded) return;
    const next: Record<string, FieldSource> = {};
    for (const s of matched) next[String(s.target!.id)] = s.source;
    if (JSON.stringify(next) === JSON.stringify(cfg.mapping)) return;
    onChange({ ...cfg, mapping: next });
    setPlan(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mappingKey, seeded, targetLoaded]);

  const createMissing = async () => {
    if (!cfg.targetSheetId) return;
    setWorking(true);
    try {
      for (const m of missing) {
        const leaf = m.label.split(".").pop() ?? m.label;
        await api.addColumn(cfg.targetSheetId, leaf.replace(/[_-]+/g, " "), "static");
      }
      await loadTarget(cfg.targetSheetId);
      invalidate();
    } catch {
      setLocalError("Could not create the columns over there.");
    } finally {
      setWorking(false);
    }
  };

  const createTable = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setLocalError(null);
    try {
      // Into the same workbook as the table sending to it. Left out, the engine files a new table
      // under a BRAND NEW workbook of its own — see the note on api.createSheet — so the
      // destination this column writes into would not appear in the tab bar it was created from.
      const workbookId = sheets.find((s) => s.id === column.sheetId)?.workbookId ?? null;
      const { sheet: made } = await api.createSheet(newName.trim(), workbookId);
      for (const s of sending) {
        const leaf = s.label.split(".").pop() ?? s.label;
        await api.addColumn(made.id, leaf.replace(/[_-]+/g, " "), "static");
      }
      await loadTarget(made.id);
      set({ targetSheetId: made.id });
      setNewName("");
    } catch {
      setLocalError("Could not create the table.");
    } finally {
      setCreating(false);
    }
  };

  const runPreview = async () => {
    setWorking(true);
    setLocalError(null);
    try {
      const res = await fetch(`/api/columns/${column.id}/send/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 200 }),
      }).then((r) => r.json());
      if (res.error) { setLocalError(res.error); return; }
      setPlan(res);
    } catch {
      setLocalError("Could not work out what this would write.");
    } finally {
      setWorking(false);
    }
  };

  /** A sensible default key: an email-ish or domain-ish thing, which is what people match on. */
  useEffect(() => {
    // Not before a destination is picked. The ticks now seed on mount rather than waiting for the
    // destination's columns, and without this the drawer would save a configuration — and log an
    // undo entry — the moment the tab was opened, on a column nobody had touched yet.
    if (!cfg.targetSheetId) return;
    if (cfg.keySource || sending.length === 0 || !seeded) return;
    const guess = sending.find((s) => /e-?mail|domain|website|url|\bid\b/i.test(s.label));
    // Same pairing as the picker below: a key without "upsert" re-adds every matching row on every
    // run, which is the exact thing having a key is for.
    if (guess) set({ keySource: guess.source, onConflict: "upsert" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sending.length, seeded, cfg.targetSheetId]);

  const keyValue = cfg.keySource
    ? cfg.keySource.from === "row" ? `row:${cfg.keySource.columnId}` : `item:${cfg.keySource.path}`
    : "";

  const tick = (on: boolean, label: string, hint: string | null, toggle: () => void, key: string) => (
    <label key={key} className="cc-sd__tick">
      <input type="checkbox" checked={on} disabled={busy} onChange={() => { toggle(); invalidate(); }} />
      <span className="cc-sd__tickname truncate" title={label}>{label}</span>
      {hint && <span className="cc-sd__tickhint truncate">{hint}</span>}
    </label>
  );

  const tickable = columns.filter((c) => c.id !== column.id && (cfg.method !== "per_item" || Number(c.id) !== Number(cfg.listColumnId)));
  const totalTickable = (cfg.method === "per_item" ? (fields ?? []).length : 0) + tickable.length;

  return (
    <div className="cc-sd">
      {(error || localError) && (
        <div className="cc-errors" role="alert"><div className="cc-errors__row">{error ?? localError}</div></div>
      )}

      <div className="cc-field">
        <span className="cc-field__label">Destination</span>
        <Select
          label="Destination table"
          value={cfg.targetSheetId}
          options={[
            { value: "", label: "Pick a table…" },
            { value: "__new__", label: "New table…", hint: "one column per thing you send" },
            ...targets.map((s) => ({ value: s.id, label: `${s.name} (${s.rowCount.toLocaleString()} rows)` })),
          ]}
          size="md"
          showLabel={false}
          onChange={(v) => {
            invalidate();
            if (v === "__new__") { setNewName(column.name.replace(/\bsend\b/i, "").trim() || "Sent rows"); return; }
            set({ targetSheetId: v });
          }}
        />
        <span className="cc-field__hint">Rows are added to that table. This table is not changed.</span>
      </div>

      {!cfg.targetSheetId && newName !== "" && (
        <label className="cc-field">
          <span className="cc-field__label">Call it</span>
          <div className="cc-sd__newrow">
            <input
              className="cc-input"
              value={newName}
              placeholder="Contacts"
              aria-label="New table name"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) void createTable(); }}
            />
            <button className="cc-btn cc-btn--primary" disabled={creating || !newName.trim()} onClick={() => void createTable()}>
              {creating ? "Creating…" : "Create it"}
            </button>
          </div>
          <span className="cc-field__hint">
            Made now, with a column for each thing ticked below. Nothing is written into it until the
            column runs.
          </span>
        </label>
      )}

      {/* ── method ── */}
      <fieldset className="cc-sd__method">
        <legend className="cc-field__label">Method</legend>
        <label className="cc-sd__radio">
          <input
            type="radio"
            name={`cc-sd-method-${column.id}`}
            checked={cfg.method === "row"}
            disabled={busy}
            onChange={() => { set({ method: "row" }); invalidate(); }}
          />
          <span>
            Send the row
            <span className="cc-sd__radiohint">One row over there for each row here.</span>
          </span>
        </label>
        <label className="cc-sd__radio">
          <input
            type="radio"
            name={`cc-sd-method-${column.id}`}
            checked={cfg.method === "per_item"}
            disabled={busy || listCandidates.length === 0}
            onChange={() => {
              set({ method: "per_item", listColumnId: cfg.listColumnId ?? Number(listCandidates[0]?.id) });
              invalidate();
            }}
          />
          <span>
            Send a row for each item in a list
            <span className="cc-sd__radiohint">
              {listCandidates.length === 0
                ? "No column here holds a list, so there is nothing to explode."
                : "A row holding five contacts becomes five rows, each knowing which row it came from."}
            </span>
          </span>
        </label>

        {cfg.method === "per_item" && listCandidates.length > 0 && (
          <div className="cc-sd__listpick">
            <RefField
              className="cc-input cc-sd__listref"
              value={listRef}
              columns={columns}
              options={refOptions}
              disabled={busy}
              ariaLabel="The list to explode"
              placeholder="Type / to insert the column holding the list"
              onChange={(v) => {
                const found = findRefs(v, columns)[0];
                const id = found?.columnId
                  ?? columns.find((c) => c.name.trim().toLowerCase() === (found?.name ?? "").trim().toLowerCase())?.id;
                set({ listColumnId: id ? Number(id) : undefined });
                invalidate();
              }}
            />
            <span className="cc-field__hint">
              {cfg.listColumnId
                ? "Each item in that column becomes its own row over there."
                : "Point at the column holding the list — type / and pick it."}
            </span>

            {/* WHERE in that column the list is.
                The writer has read `listPath` since fan-out shipped and nothing could set it, so a
                column holding {company, contacts:[…]} could only be pointed at whole — and a whole
                object is not a list, so the fan-out wrote one row containing it and looked broken.
                Discovered rather than typed: asking for a JSON path from memory means asking someone
                to already know the shape of a payload they are on this screen because they have not
                seen. Shown only when there is a real choice; one candidate is not a decision. */}
            {cfg.listColumnId && listPaths && listPaths.length > 1 && (
              <label className="cc-field cc-sd__listpath">
                <span className="cc-field__label">
                  Which list
                  <span className="cc-field__sub">this column holds more than one</span>
                </span>
                <Select
                  label="List"
                  size="sm"
                  value={cfg.listPath ?? ""}
                  options={listPaths.map((p) => ({
                    value: p.path,
                    // The counts are on the option, because "contacts" and "sources" are equally
                    // plausible names and the one present on 48 rows with 300 items is the answer.
                    label: `${p.label} — ${p.rows} ${p.rows === 1 ? "row" : "rows"}, ${p.items} ${p.items === 1 ? "item" : "items"}${p.objects ? "" : " (plain values)"}`,
                  }))}
                  onChange={(path) => { set({ listPath: path || undefined }); invalidate(); }}
                />
              </label>
            )}
          </div>
        )}
      </fieldset>

      {/* ── what gets sent ── */}
      <span className="cc-field__label">
        {cfg.method === "per_item" ? "Send additional info" : "What to send"}
        {cfg.method === "per_item" && <span className="cc-field__sub">optional</span>}
      </span>
      <div className="cc-sd__cols">
        <div className="cc-sd__colshead">
          <label className="cc-sd__all">
            <input
              type="checkbox"
              disabled={busy}
              checked={sending.length > 0 && sending.length >= totalTickable}
              ref={(el) => { if (el) el.indeterminate = sending.length > 0 && sending.length < totalTickable; }}
              onChange={(e) => {
                const on = e.target.checked;
                if (cfg.method === "per_item") setSelectedFields(on ? new Set((fields ?? []).map((f) => f.path)) : new Set());
                setSelected(on ? new Set(tickable.map((c) => c.id)) : new Set());
                invalidate();
              }}
            />
            <span>Selected</span>
          </label>
          <span className="cc-sd__count mono">{sending.length} of {totalTickable}</span>
        </div>

        <div className="cc-sd__ticks">
          {cfg.method === "per_item" &&
            (fields ?? []).map((f) =>
              tick(
                selectedFields.has(f.path),
                f.path,
                f.sample ? String(f.sample).slice(0, 28) : "in the item",
                () => setSelectedFields((s) => {
                  const n = new Set(s);
                  if (n.has(f.path)) n.delete(f.path); else n.add(f.path);
                  return n;
                }),
                `f-${f.path}`,
              ),
            )}
          {tickable.map((c) =>
            tick(
              selected.has(c.id),
              c.name,
              cfg.method === "per_item" ? "from this row" : null,
              () => setSelected((s) => {
                const n = new Set(s);
                if (n.has(c.id)) n.delete(c.id); else n.add(c.id);
                return n;
              }),
              `c-${c.id}`,
            ),
          )}
        </div>
      </div>

      {/* ── where it lands ── */}
      {cfg.targetSheetId && (
        <div className="cc-sd__land">
          <div className="cc-sd__landhead">
            <span>Where it lands</span>
            <span className="cc-sd__count mono">{matched.length} matched</span>
          </div>
          {matched.length > 0 && (
            <ul className="cc-sd__map">
              {matched.map((s) => (
                <li key={s.key} className="cc-sd__maprow">
                  <span className="cc-sd__from truncate" title={s.label}>{s.label}</span>
                  <span className="cc-sd__arrow" aria-hidden>→</span>
                  <span className="cc-sd__to truncate" title={s.target!.name}>{s.target!.name}</span>
                </li>
              ))}
            </ul>
          )}
          {missing.length > 0 && (
            <div className="cc-modal__warn">
              <p>
                {missing.length === 1 ? "One thing has" : `${missing.length} things have`} no column
                over there: <strong>{missing.map((m) => m.label).join(", ")}</strong>. They will be
                left out unless you make room for them.
              </p>
              <button className="cc-btn cc-btn--xs" onClick={() => void createMissing()} disabled={busy || working}>
                <IconPlus /> <span>{missing.length === 1 ? "Column" : `${missing.length} columns`}</span>
              </button>
            </div>
          )}
          {matched.length === 0 && missing.length === 0 && (
            <p className="cc-sd__empty">Tick something above to send.</p>
          )}
        </div>
      )}

      {/* ── matching ── */}
      <div className="cc-field">
        <span className="cc-field__label">Treat two rows as the same when this matches</span>
        <Select
          label="Match on"
          value={keyValue}
          options={[
            { value: "", label: "Nothing — always add a new row" },
            ...sending.map((s) => ({ value: s.key, label: s.label })),
          ]}
          size="md"
          showLabel={false}
          onChange={(v) => {
            const hit = sending.find((s) => s.key === v);
            // The key and the conflict policy are one decision, so they move together. Picking a key
            // and leaving the policy at "insert" would add a second copy of every matching row on
            // every run — under the one configuration the user chose to stop exactly that. Clearing
            // the key puts it back, because with nothing to match on "upsert" is not a true word.
            set({ keySource: hit?.source, onConflict: hit ? "upsert" : "insert" });
            invalidate();
          }}
        />
        <span className="cc-field__hint">
          {cfg.keySource
            ? cfg.onConflict === "upsert"
              ? "Running this again updates the row that already matches instead of adding a second copy."
              : cfg.onConflict === "skip"
                ? "Running this again leaves the row that already matches exactly as it is."
                : "Running this again adds a second copy of every row that already matches."
            : "With nothing to match on, running this twice writes everything twice. Pick something like an email or a domain."}
        </span>
      </div>

      {/* Three policies, three words. "keep" for both "skip" and "insert" hid the difference that
          matters: skip leaves the matching row alone, insert adds a second copy of it. */}
      <Section
        label="Advanced settings"
        summary={`${cfg.onConflict === "upsert" ? "update" : cfg.onConflict === "skip" ? "keep" : "always add"} · ${cfg.withBackRef ? "linked" : "unlinked"}`}
      >
        <label className="cc-sd__check">
          <input
            type="checkbox"
            checked={cfg.onConflict === "upsert"}
            disabled={busy || !cfg.keySource}
            onChange={(e) => { set({ onConflict: e.target.checked ? "upsert" : "skip" }); invalidate(); }}
          />
          <span>
            Update matching rows on a re-run
            <span className="cc-sd__checkhint">
              {cfg.keySource
                ? "Off means a matching row is left alone — new rows still arrive."
                : "Needs something to match on, above."}
            </span>
          </span>
        </label>

        <label className="cc-sd__check">
          <input type="checkbox" checked={cfg.withBackRef} disabled={busy} onChange={(e) => { set({ withBackRef: e.target.checked }); invalidate(); }} />
          <span>
            Record which row each one came from
            <span className="cc-sd__checkhint">
              Adds a column over there pointing back here. Off means the new rows are orphans, and the
              link cannot be worked out again afterwards.
            </span>
          </span>
        </label>

        {cfg.method === "per_item" && (
          <label className="cc-field cc-field--tight">
            <span className="cc-field__label">
              Most rows one list may produce
              <span className="cc-field__sub">one row with a 10,000-item list is a table, not a cell</span>
            </span>
            <input
              className="cc-input cc-input--num"
              type="number"
              min={1}
              max={1000}
              size={6}
              value={cfg.cap}
              disabled={busy}
              onChange={(e) => { set({ cap: Math.max(1, Math.min(1000, Number(e.target.value) || 1)) }); invalidate(); }}
            />
          </label>
        )}
      </Section>

      {/* ── the dry run ── */}
      <div className="cc-sd__foot">
        <span className="cc-sd__meta">
          {plan
            ? `Sampled ${plan.sampledRows?.toLocaleString() ?? 0} of ${plan.sheetRows?.toLocaleString() ?? 0} rows`
            : "Nothing written until this column runs."}
        </span>
        <button
          className="cc-btn cc-btn--xs"
          onClick={() => void runPreview()}
          disabled={busy || working || !cfg.targetSheetId || matched.length === 0}
        >
          <IconPlay /> <span>Preview</span>
        </button>
      </div>

      {plan && (
        <div className="cc-sd__plan">
          <div className="cc-modal__stat"><span className="cc-modal__stat-label">New rows</span><span className="cc-modal__stat-value mono">{plan.inserts.toLocaleString()}</span></div>
          <div className="cc-modal__stat"><span className="cc-modal__stat-label">Updated</span><span className="cc-modal__stat-value mono">{plan.updates.toLocaleString()}</span></div>
          <div className="cc-modal__stat"><span className="cc-modal__stat-label">Skipped</span><span className="cc-modal__stat-value mono">{plan.skips.toLocaleString()}</span></div>

          {plan.errors.length > 0 && (
            <div className="cc-errors" role="alert">{plan.errors.map((e, i) => <div key={i} className="cc-errors__row">{e}</div>)}</div>
          )}

          {/* What this config will really do on the SECOND run. The server works these out and this
              screen used to drop them on the floor, so the dry run — the whole point of which is
              "nothing is created behind your back" — never mentioned that a keyless send adds every
              row again, every time. */}
          {(plan.warnings ?? []).map((w) => (
            <div key={w} className="cc-modal__warn" role="status">{w}</div>
          ))}

          {/* Real resolved values, not a count. A mapping that is subtly wrong — every row getting
              the same name, or a column landing empty — is obvious here and invisible in a summary. */}
          {plan.preview.length > 0 && (
            <div className="cc-sd__previewwrap">
              <table className="cc-sd__preview">
                <thead>
                  <tr>
                    <th>Action</th>
                    {Object.keys(plan.preview[0]!.values).map((name) => <th key={name}>{name}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {plan.preview.slice(0, 5).map((p, i) => (
                    <tr key={i}>
                      <td className="cc-sd__action">{p.action}</td>
                      {Object.values(p.values).map((v, j) => (
                        <td key={j} className="truncate" title={v ?? undefined}>{v ?? "—"}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
