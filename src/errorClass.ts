// What a failure MEANS, and what to do about it.
//
// ── Why this module exists ─────────────────────────────────────────────────────────────────────
//
// The engine has always known how to classify a failure. `retryPolicy` in runs.ts reads that class
// and decides whether to try again, and it is right. Nothing ever told the USER what the class
// meant. A cell that failed showed the provider's own sentence — "429 Too Many Requests", "context
// length exceeded" — and one button, "Re-run this cell", which for a third of the classes is the one
// action guaranteed to produce the identical failure and the identical bill.
//
// So this is the table that turns a class into three things a person can act on: what went wrong,
// what to do next, and whether pressing the button again could possibly help.
//
// ── Why it imports nothing ─────────────────────────────────────────────────────────────────────
//
// Because the browser reads it too. The cell details panel is where this is shown, and it is client
// code; a single `import` of anything under src/ that touches `node:sqlite` would break the
// production bundle rather than the typecheck. There is a test asserting this file has no imports at
// all, because that invariant is one careless line away from being broken and the failure is loud,
// late, and nothing to do with the line that caused it.
//
// ── Why `rerunHelps` is not just `retryPolicy` ─────────────────────────────────────────────────
//
// They answer different questions. `retryPolicy` asks "should the ENGINE try again, right now, mid
// run" and has four answers. This asks "should the USER press the button" — and by the time a cell
// is sitting in `error`, the engine has already spent every attempt it was willing to spend. So a
// class the engine retries twice and then gives up on is `rerunHelps: false` here, because the two
// retries already happened.
//
// The two must not drift, so the constants they share live here and runs.ts imports them, and a
// property test asserts that everything false here is a class `retryPolicy` refuses.

/**
 * How a failure is classified.
 *
 * The single definition — `src/types.ts` re-exports this rather than keeping its own copy, which it
 * did until this module existed.
 */
export type ErrClass =
  | "auth"        // never retry; pause the run. A dead token costs ~3min/cell in backoff.
  | "rate_limit"  // retry WITHOUT burning an attempt; trip the global breaker
  | "overloaded"
  | "timeout"
  | "budget"      // never retry; raising the cap is the user's call
  | "schema"
  | "tool"
  | "script"      // generated code threw
  | "agent"
  | "empty"       // the model returned nothing at all — no answer and no text. Deterministic per input.
  | "cancelled"   // the user stopped the run while this cell was in flight. NOT a failure.
  | "unknown";

export const ERR_CLASSES: readonly ErrClass[] = [
  "auth", "rate_limit", "overloaded", "timeout", "budget",
  "schema", "tool", "script", "agent", "empty", "cancelled", "unknown",
] as const;

// ── the constants runs.ts shares ────────────────────────────────────────────

/**
 * Classes the engine will never retry, whatever the column's attempt limit says.
 *
 * `auth` stops the whole run; `budget` fails the cell. Both because the fix is a decision only the
 * user can make, and retrying in the meantime spends time or money proving the same thing again.
 */
export const NEVER_RETRY: ReadonlySet<ErrClass> = new Set<ErrClass>(["auth", "budget", "empty"]);

/**
 * The ceiling on free retries.
 *
 * A rate limit does not burn an attempt, which is right — it is the provider's state, not the cell's
 * fault. But "does not burn an attempt" with no separate ceiling is an unbounded loop: an endpoint
 * that answers 429 to everything held a worker forever, sleeping and calling and sleeping again,
 * with the run showing that row as running for as long as the process lived.
 */
export const MAX_FREE_RETRIES = 6;

/**
 * A schema failure gets at most this many attempts.
 *
 * Capped low on purpose: a response in the wrong shape is a configuration problem, and the third
 * identical call costs the same as the first and teaches nobody anything.
 */
export const SCHEMA_MAX_ATTEMPTS = 2;

// ── the table ───────────────────────────────────────────────────────────────

/** Where a fix lives when it is not in the column, so the panel can point at it instead of a button. */
export type FixWhere = "settings_keys" | "settings_budget" | "wait" | "nowhere";

