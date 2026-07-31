// Buying models straight from the people who make them.
//
// OpenRouter has its own screen and keeps it: one key reaches everything, its check reports the
// credit left, and it is the right first answer for almost everyone. This screen is the second
// answer, and it exists for two reasons that only show up at scale — an aggregator takes a margin on
// every token, and it is a single point of failure for rate limits and outages. A million-row column
// is exactly where both start to matter.
//
// Two things this screen must never do, because both are how a settings page lies:
//
//   claim a key works when it was not checked. Some providers serve no model list, so the check
//   cannot confirm anything. That is its own state with its own words, not a tick.
//
//   imply a price. None of these publish a machine-readable rate, so until one is entered Ferrum
//   genuinely does not know what their models cost. The screen says so rather than leaving a blank
//   that reads as free.
//
// On that second point: "does not publish a readable rate" is NOT the same as "cannot be priced",
// and the first version of this screen confused the two — it announced the limitation three times
// and offered no way out. The answer was already in the product. The HTTP column asks the user to
// declare what a call costs and the search backends reuse the same calculator; a rate copied once
// off a vendor's pricing page is a real price, and it makes the estimate, the spend report and the
// per-cell dollar limit work exactly as they do on OpenRouter. Hence the Price button per row.

import { useCallback, useEffect, useState } from "react";
import { api, type LlmProviderStatus } from "../api.ts";
import { IconCheck, IconAlert, IconTrash, IconExternal } from "../ui/Icon.tsx";
import { PriceForm } from "./PriceForm.tsx";
import "./Providers.css";

type Busy = { id: string; what: "save" | "check" | "remove" } | null;

/** Per-provider message. Keyed by id so one provider's error cannot appear under another. */
type Notes = Record<string, { kind: "ok" | "warn" | "err"; text: string } | undefined>;

