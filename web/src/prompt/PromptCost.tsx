// What this prompt will cost, while it is being written.
//
// The cost of a column visible only in the run confirmation arrives after the prompt is written,
// the model picked, and the decision effectively made. But the prompt IS the cost: it is
// re-sent on every row, and on the agent lane on every turn of every row, so a sentence added while
// drafting gets multiplied by the whole sheet. Someone typing a paragraph where a line would do had
// no way to see the difference until they were staring at a total.
//
// Three reference scales rather than one, because the number that matters depends on the table and
// the point is the SHAPE of it: a prompt costing a fiftieth of a cent per row is nothing over 1,000
// rows and real money over 100,000. A single figure invites reading it as small.

import { useEffect, useRef, useState } from "react";
import "./PromptCost.css";

interface Scale { rows: number; total: number }

interface Estimate {
  pricedLane: boolean;
  kind: string;
  model?: string;
  modelName?: string;
  local?: boolean;
  unpriced?: boolean;
  priceListUnavailable?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  tokensUsd?: number;
  searchUsd?: number;
  searchOn?: boolean;
  searches?: number;
  perSearchUsd?: number;
  maxResults?: number;
  turns?: number;
  perRow?: number;
  sheetRows?: number;
  scales?: Scale[];
}

interface Props {
  columnId: string;
  /** The draft in the editor, not what was last saved — pricing the saved one would miss the point. */
  prompt: string;
  /** The model currently selected in the picker, likewise possibly unsaved. */
  model: string;
  kind: string;
  /**
   * The web-search settings as they stand in the editor right now.
   *
   * Passed in rather than read off the saved column, because on the agent lane these are the
   * EXPENSIVE controls: a search costs more than a thousand tokens do, and a row may make one per
   * turn. Pricing the saved settings would leave the figure a save behind exactly the sliders whose
   * effect it exists to show.
   */
  searchEnabled?: boolean;
  maxResults?: number;
  maxTurns?: number;
}

/**
 * Money at the precision its size deserves.
 *
 * Sub-cent figures in cents, because "$0.0004" is a number people stop and count the zeros in — and
 * counting zeros is exactly how a per-row cost gets misread by a factor of ten. Zero is "free", not
 * an approximate zero; that distinction has been got wrong three times in this codebase already.
 */
