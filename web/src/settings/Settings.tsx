// Settings — a page, not a dialog.
//
// It was a 560px modal over the grid, and everything about that was wrong for what it holds. A modal
// says "answer this and get back to what you were doing"; this screen is where you decide what every
// column in the workspace runs on, what it costs, and whether it costs anything at all. It had no
// address, so it could not be linked to, could not be reloaded into, and closed itself if you
// navigated. Three sections were stacked in a scroll with no way to jump between them.
//
// So: a real page with a real URL (?settings=<section>), a section rail, and room for the two things
// that had nowhere to live —
//
//   WHICH MODEL EVERY `auto` COLUMN RUNS ON. There was a setting for the model that DESIGNS a column
//   and none for the model that RUNS one; that resolved to a hardcoded constant nothing could change.
//   So a model on this machine could be detected, listed, and chosen column by column, but never made
//   the default. The free lane was the only one you had to opt into a column at a time.
//
//   WHERE OLLAMA AND LM STUDIO ACTUALLY ARE. The addresses were env vars read once at boot, and this
//   screen told anyone whose runtime was not found that "no setup is needed here" — which is the app
//   confidently reporting nothing to configure while being unable to see their models.
//
// The key still travels one way. It is posted, verified against the provider BEFORE being stored, and
// never read back — no screen needs it, and a route that can return a key is a route that can leak
// one. What comes back is a masked label, enough to tell two keys apart.

import { useCallback, useEffect, useState } from "react";
import { api, type KeyCheck, type ProviderStatus, type UsageScope } from "../api.ts";
import { Select } from "../ui/Select.tsx";
import { IconCheck, IconAlert, IconTrash, IconExternal } from "../ui/Icon.tsx";
import { Usage } from "./Usage.tsx";
import { Keys } from "./Keys.tsx";
import { McpServers } from "./McpServers.tsx";
import { Providers } from "./Providers.tsx";
import { Search } from "./Search.tsx";
import { People } from "../people/People.tsx";
import { Account } from "../people/Account.tsx";
import { session, type SessionState } from "../api.ts";
import "./Settings.css";

interface CatalogModel {
  id: string;
  name: string;
  local?: boolean;
  free?: boolean;
  tools?: boolean;
}

/** Which model DESIGNS a column, as opposed to which model runs it on every row. */
interface SetupModel { model: string; freeOnly: boolean; estimateUsd: number | null }

/** Which model RUNS a column that has not chosen one. `effective` is what `auto` resolves to today. */
interface RunModel { model: string; effective: string }

/** Reused answers: the switch, the age, and what is actually stored. */
interface CacheSettings {
  on: boolean;
  days: number;
  stats: { entries: number; stale: number; hits: number; oldest: string | null };
}

interface Runtime {
  id: string;
  label: string;
  /** One line on what it is. Eight product names with no explanation is not a choice. */
  note: string;
  /** This one refuses an unauthenticated request, so it needs a token before it can be seen at all. */
  needsKey: boolean;
  hasKey: boolean;
  url: string;
  defaultUrl: string;
  isDefault: boolean;
  detected: number;
  models: Array<{ id: string; name: string }>;
}

export type SettingsSection = "models" | "local" | "openrouter" | "providers" | "search" | "apps" | "keys" | "usage" | "people" | "account";

/** Every section name the address bar is allowed to name. One list, so the URL and the rail agree. */
export const SETTINGS_SECTIONS = ["models", "local", "openrouter", "providers", "search", "apps", "keys", "usage", "people", "account"] as const;

export const isSettingsSection = (s: string | null): s is SettingsSection =>
  s != null && (SETTINGS_SECTIONS as readonly string[]).includes(s);

