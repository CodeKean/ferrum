// What a column will cost, per lane.
//
// Every number here is an ESTIMATE and the UI says so wherever one is shown. The point is not
// precision — it is the ORDER OF MAGNITUDE between lanes, which is what actually changes the
// decision. A rule is free, a model call is fractions of a cent, and a web-searching agent is two
// orders of magnitude above that. Getting the third decimal place right would not change anyone's
// mind; knowing it is 90x rather than 2x does.
//
// This module is PURE ARITHMETIC. The rates come from the caller, which reads them out of the same
// `/api/models` catalogue the server prices a run from. One hardcoded model here — gpt-4o-mini, on
// the assumption it is "the executor's default", which it is not — prices every column at that rate
// whatever the column actually runs on. Measured against the server's own estimate that
// read 4.7x OVER on the default model and roughly 22x UNDER on Claude Sonnet, and it knew nothing
// about local models, which bill nothing at all.
//
// The search rate mirrors `searchCostUsd()` in src/providers/openrouter.ts. It is duplicated rather
// than imported because the browser bundle does not include server code — if that rate changes,
// change it in both places.

/** One model's published rates, in the shape the catalogue reports them. */
export interface ModelRate {
  /** What to call it on screen. */
  label: string;
  inputPerM: number;
  outputPerM: number;
  /** Runs on this machine: the engine prices it at zero, so this must too. */
  local?: boolean;
}

export interface CostBasis {
  modelLabel: string;
  inputPerM: number;
  outputPerM: number;
  /** What one web search costs at the configured result count. */
  searchPerCall: number;
  maxResults: number;
  /**
   * False when no rate was supplied — the price list has not answered yet.
   *
   * The caller shows "—" rather than a number in that case. A price borrowed from some other model
   * is worse than no price: it reads as authoritative and is wrong by multiples.
   */
  priced: boolean;
  /** True when the chosen model runs on this machine and bills nothing. */
  local: boolean;
}

/** Exa's published rate: $0.005 up to 10 results, $0.001 for each beyond. */
export function searchCostUsd(maxResults: number): number {
  return 0.005 + Math.max(0, maxResults - 10) * 0.001;
}

export function basisFor(maxResults: number, rate?: ModelRate | null): CostBasis {
  // The same zero branch the server's estimate takes for a local model, so the mode card and the
  // run confirmation cannot disagree about a column that costs nothing.
  const local = !!rate?.local;
  return {
    modelLabel: rate?.label ?? "",
    inputPerM: local ? 0 : rate?.inputPerM ?? 0,
    outputPerM: local ? 0 : rate?.outputPerM ?? 0,
    searchPerCall: local ? 0 : searchCostUsd(maxResults),
    maxResults,
    priced: !!rate,
    local,
  };
}

/**
 * The agent loop's CEILING on tool calls per cell. Mirrors MAX_TOOL_CALLS in src/estimate.ts.
 *
 * A ceiling, and not what to price a row at — see `TYPICAL_TURNS`.
 */
const MAX_TOOL_CALLS = 16;

/**
 * Searches a default agent column actually makes in a row.
 *
 * This card priced every agent row at the CEILING of sixteen searches, which is four times what the
 * engine would quote for a column nobody has touched and infinitely more than one that never
 * enabled the search tool. The correction that produced the ceiling was right about the direction —
 * assuming ONE search understated the lane badly — and then overshot into the opposite error, which
 * on the screen built to talk someone out of the expensive lane is its own kind of lie: it makes the
 * product look several times dearer than it is.
 *
 * The card was also disagreeing with itself. Its token figure is annotated "~3 turns" while its
 * search figure assumed sixteen — the same hypothetical row, costed at two different turn counts.
 *
 * So this mirrors what `src/estimate.ts` computes for a fresh agent column with search on:
 * `min(turnsFor(col), MAX_TOOL_CALLS)`, where turns default to the schema's `max_turns` of 4. Every
 * search is a turn and the loop stops at whichever limit comes first, so a column left at its
 * defaults makes four, not sixteen.
 *
 * Raising the turn limit raises the real cost, and the run confirmation — which reads the column's
 * ACTUAL settings rather than a default — is the figure that gates the spend. This one only has to
 * be honest about the lane before the column exists.
 */
const TYPICAL_TURNS = 4;

/**
 * Typical token counts per row, per lane.
 *
 * The agent figures are the ones that carry the estimate: a search returns several thousand tokens
 * of page text, and the model re-reads the whole conversation on every turn, so its input is counted
 * across turns rather than once.
 *
 * These are the parts that do not depend on the sheet. The engine's estimate additionally measures
 * how much of the ROW each prompt inlines, which needs the database — so on a wide sheet the run
 * confirmation will read HIGHER than this card, never lower, and the confirmation is the number
 * that gates the spend.
 */
const SHAPE = {
  ai: { inTok: 400, outTok: 60, searches: 0 },
  // Four turns: the question, two rounds of results read back, and the answer. The token figure and
  // the search figure are now the SAME number of turns — they were 3 and 16, describing one
  // hypothetical row two different ways.
  agent: { inTok: 12_000, outTok: 200, searches: TYPICAL_TURNS },
};