export function Providers() {
  const [providers, setProviders] = useState<LlmProviderStatus[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  /** Which provider's price form is showing. Separate from `open`, which is the key form. */
  const [pricing, setPricing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Busy>(null);
  const [notes, setNotes] = useState<Notes>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.llmProviders();
      // OpenRouter has its own section. Listing it twice would give two places to save one key, and
      // the two would disagree the moment either was used.
      setProviders(r.providers.filter((p) => p.id !== "openrouter"));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const note = (id: string, kind: "ok" | "warn" | "err", text: string) =>
    setNotes((n) => ({ ...n, [id]: { kind, text } }));

  const save = async (p: LlmProviderStatus) => {
    const key = (draft[p.id] ?? "").trim();
    if (!key) return;
    setBusy({ id: p.id, what: "save" });
    try {
      const r = await api.saveLlmProviderKey(p.id, key);
      // The key never comes back and is never held here longer than the request.
      setDraft((d) => ({ ...d, [p.id]: "" }));
      setOpen(null);
      await load();
      if (r.unverified) note(p.id, "warn", r.unverified);
      else note(p.id, "ok", `Saved. ${r.modelCount} model${r.modelCount === 1 ? "" : "s"} available.`);
    } catch (e) {
      note(p.id, "err", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const check = async (p: LlmProviderStatus) => {
    setBusy({ id: p.id, what: "check" });
    try {
      const r = await api.checkLlmProviderKey(p.id);
      if (r.unverified) note(p.id, "warn", r.unverified);
      else note(p.id, "ok", `Working. ${r.modelCount} model${r.modelCount === 1 ? "" : "s"} available.`);
    } catch (e) {
      note(p.id, "err", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (p: LlmProviderStatus) => {
    setBusy({ id: p.id, what: "remove" });
    try {
      await api.removeLlmProviderKey(p.id);
      await load();
      note(p.id, "ok", `${p.label} removed. Columns set to its models will need a different one.`);
    } catch (e) {
      note(p.id, "err", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const connected = providers?.filter((p) => p.hasKey) ?? [];

  return (
    <section className="cc-set__sec">
      <div className="cc-set__head">
        <h2 className="cc-set__title">Buy models direct</h2>
        <span className={`cc-set__pill${connected.length ? " cc-set__pill--on" : ""}`}>
          {providers == null ? "…" : connected.length ? `${connected.length} connected` : "None set up"}
        </span>
      </div>
      <p className="cc-set__lede">
        Optional. OpenRouter already reaches all of these, and it is the simpler way in. Add a
        provider here when you want its own rate rather than a reseller's, or your own rate limits on
        a very large run.
      </p>

      <p className="cc-prov__caveat">
        <IconAlert />
        <span>
          None of these publish a rate Ferrum can read, so a cost estimate needs their price entering
          once — press <strong>Price</strong> on any of them and copy it off their pricing page. Until
          then a column on their models shows no estimate and no spend, and a per-cell dollar limit on
          it cannot be enforced. Runs through OpenRouter are priced automatically.
        </span>
      </p>

      {loadError && (
        <div className="cc-set__msg" role="status" aria-live="polite">
          <span className="cc-set__err"><IconAlert /> {loadError}</span>
        </div>
      )}

      {providers == null && !loadError && (
        // Fixed-height placeholders, so the list arriving does not shove the page down.
        <ul className="cc-prov__list">
          {[0, 1, 2, 3].map((i) => <li key={i} className="cc-prov__row cc-prov__row--skel" aria-hidden="true" />)}
        </ul>
      )}

      {providers?.length === 0 && !loadError && (
        <p className="cc-set__hint">No other providers are available in this build.</p>
      )}

      <ul className="cc-prov__list">
        {(providers ?? []).map((p) => {
          const b = busy?.id === p.id ? busy.what : null;
          const n = notes[p.id];
          const isOpen = open === p.id;
          return (
            <li key={p.id} className={`cc-prov__row${p.hasKey ? " cc-prov__row--on" : ""}`}>
              <div className="cc-prov__main">
                <div className="cc-prov__id">
                  <span className="cc-prov__name">{p.label}</span>
                  {p.hasKey && <span className="cc-prov__tag">Connected</span>}
                  {!p.tools && (
                    <span className="cc-prov__tag cc-prov__tag--warn" title="Agent columns need a model that can call tools.">
                      No tool calls
                    </span>
                  )}
                </div>
                <p className="cc-prov__note">{p.note}</p>
              </div>

              <div className="cc-prov__acts">
                {/* Available whether or not a key is saved. Someone comparing two vendors before
                    committing needs the estimate to work BEFORE they sign up, and gating this behind
                    a key made the one screen that answers "what would this cost" unreachable until
                    after the decision it informs. */}
                <button
                  className="cc-btn"
                  aria-expanded={pricing === p.id}
                  onClick={() => setPricing(pricing === p.id ? null : p.id)}
                >
                  {pricing === p.id ? "Done" : "Price"}
                </button>
                {p.hasKey ? (
                  <>
                    <button className="cc-btn" onClick={() => void check(p)} disabled={b != null}>
                      {b === "check" ? "Checking…" : "Check"}
                    </button>
                    <button className="cc-btn cc-btn--danger" onClick={() => void remove(p)} disabled={b != null}>
                      <IconTrash /> {b === "remove" ? "Removing…" : "Remove"}
                    </button>
                  </>
                ) : (
                  <button
                    className="cc-btn"
                    aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? null : p.id)}
                  >
                    {isOpen ? "Cancel" : "Add key"}
                  </button>
                )}
              </div>

              {pricing === p.id && (
                <div className="cc-prov__form">
                  <PriceForm providerId={p.id} providerLabel={p.label} />
                </div>
              )}

              {isOpen && !p.hasKey && (
                <div className="cc-prov__form">
                  <label className="cc-set__field">
                    <span className="cc-set__label">Paste your {p.label} key</span>
                    <input
                      className="cc-input"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      autoFocus
                      value={draft[p.id] ?? ""}
                      onChange={(e) => setDraft((d) => ({ ...d, [p.id]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter" && !busy) void save(p); }}
                      aria-label={`${p.label} API key`}
                    />
                  </label>
                  <div className="cc-prov__formacts">
                    <button
                      className="cc-btn cc-btn--primary"
                      onClick={() => void save(p)}
                      disabled={b != null || !(draft[p.id] ?? "").trim()}
                    >
                      {b === "save" ? "Checking…" : "Save key"}
                    </button>
                    <a className="cc-set__link" href={p.signupUrl} target="_blank" rel="noopener noreferrer">
                      Get a key <IconExternal />
                    </a>
                  </div>
                </div>
              )}

              {/* Has no height until it holds something — see the note on .cc-prov__msg for why the
                  reserved-strip approach was measured and dropped here. */}
              <div className="cc-prov__msg" role="status" aria-live="polite">
                {n?.kind === "err" && <span className="cc-set__err"><IconAlert /> {n.text}</span>}
                {n?.kind === "warn" && <span className="cc-prov__warn"><IconAlert /> {n.text}</span>}
                {n?.kind === "ok" && <span className="cc-set__ok"><IconCheck /> {n.text}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
