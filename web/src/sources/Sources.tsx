// Where data comes from.
//
// The mirror image of everything else in this app: every other screen is about what a sheet does to
// its rows, and this one is about rows arriving.
//
// Two ways in, one screen, because "how do I get data in here" is one question. A file you have is
// the common answer and goes first; a webhook is the answer when the data is not sitting on your
// disk yet. Splitting them across two places would mean knowing which kind of source you wanted
// before you could look for it.
//
// Three things have to be on screen at once for a webhook to be usable, and leaving any of them out
// is why webhook screens are usually painful:
//
//   THE ADDRESS, copyable in one click. It is the only thing you need in the other tool.
//   THE MAPPING, in the sender's words, so "which field goes where" is answered here rather than by
//   trial and error against a live integration.
//   WHAT ACTUALLY ARRIVED, successes and failures both — because a webhook that silently drops a
//   payload looks exactly like one nobody ever called, and that is the thing you always end up
//   debugging.

import { useCallback, useEffect, useState } from "react";
import { Modal } from "../ui/Modal.tsx";
import { Section } from "../ui/Section.tsx";
import { IconPlus } from "../ui/Icon.tsx";
import { CsvImport } from "./CsvImport.tsx";
import type { Column } from "../api.ts";
import "./Sources.css";

interface Source {
  id: number;
  name: string;
  token: string;
  url: string;
  enabled: boolean;
  /** The column a delivery lands in whole. Null until the first one arrives. */
  payloadColumnId: number | null;
  mapping: Record<string, string>;
  keyPath: string | null;
  itemsPath: string | null;
  lastAt: string | null;
  received: number;
  rejected: number;
}

interface Delivery {
  id: number;
  at: string;
  ok: boolean;
  rowsWritten: number;
  note: string | null;
  body: string;
}

interface Props {
  sheetId: string;
  columns: Column[];
  onClose: () => void;
  /** Rows may have arrived while this was open. */
  onChanged: () => void;
}

/** Every leaf path in a sample body, so the mapping offers real fields instead of a text box. */
function pathsOf(value: unknown, prefix = "", out: string[] = [], depth = 0): string[] {
  if (depth > 5 || out.length > 60 || value == null || typeof value !== "object") return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) pathsOf(v, path, out, depth + 1);
    else out.push(path);
  }
  return out;
}

type Kind = "file" | "hook";