/** The ceiling is still real; nothing prices at it, but the copy that explains the lane cites it. */
export const AGENT_SEARCH_CEILING = MAX_TOOL_CALLS;
export const AGENT_TYPICAL_SEARCHES = TYPICAL_TURNS;

export interface Estimate {
  /** Cost for the whole sheet. */
  total: number;
  perRow: number;
  /**
   * True when this lane bills a THIRD PARTY per row at a rate this app cannot see.
   *
   * Mirrors `RunCost.external` in src/estimate.ts, and it exists because the two screens are one
   * decision seen twice. The mode card badged an HTTP column "free" — its own detail text on the
   * same card says "Costs whatever that service charges" — while the run confirmation, which reads
   * the server's estimate, calls the identical column external and refuses to call it free. A total
   * of zero is not the same statement as free, and the card that sells the lane is the worse place
   * to get that wrong.
   */
  external: boolean;
}

/** Lanes that bill somebody else per row. Kept in step with the same branch in src/estimate.ts. */
const EXTERNAL = new Set(["http", "mcp"]);

export function estimateForKind(kind: string, rowCount: number, basis: CostBasis): Estimate {
  // A rule and a typed-in column cost nothing per row. The one model call that WRITES a rule is
  // real but is a single fraction of a cent for the whole column, and rounding it into a per-sheet
  // total would show "$0.00" anyway — claiming free is both simpler and accurate to the cent.
  //
  // An http or mcp column also totals zero HERE, because no rate is knowable — but it carries the
  // external flag so the caller says "their rate" rather than "free".
  if (kind !== "ai" && kind !== "agent") return { total: 0, perRow: 0, external: EXTERNAL.has(kind) };

  const s = SHAPE[kind];
  const perRow =
    (s.inTok * basis.inputPerM) / 1e6 +
    (s.outTok * basis.outputPerM) / 1e6 +
    s.searches * basis.searchPerCall;

  return { perRow, total: perRow * rowCount, external: false };
}

/**
 * What goes in a mode card's price slot.
 *
 * The case this exists for: a sheet with NO ROWS YET. Every per-row lane multiplied out to exactly
 * zero, zero rendered as "free", and the web-searching agent — the most expensive thing in the
 * product — sat on screen badged free, in green, next to a rule that genuinely is.
 *
 * That is not a rounding problem, it is the wrong sentence at the worst possible moment. Columns get
 * set up on an empty table and the rows are imported AFTERWARDS, so "0 rows" is the normal state of
 * the screen whose entire purpose is to talk someone out of the expensive lane by accident. The
 * total was true and the word was a lie: nothing had been costed, not nothing would be charged.
 *
 * So with no rows there is no total to give, and the card quotes the RATE instead. Per thousand
 * rather than per row, because per row rounds back into "$0.0000" for the model lane and lands
 * straight back where it started.
 */
export function priceLabel(est: Estimate, rowCount: number, opts: { billsPerRow: boolean; priced: boolean }): {
  text: string;
  /** True only when this lane costs nothing at any scale — never merely because it has not been costed. */
  free: boolean;
} {
  if (opts.billsPerRow && !opts.priced) return { text: "—", free: false };
  if (est.external) return { text: "their rate", free: false };
  // A lane that bills nothing per row is free whether the sheet holds no rows or a million.
  if (est.perRow === 0) return { text: "free", free: true };
  if (rowCount === 0) return { text: `${usd(est.perRow * 1000)}/1k`, free: false };
  return { text: usd(est.total), free: false };
}

/** Money, at a precision that suits its size — "$0.08" and "$7,000" both need to read cleanly. */
export function usd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(2)}`;
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

/** "90x" — the comparison that makes the cost difference land. */
export function ratio(a: number, b: number): string {
  if (b <= 0) return "far more than";
  const r = a / b;
  return r >= 10 ? `${Math.round(r)}x` : `${r.toFixed(1)}x`;
}

/**
 * What ONE design call cost, in words.
 *
 * Separate from `usd` above, which prices a whole run: this is the single "set it up" call, and its
 * amounts are two orders of magnitude smaller — a run is quoted in dollars, a design call in cents.
 *
 * Zero is "free", NOT an approximate zero. That distinction has been got wrong twice in one day, in
 * two components, the same way: "≈ $0.00" on the run strip and "about 0.00¢" in the setup panel.
 * Both read as a small charge rounded down, and both sat beside something saying the opposite — a
 * confirmation reading "free", a model whose id ends in ":free". Three outcomes, never two: nothing
 * was charged, a little was charged, and we cannot tell. Only the middle one is approximate.
 */
export function designCost(n: number | null): string | null {
  if (n == null) return null;
  if (n === 0) return "free";
  return n < 0.01 ? `about ${(n * 100).toFixed(2)}¢` : `about $${n.toFixed(3)}`;
}
