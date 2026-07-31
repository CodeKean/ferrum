// Saved keys.
//
// The screen exists to make one habit possible: stop typing keys into columns. So the two things it
// has to communicate are how a key is used once it is here, and what deleting one will break.
//
// ── What this screen deliberately cannot do ────────────────────────────────────────────────────
//
// Show a key back. There is no route that returns one — not even to the screen that set it — so
// "reveal" is not a button that was left out, it is a thing that cannot happen. What is shown is the
// two ends, which is enough to tell two keys apart and not enough to use one. Replacing a key means
// pasting the new one, which is also what rotating it means.

import { useCallback, useEffect, useState } from "react";
import { IconAlert, IconCheck, IconTrash } from "../ui/Icon.tsx";
import "./Keys.css";

export interface SecretInfo {
  name: string;
  category: string;
  note: string;
  masked: string;
  uses: number;
  lastUsedAt: string | null;
  updatedAt: string;
}

interface Usage {
  columnId: number;
  column: string;
  sheetId: string;
  sheet: string;
}

const when = (iso: string | null): string => {
  if (!iso) return "never used";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "used today";
  if (days === 1) return "used yesterday";
  if (days < 30) return `used ${days} days ago`;
  return `used ${Math.round(days / 30)} months ago`;
};

export function Keys() {
  const [list, setList] = useState<SecretInfo[] | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /** The key being deleted, and what still refers to it — asked BEFORE the delete, never after. */
  const [confirming, setConfirming] = useState<{ name: string; used: Usage[] } | null>(null);

  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/secrets").then((x) => x.json());
      if (r.error) { setError(r.error); return; }
      setList(r.secrets ?? []);
      setCategories(r.categories ?? []);
    } catch { setError("Could not read your saved keys."); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setBusy(true); setError(null); setNote(null);
    try {
      const r = await fetch("/api/secrets", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), value: value.trim(), category: category.trim() }),
      }).then((x) => x.json());
      if (r.error) { setError(r.error); return; }
      // Cleared immediately on success, so a key is not left sitting in a field behind a closed
      // panel or in whatever the browser decides to autofill next.
      setName(""); setValue(""); setCategory(""); setAdding(false);
      setNote(`Saved. Use it in a column as {{secret:${r.secret.name}}}.`);
      await load();
    } catch { setError("Could not save that key."); }
    finally { setBusy(false); }
  };

  const askDelete = async (n: string) => {
    setError(null); setNote(null);
    try {
      const r = await fetch(`/api/secrets/${encodeURIComponent(n)}/usage`).then((x) => x.json());
      setConfirming({ name: n, used: r.used ?? [] });
    } catch {
      // Asked anyway, but honestly: better to confirm without the list than to delete without asking.
      setConfirming({ name: n, used: [] });
    }
  };

  const doDelete = async () => {
    if (!confirming) return;
    await fetch(`/api/secrets/${encodeURIComponent(confirming.name)}`, { method: "DELETE" });
    setNote(`"${confirming.name}" removed.`);
    setConfirming(null);
    await load();
  };

  const grouped = new Map<string, SecretInfo[]>();
  for (const s of list ?? []) {
    const k = s.category || "Uncategorised";
    grouped.set(k, [...(grouped.get(k) ?? []), s]);
  }

  return (
    <section className="cc-set__sec">
      <div className="cc-set__head">
        <h2 className="cc-set__title">Keys</h2>
      </div>
      <p className="cc-set__lede">
        A key saved here is written into a column as <code>{"{{secret:Name}}"}</code> rather than
        typed in. The reference is what travels when a column is copied, duplicated or kept as a
        template — the key itself never leaves this machine.
      </p>

      {list == null && <div className="cc-keys__skel" />}

      {list && list.length === 0 && !adding && (
        <div className="cc-keys__empty">
          <p className="cc-keys__empty__h">No keys saved yet.</p>
          <p className="cc-keys__empty__p">
            Anything you type straight into a column's header becomes part of that column — it copies
            with it, and rotating it means finding every column that has it. Saving it here once
            avoids all of that.
          </p>
        </div>
      )}

      {list && list.length > 0 && (
        <div className="cc-keys__groups">
          {[...grouped.entries()].map(([cat, items]) => (
            <div key={cat} className="cc-keys__group">
              <h3 className="cc-keys__cat">{cat}</h3>
              <ul className="cc-keys__list">
                {items.map((s) => (
                  <li key={s.name} className="cc-keys__row">
                    <div className="cc-keys__main">
                      <span className="cc-keys__name">{s.name}</span>
                      <span className="cc-keys__meta">
                        <code className="cc-keys__ref">{`{{secret:${s.name}}}`}</code>
                      </span>
                    </div>
                    <span className="cc-keys__masked mono" title="Only the ends are ever shown">{s.masked}</span>
                    <span className="cc-keys__used">{when(s.lastUsedAt)}</span>
                    <button
                      className="cc-icon-btn"
                      title={`Remove ${s.name}`}
                      aria-label={`Remove ${s.name}`}
                      onClick={() => void askDelete(s.name)}
                    >
                      <IconTrash />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {adding ? (
        <div className="cc-keys__form">
          <div className="cc-field cc-field--tight">
            <span className="cc-field__label">Called</span>
            <input
              className="cc-input"
              value={name}
              placeholder="Prospeo"
              disabled={busy}
              aria-label="Name for this key"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="cc-field cc-field--tight">
            <span className="cc-field__label">Grouped under</span>
            <input
              className="cc-input"
              value={category}
              placeholder={categories[0] ?? "Enrichment"}
              list="cc-keys-cats"
              disabled={busy}
              aria-label="Category"
              onChange={(e) => setCategory(e.target.value)}
            />
            <datalist id="cc-keys-cats">
              {categories.map((c) => <option key={c} value={c} />)}
            </datalist>
          </div>
          <div className="cc-field cc-field--tight cc-keys__wide">
            <span className="cc-field__label">The key</span>
            <input
              className="cc-input mono"
              type="password"
              value={value}
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
              aria-label="The key itself"
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && name.trim() && value.trim()) void save(); }}
            />
          </div>
          <div className="cc-keys__acts">
            <button className="cc-btn cc-btn--primary" disabled={busy || !name.trim() || !value.trim()} onClick={() => void save()}>
              {busy ? "Saving…" : "Save it"}
            </button>
            <button className="cc-btn" disabled={busy} onClick={() => { setAdding(false); setValue(""); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="cc-btn cc-keys__add" onClick={() => setAdding(true)}>+ Key</button>
      )}

      {/* Deleting one is the action worth a confirmation, because what breaks is somewhere else and
          only shows up on the next run — hours later, with nothing pointing back here. */}
      {confirming && (
        <div className="cc-keys__confirm" role="alertdialog" aria-label={`Remove ${confirming.name}`}>
          <p className="cc-keys__confirm__h">Remove “{confirming.name}”?</p>
          {confirming.used.length === 0 ? (
            <p className="cc-keys__confirm__p">No column refers to it, so nothing here will change.</p>
          ) : (
            <>
              <p className="cc-keys__confirm__p">
                {confirming.used.length === 1 ? "One column uses it" : `${confirming.used.length} columns use it`}, and
                will fail on every row from their next run:
              </p>
              <ul className="cc-keys__confirm__list">
                {confirming.used.slice(0, 6).map((u) => (
                  <li key={u.columnId}>{u.sheet} · {u.column}</li>
                ))}
                {confirming.used.length > 6 && <li>and {confirming.used.length - 6} more</li>}
              </ul>
            </>
          )}
          <div className="cc-keys__acts">
            <button className="cc-btn cc-btn--danger" onClick={() => void doDelete()}>Remove it</button>
            <button className="cc-btn" onClick={() => setConfirming(null)}>Keep it</button>
          </div>
        </div>
      )}

      <div className="cc-set__msg" role="status" aria-live="polite">
        {error && <span className="cc-set__err"><IconAlert /> {error}</span>}
        {!error && note && <span className="cc-set__ok"><IconCheck /> {note}</span>}
      </div>
    </section>
  );
}
