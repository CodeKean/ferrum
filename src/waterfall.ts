// Waterfalls — try A, else B, else C.
//
// THE ONE DECISION THAT SHAPES EVERYTHING HERE: a step is a LANE, never a vendor.
//
// The obvious way to build this is a column kind per provider — a Prospeo column, a BetterEnrich
// column — and it is wrong in a way that gets worse every month. It makes the app's vocabulary a list
// of companies, so every new provider is a code change, every provider that changes its API is a
// release, and a user with an internal endpoint or a provider nobody here has heard of has nowhere to
// put it. The interesting part of a waterfall was never which companies are in it; it is the ORDER
// and the rule for "good enough".
//
// So a step is one of the lanes this app already has — an HTTP request, an MCP call, a model, an
// agent, a script, a lookup in another table — configured exactly the way a column of that kind is
// configured. That makes "any app" true rather than aspirational: an HTTP step reaches anything with
// a URL. Named providers ship as PRESETS that fill in an HTTP step you can then edit, which is the
// same trade the search engines took, and for the same reason: a preset that turns out to be wrong is
// a data fix, not a release.
//
// It also means an email waterfall, a phone waterfall, a company-data waterfall and an LLM waterfall
// are not four features. They are four orderings of the same one.
//
// This module is PURE and imports nothing, so the column editor can describe a step in exactly the
// words the engine uses. A test asserts the zero imports, because that invariant is one careless line
// away from pulling node:sqlite into the browser bundle.

/** The lanes a step can run on. Deliberately the same set a column has, minus the ones that make no sense inside a waterfall. */
export const STEP_KINDS = ["http", "mcp", "ai", "agent", "script", "lookup"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/**
 * "Is this result good enough to stop here?"
 *
 * The whole economics of a waterfall is in this rule. Too loose and the cheap step's blank-ish answer
 * ends the run, so the expensive step that would have found the real value never runs and the column
 * looks finished. Too tight and every row falls through every step and the bill is the sum of all of
 * them. So it is explicit, per step, and shown in words on the step's row rather than buried.
 */
export type AcceptRule =
  /** Anything that is not empty. The default, and right for most steps. */
  | { kind: "non_empty" }
  /** The value has to LOOK like the thing being asked for — an email, a phone number, a domain. */
  | { kind: "matches"; pattern: string }
  /** Model lanes only: accept only an answer the model itself graded at least this sure. */
  | { kind: "confidence"; min: "high" | "medium" }
  /** Anything else, as a generated predicate. The escape hatch, so the three above never have to grow. */
  | { kind: "script"; scriptId: number }
  /** Take whatever comes back, even nothing. Ends the waterfall at this step, always. */
  | { kind: "any" };

export interface WaterfallStep {
  /**
   * Stable across edits and reorders.
   *
   * A result records WHICH step answered, and that record outlives the ordering — reordering a
   * waterfall must not silently re-attribute last week's values to a different provider. Indexes
   * would do exactly that.
   */
  id: string;
  /** What the user calls it: "Prospeo work email", "Guess from pattern". Shown on the cell's provenance. */
  name: string;
  kind: StepKind;
  /** Off keeps a step in the list without running it — how you take one out for a week without losing its config. */
  enabled: boolean;
  /**
   * The lane's own configuration, in the SAME shape the column of that kind uses: `httpConfig` for
   * http, `prompt`/`model` for ai and agent, `transformScriptId` for script, and so on. Reusing the
   * shape is what lets a step run through the existing executor rather than a parallel one — a second
   * implementation of the HTTP lane would be a second place for the private-address guard to be
   * forgotten.
   */
  config: Record<string, unknown>;
  /** Overrides the column-level rule. Absent means "use the column's". */
  accept?: AcceptRule;
  /**
   * What one call on this step costs, when the lane cannot work it out for itself.
   *
   * A model lane prices itself from the token count. An HTTP call to a paid provider does not — it
   * is real money leaving the workspace and the engine cannot see it, so it is declared here or the
   * forecast reports a waterfall of paid providers as free. Null means "not declared", which the
   * forecast has to SAY rather than treat as zero.
   */
  costUsd?: number | null;
}

export interface Waterfall {
  steps: WaterfallStep[];
  /** The rule applied to any step that does not carry its own. */
  accept: AcceptRule;
}

export const DEFAULT_ACCEPT: AcceptRule = { kind: "non_empty" };

export function emptyWaterfall(): Waterfall {
  return { steps: [], accept: { ...DEFAULT_ACCEPT } };
}

// ─────────────────────────────────────────────────────────────── reading one back

function isStepKind(v: unknown): v is StepKind {
  return typeof v === "string" && (STEP_KINDS as readonly string[]).includes(v);
}

function parseAccept(raw: unknown): AcceptRule | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  switch (r.kind) {
    case "non_empty": return { kind: "non_empty" };
    case "any": return { kind: "any" };
    case "matches":
      return typeof r.pattern === "string" && r.pattern.trim() ? { kind: "matches", pattern: r.pattern } : undefined;
    case "confidence":
      return r.min === "high" || r.min === "medium" ? { kind: "confidence", min: r.min } : undefined;
    case "script": {
      const id = Number(r.scriptId);
      return Number.isInteger(id) && id > 0 ? { kind: "script", scriptId: id } : undefined;
    }
    default: return undefined;
  }
}

