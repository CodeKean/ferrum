// What this cell IS, in words, before any of its data.
//
// ── The problem ────────────────────────────────────────────────────────────────────────────────
//
// The cell details panel was near-empty for most cells, and worst for the ones people click on when
// confused. A never-run cell showed a title, a "Never run" pill, and nothing else. A static cell
// showed the same. There was no answer to any of the four questions somebody actually opens this
// panel to ask:
//
//   what is this column supposed to do?
//   what did it actually send, and to whom?
//   why is this empty?
//   what would make it fill in?
//
// The data for most of that was already being fetched and thrown away — the route returns twenty
// attempts with the rendered prompt, the model, the cost and the timings on each, and the panel read
// `res.cell` and dropped `res.attempts` on the floor.
//
// ── Why the wording lives here ─────────────────────────────────────────────────────────────────
//
// Because it is the part most likely to be wrong, and the part a test can check. A sentence that
// says "run this column to fill it in" on a column that cannot be run, or "waiting for an upstream
// column" on one with no dependencies, is worse than the blank panel it replaced: it is a confident
// wrong answer to the question that brought someone here.

import { errorFacts, type ErrClass, type FixArea, type FixWhere } from "@shared/errorClass.ts";

export type CellKind =
  | "static" | "script" | "http" | "mcp" | "ai" | "agent" | "send" | "lookup" | "rollup";

/** What each kind of column does, in one line, in plain words. */
const WHAT: Record<CellKind, string> = {
  static: "You type the values in this column yourself. Nothing runs.",
  script: "A rule runs on this row's values. No model, no cost, and the same answer every time.",
  http: "This calls an API and puts part of the answer here.",
  mcp: "This asks a connected app for the answer.",
  ai: "A model reads this row and answers in one go.",
  agent: "A model works on this row and may look things up on the web before answering.",
  send: "This writes a row into another table rather than filling this cell in.",
  lookup: "This copies a value across from a matching row in another table.",
  rollup: "This counts or totals the matching rows in another table.",
};

/** Which kinds cost money per row, so the panel can say whether re-running spends anything. */
const PAID: Record<CellKind, boolean> = {
  static: false, script: false, lookup: false, rollup: false,
  http: true, mcp: true, ai: true, agent: true, send: false,
};

export interface CellFacts {
  kind: CellKind;
  status: string;
  /** True when the column can be run at all — a static column cannot. */
  runnable: boolean;
  /** Whether re-running this cell would spend money. */
  costs: boolean;
  /** What the column does. */
  what: string;
  /**
   * Why the cell looks the way it does, and what to do about it. Null when the value speaks for
   * itself — a cell that ran and produced an answer needs no explanation.
   */
  why: string | null;
  /**
   * On a failure: what went wrong, in words, separate from what to do about it.
   *
   * Kept apart from `why` because the panel shows them in different places — the cause belongs
   * beside the provider's own message, the to-do belongs beside the button.
   */
  cause?: string;
  /**
   * Whether pressing the button again could produce a different result.
   *
   * Undefined on anything that is not a failure. False is the load-bearing value: it is what stops
   * the panel offering a re-run on a rejected key, which fails identically and costs the same.
   */
  rerunHelps?: boolean;
  /** Whether a model reading the column's settings could plausibly propose a fix. */
  aiCanHelp?: boolean;
  /** Which part of the column such a fix would change. */
  fixArea?: FixArea | null;
  /** Where the fix lives when it is not in the column at all. */
  fixWhere?: FixWhere;
}

/**
 * The explanation for one cell.
 *
 * `message` is the stored failure or skip reason, which is the difference between a useful sentence
 * and a generic one: "skipped" alone tells nobody anything, while "skipped — the run condition was
 * false" and "skipped — nothing in Website" send someone to two different places.
 */