/**
 * Which part of a column a proposed fix would change.
 *
 * Mirrors `SetupArea` in src/setup/aiSetup.ts. Kept as a string union rather than an import because
 * this file imports nothing; a test asserts the two agree.
 */
export type FixArea = "mode" | "request" | "rule" | "condition" | "prompt" | "search" | "output";

export interface ErrFacts {
  /** Would running this again, unchanged, plausibly produce a different result? */
  rerunHelps: boolean;
  /** What went wrong, in the user's terms. One sentence. */
  cause: string;
  /** The next action, in the user's terms. One sentence. */
  todo: string;
  /** Whether a model reading the column's settings could plausibly propose a fix. */
  aiCanHelp: boolean;
  /**
   * Which part of the column a fix would target, when there is exactly one.
   *
   * Null in two different situations, and both mean "do not narrow it": no model can help at all, or
   * the fix could honestly be in more than one place. Narrowing to ONE part is what tells the
   * designer to keep everything else as it is, so naming the wrong part is worse than naming none —
   * it produces a correct diagnosis with an empty proposal attached, which reads as the feature not
   * working. See the `schema` branch, where that is exactly what happened.
   */
  area: FixArea | null;
  /** Where the fix actually lives, when it is not an AI fix. */
  fixWhere: FixWhere;
}

/** The lane a column runs on. A loose string because the caller has `kind` as text. */
type Lane = string;

/**
 * What a failure means on this lane.
 *
 * `kind` is a parameter because the same class is a different problem per lane, and the advice that
 * ignores that is the advice nobody follows: a `timeout` on an agent means it searched too long and
 * the fix is in the search settings; on an http column it means the endpoint is slow and the fix is
 * the timeout or a retry. One sentence for both would be true of neither.
 */