/**
 * Read `columns.waterfall_json` into something the engine can run.
 *
 * Anything unreadable is DROPPED rather than guessed at, and the drops are returned rather than
 * swallowed. The reason is the same one that makes `resolveScope` refuse a filter it cannot compile:
 * a step that silently disappears makes the waterfall fall through to a more expensive one, and the
 * user is charged for a change they never made. The caller decides what to do about it; what it must
 * not do is happen invisibly.
 */
export function parseWaterfall(raw: unknown): { waterfall: Waterfall; dropped: string[] } {
  const dropped: string[] = [];
  let obj: unknown = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) return { waterfall: emptyWaterfall(), dropped };
    try { obj = JSON.parse(raw); } catch {
      return { waterfall: emptyWaterfall(), dropped: ["The saved waterfall could not be read, so no steps were run."] };
    }
  }
  if (!obj || typeof obj !== "object") return { waterfall: emptyWaterfall(), dropped };

  const o = obj as Record<string, unknown>;
  const steps: WaterfallStep[] = [];
  const seen = new Set<string>();

  for (const [i, rawStep] of (Array.isArray(o.steps) ? o.steps : []).entries()) {
    if (!rawStep || typeof rawStep !== "object") { dropped.push(`Step ${i + 1} was not readable.`); continue; }
    const s = rawStep as Record<string, unknown>;
    if (!isStepKind(s.kind)) {
      dropped.push(`Step ${i + 1} ("${String(s.name ?? "unnamed")}") asks for a kind of step this build does not have.`);
      continue;
    }
    const id = typeof s.id === "string" && s.id.trim() ? s.id : "";
    if (!id) { dropped.push(`Step ${i + 1} has no id, so its results could not be attributed to it.`); continue; }
    // A duplicate id is worse than a missing one: two steps sharing an id means a cell's provenance
    // names a step that is not the one that produced it, and no amount of later reading can tell.
    if (seen.has(id)) { dropped.push(`Two steps share the id "${id}", so the second was left out.`); continue; }
    seen.add(id);

    steps.push({
      id,
      name: typeof s.name === "string" && s.name.trim() ? s.name : `Step ${i + 1}`,
      kind: s.kind,
      // Absent means ON. A step someone added and never explicitly enabled should run; defaulting to
      // off would make a freshly-built waterfall do nothing and look broken.
      enabled: s.enabled !== false,
      config: s.config && typeof s.config === "object" ? (s.config as Record<string, unknown>) : {},
      accept: parseAccept(s.accept),
      // The null check comes FIRST and is not decoration. `Number(null)` is 0, and `Number(undefined)`
      // is NaN — so the obvious one-line version turned "nobody has said what this costs" into
      // "this costs nothing", which is precisely the reading that makes a forecast of paid providers
      // come back as free. Undeclared has to stay undeclared all the way to the number on screen.
      costUsd: s.costUsd == null ? null
        : Number.isFinite(Number(s.costUsd)) && Number(s.costUsd) >= 0 ? Number(s.costUsd)
        : null,
    });
  }

  return { waterfall: { steps, accept: parseAccept(o.accept) ?? { ...DEFAULT_ACCEPT } }, dropped };
}

// ─────────────────────────────────────────────────────────────── the accept decision

export interface StepResult {
  status: "done" | "not_found" | "error" | "skipped";
  valueText?: string | null;
  value?: unknown;
  confidence?: "high" | "medium" | "low" | null;
}

const CONFIDENCE_RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };

/**
 * Did this step settle the cell?
 *
 * An ERROR never accepts, whatever the rule says — including under `any`. A step that could not run
 * has not answered, and treating a 500 as an answer would stop the waterfall at the one step that
 * definitely did not work. This is the single most important line in the file: it is the difference
 * between "the first provider was down so we tried the second" and "the first provider was down so
 * the row is blank forever".
 *
 * `runAccept` is threaded in rather than imported, so this stays pure and the script lane's runner
 * does not have to exist for the other four rules to be testable.
 */
