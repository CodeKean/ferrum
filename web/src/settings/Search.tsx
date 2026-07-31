// Which engine a web search runs through, and what it costs.
//
// ── Why this screen matters more than it looks ─────────────────────────────────────────────────
//
// A search is the most expensive thing a cell can do. It is a FLAT per-call charge that appears in
// no token count, and it varies by a factor of fourteen between engines — $0.005 through OpenRouter
// against $0.00035 direct. On a million rows that is $5,000 against $350 for the same question,
// asked the same way, answered by the same underlying index.
//
// All of the machinery for choosing existed and none of it was reachable. Eight built-in engines,
// sixteen more described as data, an add-your-own form, an editable price and a per-cell budget —
// with no screen. So every workspace defaulted, permanently, to the most expensive option, and the
// cheapest one may as well not have been written.
//
// ── The two things this screen is FOR ──────────────────────────────────────────────────────────
//
//   1. Showing what each engine costs against the $0.003 per-cell ceiling, so "which one" is a
//      decision with a number attached rather than a list of brand names.
//
//   2. The Try button. A results path that is subtly wrong returns zero hits on every row, forever,
//      charges for each one, and looks exactly like a question nobody could answer. Nothing in the
//      output distinguishes the two — only the SHAPE of the raw response does, which is what Try
//      hands back when the path finds nothing.

import { useCallback, useEffect, useState } from "react";
import { api, type SearchSettings, type SearchTry } from "../api.ts";
import { IconAlert, IconCheck, IconTrash, IconExternal } from "../ui/Icon.tsx";
import "./Search.css";

// Both live in searchPrice.ts so they can be tested — this file imports CSS, which the test runner
// cannot load, and these two are the code most worth checking on a screen made of small numbers.
import { perMillion, price } from "./searchPrice.ts";