const SECTIONS: Array<{ id: SettingsSection; label: string; blurb: string }> = [
  { id: "models", label: "Models", blurb: "What columns run on, and what designs them" },
  // No product list in the blurb — it went stale the moment the list grew past the two it named.
  { id: "local", label: "On this machine", blurb: "Models running on your own computer" },
  { id: "openrouter", label: "OpenRouter", blurb: "The hosted models, and your credit" },
  // No count in the blurb. A hardcoded one goes stale the next time a provider is added, and the
  // list is right there on the screen anyway.
  { id: "providers", label: "Buy direct", blurb: "OpenAI, Anthropic, Gemini, Mistral and more" },
  { id: "search", label: "Web search", blurb: "Which engine looks things up, and what it costs" },
  { id: "apps", label: "Connected apps", blurb: "Tools a column or an agent can call" },
  { id: "keys", label: "Keys", blurb: "Saved keys your columns refer to by name" },
  { id: "usage", label: "Usage and cost", blurb: "What has run, and what it cost" },
];

/**
 * The rail, for this particular person.
 *
 * The two team sections appear only on an instance somebody has claimed — a single-user install has
 * nobody to list and no account to sign out of, and offering either would be offering to configure
 * something that does not exist. "People" additionally needs an admin, matching the server, which
 * refuses that route outright: this only decides whether to draw a door that would not open.
 */
function sectionsFor(me: { claimed: boolean; can: { people: boolean } }): typeof SECTIONS {
  if (!me.claimed) return SECTIONS;
  const extra = SECTIONS.slice();
  extra.push({ id: "account", label: "Your account", blurb: "Your name, your password, where you are signed in" });
  if (me.can.people) {
    extra.push({ id: "people", label: "People", blurb: "Who can sign in, and what they may do" });
  }
  return extra;
}

/**
 * What one design call costs, in words.
 *
 * Cents below a cent, because "$0.004" is a number people have to stop and count the zeros in, and
 * "unknown" rather than a rounded zero when there is no published price — a fabricated zero here is
 * exactly the reassurance that turns into a surprise on a bill.
 */
const setupPrice = (s: SetupModel): string =>
  s.estimateUsd == null ? "price unknown"
  : s.estimateUsd === 0 ? "free"
  : s.estimateUsd < 0.01 ? `${(s.estimateUsd * 100).toFixed(2)}¢`
  : `$${s.estimateUsd.toFixed(3)}`;

/**
 * A model as an option, grouped so the one that costs nothing is not buried.
 *
 * The catalogue is ~300 long. Flat, a local model sat somewhere among a hundred hosted free ones and
 * was findable only by already knowing its name. `Select` searches and groups past a threshold; this
 * supplies the headings.
 */
const groupOf = (m: CatalogModel) => (m.local ? "On this machine" : m.free ? "Free, hosted" : "Paid");
const hintOf = (m: CatalogModel) => (m.local ? "on device" : m.free ? "free" : undefined);

interface Props {
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  /** Back to the table. A page needs a way out that is not a close button on a dialog. */
  onClose: () => void;
  /** Which scope the usage report is about. Lives in the address, so a table's cost page is a link. */
  usageScope: UsageScope;
  usageScopeId: string | null;
  onUsageScope: (scope: UsageScope, id: string | null) => void;
  /** Who is signed in, or an unclaimed instance. Decides which sections exist at all. */
  me: SessionState;
  onSessionChanged: () => void;
}