function money(n: number): string {
  if (n === 0) return "free";
  if (n < 0.01) return `${(n * 100).toFixed(n < 0.001 ? 3 : 2)}¢`;
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

const rowLabel = (n: number) =>
  n === 1 ? "1 row" : n >= 1000 ? `${(n / 1000).toLocaleString()}k rows` : `${n.toLocaleString()} rows`;

export function PromptCost({ columnId, prompt, model, kind, searchEnabled, maxResults, maxTurns }: Props) {
  const [est, setEst] = useState<Estimate | null>(null);
  const [error, setError] = useState(false);
  // Held so a keystroke can abandon the request the previous keystroke started, rather than racing
  // it — out-of-order replies would make the figure flicker between two prompts.
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (kind !== "ai" && kind !== "agent") { setEst(null); return; }

    // Debounced: this runs on every keystroke, and the answer only changes meaningfully after a
    // pause. The request itself is free — it reads a published price list — but a request per
    // character would still be silly.
    const t = setTimeout(() => {
      abort.current?.abort();
      const ac = new AbortController();
      abort.current = ac;
      fetch(`/api/columns/${columnId}/estimate-prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt, model, kind,
          search: { enabled: searchEnabled, maxResults },
          maxTurns,
        }),
        signal: ac.signal,
      })
        .then((r) => r.json())
        .then((d) => { if (d.error) setError(true); else { setEst(d); setError(false); } })
        .catch((e) => { if ((e as Error)?.name !== "AbortError") setError(true); });
    }, 400);

    return () => clearTimeout(t);
  }, [columnId, prompt, model, kind, searchEnabled, maxResults, maxTurns]);

  if (kind !== "ai" && kind !== "agent") return null;
  // Nothing at all until the first answer, rather than a box that says "…" — the panel appearing
  // once with a figure reads better than one that is present and empty while you type your first
  // word.
  if (error || !est?.pricedLane) return null;

  if (est.local) {
    return (
      <div className="cc-pc cc-pc--note">
        Runs on this machine, so the words cost nothing however many rows you run.
        {(est.searchUsd ?? 0) > 0 && " Web search still bills through OpenRouter."}
      </div>
    );
  }

  if (est.unpriced) {
    return (
      <div className="cc-pc cc-pc--note" role="status">
        {est.priceListUnavailable
          ? "The price list could not be read just now, so this cannot be costed. The run confirmation will try again."
          : `${est.modelName} has no published price, so this cannot be costed before it runs.`}
      </div>
    );
  }

  const perRow = est.perRow ?? 0;
  const scales = est.scales ?? [];
  // The user's OWN table, alongside the reference scales — the only one of the figures that is not
  // hypothetical, and usually the one they actually want.
  const own = est.sheetRows && est.sheetRows > 0
    ? { rows: est.sheetRows, total: perRow * est.sheetRows }
    : null;

  // Only worth splitting when there IS a second half. On the plain model lane the words are the
  // whole cost, and a "web search: free" line would be noise pretending to be information.
  const searchSplit = !!est.searchOn && (est.searchUsd ?? 0) > 0;
  // How lopsided it is, stated plainly. "Search is 96% of this" lands in a way two figures do not.
  const searchShare = searchSplit && perRow > 0 ? Math.round(((est.searchUsd ?? 0) / perRow) * 100) : 0;

  return (
    <div className="cc-pc">
      <div className="cc-pc__head">
        <span className="cc-pc__title">What this will cost</span>
        <span className="cc-pc__per mono">{money(perRow)} per row</span>
      </div>

      {/* The split, and the reason this panel is worth having on the agent lane.
          A search costs more than a thousand tokens do, so blended into one figure the words look
          like the thing to optimise when they are almost never the thing that matters. Shown as two
          lines, the ratio is the first thing you see — and the control that moves the big one is
          named, because it lives on a different tab. */}
      {searchSplit && (
        <ul className="cc-pc__split">
          <li className="cc-pc__part">
            <span className="cc-pc__partname">the words</span>
            <span className="cc-pc__partsub">prompt + row + answer</span>
            <span className="cc-pc__partval mono">{money(est.tokensUsd ?? 0)}</span>
          </li>
          <li className="cc-pc__part cc-pc__part--big">
            <span className="cc-pc__partname">web search</span>
            <span className="cc-pc__partsub">
              up to {est.searches} {est.searches === 1 ? "search" : "searches"} a row at{" "}
              {money(est.perSearchUsd ?? 0)} each, {est.maxResults} results
            </span>
            <span className="cc-pc__partval mono">{money(est.searchUsd ?? 0)}</span>
          </li>
        </ul>
      )}

      <ul className="cc-pc__scales">
        {scales.map((s) => (
          <li key={s.rows} className="cc-pc__scale">
            <span className="cc-pc__rows">{rowLabel(s.rows)}</span>
            <span className="cc-pc__total mono">{money(s.total)}</span>
          </li>
        ))}
        {own && (
          <li className="cc-pc__scale cc-pc__scale--own">
            <span className="cc-pc__rows">this table — {own.rows.toLocaleString()} rows</span>
            <span className="cc-pc__total mono">{money(own.total)}</span>
          </li>
        )}
      </ul>

      {/* What the figure is MADE of, so it can be argued with. An estimate nobody can check is just
          a number to be believed or ignored. */}
      <p className="cc-pc__basis">
        {est.modelName} · about {(est.inputTokens ?? 0).toLocaleString()} tokens in and{" "}
        {(est.outputTokens ?? 0).toLocaleString()} out per row
        {est.turns && est.turns > 1 ? `, over up to ${est.turns} turns` : ""}. Your prompt and the
        row's other columns are sent every time, so longer prompts cost more on every row.
        {searchSplit && searchShare >= 50 && (
          <>
            {" "}
            <strong>
              Searching is {searchShare}% of this — fewer turns or fewer results will save far more
              than shortening the prompt.
            </strong>
          </>
        )}
      </p>
    </div>
  );
}