export function explainCell(input: {
  kind: string;
  status: string;
  message?: string | null;
  /** True when the value was typed by hand and a run will not overwrite it. */
  pinned?: boolean;
  /** True when something this cell depends on changed after it ran. */
  stale?: boolean;
  /** Whether the column has a run condition at all — changes what "skipped" can mean. */
  hasCondition?: boolean;
  /** How the engine classified the failure. The difference between advice and a shrug. */
  errorType?: string | null;
  /**
   * The column this one is a projection of, by name, when it is one.
   *
   * A derived child is STORED as a script column, so without this the panel called it "a rule that
   * runs on this row's values" while the badge two lines above it said "pulled out of Enrichment" —
   * two descriptions of one column, in one panel, disagreeing.
   */
  derivedFrom?: string | null;
}): CellFacts {
  const kind = (KINDS.includes(input.kind as CellKind) ? input.kind : "static") as CellKind;
  const runnable = kind !== "static";
  const facts: CellFacts = {
    kind,
    status: input.status,
    runnable,
    costs: PAID[kind],
    what: input.derivedFrom
      ? `This is one field out of "${input.derivedFrom}". It re-reads that answer rather than asking again, so it costs nothing.`
      : WHAT[kind],
    why: null,
  };

  const msg = (input.message ?? "").trim();

  switch (input.status) {
    case "empty":
      facts.why = runnable
        // Deliberately not "run the column to fill it in" for a static column — that is an
        // instruction to press a button that is not there.
        ? "This has never run. Run the cell or the column to fill it in."
        : "Nothing has been typed here yet. Click the cell in the grid and type.";
      break;

    case "queued":
      facts.why = "Waiting its turn in a run that is already going.";
      break;

    case "running":
      facts.why = "Working on it now.";
      break;

    case "skipped":
      // Two very different situations wearing one word. The stored message distinguishes them, and
      // guessing when it is absent would send half of these people to the wrong screen.
      facts.why =
        /condition/i.test(msg) ? "A run condition on this column was false for this row, so it was left alone."
        : /nothing in /i.test(msg) ? `${msg}. Fill that in first, then run this again.`
        : input.hasCondition ? "Left alone — either the run condition was false, or something it reads was empty."
        : "Left alone, because something this column reads was empty on this row.";
      break;

    case "blocked":
      facts.why = "Something this column depends on failed on this row, so this never ran. Fix that column first.";
      break;

    case "not_found":
      // NOT a failure, and saying so matters: re-running will not help, and the natural reaction to
      // an empty cell is to run it again.
      facts.why = "It looked and the answer genuinely is not there. Running it again will not change that.";
      break;

    case "cancelled":
      facts.why = "The run was stopped before this cell finished.";
      break;

    case "error": {
      /**
       * This used to return NOTHING whenever there was a message, on the reasoning that the error is
       * already shown above in full and a paraphrase adds nothing.
       *
       * Right about the cause, wrong about the remedy. "429 Too Many Requests" says exactly what
       * happened and nothing whatever about what to do, and the panel's only button was "Re-run this
       * cell" — which on a third of the failure classes is the one action the engine has already
       * refused. So the paraphrase is still suppressed when the real message is on screen, and the
       * TO-DO is not.
       */
      const e = errorFacts((input.errorType ?? null) as ErrClass | null, kind);
      facts.cause = e.cause;
      facts.rerunHelps = e.rerunHelps;
      facts.aiCanHelp = e.aiCanHelp;
      facts.fixArea = e.area;
      facts.fixWhere = e.fixWhere;
      facts.why = msg ? e.todo : `${e.cause} ${e.todo}`;
      break;
    }

    default:
      facts.why = null;
  }

  // These two are true ALONGSIDE a status rather than instead of one, so they are appended rather
  // than replacing the reason above.
  const extra: string[] = [];
  if (input.pinned) extra.push("You typed this value in, so a run will not overwrite it.");
  if (input.stale) {
    // On an overridden projection, "something this cell reads changed" is technically true and
    // useless — nothing is out of date, the typed value and the source simply disagree, and the fix
    // is to pick one rather than to re-run anything.
    extra.push(
      input.pinned && input.derivedFrom
        ? `It no longer matches what "${input.derivedFrom}" produces — keep yours, or restore theirs.`
        : "Something this cell reads changed after it ran, so this may be out of date.",
    );
  }
  if (extra.length) facts.why = [facts.why, ...extra].filter(Boolean).join(" ");

  return facts;
}

const KINDS: CellKind[] = [
  "static", "script", "http", "mcp", "ai", "agent", "send", "lookup", "rollup",
];

const STATUS_WORDS: Record<string, string> = {
  empty: "Never run",
  queued: "Queued",
  running: "Running",
  done: "Ran successfully",
  not_found: "Looked, and it does not exist",
  error: "Failed",
  skipped: "Skipped by a run condition",
  blocked: "Blocked by an upstream failure",
  cancelled: "Cancelled",
};

/**
 * The status, in words that can be true for this kind of column.
 *
 * A static column stores what you typed. Its cells are `done` when they hold something and `empty`
 * when they do not — the same two values every other column uses — but "Ran successfully" and
 * "Never run" are both false about a column that does not run. The panel now says "Nothing runs"
 * directly underneath, so the contradiction is no longer hypothetical: it is two lines apart.
 */
export function statusWord(kind: string, status: string): string {
  if (kind === "static") {
    if (status === "done") return "Has a value";
    if (status === "empty") return "Empty";
  }
  return STATUS_WORDS[status] ?? status;
}

/** One attempt at filling this cell, as the route returns it. */
export interface Attempt {
  id: number;
  attempt: number;
  status: string;
  model?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  cost_usd?: number | null;
  duration_ms?: number | null;
  /** The instruction with this row's values already substituted. Redacted server-side. */
  rendered_prompt?: string | null;
  error_type?: string | null;
  error_msg?: string | null;
  /** How many turns the agent loop took. Null on the lanes that do not loop. */
  num_turns?: number | null;
  /** The model's own finish-tool envelope, redacted. What makes a schema failure diagnosable. */
  raw_result?: string | null;
  script_hash?: string | null;
}

/**
 * A cost, in words a person can act on.
 *
 * Sub-cent amounts as cents, because "$0.0004" is a number you have to stop and count the zeros in —
 * and on this panel the figure is always sub-cent, since it is one cell.
 */
export function attemptCost(usd: number | null | undefined): string | null {
  if (usd == null) return null;
  if (usd === 0) return "free";
  if (usd < 0.01) return `${(usd * 100).toFixed(2)}¢`;
  return `$${usd.toFixed(3)}`;
}

/** A duration, at a precision that matches how long it took. */
export function attemptTook(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * How many attempts, and whether that is worth saying.
 *
 * One attempt is the normal case and needs no mention. More than one means it was retried, which is
 * a fact about reliability worth surfacing — a column quietly succeeding on its third try every time
 * is a column about to start failing.
 */
export function retryNote(attempts: Attempt[]): string | null {
  if (attempts.length <= 1) return null;
  const failed = attempts.filter((a) => a.status === "error").length;
  if (failed === 0) return `Took ${attempts.length} tries.`;
  return `Failed ${failed} time${failed === 1 ? "" : "s"} before this.`;
}
