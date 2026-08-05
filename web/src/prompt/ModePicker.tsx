// How this column gets its value — the lane picker.
//
// This screen exists because the two ways to get a column wrong are BOTH expensive, in opposite
// directions, and neither announces itself:
//
//   Picking "Model + web search" when the answer was already in the row costs roughly 90x what it
//   needed to. On a million rows that is thousands of dollars for something a rule would have done
//   for nothing.
//
//   Picking "Model" when the answer was NOT in the row costs almost nothing and is far worse: the
//   model cannot say "I would have to look this up", so it guesses. You get a full column of
//   confident, plausible, wrong values and no error anywhere to tell you.
//
// So the choice is not buried in a dropdown labelled "kind". It is a comparison at the moment of
// deciding, with the price of each option next to it, priced against THIS sheet's row count rather
// than a generic per-1000 figure — because "$7 per 1,000 rows" and "$7,000 for your sheet" are the
// same number and only one of them changes what people do.

import { useMemo, useState } from "react";
import type { Column } from "../api.ts";
import {
  AGENT_SEARCH_CEILING, AGENT_TYPICAL_SEARCHES, estimateForKind, priceLabel, ratio, usd, type CostBasis,
} from "./cost.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { IconSearch } from "../ui/Icon.tsx";
import { ColumnKindIcon } from "../ui/ColumnKindIcon.tsx";
import { badgeForKind } from "../ui/columnBadge.ts";
// The catalogue and its search live next door so they can be tested — importing this file pulls in
// its stylesheet, which a test runner cannot load.
import { filterModes, MODES, type Mode } from "./modes.ts";
import "./ModePicker.css";

interface Props {
  column: Column;
  /**
   * Whether the request keeps its reply — LIVE, not read back off `column`.
   *
   * The `column` prop is a snapshot taken when the drawer opened, so reading the stored config here
   * meant picking "Send it somewhere" left "Call an API" highlighted with its explanation expanded:
   * the user could believe replies were being kept on a column that is fire-and-forget.
   */
  fireAndForget: boolean;
  /** Row count of the sheet, so the estimate is about this sheet rather than a generic 1,000. */
  rowCount: number;
  /** Jump to the condition editor. The cheapest fix for an expensive mode, so it is offered there. */
  onOpenCondition?: () => void;
  /**
   * The screen this mode now needs filling in, as a button rather than an automatic jump.
   *
   * Picking a card used to move you to that screen immediately, which meant the card's explanation
   * — the thing you clicked the card to read — appeared and disappeared in the same frame.
   */
  onContinue?: { label: string; go: () => void };
  /** Search settings feed the estimate — more results per search costs more per row. */
  basis: CostBasis;
  onPick: (mode: Mode, httpPreset?: { fireAndForget: boolean }) => void;
  /** The column's stored model, or "auto". */
  model?: string | null;
  onModelChange?: (modelId: string) => void;
  busy?: boolean;
  error?: string | null;
}