export function Search() {
  const [s, setS] = useState<SearchSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  /** Per-engine drafts, so typing in one row cannot touch another. */
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});
  const [priceDraft, setPriceDraft] = useState<Record<string, string>>({});
  const [tried, setTried] = useState<Record<string, SearchTry | undefined>>({});

  const load = useCallback(async () => {
    try { setS(await api.search()); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const act = async (id: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(id);
    try { await fn(); await load(); setErr(null); if (ok) setNote(ok); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); setNote(null); }
    finally { setBusy(null); }
  };

  const choose = (id: string) => act(id, () => api.chooseSearchBackend(id), "Searches will use this engine.");

  const savePrice = (id: string) => {
    const raw = (priceDraft[id] ?? "").trim();
    return act(id, async () => {
      await api.setSearchPrice(id, raw === "" ? null : Number(raw));
      setPriceDraft((d) => ({ ...d, [id]: "" }));
    }, raw === "" ? "Back to the published price." : "Price saved.");
  };

  const saveKey = (id: string) => {
    const k = (keyDraft[id] ?? "").trim();
    return act(id, async () => {
      await api.setSearchKey(id, k);
      setKeyDraft((d) => ({ ...d, [id]: "" }));
    }, k ? "Key saved." : "Key removed.");
  };

  const tryIt = (id: string, body: { id?: string; preset?: string }) =>
    act(id, async () => {
      const out = await api.trySearchEngine({ ...body, query: "openai pricing" });
      setTried((t) => ({ ...t, [id]: out }));
    });

  const budget = s?.budgetUsd ?? 0.003;

  return (
    <section className="cc-set__sec">
      <div className="cc-set__head">
        <h2 className="cc-set__title">Web search</h2>
        <span className="cc-set__pill cc-set__pill--on">
          {s ? `${price(currentPrice(s))} a search` : "…"}
        </span>
      </div>
      <p className="cc-set__lede">
        Searching is the most expensive thing a cell does, and the price is per search rather than
        per word — so it never shows up in a token count. The engines below answer much the same
        question at very different prices. A cell makes{" "}
        <strong>{s?.maxSearches ?? 1} search</strong> by default and stops looking once it has spent{" "}
        <strong>{price(budget)}</strong>. The first search always runs, whatever it costs — otherwise
        picking an expensive engine would silently switch searching off altogether — so an engine
        priced above that limit will go over it.
      </p>

      {err && (
        <div className="cc-set__msg" role="status" aria-live="polite">
          <span className="cc-set__err"><IconAlert /> {err}</span>
        </div>
      )}
      {!err && note && (
        <div className="cc-set__msg" role="status" aria-live="polite">
          <span className="cc-set__ok"><IconCheck /> {note}</span>
        </div>
      )}

      {s == null && !err && (
        <ul className="cc-srch__list">
          {[0, 1, 2, 3].map((i) => <li key={i} className="cc-srch__row cc-srch__row--skel" aria-hidden="true" />)}
        </ul>
      )}

      {/* ── the engines that need no describing ─────────────────────────────── */}
      <ul className="cc-srch__list">
        {(s?.builtins ?? []).map((b) => {
          const on = s!.chosen === b.id;
          // Stated plainly rather than left to arithmetic. An engine that cannot fit inside the
          // per-cell ceiling will refuse its first search on every row, and finding that out on row
          // one of a million-row run is the failure this line exists to prevent.
          const overBudget = b.perSearchUsd != null && b.perSearchUsd > budget;
          const million = perMillion(b.perSearchUsd);
          return (
            <li key={b.id} className={`cc-srch__row${on ? " cc-srch__row--on" : ""}`}>
              <div className="cc-srch__main">
                <div className="cc-srch__id">
                  <span className="cc-srch__name">{b.label}</span>
                  {on && <span className="cc-srch__tag">In use</span>}
                  {b.hasKey && <span className="cc-srch__tag cc-srch__tag--quiet">Key saved</span>}
                  {b.returnsContent && <span className="cc-srch__tag cc-srch__tag--quiet">Reads pages</span>}
                  {overBudget && (
                    <span
                      className="cc-srch__tag cc-srch__tag--warn"
                      title={`One search here costs more than the ${price(budget)} a cell is meant to spend, so every searching cell goes over.`}
                    >
                      One search exceeds {price(budget)}
                    </span>
                  )}
                </div>
                <p className="cc-srch__note">{b.priceNote}</p>
              </div>

              <div className="cc-srch__cost">
                <span className="cc-srch__price">{price(b.perSearchUsd)}</span>
                <span className="cc-srch__per">
                  {million ? `${million} per million rows` : "set a price to budget it"}
                  {b.priceIsCustom && " · yours"}
                </span>
              </div>

              <div className="cc-srch__acts">
                <button className="cc-btn" onClick={() => void choose(b.id)} disabled={on || busy != null}>
                  {on ? "In use" : "Use this"}
                </button>
              </div>

              <div className="cc-srch__edit">
                {b.keyManagedElsewhere ? (
                  <p className="cc-srch__note">
                    Uses the same key as your models, set on the <strong>OpenRouter</strong> screen.
                  </p>
                ) : (
                <label className="cc-set__field cc-srch__field">
                  <span className="cc-set__label">
                    Key
                    <span className="cc-set__sub">{b.hasKey ? " — saved" : " — needed before it can search"}</span>
                  </span>
                  <div className="cc-srch__inline">
                    <input
                      className="cc-input"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={keyDraft[b.id] ?? ""}
                      placeholder={b.hasKey ? "••••••••" : ""}
                      aria-label={`${b.label} key`}
                      onChange={(e) => setKeyDraft((d) => ({ ...d, [b.id]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter") void saveKey(b.id); }}
                    />
                    <button
                      className="cc-btn"
                      onClick={() => void saveKey(b.id)}
                      disabled={busy != null || (!(keyDraft[b.id] ?? "").trim() && !b.hasKey)}
                    >
                      {(keyDraft[b.id] ?? "").trim() ? "Save" : "Remove"}
                    </button>
                    <a className="cc-set__link" href={b.signupUrl} target="_blank" rel="noopener noreferrer">
                      Get one <IconExternal />
                    </a>
                  </div>
                </label>
                )}

                <label className="cc-set__field cc-srch__field">
                  <span className="cc-set__label">
                    Price per search
                    <span className="cc-set__sub"> — leave blank to use the published one</span>
                  </span>
                  <div className="cc-srch__inline">
                    <input
                      className="cc-input"
                      inputMode="decimal"
                      value={priceDraft[b.id] ?? ""}
                      placeholder={b.listPriceUsd == null ? "they bill by plan — set yours" : String(b.listPriceUsd)}
                      aria-label={`${b.label} price per search`}
                      onChange={(e) => setPriceDraft((d) => ({ ...d, [b.id]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter") void savePrice(b.id); }}
                    />
                    <button className="cc-btn" onClick={() => void savePrice(b.id)} disabled={busy != null}>
                      {(priceDraft[b.id] ?? "").trim() ? "Save" : "Reset"}
                    </button>
                  </div>
                </label>
              </div>
            </li>
          );
        })}
      </ul>

      {/* ── engines the user added ──────────────────────────────────────────── */}
      {!!s?.custom.length && (
        <>
          <h3 className="cc-srch__sub">Your engines</h3>
          <ul className="cc-srch__list">
            {s.custom.map((c) => {
              const on = s.chosen === c.id;
              const t = tried[c.id];
              return (
                <li key={c.id} className={`cc-srch__row${on ? " cc-srch__row--on" : ""}`}>
                  <div className="cc-srch__main">
                    <div className="cc-srch__id">
                      <span className="cc-srch__name">{c.label}</span>
                      {on && <span className="cc-srch__tag">In use</span>}
                    </div>
                    <p className="cc-srch__note cc-srch__mono">{c.url}</p>
                  </div>

                  <div className="cc-srch__cost">
                    <span className="cc-srch__price">{price(c.perSearchUsd)}</span>
                    <span className="cc-srch__per">
                      {perMillion(c.perSearchUsd) ? `${perMillion(c.perSearchUsd)} per million rows` : "no price set"}
                    </span>
                  </div>

                  <div className="cc-srch__acts">
                    <button className="cc-btn" onClick={() => void tryIt(c.id, { id: c.id })} disabled={busy != null}>
                      {busy === c.id ? "Trying…" : "Try"}
                    </button>
                    <button className="cc-btn" onClick={() => void choose(c.id)} disabled={on || busy != null}>
                      {on ? "In use" : "Use this"}
                    </button>
                    <button
                      className="cc-btn cc-btn--danger"
                      onClick={() => void act(c.id, () => api.deleteSearchEngine(c.id), "Engine removed.")}
                      disabled={busy != null}
                      aria-label={`Remove ${c.label}`}
                    >
                      <IconTrash />
                    </button>
                  </div>

                  {t && <TryResult t={t} />}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {/* ── engines described but not yet added ─────────────────────────────── */}
      {!!s?.presets.length && (
        <details className="cc-set__more">
          <summary className="cc-set__moresum">
            Other search engines ({s.presets.filter((p) => !s.custom.some((c) => c.label === p.label)).length})
          </summary>
          <ul className="cc-set__quiet">
            {s.presets
              .filter((p) => !s.custom.some((c) => c.label === p.label))
              .map((p) => (
                <li key={p.key} className="cc-set__quietrow">
                  <div className="cc-srch__presetrow">
                    <div className="cc-set__quietmain">
                      <span className="cc-set__quietname">{p.label}</span>
                      <p className="cc-set__quietnote">{p.note}</p>
                      {!!p.secretNames.length && (
                        <p className="cc-set__quietnote">
                          Needs a key saved as{" "}
                          {p.secretNames.map((n) => <code key={n} className="cc-srch__code">{n}</code>)}
                          {" on the Keys screen. "}
                          <a className="cc-set__link" href={p.signupUrl} target="_blank" rel="noopener noreferrer">
                            Get one <IconExternal />
                          </a>
                        </p>
                      )}
                    </div>
                    <div className="cc-srch__acts">
                      <button
                        className="cc-btn"
                        onClick={() => void tryIt(`preset:${p.key}`, { preset: p.key })}
                        disabled={busy != null}
                      >
                        {busy === `preset:${p.key}` ? "Trying…" : "Try"}
                      </button>
                      <button
                        className="cc-btn cc-btn--primary"
                        onClick={() => void act(
                          `add:${p.key}`,
                          () => api.saveSearchEngine({ preset: p.key, label: p.label }),
                          `${p.label} added. Press "Use this" to search with it.`,
                        )}
                        disabled={busy != null}
                      >
                        {busy === `add:${p.key}` ? "Adding…" : "Add"}
                      </button>
                    </div>
                  </div>
                  {tried[`preset:${p.key}`] && <TryResult t={tried[`preset:${p.key}`]!} />}
                </li>
              ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/**
 * What one real search returned.
 *
 * The raw response is shown ONLY when the path found nothing, because that is the only moment it is
 * useful — and on a working engine it is a wall of noise. Zero results with a 200 is otherwise
 * indistinguishable from a hard question.
 */
function TryResult({ t }: { t: SearchTry }) {
  if (t.error) {
    return (
      <div className="cc-srch__try">
        <span className="cc-set__err"><IconAlert /> {t.error}</span>
      </div>
    );
  }
  if (!t.hits.length) {
    return (
      <div className="cc-srch__try">
        <span className="cc-set__err">
          <IconAlert /> It answered, but nothing was found where the results were expected.
        </span>
        <p className="cc-srch__hint">
          The whole response is below — find the list of results in it, and correct the path.
        </p>
        <pre className="cc-srch__raw">{JSON.stringify(t.raw ?? {}, null, 2).slice(0, 4000)}</pre>
      </div>
    );
  }
  return (
    <div className="cc-srch__try">
      <span className="cc-set__ok">
        <IconCheck /> {t.hits.length} result{t.hits.length === 1 ? "" : "s"}
        {t.costUsd != null && ` · this one cost ${price(t.costUsd)}`}
      </span>
      <ul className="cc-srch__hits">
        {t.hits.slice(0, 3).map((h, i) => (
          <li key={i} className="cc-srch__hit">
            <span className="cc-srch__hittitle">{h.title || h.url}</span>
            <span className="cc-srch__hiturl">{h.url}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What a search costs right now, for the heading. */
function currentPrice(s: SearchSettings): number | null {
  const b = s.builtins.find((x) => x.id === s.chosen);
  if (b) return b.perSearchUsd;
  return s.custom.find((c) => c.id === s.chosen)?.perSearchUsd ?? null;
}