export function errorFacts(cls: ErrClass | null | undefined, kind: Lane): ErrFacts {
  switch (cls) {
    case "auth":
      return {
        rerunHelps: false,
        cause: "The key this column uses was rejected.",
        todo: "Fix the key in Settings, then run the column again. Running it now fails the same way and stops the run.",
        aiCanHelp: false,
        area: null,
        fixWhere: "settings_keys",
      };

    case "budget":
      return {
        rerunHelps: false,
        cause: "This cell hit a spending limit before it finished.",
        todo: "Raise the limit on the column, pick a cheaper model, or leave it — nothing more was spent.",
        aiCanHelp: false,
        area: null,
        fixWhere: "settings_budget",
      };

    case "rate_limit":
      return {
        rerunHelps: true,
        cause: "The provider is throttling this key.",
        // True and worth saying: the engine already retried six times without charging an attempt.
        // Someone who does not know that reads a 429 as "click again", immediately.
        todo: "It already waited and retried several times. Give it a few minutes, or run fewer rows at once.",
        aiCanHelp: false,
        area: null,
        fixWhere: "wait",
      };

    case "overloaded":
      return {
        rerunHelps: true,
        cause: "The provider was too busy to answer.",
        todo: "Run it again — this one usually clears on its own.",
        aiCanHelp: false,
        area: null,
        fixWhere: "wait",
      };

    case "timeout":
      return kind === "agent"
        ? {
            rerunHelps: true,
            cause: "The agent ran out of time before it answered.",
            todo: "Raise the time limit, or let it search less — every search it makes eats the clock.",
            aiCanHelp: true,
            area: "search",
            fixWhere: "nowhere",
          }
        : kind === "http"
          ? {
              rerunHelps: true,
              cause: "The endpoint did not answer in time.",
              todo: "Raise the timeout on the request, or turn on retries for it.",
              aiCanHelp: true,
              area: "request",
              fixWhere: "nowhere",
            }
          : {
              rerunHelps: true,
              cause: "It did not answer in time.",
              todo: "Raise the time limit on the column, or ask for a shorter answer.",
              aiCanHelp: true,
              area: "prompt",
              fixWhere: "nowhere",
            };

    case "schema":
      // False, and this is the one most likely to be argued with. The engine gives a schema failure
      // at most two attempts precisely because the answer will come back in the same wrong shape;
      // by the time the cell reads `error`, both are gone.
      return kind === "http"
        ? {
            rerunHelps: false,
            cause: "The reply came back in a shape this column cannot store.",
            todo: "Check which part of the reply the column reads, and the data type it expects.",
            aiCanHelp: true,
            area: "request",
            fixWhere: "nowhere",
          }
        : {
            rerunHelps: false,
            cause: "The answer came back in a shape this column cannot store.",
            todo: "Loosen the data type, or say in the instruction exactly what shape you want back.",
            aiCanHelp: true,
            // NULL, not "output", and the `todo` one line up is the whole argument: it names two
            // remedies — the data type OR the instruction — while "output" tells the designer "only
            // the data type matters here; keep the current mode", which forbids the second. Advice
            // that recommends something the area it ships with will not permit is a contradiction
            // whichever of the two turns out to be right.
            //
            // To be clear about what this did NOT fix: an enum column answered "Biotechnology" came
            // back with a correct explanation and zero applicable changes, and it still does after
            // this change. Six runs measured across no area, "output" and "prompt" produced a mode
            // change or nothing, never the instruction the answer itself described. That is the free
            // model being incomplete, not the area, and the panel handles it by saying so and
            // offering to ask again. This line removes a real contradiction; it is not the cure for
            // that symptom and should not be read as one.
            area: null,
            fixWhere: "nowhere",
          };

    case "script":
      return {
        rerunHelps: false,
        cause: "The rule threw an error on this row.",
        todo: "The rule has to cope with what this row actually contains — an empty value, or a different shape.",
        aiCanHelp: true,
        area: "rule",
        fixWhere: "nowhere",
      };

    case "tool":
      return {
        rerunHelps: true,
        cause: "A tool this column uses failed.",
        todo: "Check the tool is still connected, then run it again.",
        aiCanHelp: true,
        area: "request",
        fixWhere: "nowhere",
      };

    case "agent":
      return {
        rerunHelps: true,
        cause: "The agent stopped before it answered.",
        todo: "Give it more turns, or make the instruction more specific so it settles sooner.",
        aiCanHelp: true,
        area: "prompt",
        fixWhere: "nowhere",
      };

    case "empty":
      // False, and it is the measured answer rather than a guess. The same rows of the same column
      // came back empty on three passes across two different search backends; the split never moved.
      // The loop has also already asked a second time, in the same conversation, before this class is
      // reached — so the cheap retry is spent and the expensive one would buy the same nothing.
      return {
        rerunHelps: false,
        cause: "The model returned nothing at all — no answer and no explanation.",
        todo: "Some models do this on particular rows and do it every time. Pick a different model for this column; the rows that already answered keep their values.",
        aiCanHelp: false,
        area: null,
        fixWhere: "nowhere",
      };

    case "cancelled":
      return {
        rerunHelps: true,
        cause: "You stopped the run before this finished.",
        todo: "Run it again to finish it.",
        aiCanHelp: false,
        area: null,
        fixWhere: "nowhere",
      };

    case "unknown":
      return {
        rerunHelps: true,
        cause: "It failed, and the engine could not work out which kind of failure it was.",
        todo: "The message says what happened. Try it again, and if it repeats the same way the instruction or the request needs changing.",
        aiCanHelp: true,
        area: "prompt",
        fixWhere: "nowhere",
      };

    default:
      // No class at all. Distinct from `unknown`, which means the engine looked and could not tell;
      // this means nothing recorded one, which is a gap in the engine rather than in the run.
      return {
        rerunHelps: true,
        cause: "It failed, and no reason was recorded.",
        todo: "Run it again — if it fails the same way, the details below will say more the second time.",
        aiCanHelp: false,
        area: null,
        fixWhere: "nowhere",
      };
  }
}