export function ModePicker({ column, fireAndForget, rowCount, basis, onPick, model, onModelChange, busy, error, onOpenCondition, onContinue }: Props) {
  // Which CARD is selected. Both http cards share a lane, so the fireAndForget flag is what tells
  // them apart — without it, picking "Send it somewhere" would light up "Call an API" too.
  const currentKind = column.kind as Mode;
  const currentId =
    currentKind === "http" ? (fireAndForget ? "http-send" : "http-get") : currentKind;
  const estimates = new Map(MODES.map((m) => [m.id, estimateForKind(m.mode, rowCount, basis)]));
  const aiCost = estimates.get("ai")!.total;
  const agentCost = estimates.get("agent")!.total;

  const [query, setQuery] = useState("");
  const shown = useMemo(() => filterModes(query), [query]);

  // Money sentences only make sense once there is a real rate to state. A price list that has not
  // answered has no number to give, and a local model bills nothing at all — "would run at roughly
  // $0 instead of $0" is a true sentence that tells the reader nothing.
  const hasPrices = basis.priced && !basis.local;

  return (
    <div className="cc-mode">
      <p className="cc-mode__intro">
        Pick by answering one question: <strong>where does the answer come from?</strong> Each mode
        below states the case it is for.{" "}
        {rowCount === 0 ? (
          // Said plainly, because "the prices are for this sheet's 0 rows" is a sentence that reads
          // as a price and is not one. This is the normal state when a table is being set up, and
          // the whole screen is about a decision made before the rows arrive.
          <>
            This table has no rows yet, so the prices below are <strong>per thousand rows</strong>{" "}
            rather than a total.
          </>
        ) : (
          <>
            The prices are for this table's {rowCount.toLocaleString()}{" "}
            {rowCount === 1 ? "row" : "rows"}, estimated — see the note at the bottom.
          </>
        )}
      </p>

      {/* Nine lanes is more than anyone reads top to bottom, and the person who knows exactly what
          they want — "http api", "webhook", "rollup" — was previously made to read all nine to find
          it. Matches the industry name and a pile of synonyms, not just what is on screen. */}
      <label className="cc-search cc-mode__search">
        <span className="cc-search__icon" aria-hidden><IconSearch /></span>
        <input
          type="search"
          value={query}
          placeholder="Search — http api, webhook, lookup, rollup, formula…"
          aria-label="Search the ways a column can get its value"
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      {shown.length === 0 && (
        <p className="cc-mode__none" role="status">
          Nothing matches “{query}”. Ferrum has twelve ways to fill a column — clear the search to see
          them all, or try the word for what the value IS rather than for the tool that makes it.
        </p>
      )}

      <div className="cc-mode__list" role="radiogroup" aria-label="How this column gets its value">
        {shown.map((m) => {
          // Keyed by card id, not by lane: two cards share the http lane, so a lane lookup misses
          // for both of them. `!` hid that from the compiler and it surfaced as a blank screen.
          const est = estimates.get(m.id)!;
          const on = currentId === m.id;
          // A lane that never bills per row reads "free" whatever the price list says. Only the two
          // model lanes have to wait for a rate, and they say "—" rather than borrow one.
          const billsPerRow = m.mode === "ai" || m.mode === "agent";
          // An http lane bills SOMEBODY, just not us, so it may not read "free" — the run
          // confirmation calls the same column external, and the two screens are one decision.
          // On a sheet with no rows the per-row lanes quote a RATE rather than a total of zero;
          // see `priceLabel`, which is where that decision and its reasoning live.
          const price = priceLabel(est, rowCount, { billsPerRow, priced: basis.priced });
          return (
            <button
              key={m.id}
              role="radio"
              aria-checked={on}
              disabled={busy}
              className={`cc-mode__card${on ? " cc-mode__card--on" : ""}`}
              onClick={() => { if (!on) onPick(m.mode, m.httpPreset); }}
            >
              <span className="cc-mode__head">
                {/* The same mark this lane wears on the grid header and in the drawer title.
                    The icons only teach anything if they are the same in the place you CHOOSE a
                    kind and the place you later look at what you chose — two vocabularies and the
                    reader learns neither, only that the marks are decoration. */}
                <ColumnKindIcon kind={badgeForKind(m.mode)} />
                <span className="cc-mode__title">{m.title}</span>
                {/* The industry name, beside the plain-English one. Both readers are real and often
                    on the same team: one does not know what HTTP is, the other is looking for
                    exactly that word and concluding it is missing when it is not on screen. */}
                <span className="cc-mode__tag mono">{m.tag}</span>
                {/* Right-pinned against a left-pinned title, so the card spans its width rather
                    than leaving a void beside a short label. */}
                <span
                  className={`cc-mode__price mono${price.free ? " cc-mode__price--free" : ""}`}
                  title={
                    billsPerRow && !basis.priced
                      ? "The price list has not loaded yet."
                      : est.external
                        ? `One request per row — ${rowCount.toLocaleString()} of them. The service you call sets the price, and this app cannot see it.`
                        : rowCount === 0 && est.perRow > 0
                          ? `This table has no rows yet, so there is no total to give. At this rate, a thousand rows would cost about ${usd(est.perRow * 1000)}.`
                          : undefined
                  }
                >
                  {price.text}
                </span>
              </span>
              <span className="cc-mode__test">{m.test}</span>
              {/* Shown for the chosen mode only. Everything is still here — it just arrives when it
                  is relevant rather than all at once. */}
              {on && (
                <>
                  <span className="cc-mode__detail">{m.detail}</span>
                  <span className="cc-mode__eg">{m.example}</span>
                </>
              )}
            </button>
          );
        })}
      </div>

      {/* The two mistakes, each shown only against the mode that makes it. A warning that is always
          on screen stops being read. */}
      {/* Each callout is TEXT then ACTION, as two rows.
          The button is NOT a child of the paragraph. There it renders inline in the middle of a
          sentence — "…sending twice writes everything twice. [Only send some rows…]" — which reads
          as a typo rather than as a control. It is an action about the paragraph, so it sits under
          it. */}
      {currentKind === "agent" && (
        <div className="cc-mode__warn" role="status">
          <p className="cc-mode__notetext">
          {hasPrices ? (
            <>
              <strong>Web search is about {ratio(agentCost, aiCost)} the cost of reading the row.</strong>{" "}
              This sheet would run at roughly {usd(agentCost)} instead of {usd(aiCost)}.{" "}
            </>
          ) : (
            <>
              <strong>Web search is far and away the most expensive mode.</strong>{" "}
              {basis.local
                ? "This column is set to a model on this machine, so the model calls bill nothing — but each row is still several of them, and the searches themselves go through a provider."
                : "The price list has not loaded, so this table has not been costed yet."}{" "}
            </>
          )}
          If the answer is already somewhere in the row, switch to “The model reads the row” — or to
          a rule, which is free.
          </p>
          {onOpenCondition && (
            <button className="cc-btn cc-btn--xs cc-mode__cond" onClick={onOpenCondition}>
              Only run some rows…
            </button>
          )}
        </div>
      )}

      {currentKind === "ai" && (
        <div className="cc-mode__note" role="status">
          <p className="cc-mode__notetext">
            This mode cannot look anything up. If the answer is not in the row, the model will
            produce a confident wrong value rather than an error — that failure is silent, so check
            the first few rows before running the sheet.
          </p>
          {onOpenCondition && (
            <button className="cc-btn cc-btn--xs cc-mode__cond" onClick={onOpenCondition}>
              Only run some rows…
            </button>
          )}
        </div>
      )}

      {currentKind === "http" && onOpenCondition && (
        <div className="cc-mode__note" role="status">
          <p className="cc-mode__notetext">
            Every row is one request, and most services bill per request. A condition decides which
            rows are worth asking about — it costs nothing and runs before anything is sent.
          </p>
          <button className="cc-btn cc-btn--xs cc-mode__cond" onClick={onOpenCondition}>
            Only run some rows…
          </button>
        </div>
      )}

      {currentKind === "script" && (
        <div className="cc-mode__note" role="status">
          A model writes this code once, then never runs again. The whole column costs one call no
          matter how many rows it covers, and re-running it later is free.
        </div>
      )}

      {currentKind === "send" && (
        <div className="cc-mode__note" role="status">
          <p className="cc-mode__notetext">
            This is the one mode that creates data somewhere you are not looking, so it shows you
            what it would write before it writes anything. Pick something to match on — without one,
            sending twice writes everything twice.
          </p>
          {onOpenCondition && (
            <button className="cc-btn cc-btn--xs cc-mode__cond" onClick={onOpenCondition}>
              Only send some rows…
            </button>
          )}
        </div>
      )}

      {/* Only on the lanes that bill per row. A rule column has no model, and offering one there
          would imply a cost it does not have. */}
      {(currentKind === "ai" || currentKind === "agent") && onModelChange && (
        <ModelPicker
          value={model ?? "auto"}
          toolsRequired={currentKind === "agent"}
          onChange={onModelChange}
          busy={busy}
        />
      )}

      {error && <div className="cc-errors" role="alert"><div className="cc-errors__row">{error}</div></div>}

      {/* The next step, as a decision rather than a side effect.

          Last on the screen on purpose: everything above it is what this mode is, what it costs and
          what it cannot do, and the whole reason this button exists is to make reading that possible
          at all: moving off this tab the instant a card is picked hides it. */}
      {onContinue && (
        <div className="cc-mode__next">
          <span className="cc-mode__nexttext">Set up when you have read this.</span>
          <button className="cc-btn cc-btn--primary cc-btn--xs" onClick={onContinue.go} disabled={busy}>
            <span>{onContinue.label}</span>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M6 4l4 4-4 4" />
            </svg>
          </button>
        </div>
      )}

      {/* The note names the model the estimate ACTUALLY used. It used to assert gpt-4o-mini on every
          column whatever the column ran on, which made the sentence itself the misleading part. */}
      <details className="cc-mode__basis">
        <summary>How these prices are worked out</summary>
        <p>
          {!basis.priced
            ? "The price list has not loaded, so the two model lanes above are not costed. The engine prices the run itself on the confirmation screen before anything starts."
            : basis.local
              ? `${basis.modelLabel} runs on this machine, so the model calls bill nothing — the same zero the engine uses. Web searches still go through a provider and are not counted here. Your real cost is time rather than money.`
              : `Estimated, not a quote. Based on ${basis.modelLabel} — the model this column is set to — at ${usd(basis.inputPerM)}/M input and ${usd(basis.outputPerM)}/M output tokens, and ${usd(basis.searchPerCall)} per search at ${basis.maxResults} results. Nearly all of the web-search figure is the searches, not the words: it assumes ${AGENT_TYPICAL_SEARCHES} per row, which is what a column left at its default turn limit makes. Raise that limit and it rises with it, up to a ceiling of ${AGENT_SEARCH_CEILING}; turn the search tool off and the searches cost nothing at all. It also does not know how much of each ROW your prompt carries, which the engine measures — so the run confirmation reads higher than this on a wide sheet, and that is the figure that gates the spend. An HTTP column is not costed here at all: what it calls is billed by whoever answers.`}
        </p>
      </details>
    </div>
  );
}