export function Settings({ section, onSection, onClose, usageScope, usageScopeId, onUsageScope, me, onSessionChanged }: Props) {
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [check, setCheck] = useState<KeyCheck | null>(null);
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [runtimes, setRuntimes] = useState<Runtime[] | null>(null);
  const [setup, setSetup] = useState<SetupModel | null>(null);
  const [run, setRun] = useState<RunModel | null>(null);
  /** Whether answers are reused, how long for, and what is stored. */
  const [cache, setCache] = useState<CacheSettings | null>(null);

  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<null | "save" | "check" | "remove">(null);
  const [error, setError] = useState<string | null>(null);
  /** Kept apart from `error` so a success line cannot be mistaken for a failure that stayed on screen. */
  const [note, setNote] = useState<string | null>(null);

  const locals = models.filter((m) => m.local);
  /** Only tool-calling models can design: the setup call forces a tool call, so one that cannot make it fails every time. */
  const designable = models.filter((m) => m.tools !== false);

  const load = useCallback(async () => {
    try {
      const [p, m, s, r, rt, ca] = await Promise.all([
        api.providers(),
        // The catalogue is the provider's public price list — no key, no tokens, nothing billed.
        fetch("/api/models").then((x) => x.json()).catch(() => ({ models: [] })),
        fetch("/api/settings/setup-model").then((x) => x.json()).catch(() => null),
        fetch("/api/settings/run-model").then((x) => x.json()).catch(() => null),
        fetch("/api/settings/local-runtimes").then((x) => x.json()).catch(() => null),
        fetch("/api/cache").then((x) => x.json()).catch(() => null),
      ]);
      setStatus(p.providers.find((x) => x.provider === "openrouter") ?? null);
      setModels(m.models ?? []);
      if (s && !s.error) setSetup(s);
      if (r && !r.error) setRun(r);
      if (rt?.runtimes) setRuntimes(rt.runtimes);
      if (ca && !ca.error) setCache(ca);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the current settings.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * Save a setting optimistically, then reconcile with what the server actually stored.
   *
   * The estimate and the effective model are both computed there from the live price list, so the
   * numbers beside a choice have to come back from the server rather than be guessed at here.
   */
  const saveSetup = async (next: Partial<SetupModel>) => {
    setSetup((s) => (s ? { ...s, ...next } : s));
    try {
      const res = await fetch("/api/settings/setup-model", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next),
      }).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      setSetup(res); setError(null);
    } catch { setError("Could not save that setting."); }
  };

  const saveRun = async (model: string) => {
    setRun((s) => (s ? { ...s, model } : s));
    try {
      const res = await fetch("/api/settings/run-model", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }),
      }).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      setRun(res); setError(null);
      setNote("Saved. Every column set to “Engine default” uses this from its next run.");
    } catch { setError("Could not save that setting."); }
  };

  /** One handler for both controls: the route takes either and answers with the whole state. */
  const saveCache = async (patch: { on?: boolean; days?: number }) => {
    try {
      const res = await fetch("/api/cache", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
      }).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      setError(null);
      setCache(res);
    } catch { setError("Could not save that."); }
  };

  const clearCacheNow = async () => {
    try {
      const res = await fetch("/api/cache/clear", { method: "POST" }).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      setError(null);
      setNote(`Forgot ${res.removed.toLocaleString()} stored answer${res.removed === 1 ? "" : "s"}.`);
      setCache((c) => (c ? { ...c, stats: res.stats } : c));
    } catch { setError("Could not clear the stored answers."); }
  };

  const saveRuntimeUrl = async (id: Runtime["id"], url: string) => {
    try {
      const res = await fetch(`/api/settings/local-runtimes/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }),
      }).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      // An address that is not local is refused rather than stored. Saying so is the point: silently
      // ignoring it, on the one lane advertised as private, is the worst available outcome.
      if (res.rejected) {
        setError(`That address is not on this machine or your own network, so it was not used. ${res.url} is still in use.`);
      } else {
        setError(null);
        setNote(res.detected > 0
          ? `Found ${res.detected} model${res.detected === 1 ? "" : "s"} there.`
          : "Saved, but nothing answered at that address. Is the app running?");
      }
      // Both lists change: the runtime's own row, and the catalogue the pickers read.
      await load();
    } catch { setError("Could not save that address."); }
  };

  /**
   * The token for a runtime that needs one.
   *
   * The re-probe in the response is the verification: it answers "can Ferrum see your models now?",
   * which is the question actually being asked, rather than "does this string look like a token".
   */
  const saveRuntimeKey = async (id: Runtime["id"], key: string) => {
    try {
      const res = await fetch(`/api/settings/local-runtimes/${id}/key`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }),
      }).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      setError(null);
      setNote(
        !res.hasKey ? "Token removed."
        : res.detected > 0 ? `Found ${res.detected} model${res.detected === 1 ? "" : "s"} there.`
        : "Token saved, but nothing answered. Check the address and that the app is running.",
      );
      await load();
    } catch { setError("Could not save that token."); }
  };

  // Only when a key is already stored. Checking on open with no key would report a failure the user
  // has not caused yet.
  useEffect(() => {
    if (!status?.present) return;
    let cancelled = false;
    void api.checkOpenRouterKey()
      .then((r) => { if (!cancelled) setCheck(r.check); })
      .catch(() => { /* the panel already says a key is stored; a failed re-check is not an error to shout about */ });
    return () => { cancelled = true; };
  }, [status?.present]);

  const save = async () => {
    const trimmed = key.trim();
    if (!trimmed) { setError("Paste your key first."); return; }
    setBusy("save"); setError(null); setNote(null);
    try {
      const r = await api.saveOpenRouterKey(trimmed);
      setStatus(r.status); setCheck(r.check);
      // Cleared on success so the key is not left sitting in a field behind a closed screen.
      setKey("");
      setNote("Saved. Paid columns will run now.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "That key could not be saved.");
    } finally { setBusy(null); }
  };

  const recheck = async () => {
    setBusy("check"); setError(null); setNote(null);
    try {
      const r = await api.checkOpenRouterKey();
      setCheck(r.check);
      setNote(r.check.ok ? "Still working." : null);
      if (!r.check.ok) setError(r.check.error ?? "That key no longer works.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach the provider.");
    } finally { setBusy(null); }
  };

  const remove = async () => {
    setBusy("remove"); setError(null); setNote(null);
    try {
      const r = await api.removeOpenRouterKey();
      setStatus(r.status); setCheck(null);
      setNote("Key removed. Paid columns will stop running.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove the key.");
    } finally { setBusy(null); }
  };

  const money = (n: number | null | undefined) =>
    n == null ? null : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;

  const nameOf = (id: string) => models.find((m) => m.id === id)?.name ?? id;

  return (
    <div className="cc-setpage">
      <header className="cc-setpage__top">
        <button className="cc-btn cc-setpage__back" onClick={onClose}>← Back to the table</button>
        <h1 className="cc-setpage__h1">Settings</h1>
      </header>

      <div className="cc-setpage__body">
        <nav className="cc-setnav" aria-label="Settings sections">
          {sectionsFor(me).map((s) => (
            <button
              key={s.id}
              className={`cc-setnav__item${section === s.id ? " cc-setnav__item--on" : ""}`}
              aria-current={section === s.id ? "page" : undefined}
              onClick={() => onSection(s.id)}
            >
              <span className="cc-setnav__label">{s.label}</span>
              <span className="cc-setnav__blurb">{s.blurb}</span>
            </button>
          ))}
        </nav>

        <main className="cc-setmain">
          {/* ── what columns run on ──────────────────────────────────────────────────────────── */}
          {section === "models" && (
            <>
              <section className="cc-set__sec">
                <div className="cc-set__head">
                  <h2 className="cc-set__title">What columns run on</h2>
                  <span className="cc-set__pill cc-set__pill--on">
                    {run ? (run.model === "auto" ? "chosen for you" : "chosen") : "…"}
                  </span>
                </div>
                <p className="cc-set__lede">
                  Every column set to <strong>Engine default</strong> runs on this model. Set it to one
                  on your own machine and the whole workspace costs nothing per row by default, rather
                  than only the columns you remembered to change one at a time.
                </p>

                <div className="cc-set__field">
                  <span className="cc-set__label">Default model for columns</span>
                  <Select
                    label="Default model for columns"
                    value={run?.model ?? "auto"}
                    showLabel={false}
                    size="md"
                    options={[
                      { value: "auto", label: "Let the engine choose", hint: "cheapest that works" },
                      ...models.map((m) => ({ value: m.id, label: m.name, hint: hintOf(m), group: groupOf(m) })),
                    ]}
                    onChange={(v) => void saveRun(v)}
                  />
                </div>

                {/* The stored choice and the model actually running can differ — "auto" resolves to
                    the engine's pick, and a chosen model the provider has retired falls back. Showing
                    only the stored value would keep naming a model that is not the one running. */}
                {run && (
                  <p className="cc-set__hint">
                    {run.model === "auto"
                      ? <>Right now that is <strong>{nameOf(run.effective)}</strong>. The engine picks the cheapest model that can do the job, and follows it if the provider retires one.</>
                      : run.effective === run.model
                        ? <>Running on <strong>{nameOf(run.effective)}</strong>.</>
                        : <><strong>{nameOf(run.model)}</strong> is no longer available from the provider, so columns are running on <strong>{nameOf(run.effective)}</strong> instead. Pick another to make the choice yours again.</>}
                  </p>
                )}
              </section>

              {/* ── answers already bought ─────────────────────────────────────────────────────── */}
              <section className="cc-set__sec">
                <div className="cc-set__head">
                  <h2 className="cc-set__title">Reusing answers</h2>
                  <span className={`cc-set__pill${cache?.on ? " cc-set__pill--on" : ""}`}>
                    {cache == null ? "…" : cache.on ? "On" : "Off"}
                  </span>
                </div>
                <p className="cc-set__lede">
                  When the exact same question comes up again — the same instruction, the same row
                  values, the same model — the stored answer is used instead of buying it a second
                  time. It works across tables, so a company that appears in two lists is only paid
                  for once. Answers older than the age below are asked again.
                </p>

                <label className="cc-set__field">
                  <span className="cc-set__label">Reuse answers</span>
                  <span className="cc-set__row">
                    <input
                      type="checkbox"
                      checked={!!cache?.on}
                      onChange={(e) => void saveCache({ on: e.target.checked })}
                      aria-label="Reuse answers already bought"
                    />
                    <span className="cc-set__hint">
                      Off means every cell asks again, every time, and pays each time.
                    </span>
                  </span>
                </label>

                <label className="cc-set__field">
                  <span className="cc-set__label">
                    Ask again after
                    <span className="cc-set__sub"> — most of what you ask is a fact that can change</span>
                  </span>
                  <span className="cc-set__row">
                    <input
                      className="cc-input cc-input--num"
                      inputMode="numeric"
                      defaultValue={String(cache?.days ?? 30)}
                      key={cache?.days ?? 30}
                      aria-label="Days before an answer is asked again"
                      onBlur={(e) => void saveCache({ days: Number(e.target.value) })}
                      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                    />
                    <span className="cc-set__hint">days</span>
                  </span>
                </label>

                {/* Counted, not claimed. "Reusing answers is on" is a setting; "1,204 answers stored
                    and reused 3,891 times" is the evidence that it is worth having on. */}
                {cache && (
                  <p className="cc-set__hint">
                    {cache.stats.entries === 0
                      ? "Nothing stored yet — answers are remembered as columns run."
                      : <>
                          <strong>{cache.stats.entries.toLocaleString()}</strong> answers stored, reused{" "}
                          <strong>{cache.stats.hits.toLocaleString()}</strong> times.
                          {cache.stats.stale > 0 && <> {cache.stats.stale.toLocaleString()} are past the age above and will be asked again.</>}
                        </>}
                  </p>
                )}

                <div className="cc-set__row">
                  <button
                    className="cc-btn cc-btn--danger"
                    disabled={!cache?.stats.entries}
                    onClick={() => void clearCacheNow()}
                  >
                    <IconTrash /> Forget all stored answers
                  </button>
                </div>
              </section>

              {/* ── which model DESIGNS a column ───────────────────────────────────────────────── */}
              <section className="cc-set__sec">
                <div className="cc-set__head">
                  <h2 className="cc-set__title">What builds columns for you</h2>
                  <span className={`cc-set__pill${setup?.freeOnly ? " cc-set__pill--on" : ""}`}>
                    {setup == null ? "…" : setup.freeOnly ? "free only" : setupPrice(setup)}
                  </span>
                </div>
                <p className="cc-set__lede">
                  This is the model that <strong>sets a column up</strong> when you describe what you
                  want — not the one above, which runs it on every row. Setting up happens once, so it
                  is worth a better model; running happens on every row, so that one is worth being
                  careful about.
                </p>

                <div className="cc-set__field">
                  <span className="cc-set__label">Model that designs columns</span>
                  <Select
                    label="Model that designs columns"
                    value={setup?.model ?? "auto"}
                    showLabel={false}
                    size="md"
                    options={[
                      { value: "auto", label: "Engine default", hint: "recommended" },
                      ...designable.map((m) => ({ value: m.id, label: m.name, hint: hintOf(m), group: groupOf(m) })),
                    ]}
                    onChange={(v) => void saveSetup({ model: v })}
                  />
                </div>

                {/* A guard, not a preference — which is why it is phrased as a promise about what
                    CANNOT happen rather than as "prefer free models". */}
                <label className="cc-set__check">
                  <input
                    type="checkbox"
                    checked={!!setup?.freeOnly}
                    onChange={(e) => void saveSetup({ freeOnly: e.target.checked })}
                  />
                  <span>
                    <strong>Only design with free models.</strong> Setting up a column then cannot cost
                    anything: if the chosen model bills, or its price cannot be confirmed, the request
                    is refused before it is sent rather than after. Free models are rate-limited, so
                    this can be slower, and it never affects what your columns run on.
                  </span>
                </label>

                {setup && !setup.freeOnly && (
                  <p className="cc-set__hint">
                    {setup.estimateUsd == null
                      ? "This model is not in the published price list, so a design call cannot be costed in advance."
                      : setup.estimateUsd === 0
                        ? "This model is free, so designing a column costs nothing."
                        : `About ${setupPrice(setup)} each time you press “Set it up”. Nothing runs on your rows.`}
                  </p>
                )}
              </section>
            </>
          )}

          {/* ── on this machine ──────────────────────────────────────────────────────────────── */}
          {section === "local" && (
            <section className="cc-set__sec">
              <div className="cc-set__head">
                <h2 className="cc-set__title">On this machine</h2>
                <span className={`cc-set__pill${locals.length ? " cc-set__pill--on" : ""}`}>
                  {runtimes == null ? "…" : locals.length ? `${locals.length} available` : "None found"}
                </span>
              </div>
              <p className="cc-set__lede">
                A model running on your own computer needs no key and costs nothing, however many rows
                you run it over. It is the right choice for tidying, classifying and pulling fields out
                of text. Ferrum looks for these automatically — the addresses below only matter if
                yours is somewhere unusual.
              </p>

              {/* Running first, expanded. Eight address forms stacked open would bury the one
                  runtime that is actually answering under seven that are not — so the rest collapse
                  to a line each, and open on request. */}
              {runtimes?.filter((rt) => rt.detected > 0).map((rt) => (
                <div key={rt.id} className="cc-set__rt">
                  <div className="cc-set__head">
                    <h3 className="cc-set__rtname">{rt.label}</h3>
                    <span className="cc-set__pill cc-set__pill--on">
                      {rt.detected} model{rt.detected === 1 ? "" : "s"}
                    </span>
                  </div>

                  <ul className="cc-set__list">
                    {rt.models.slice(0, 8).map((m) => (
                      <li key={m.id} className="cc-set__item">
                        <span className="cc-set__item-name">{m.name}</span>
                        {/* "on device", not "free". Both bill nothing, and calling them the same
                            thing misleads in opposite directions: a hosted free model is
                            rate-limited by someone else, a local one by your own machine. */}
                        <span className="cc-set__free">on device</span>
                      </li>
                    ))}
                  </ul>
                  {rt.models.length > 8 && (
                    // Stated, not silently cut. A list that stops at eight without saying so reads
                    // as "these are all of them".
                    <p className="cc-set__hint">and {rt.models.length - 8} more</p>
                  )}

                  <RuntimeAddress
                    rt={rt}
                    onSave={(url) => void saveRuntimeUrl(rt.id, url)}
                    onSaveKey={(key) => void saveRuntimeKey(rt.id, key)}
                  />
                </div>
              ))}

              {runtimes != null && (
                <details className="cc-set__more">
                  <summary className="cc-set__moresum">
                    {runtimes.some((rt) => rt.detected > 0)
                      ? "Other places a model can run here"
                      : "Where Ferrum looked"}
                    {" "}({runtimes.filter((rt) => rt.detected === 0).length})
                  </summary>
                  <ul className="cc-set__quiet">
                    {runtimes.filter((rt) => rt.detected === 0).map((rt) => (
                      <li key={rt.id} className="cc-set__quietrow">
                        <div className="cc-set__quietmain">
                          <span className="cc-set__quietname">{rt.label}</span>
                          <p className="cc-set__quietnote">{rt.note}</p>
                        </div>
                        <RuntimeAddress
                          rt={rt}
                          onSave={(url) => void saveRuntimeUrl(rt.id, url)}
                          onSaveKey={(key) => void saveRuntimeKey(rt.id, key)}
                        />
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {runtimes != null && locals.length === 0 && (
                <p className="cc-set__hint">
                  Nothing answered at any of those addresses. Install one of them, start it, load a
                  model, then press Check. If yours runs somewhere else, put its address in above.
                </p>
              )}

              <div className="cc-set__msg" role="status" aria-live="polite">
                {error && <span className="cc-set__err"><IconAlert /> {error}</span>}
                {!error && note && <span className="cc-set__ok"><IconCheck /> {note}</span>}
              </div>
            </section>
          )}

          {/* ── hosted ───────────────────────────────────────────────────────────────────────── */}
          {section === "openrouter" && (
            <section className="cc-set__sec">
              <div className="cc-set__head">
                <h2 className="cc-set__title">OpenRouter</h2>
                <span className={`cc-set__pill${status?.present ? " cc-set__pill--on" : ""}`}>
                  {status == null ? "…" : status.present ? "Connected" : "Not set up"}
                </span>
              </div>
              <p className="cc-set__lede">
                One key reaches hundreds of models. Needed for anything that is not running on this
                machine — and charged per row, by whoever made the model.
              </p>

              {status?.present ? (
                <>
                  <dl className="cc-set__facts">
                    <div className="cc-set__fact"><dt>Key</dt><dd className="cc-set__mono">{status.label ?? "—"}</dd></div>
                    {/* Only when the provider's own name for the key says something the masked key
                        does not. OpenRouter defaults that name to the key's own prefix, so showing it
                        unconditionally printed the same string twice under two different labels. */}
                    {check?.label && !check.label.startsWith("sk-") && (
                      <div className="cc-set__fact"><dt>Named</dt><dd>{check.label}</dd></div>
                    )}
                    <div className="cc-set__fact">
                      <dt>Credit left</dt>
                      <dd>
                        {check == null ? "checking…"
                          : check.remainingUsd == null ? "No limit set on this key"
                          : money(check.remainingUsd)}
                      </dd>
                    </div>
                    {check?.usageUsd != null && (
                      <div className="cc-set__fact"><dt>Spent so far</dt><dd>{money(check.usageUsd)}</dd></div>
                    )}
                  </dl>

                  {check?.freeTierOnly && (
                    <p className="cc-set__warn">
                      <IconAlert />
                      <span>
                        This key can only call <strong>free</strong> models. A column that searches the
                        web will fail on every row — add credit at OpenRouter, or point those columns
                        at a free model.
                      </span>
                    </p>
                  )}

                  <div className="cc-set__row">
                    <button className="cc-btn" onClick={recheck} disabled={busy != null}>
                      {busy === "check" ? "Checking…" : "Check again"}
                    </button>
                    <button className="cc-btn cc-btn--danger" onClick={remove} disabled={busy != null}>
                      <IconTrash /> {busy === "remove" ? "Removing…" : "Remove key"}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <label className="cc-set__field">
                    <span className="cc-set__label">Paste your key</span>
                    <input
                      className="cc-input"
                      type="password"
                      value={key}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="sk-or-v1-…"
                      onChange={(e) => setKey(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !busy) void save(); }}
                      aria-label="OpenRouter API key"
                    />
                  </label>
                  <p className="cc-set__hint">
                    It is checked with OpenRouter before it is saved, so you find out here rather than
                    on row one of a long run.{" "}
                    <a className="cc-set__link" href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">
                      Get a key <IconExternal />
                    </a>
                  </p>
                  <div className="cc-set__row">
                    <button className="cc-btn cc-btn--primary" onClick={save} disabled={busy != null || !key.trim()}>
                      {busy === "save" ? "Checking…" : "Save key"}
                    </button>
                  </div>
                </>
              )}

              {/* Both messages occupy the same reserved strip, so neither appearing can move the
                  buttons above it — the layout must not shift under a pointer about to click again. */}
              <div className="cc-set__msg" role="status" aria-live="polite">
                {error && <span className="cc-set__err"><IconAlert /> {error}</span>}
                {!error && note && <span className="cc-set__ok"><IconCheck /> {note}</span>}
              </div>
            </section>
          )}

          {section === "providers" && <Providers />}

          {section === "search" && <Search />}

          {section === "apps" && <McpServers />}
          {section === "keys" && <Keys />}

          {section === "people" && <People me={me} onSessionChanged={onSessionChanged} />}

          {section === "account" && <Account me={me} onSessionChanged={onSessionChanged} />}

          {section === "usage" && (
            <section className="cc-set__sec">
              <div className="cc-set__head">
                <h2 className="cc-set__title">Usage and cost</h2>
              </div>
              <p className="cc-set__lede">
                Every cell that has run, what it cost, and where the money went. Counted as each cell
                finishes, so this is what actually happened rather than an estimate of it.
              </p>
              <Usage scope={usageScope} scopeId={usageScopeId} onScope={onUsageScope} />
            </section>
          )}

          <p className="cc-set__foot">
            Keys and addresses are stored on this machine only, in the app's own data folder.
          </p>
        </main>
      </div>
    </div>
  );
}

/**
 * One runtime's address.
 *
 * Local state rather than saving per keystroke: an address is only meaningful once it is finished
 * being typed, and probing "http://12" on the way to "http://127.0.0.1:11434" would report a string
 * of failures for a value nobody meant.
 */
function RuntimeAddress({
  rt, onSave, onSaveKey,
}: {
  rt: Runtime;
  onSave: (url: string) => void;
  onSaveKey: (key: string) => void;
}) {
  const [url, setUrl] = useState(rt.url);
  const [key, setKey] = useState("");
  // Re-synced when the server reports a different address than what is on screen — a rejected value
  // falls back, and leaving the refused text in the box implies it was accepted.
  useEffect(() => { setUrl(rt.url); }, [rt.url]);

  const dirty = url.trim() !== rt.url;

  return (
    <div className="cc-set__addr">
      <label className="cc-set__field">
        <span className="cc-set__label">
          Address
          {rt.isDefault && <span className="cc-set__sub"> the usual one — leave it unless yours differs</span>}
        </span>
        <input
          className="cc-input mono"
          type="text"
          value={url}
          spellCheck={false}
          autoComplete="off"
          placeholder={rt.defaultUrl}
          aria-label={`${rt.label} address`}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onSave(url); }}
        />
      </label>
      {/* Only for the runtimes that genuinely refuse without one. Showing a key box on Ollama would
          imply it needs a key it has never asked for, and half the point of a local model is that
          there is nothing to sign up for. */}
      {rt.needsKey && (
        <label className="cc-set__field">
          <span className="cc-set__label">
            Access token
            <span className="cc-set__sub">
              {rt.hasKey
                ? " — saved. Type a new one to replace it."
                : " — this one will not answer without it, so it reads as not running until you add one."}
            </span>
          </span>
          <input
            className="cc-input"
            type="password"
            value={key}
            spellCheck={false}
            autoComplete="off"
            placeholder={rt.hasKey ? "••••••••" : ""}
            aria-label={`${rt.label} access token`}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { onSaveKey(key); setKey(""); } }}
          />
        </label>
      )}

      <div className="cc-set__row">
        <button className="cc-btn" onClick={() => onSave(url)}>
          {dirty ? "Save and check" : "Check"}
        </button>
        {rt.needsKey && (
          <button className="cc-btn" onClick={() => { onSaveKey(key); setKey(""); }} disabled={!key.trim() && !rt.hasKey}>
            {key.trim() ? "Save token" : "Remove token"}
          </button>
        )}
        {!rt.isDefault && (
          <button className="cc-btn" onClick={() => onSave("")}>Reset to the usual address</button>
        )}
      </div>
    </div>
  );
}
