// Web-search settings for one column.
//
// The right answer differs per column: a pricing lookup wants the company's own domain and two
// results, a market-research column wants ten and no restriction.
//
// ── Two layers, and this screen must show both ──────────────────────────────────────────────────
//
// WHO runs the search — Serper, Exa, Jina, Spider, Firecrawl, Tavily, Brave, OpenRouter's own, or an
// engine you describe yourself — is ONE choice for the whole workspace, made in Settings → Search
// with that company's key. Nothing on this tab changes it.
//
// This file's controls are OpenRouter's web-plugin options. They mean something when the workspace
// is set to OpenRouter and nothing at all when it is not: a direct backend is handed the query, the
// result count and the domain lists, and nothing else. A dropdown here labelled "Search engine",
// listing engines that are not Ferrum backends (Parallel, Perplexity) while hiding five that are,
// leaves the engine that will actually run unnamed anywhere on the screen.
//
// So the tab opens by saying which engine will run and where to change it, and every control below
// appears only if that engine reads it.
//
// The rule, restated, because it is the whole point: never show a control that does nothing. A
// visible, changeable, silently ignored control is worse than a missing one — the user believes
// their results were filtered and acts on output that was not.

import { useCallback, useEffect, useRef, useState } from "react";
import { Select } from "../ui/Select.tsx";
import { useAutosave } from "../ui/useAutosave.ts";
import { searchCostUsd } from "./cost.ts";
import "./SearchSettings.css";

export interface WebSearchSettings {
  engine: string;
  maxResults: number;
  includeDomains: string[];
  excludeDomains: string[];
  contextSize: "low" | "medium" | "high" | null;
  searchPrompt: string;
  /**
   * The two ceilings on one cell's searching. `0` means no ceiling, for both.
   *
   * `src/agent/executor.ts` reads these from `agent.search`, so this type has to carry them. A
   * behaviour the engine honours with no control on the screen is this file's own rule broken from
   * the other direction: not a control that does nothing, but a limit nobody can reach.
   */
  maxSpendUsd: number;
  maxSearches: number;
}

export const DEFAULT_SEARCH: WebSearchSettings = {
  engine: "auto",
  maxResults: 5,
  includeDomains: [],
  excludeDomains: [],
  contextSize: null,
  searchPrompt: "",
  // The engine's own defaults, repeated here so a column that has never been edited shows the
  // numbers it is actually running under rather than a blank box.
  maxSpendUsd: 0.003,
  maxSearches: 1,
};

const ENGINES = [
  { value: "auto", label: "Automatic" },
  { value: "exa", label: "Exa" },
  { value: "native", label: "The model's own search" },
  { value: "firecrawl", label: "Firecrawl" },
  { value: "parallel", label: "Parallel" },
  { value: "perplexity", label: "Perplexity" },
];