export function Sources({ sheetId, columns, onClose, onChanged }: Props) {
  const [kind, setKind] = useState<Kind>("file");
  const [sources, setSources] = useState<Source[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sheets/${sheetId}/sources`).then((r) => r.json());
      setSources(res.sources ?? []);
      setSelected((cur) => cur ?? res.sources?.[0]?.id ?? null);
    } catch {
      setError("Could not load this table’s sources.");
    }
  }, [sheetId]);

  useEffect(() => { void load(); }, [load]);

  /**
   * The counters, and nothing else.
   *
   * The poll below must not call `load()`, which replaces the whole array, because every field on
   * this screen is a controlled input holding a local edit until it blurs. A delivery landing while
   * someone types a mapping path would revert the field mid-word, and the blur that followed would
   * SAVE the reverted value. Only what the server owns moves on a poll; the editable fields belong to
   * whoever is typing into them.
   */
  const refreshCounts = useCallback(async () => {
    try {
      const res = await fetch(`/api/sheets/${sheetId}/sources`).then((r) => r.json());
      const fresh = new Map<number, Source>(((res.sources ?? []) as Source[]).map((s) => [s.id, s]));
      setSources((prev) =>
        prev.map((s) => {
          const f = fresh.get(s.id);
          return f
            ? { ...s, received: f.received, rejected: f.rejected, lastAt: f.lastAt, payloadColumnId: f.payloadColumnId }
            : s;
        }),
      );
    } catch { /* the counters just stay as they were */ }
  }, [sheetId]);

  const current = sources.find((s) => s.id === selected) ?? null;
  // The poll depends on the source's ID, not on the object. `load` hands back a new identity every
  // time, so an object dependency tore the interval down and rebuilt it on every refresh — with an
  // immediate extra request each time, three per four-second cycle instead of two.
  const currentId = current?.id ?? null;

  // Deliveries are polled while the panel is open, so a payload sent from the other tool right now
  // shows up here without a reload — which is exactly when someone is watching this screen.
  useEffect(() => {
    if (currentId == null) { setDeliveries([]); return; }
    let live = true;
    const pull = async () => {
      try {
        const res = await fetch(`/api/sources/${currentId}/deliveries`).then((r) => r.json());
        if (live) setDeliveries(res.deliveries ?? []);
      } catch { /* the list just stays as it was */ }
    };
    void pull();
    const t = setInterval(() => { void pull(); void refreshCounts(); }, 4000);
    return () => { live = false; clearInterval(t); };
  }, [currentId, refreshCounts]);

  const patch = async (id: number, body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sources/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      setSources((prev) => prev.map((s) => (s.id === id ? res.source : s)));
      onChanged();
    } catch {
      setError("Could not reach the engine.");
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sheets/${sheetId}/sources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Incoming data" }),
      }).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      setSources((prev) => [...prev, res.source]);
      setSelected(res.source.id);
    } catch {
      setError("Could not reach the engine.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(current.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { setError("Could not copy — select the address and copy it by hand."); }
  };

  // The last body that arrived is what makes the mapping fillable: you pick from the fields the
  // sender actually sends, rather than typing paths from memory against a live integration.
  const sample = (() => {
    const last = deliveries.find((d) => d.body?.trim().startsWith("{"));
    if (!last) return null;
    try { return JSON.parse(last.body) as unknown; } catch { return null; }
  })();
  const samplePaths = sample ? pathsOf(sample) : [];

  /** The column deliveries land in whole, once one has. Absent until the first delivery. */
  const payloadCol = current?.payloadColumnId
    ? columns.find((c) => String(c.id) === String(current.payloadColumnId)) ?? null
    : null;

  return (
    <Modal
      open
      onClose={onClose}
      title="Data arriving into this table"
      width={720}
      footNote={
        kind === "file"
          ? "A file is read once. For data that keeps arriving, use an address."
          : current
          ? `${current.received.toLocaleString()} accepted · ${current.rejected.toLocaleString()} rejected`
          : "Nothing set up yet."
      }
      footer={<button className="cc-btn" onClick={onClose}>Done</button>}
    >
      {error && <div className="cc-modal__error" role="alert">{error}</div>}

      <div className="cc-src">
        <div className="cc-seg cc-src__kinds" role="tablist">
          <button
            role="tab"
            aria-selected={kind === "file"}
            className={`cc-seg__btn${kind === "file" ? " cc-seg__btn--on" : ""}`}
            onClick={() => setKind("file")}
          >
            From a file
          </button>
          <button
            role="tab"
            aria-selected={kind === "hook"}
            className={`cc-seg__btn${kind === "hook" ? " cc-seg__btn--on" : ""}`}
            onClick={() => setKind("hook")}
          >
            Sent to an address
          </button>
        </div>

        {kind === "file" ? (
          <CsvImport sheetId={sheetId} columns={columns} onImported={onChanged} />
        ) : (
        <>
        {/* The tab strip is hidden when there is nothing in it.

            Empty, it was a lone "+ Source" button sitting directly above the empty state's own
            "+ Source" button — the same action twice, eighty pixels apart, with a sentence
            between them. The strip is for switching between sources; with none to switch
            between it has no job, and the empty state's button is the one that reads. */}
        {sources.length > 0 && (
        <div className="cc-src__list">
          {sources.map((s) => (
            <button
              key={s.id}
              className={`cc-src__tab${s.id === selected ? " cc-src__tab--on" : ""}`}
              onClick={() => setSelected(s.id)}
            >
              <span className="truncate">{s.name}</span>
              <span className={`cc-src__dot${s.enabled ? " cc-src__dot--on" : ""}`} aria-hidden />
            </button>
          ))}
          <button className="cc-btn cc-btn--ghost cc-btn--xs" onClick={() => void add()} disabled={busy}>
            <IconPlus /> <span>Source</span>
          </button>
        </div>
        )}

        {!current ? (
          <div className="cc-src__empty">
            <p>
              A source gives you a web address. Anything that can send JSON to a URL — a form, Zapier,
              n8n, a CRM trigger — posts to it, and rows appear here.
            </p>
            <button className="cc-btn cc-btn--primary" onClick={() => void add()} disabled={busy}>
              <IconPlus /> <span>Source</span>
            </button>
          </div>
        ) : (
          <div className="cc-src__detail">
            <label className="cc-field">
              <span className="cc-field__label">Name</span>
              <input
                className="cc-input"
                value={current.name}
                onChange={(e) => setSources((p) => p.map((s) => (s.id === current.id ? { ...s, name: e.target.value } : s)))}
                onBlur={(e) => void patch(current.id, { name: e.target.value })}
              />
            </label>

            <div className="cc-field">
              <span className="cc-field__label">
                Send data here
                <span className="cc-field__sub">POST JSON to this address</span>
              </span>
              <div className="cc-src__url">
                <code className="truncate mono">{current.url}</code>
                <button className="cc-btn cc-btn--xs" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
              </div>
              <span className="cc-field__hint">
                This address is the password. Anyone who has it can add rows to this sheet, so treat
                it like a key — and if it gets out, replace it below.
              </span>
              {/* Said here rather than discovered after twenty minutes of a Zapier step timing out.
                  The engine listens on this machine only — deliberately, since it holds the provider
                  keys — so anything on the internet needs a way in. */}
              {/^https?:\/\/(127\.0\.0\.1|localhost)/i.test(current.url) && (
                <span className="cc-src__note">
                  This address only works from this computer. Ferrum runs here and nowhere else, on
                  purpose — it holds your API keys. For something on the internet to reach it, put a
                  tunnel in front (<code>cloudflared tunnel</code>, <code>ngrok http 4317</code>) and
                  send to the address that gives you, with the same <code>/hook/…</code> on the end.
                </span>
              )}
            </div>

            {/* The test fire.
                
                A webhook you cannot try is a webhook you configure blind, and the usual result is
                twenty minutes of guessing whether the address, the tool, or the mapping is wrong.
                So this screen watches: it is already polling deliveries, and the only thing missing
                was saying out loud which state you are in. */}
            <div className={`cc-src__test${payloadCol ? " cc-src__test--got" : ""}`} role="status">
              <span className="cc-src__testdot" aria-hidden />
              <div className="cc-src__testbody">
                {payloadCol ? (
                  <>
                    <strong>A delivery arrived.</strong> The whole thing is in{" "}
                    <strong>{payloadCol.name}</strong>, pinned as the first column. Open any cell in
                    it and click a field to turn that field into a column of its own.
                  </>
                ) : (
                  <>
                    <strong>Waiting for a test.</strong> Send one delivery from the other tool to the
                    address above. It lands whole in a new pinned column, and you build the columns
                    you want out of what actually arrived — no guessing at field names first.
                  </>
                )}
              </div>
              {payloadCol && (
                <button className="cc-btn cc-btn--xs" onClick={onClose}>Show me</button>
              )}
            </div>

            <label className="cc-src__check">
              <input
                type="checkbox"
                checked={current.enabled}
                disabled={busy}
                onChange={(e) => void patch(current.id, { enabled: e.target.checked })}
              />
              <span>
                Accepting data
                <span className="cc-src__checkhint">
                  Switched off, deliveries are refused and recorded below, so you can see who is still
                  sending.
                </span>
              </span>
            </label>

            {/* Not the way in any more — the way to OVERRIDE the way in. Filling any row here stops
                the whole-payload column being written and goes back to landing only what is named,
                which is what you want once a shape has settled and you no longer need the raw JSON. */}
            <Section
              label="Send fields straight to columns instead"
              summary={Object.keys(current.mapping).length > 0 ? `${Object.keys(current.mapping).length} mapped` : "off"}
              defaultOpen={Object.keys(current.mapping).length > 0}
            >
              <p className="cc-src__hint">
                Optional. Leave this empty and each delivery lands whole in one column, which is the
                easier way round — you can see the data before deciding what to pull out of it. Fill
                any row and the raw column stops being written: only the fields named here are stored.
                {samplePaths.length > 0 ? " The paths offered are from the last delivery." : ""}
              </p>
              {columns.map((c) => (
                <div key={c.id} className="cc-src__maprow">
                  <span className="cc-src__col truncate" title={c.name}>{c.name}</span>
                  <input
                    className="cc-input cc-src__path mono"
                    list={samplePaths.length ? `cc-src-paths-${current.id}` : undefined}
                    placeholder="not filled"
                    aria-label={`Field for ${c.name}`}
                    value={current.mapping[c.id] ?? ""}
                    onChange={(e) => setSources((p) => p.map((s) => (s.id === current.id
                      ? { ...s, mapping: { ...s.mapping, [c.id]: e.target.value } } : s)))}
                    onBlur={() => {
                      const clean = Object.fromEntries(Object.entries(current.mapping).filter(([, v]) => v));
                      void patch(current.id, { mapping: clean });
                    }}
                  />
                </div>
              ))}
              {samplePaths.length > 0 && (
                <datalist id={`cc-src-paths-${current.id}`}>
                  {samplePaths.map((p) => <option key={p} value={p} />)}
                </datalist>
              )}
            </Section>

            <Section label="Repeats and batches" summary={current.keyPath ? "matched" : "always adds"}>
              <label className="cc-field cc-field--tight">
                <span className="cc-field__label">Treat two deliveries as the same record when this matches</span>
                <input
                  className="cc-input mono"
                  placeholder="user.email"
                  value={current.keyPath ?? ""}
                  onChange={(e) => setSources((p) => p.map((s) => (s.id === current.id ? { ...s, keyPath: e.target.value } : s)))}
                  onBlur={(e) => void patch(current.id, { keyPath: e.target.value })}
                />
                <span className="cc-field__hint">
                  Strongly recommended. Almost every sender retries — on a timeout, on a deploy — and
                  without this each retry adds another row.
                </span>
              </label>

              <label className="cc-field cc-field--tight">
                <span className="cc-field__label">When one delivery carries many records, they are at</span>
                <input
                  className="cc-input mono"
                  placeholder="records"
                  value={current.itemsPath ?? ""}
                  onChange={(e) => setSources((p) => p.map((s) => (s.id === current.id ? { ...s, itemsPath: e.target.value } : s)))}
                  onBlur={(e) => void patch(current.id, { itemsPath: e.target.value })}
                />
                <span className="cc-field__hint">Leave empty when each delivery is one record.</span>
              </label>
            </Section>

            <Section label="What has arrived" summary={deliveries.length ? `last ${deliveries.length}` : "nothing yet"} defaultOpen>
              {deliveries.length === 0 ? (
                <p className="cc-src__hint">
                  Nothing has been sent to this address yet. Post to it from the other tool and it will
                  show up here within a few seconds.
                </p>
              ) : (
                deliveries.map((d) => (
                  <details key={d.id} className="cc-src__del">
                    <summary>
                      <span className={`cc-pill ${d.ok ? "cc-pill--done" : "cc-pill--error"}`}>{d.ok ? "Accepted" : "Rejected"}</span>
                      <span className="cc-src__delnote truncate">{d.note ?? ""}</span>
                      <span className="cc-src__delat mono">{d.at}</span>
                    </summary>
                    <pre className="cc-src__body mono">{d.body || "(empty)"}</pre>
                  </details>
                ))
              )}
            </Section>

            <div className="cc-src__danger">
              {/* Both of these change what the outside world can reach, so a failure has to be
                  said. Silently, "Replace the address" left the old one live while the screen
                  showed no change at all — which is the one outcome you must not guess at when the
                  reason you pressed it is that the address leaked. */}
              <button
                className="cc-btn cc-btn--xs"
                disabled={busy}
                onClick={async () => {
                  setError(null);
                  try {
                    const res = await fetch(`/api/sources/${current.id}/rotate`, { method: "POST" }).then((r) => r.json());
                    if (res.error) { setError(res.error); return; }
                    if (res.source) setSources((p) => p.map((s) => (s.id === current.id ? res.source : s)));
                  } catch {
                    setError("Could not replace the address — the old one is still live.");
                  }
                }}
              >
                Replace the address
              </button>
              <button
                className="cc-btn cc-btn--danger cc-btn--xs"
                disabled={busy}
                onClick={async () => {
                  setError(null);
                  try {
                    const res = await fetch(`/api/sources/${current.id}`, { method: "DELETE" }).then((r) => r.json());
                    if (res.error) { setError(res.error); return; }
                    setSelected(null);
                    await load();
                  } catch {
                    setError("Could not delete that source.");
                  }
                }}
              >
                Delete this source
              </button>
            </div>
          </div>
        )}
        </>
        )}
      </div>
    </Modal>
  );
}