export function accepts(
  result: StepResult,
  rule: AcceptRule,
  runScript?: (scriptId: number, result: StepResult) => boolean,
): boolean {
  if (result.status === "error" || result.status === "skipped") return false;

  const text = result.valueText ?? (typeof result.value === "string" ? result.value : null);
  // Whitespace is not a value. A provider returning " " has found nothing, and the string is truthy.
  const nonEmpty = result.status === "done" && text != null && String(text).trim() !== "";

  switch (rule.kind) {
    case "any":
      // Still requires the step to have RUN — see the error guard above. "Any" means "any answer",
      // not "any outcome".
      return result.status === "done" || result.status === "not_found";
    case "non_empty":
      return nonEmpty;
    case "matches": {
      if (!nonEmpty) return false;
      try {
        return new RegExp(rule.pattern, "i").test(String(text));
      } catch {
        // A pattern that will not compile must not silently accept everything — that is the loose
        // failure that ends the waterfall at step one and skips the provider that would have worked.
        return false;
      }
    }
    case "confidence": {
      if (!nonEmpty) return false;
      const got = CONFIDENCE_RANK[String(result.confidence ?? "")] ?? 0;
      return got >= (CONFIDENCE_RANK[rule.min] ?? 3);
    }
    case "script":
      // No runner means the rule cannot be evaluated, and an unevaluated rule must FAIL rather than
      // pass: falling through to the next step costs money, but stopping on an unchecked value writes
      // a wrong answer and calls it done.
      return runScript ? runScript(rule.scriptId, result) : false;
  }
}

// ─────────────────────────────────────────────────────────────── saying it in words

/** The rule as a sentence, for the step's row in the editor and for the cell's provenance. */
export function describeAccept(rule: AcceptRule): string {
  switch (rule.kind) {
    case "any": return "stop here whatever comes back";
    case "non_empty": return "stop when it finds anything";
    case "matches": return `stop when it looks like ${rule.pattern}`;
    case "confidence": return `stop when the model is at least ${rule.min === "high" ? "sure" : "fairly sure"}`;
    case "script": return "stop when your rule says so";
  }
}

/** The lane in the user's words, not the engine's. */
export const STEP_KIND_LABEL: Record<StepKind, string> = {
  http: "Call an API",
  mcp: "Ask a connected app",
  ai: "Ask a model",
  agent: "Send an agent to look",
  script: "Work it out with a rule",
  lookup: "Look it up in another table",
};

/**
 * What a whole waterfall costs per row, worst case and best case.
 *
 * BOTH numbers, always, and this is not padding. Best case is the first step's price and is what
 * people quote themselves; worst case is every step running, and is what actually arrives when the
 * cheap steps miss — which on a hard list is most rows. A forecast showing only one of them is the
 * forecast that produces the surprised invoice.
 *
 * `unpriced` names the steps that could not be counted, because a total that quietly omits an
 * undeclared paid API reads as authoritative and is short by exactly the amount that matters.
 */
export function waterfallCost(w: Waterfall): { best: number; worst: number; unpriced: string[] } {
  const on = w.steps.filter((s) => s.enabled);
  const unpriced = on.filter((s) => s.costUsd == null).map((s) => s.name);
  const priced = on.map((s) => s.costUsd ?? 0);
  return {
    best: priced.length > 0 ? priced[0]! : 0,
    worst: priced.reduce((a, b) => a + b, 0),
    unpriced,
  };
}

/**
 * Does running this column spend money?
 *
 * Used by the auto-run and schedule gates, which must never start a paid waterfall on their own. A
 * step is treated as PAID unless it is provably free, and "provably free" is a short list on purpose:
 * a script, a lookup, and a model the caller confirms is local. Anything else — an HTTP call to an
 * unknown endpoint, an MCP server, a hosted model — is assumed to cost, because the failure mode of
 * guessing wrong in the other direction is an unattended bill.
 */
export function waterfallSpends(w: Waterfall, isLocalModel: (id: string) => boolean): boolean {
  return w.steps.filter((s) => s.enabled).some((s) => {
    if (s.kind === "script" || s.kind === "lookup") return false;
    if (s.kind === "ai" || s.kind === "agent") {
      const m = String(s.config.model ?? "").trim();
      return !m || m === "auto" || !isLocalModel(m);
    }
    return true;
  });
}