const CONTEXT = [
  { value: "", label: "Provider default" },
  { value: "low", label: "Low — cheapest" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High — most page content" },
];

/** Native search is run by the model's own vendor, and they do not agree on what they support. */
const NATIVE_ONLY = new Set(["native"]);

/**
 * Which engines the depth setting reaches.
 *
 * One predicate, used both to decide whether the control is offered and to decide whether switching
 * engine clears the stored value. They were two expressions and disagreed: picking "Automatic"
 * wiped the depth while the control above it still read as available.
 */
const keepsContext = (engine: string) => NATIVE_ONLY.has(engine) || engine === "auto";

interface Props {
  value: WebSearchSettings;
  onChange: (next: WebSearchSettings) => void;
  /** Shown inline so a mistake is visible next to the control that caused it. */
  error?: string | null;
  busy?: boolean;
}

const toLines = (list: string[]) => list.join("\n");
const fromLines = (s: string) =>
  s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

export function SearchSettings({ value, onChange, error, busy }: Props) {
  // The textareas are edited as raw text and parsed on the way out. Parsing on every keystroke turns
  // "acme.com, globex.com" into a list the moment you type the comma, and the cursor jumps.
  const [includeText, setIncludeText] = useState(toLines(value.includeDomains));
  const [excludeText, setExcludeText] = useState(toLines(value.excludeDomains));
  const includeRef = useRef<HTMLTextAreaElement>(null);
  const excludeRef = useRef<HTMLTextAreaElement>(null);

  /**
   * The current settings, readable synchronously.
   *
   * A patch built from the `value` prop is built from whatever the parent last SAVED, and a domain
   * list typed a moment ago has not been saved yet. Two edits inside one debounce window would drop
   * the first.
   */
  const latest = useRef(value);
  useEffect(() => { latest.current = value; }, [value]);

  /**
   * The domain boxes save themselves shortly after typing stops.
   *
   * They committed on blur alone, and the drawer closes on mousedown and on Escape without waiting
   * for one — so a typed allowlist was silently thrown away and the next paid run searched the whole
   * web. `useAutosave` also flushes on unmount, which is what makes closing the drawer mid-word
   * keep the word. This is also why they stay out of the drawer's unsaved-changes check: there is
   * nothing left to lose by closing.
   */
  const autosave = useAutosave<WebSearchSettings>(
    useCallback((next: WebSearchSettings) => onChange(next), [onChange]),
  );

  const set = (patch: Partial<WebSearchSettings>) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    // Absorbs anything the domain boxes have pending — `next` already carries it — so an immediate
    // control cannot fire after a debounce and overwrite it with a stale copy.
    autosave.markSaved(next);
    onChange(next);
  };

  const editDomains = (patch: Partial<WebSearchSettings>) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    autosave.schedule(next);
  };

  // The server normalizes what it stores — a pasted URL comes back as a bare domain — so the boxes
  // adopt the saved value once it lands. Without this the screen keeps showing
  // "https://www.acme.com/pricing" while "acme.com/pricing" is what was actually saved, and the
  // discrepancy only surfaces the next time the drawer is opened. Never while the box has the caret
  // in it, though: rewriting a list under someone mid-line is worse than showing it a beat late.
  const savedInclude = toLines(value.includeDomains);
  const savedExclude = toLines(value.excludeDomains);
  useEffect(() => {
    if (document.activeElement !== includeRef.current) setIncludeText(savedInclude);
  }, [savedInclude]);
  useEffect(() => {
    if (document.activeElement !== excludeRef.current) setExcludeText(savedExclude);
  }, [savedExclude]);

  /**
   * Which search company will actually run these searches.
   *
   * ── The confusion this exists to end ──────────────────────────────────────────────────────────
   *
   * There are two layers, and this screen must not show only the lower one. WHO searches — Serper,
   * Exa, Jina, Brave, Tavily and the rest — is one choice for the whole workspace, made in
   * Settings → Search, with that company's key. This tab's "Search engine" dropdown was something
   * else entirely: OpenRouter's own web-plugin engine, meaningful only when the workspace is set to
   * OpenRouter, and inert the moment it is not.
   *
   * Two controls with the same label, on two screens, with overlapping option names that mean
   * different things — "Exa" here meant "ask OpenRouter to use its Exa plugin", "Exa" there meant
   * "call Exa directly with your key" — while the list here offered two engines that are not
   * backends at all and hid five that are. Anyone looking for their search engine came to this
   * screen first, because it has the right label, and found the wrong options and no bearing on the
   * engine actually in use.
   *
   * So the tab now opens by naming the engine that will run, and every control below it is shown
   * only if THAT engine reads it — which is this file's own stated rule, applied to itself.
   */
  const [backend, setBackend] = useState<{ id: string; label: string; domains: boolean; perSearchUsd: number | null } | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/search").then((r) => r.json());
        if (!live) return;
        const id = String(res.chosen ?? "openrouter");
        const spec = (res.builtins ?? []).find((b: { id: string }) => b.id === id);
        const custom = (res.custom ?? []).find((c: { id: string }) => c.id === id);
        setBackend({
          id,
          label: String(spec?.label ?? custom?.label ?? id),
          // A backend that cannot filter by domain is not shown the boxes. The registry knows;
          // guessing from the id would go stale the day a backend gains the feature.
          domains: spec ? !!spec.supportsDomainFilter : true,
          // The price the SETTINGS screen shows for this engine — the user's figure if they typed
          // one, else its list price — so the two screens cannot quote different rates for the
          // same search.
          perSearchUsd: typeof spec?.perSearchUsd === "number" ? spec.perSearchUsd
            : typeof custom?.perSearchUsd === "number" ? custom.perSearchUsd
            : null,
        });
      } catch {
        // Unknown rather than assumed. A wrong claim about which engine is running is worse than no
        // claim, so the banner says it could not check and every control stays visible.
        if (live) setBackend(null);
      }
    })();
    return () => { live = false; };
  }, []);

  /** OpenRouter's plugin settings only mean anything when OpenRouter is the one searching. */
  const viaOpenRouter = backend?.id === "openrouter";
  const contextAvailable = viaOpenRouter && keepsContext(value.engine);

  /**
   * What one search costs on the engine that will actually run it.
   *
   * This was `searchCostUsd(maxResults)` unconditionally — OpenRouter's Exa rate — so with Serper
   * chosen the tab quoted $0.005 against a real list price of $0.001. Five times over, beside the
   * one control that changes it, on the screen whose entire job is making search spend visible.
   *
   * The engine's own figure now, which is the user's typed price when they set one and the list
   * price otherwise. Falls back to the old estimate only when the engine could not be identified —
   * an unknown price is worth saying, but a blank where a number belongs is not.
   */
  const perSearch = backend?.perSearchUsd ?? searchCostUsd(value.maxResults);

  return (
    <div className="cc-ss">
      <p className="cc-ss__intro">
        Used when this column's agent calls <code>web_search</code>. Fetching a page it already knows
        the address of stays free — these settings only affect looking something up.
      </p>

      {/* Which engine will actually run, said before anything asks you to configure it. Without this
          line the tab looked like the place you chose the engine, and it never was. */}
      <div className="cc-ss__who" role="status">
        {backend ? (
          <>
            Searches run through <strong>{backend.label}</strong>.{" "}
            <span className="cc-ss__whohint">
              That is one choice for the whole workspace — change it, or add a key, in
              {" "}<strong>Settings → Search</strong>.
            </span>
          </>
        ) : (
          <>
            Could not check which search engine is set for this workspace. It is chosen in
            {" "}<strong>Settings → Search</strong>.
          </>
        )}
      </div>

      {/* Shown ONLY when OpenRouter is the one searching, because it is OpenRouter's setting.
          On every column, labelled "Search engine", it lists engines that are not Ferrum backends
          while the engine that will really run is chosen on another screen and named nowhere on this
          one. */}
      {viaOpenRouter && (
        <div className="cc-field">
          <span className="cc-field__label">Which engine OpenRouter uses</span>
          <Select
            label="OpenRouter search engine"
            value={value.engine}
            options={ENGINES}
            size="md"
            showLabel={false}
            onChange={(v) => set({ engine: v, ...(keepsContext(v) ? {} : { contextSize: null }) })}
          />
          <span className="cc-field__hint">
            {value.engine === "auto"
              ? "Uses the model's own search when it has one, and Exa otherwise."
              : value.engine === "native"
                ? "The model vendor's own search. Cheapest with models that include it, but each vendor supports different filters — see the note below."
                : "One of the engines OpenRouter can search with on your behalf. Not the same as choosing that company directly in Settings → Search, which uses your own key with them."}
          </span>
        </div>
      )}

      <label className="cc-field">
        <span className="cc-field__label">
          Results per search
          <span className="cc-field__sub">≈ ${perSearch.toFixed(3)} per search, est.</span>
        </span>
        {/* `size` so the box hugs its content instead of stretching across the drawer. */}
        <input
          className="cc-input cc-input--num"
          type="number"
          min={1}
          max={50}
          size={4}
          value={value.maxResults}
          disabled={busy}
          onChange={(e) => set({ maxResults: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })}
        />
        <span className="cc-field__hint">
          More results give the model more to work with and cost more. Five is usually enough to find
          a specific fact; raise it for questions with no single right page.
        </span>
      </label>

      {/* ── the two ceilings on one cell's searching ──────────────────────
          Both, because they fail differently: the money cap cannot bound a search whose price the
          provider declines to report, and the count cap cannot bound one that turns out to be
          expensive. The engine has enforced both from the start; neither had a box until now. */}
      <label className="cc-field">
        <span className="cc-field__label">
          Searches per cell
          <span className="cc-field__sub">0 for no limit</span>
        </span>
        <input
          className="cc-input cc-input--num"
          type="number"
          min={0}
          max={16}
          size={4}
          value={value.maxSearches}
          disabled={busy}
          aria-label="How many web searches one cell may run"
          onChange={(e) => set({ maxSearches: Math.max(0, Math.min(16, Math.floor(Number(e.target.value) || 0))) })}
        />
        <span className="cc-field__hint">
          One is deliberately tight: a single good query answers most questions, and reading a page
          the model already has the address for is free and unlimited. Raise it for questions that
          genuinely need several places checked.
        </span>
      </label>

      <label className="cc-field">
        <span className="cc-field__label">
          Most one cell may spend searching
          <span className="cc-field__sub">US dollars, 0 for no limit</span>
        </span>
        <input
          className="cc-input cc-input--num"
          type="number"
          min={0}
          step="0.001"
          size={6}
          value={value.maxSpendUsd}
          disabled={busy}
          aria-label="The most one cell may spend on web searches, in dollars"
          onChange={(e) => set({ maxSpendUsd: Math.max(0, Number(e.target.value) || 0) })}
        />
        <span className="cc-field__hint">
          Checked before each search, and the next one is priced from what the last one really cost,
          so it cannot be stepped over. The first search of a cell always runs, so setting this too
          low slows the column down rather than switching searching off.
        </span>
      </label>

      {/* Hidden when the chosen engine cannot filter by domain — the registry says which can. A
          filter that is quietly dropped on the way out is worse than no filter: you would believe
          the column only ever read the company site. */}
      {(backend?.domains ?? true) && (
      <>
      <label className="cc-field">
        <span className="cc-field__label">Only search these sites</span>
        <textarea
          ref={includeRef}
          className="cc-textarea cc-textarea--sm"
          rows={3}
          placeholder={"acme.com\n*.acme.com\nacme.com/blog"}
          value={includeText}
          disabled={busy}
          onChange={(e) => { setIncludeText(e.target.value); editDomains({ includeDomains: fromLines(e.target.value) }); }}
          onBlur={autosave.flush}
        />
        <span className="cc-field__hint">
          One per line. Leave empty to search the whole web. Useful when the answer is only ever on
          the company's own site.
        </span>
      </label>

      <label className="cc-field">
        <span className="cc-field__label">Never search these sites</span>
        <textarea
          ref={excludeRef}
          className="cc-textarea cc-textarea--sm"
          rows={2}
          placeholder={"linkedin.com\npinterest.com"}
          value={excludeText}
          disabled={busy}
          onChange={(e) => { setExcludeText(e.target.value); editDomains({ excludeDomains: fromLines(e.target.value) }); }}
          onBlur={autosave.flush}
        />
      </label>
      </>
      )}

      {viaOpenRouter && value.engine === "native" && (value.includeDomains.length > 0 || value.excludeDomains.length > 0) && (
        <div className="cc-ss__warn" role="status">
          With the model's own search, site filtering depends on the model vendor: some accept only
          one of the two lists, and some ignore filtering entirely. Choose Exa if the filter has to
          be reliable.
        </div>
      )}

      {/* OpenRouter-plugin only. It was shown on every column with a note explaining it might not
          apply — which is a control that does nothing wearing an apology. */}
      {viaOpenRouter && (
      <div className="cc-field">
        <span className="cc-field__label">
          How much of each page to read
          {!contextAvailable && <span className="cc-field__sub">not used by this engine</span>}
        </span>
        <Select
          label="Depth"
          value={value.contextSize ?? ""}
          options={CONTEXT}
          size="md"
          showLabel={false}
          onChange={(v) => set({ contextSize: (v || null) as WebSearchSettings["contextSize"] })}
        />
        <span className="cc-field__hint">
          {contextAvailable
            ? "Only applies to the model's own search. More depth means more of each page is read, and a higher bill."
            : "This setting is part of the model vendor's own search, so it has no effect on the engine selected above. It is kept in case you switch back."}
        </span>
      </div>
      )}

      {/* Also OpenRouter-plugin only: a direct backend is handed the query, the result count and
          the domain lists, and nothing else. This sentence never reached Serper or Brave. */}
      {viaOpenRouter && (
      <details className="cc-ss__adv">
        <summary>Advanced</summary>
        <label className="cc-field">
          <span className="cc-field__label">Instruction attached to the results</span>
          <textarea
            className="cc-textarea cc-textarea--sm"
            rows={3}
            placeholder="Leave empty to use the provider's default, which asks the model to cite its sources."
            value={value.searchPrompt}
            disabled={busy}
            onChange={(e) => set({ searchPrompt: e.target.value })}
          />
          <span className="cc-field__hint">
            Replaces the sentence put in front of the search results. The default already asks for
            citations, so changing this can lose the source links.
          </span>
        </label>
      </details>
      )}

      {error && <div className="cc-errors" role="alert"><div className="cc-errors__row">{error}</div></div>}
    </div>
  );
}
