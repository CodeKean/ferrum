// Why is this column empty?
//
// The single most common thing anyone asks a tool like this, and the one it is worst at answering. A
// column reads "62% complete" and the other 38% is a silence. So people re-run it — which on a paid
// column means paying again to produce the same silence, because a re-run does not fix a missing
// upstream value or a condition that said no.
//
// ── This is a READER, not new machinery ────────────────────────────────────────────────────────
//
// The engine already knows every one of these answers and has always written them down. A cell that
// was skipped for a missing reference carries the sentence "Nothing in /Website for this row"; a
// gated one carries "condition returned false"; a failure carries its error and its type. All of it
// sits in `cells.error_msg` and `cells.note`, per row, and nothing ever read it in aggregate. The
// grid shows one cell's reason if you open that cell — which is no use at all when the question is
// about eight hundred of them.
//
// So this groups the blanks by the reason already recorded and counts them. No new column, no new
// write, no new cost.
//
// ── The distinction that makes it worth building ───────────────────────────────────────────────
//
// "Blank" is four completely different situations with four different fixes:
//
//   never run ......... nothing has happened yet          → run it
//   no input .......... the row had nothing to work from  → fill the upstream, or mark it optional
//   nothing found ..... it looked, the answer isn't there → the data does not exist; stop paying
//   gated ............. your run condition said no        → that is your rule working
//   failed ............ it broke                          → read the error
//
// Collapsing those into one number is what makes people re-run a column eleven times. Three of the
// five are not fixed by running it again, and two of them cost money every time you try.

import { db } from "./db.ts";
import { countRows } from "./store.ts";
import { redactSecrets } from "./redact.ts";
import type { CellStatus } from "./types.ts";
import { errorFacts, type ErrClass } from "./errorClass.ts";

/** `never_run` is not a stored status — it is the ABSENCE of a cell row. See `explainBlanks`. */
export type BlankKind = CellStatus | "never_run";

export interface BlankGroup {
  kind: BlankKind;
  /** The engine's own machine-readable class, when it recorded one. */
  errorType: string | null;
  /** The sentence already stored on the cell. Redacted on the way out, belt and braces. */
  message: string | null;
  /** Exact. Never a sample, never capped. */
  count: number;
  /** A few row ids so "show me one" is one click. */
  sampleRows: number[];
  /** What to actually do about it, in plain words. */
  advice: string;
  /** Would running this column again change this group? The answer is usually no. */
  fixedByRerunning: boolean;
}

export interface BlankReport {
  columnId: number;
  columnName: string;
  total: number;
  filled: number;
  blank: number;
  groups: BlankGroup[];
  /**
   * Distinct reasons that exist but are not in `groups`, because a column can accumulate a long tail
   * of one-off error strings.
   *
   * Stated rather than silently dropped: a breakdown that quietly stops short reads as complete, and
   * "everything is accounted for" is precisely the claim this screen must not make falsely.
   */
  moreReasons: number;
  /** Rows covered by the reasons NOT shown, so the numbers on screen still add up to the total. */
  moreRows: number;
}

/** How many distinct message variants to show before folding the rest into `moreReasons`. */
const VARIANTS = 8;

/** Statuses that carry an explanation worth grouping by. `done` and `empty` never do. */
const EXPLAINED: ReadonlySet<string> = new Set(["skipped", "blocked", "error", "not_found", "cancelled"]);

const ADVICE: Record<BlankKind, string> = {
  never_run: "This column has not run over these rows yet. Run it.",
  empty: "This column has not run over these rows yet. Run it.",
  queued: "Waiting for a worker. It will start on its own.",
  running: "In progress right now.",
  done: "This one has a value.",
  not_found:
    "It looked and the answer genuinely is not there. Running it again will cost the same and find the same nothing — try a different source instead.",
  // Only reached when the skip carries no message of its own. When it does, `adviceFor` below says
  // which of the two happened instead of offering both.
  skipped: "It did not run, so nothing was spent.",
  blocked: "Something this column reads failed first. Fix that column, then re-run this one.",
  // Only reached when a group has no error class at all. When it has one, `adviceFor` says what that
  // class actually means instead — see the note on RERUN_HELPS below.
  error: "It ran and broke. The message says what happened.",
  cancelled: "You stopped the run before these got their turn. Run it again to finish them.",
};

/**
 * The kinds a re-run genuinely fixes, and the one that USED to be wrongly in here.
 *
 * `"error"` was in this set, so every failing group — including a dead API key and a hit spending cap
 * — was advertised as "re-running will fix this". The engine's own `retryPolicy` refuses both
 * outright, so the panel was telling the user to press a button the engine would decline, on the one
 * screen whose entire purpose is to say whether pressing it helps. Costing them a wait each time, and
 * on a paid lane a bill.
 *
 * The information to answer it properly was already sitting in the row: `error_type` is grouped on
 * and was read by nothing. Errors are now answered through `errorFacts` — including the ones with no
 * class at all — and this set holds only the kinds whose verdict never depended on one.
 */
const RERUN_HELPS: ReadonlySet<BlankKind> = new Set<BlankKind>(["never_run", "empty", "cancelled"]);

/**
 * Advice for a group, narrowed by the message the engine already wrote.
 *
 * `skipped` covers two situations with opposite fixes: the row had no input, or your condition
 * deliberately excluded it. The first is a problem, the second is your rule working exactly as
 * intended. Offering both on every skipped group — when the message beside it already says which —
 * makes the panel read as if it does not know, and turns a correct gate into something that looks
 * like a fault.
 */
function adviceFor(kind: BlankKind, message: string | null, errorType?: string | null, lane?: string): string {
  // An error is answered by its CLASS, not by the word "error". 400 cells failing on a rejected key
  // and 400 failing on a wrong-shaped answer are two different afternoons, and `ADVICE.error` — "it
  // ran and broke, the message says what happened" — is the same non-answer for both.
  if (kind === "error" && errorType) {
    const e = errorFacts(errorType as ErrClass, lane ?? "ai");
    return `${e.cause} ${e.todo}`;
  }
  if (kind === "skipped" && message) {
    if (/condition/i.test(message)) {
      return "Your run condition excluded these rows on purpose. Nothing was spent on them, and nothing is wrong.";
    }
    if (/nothing in /i.test(message)) {
      return "These rows had nothing to work from. Fill the column they need first, or mark that reference optional so they run anyway.";
    }
  }
  return ADVICE[kind] ?? "";
}

/**
 * Explain a column's blanks.
 *
 * Two passes rather than one grouped query, and the split is deliberate. The COUNTS come from
 * `ix_cells_col_status`, which covers `(column_id, status)` and answers without touching the table —
 * measured at ~400ms on the million-row sheet. Grouping by the message as well cannot use that
 * index, so it runs only over the statuses that actually carry a message, and only when there are
 * any. On the ordinary case — a column that is mostly `never_run` — the second pass reads nothing.
 */
export function explainBlanks(columnId: number, limit = VARIANTS): BlankReport {
  const col = db
    // `kind` is read because the same failure means different things per lane — a timed-out agent
    // searched too long, a timed-out endpoint is simply slow — and the advice has to say which.
    .prepare("SELECT id, name, sheet_id, kind FROM columns WHERE id = ? AND deleted_at IS NULL")
    .get(Number(columnId)) as any;
  if (!col) throw new Error("That column no longer exists.");

  const total = countRows(String(col.sheet_id));

  // Index-covered.
  const byStatus = new Map<string, number>();
  let cellRows = 0;
  for (const r of db
    .prepare("SELECT status, COUNT(*) AS n FROM cells WHERE column_id = ? GROUP BY status")
    .all(Number(columnId)) as any[]) {
    byStatus.set(String(r.status), Number(r.n));
    cellRows += Number(r.n);
  }

  // A `done` cell holding nothing is counted as blank, not filled.
  //
  // It is rare and it is the most confusing state in the product: the column says it completed, the
  // cell says it succeeded, and there is nothing there. Filed under `not_found` would be a lie —
  // that means "it looked and there is no answer" — so it keeps its own group and says plainly that
  // the run reported success and returned nothing.
  const doneEmpty = Number(
    (db
      .prepare(
        `SELECT COUNT(*) AS n FROM cells
          WHERE column_id = ? AND status = 'done' AND (value_text IS NULL OR value_text = '')`,
      )
      .get(Number(columnId)) as any).n,
  );

  const filled = Math.max(0, (byStatus.get("done") ?? 0) - doneEmpty);
  const blank = Math.max(0, total - filled);

  const groups: BlankGroup[] = [];

  // Rows with no cell for this column at all. On a column added to an existing table that is every
  // row, and it is the answer to "why is my new column empty" nearly every time.
  const neverRun = Math.max(0, total - cellRows);
  if (neverRun > 0) {
    groups.push({
      kind: "never_run", errorType: null, message: null, count: neverRun,
      sampleRows: sampleRowsWithoutCell(String(col.sheet_id), Number(columnId)),
      advice: ADVICE.never_run, fixedByRerunning: true,
    });
  }

  // Statuses with no message of their own: counted, not grouped.
  for (const [status, n] of byStatus) {
    if (status === "done" || EXPLAINED.has(status)) continue;
    if (n === 0) continue;
    groups.push({
      kind: status as BlankKind, errorType: null, message: null, count: n,
      sampleRows: sampleRows(Number(columnId), status),
      advice: ADVICE[status as BlankKind] ?? "",
      fixedByRerunning: RERUN_HELPS.has(status as BlankKind),
    });
  }

  if (doneEmpty > 0) {
    groups.push({
      kind: "done", errorType: null,
      message: "The run reported success and returned nothing.",
      count: doneEmpty,
      sampleRows: sampleRows(Number(columnId), "done", true),
      advice:
        "This usually means the source had the record but not this field. Open one and look at what came back.",
      fixedByRerunning: false,
    });
  }

  // The explained statuses, grouped by the sentence the engine already wrote.
  const explained = [...byStatus.keys()].filter((s) => EXPLAINED.has(s) && (byStatus.get(s) ?? 0) > 0);
  let shownFromExplained = 0;
  let explainedTotal = 0;
  let variants = 0;

  if (explained.length > 0) {
    for (const s of explained) explainedTotal += byStatus.get(s) ?? 0;

    const rows = db
      .prepare(
        `SELECT status, error_type, COALESCE(error_msg, note) AS msg, COUNT(*) AS n, MIN(row_id) AS lo
           FROM cells
          WHERE column_id = ? AND status IN (${explained.map(() => "?").join(",")})
          GROUP BY status, error_type, msg
          ORDER BY n DESC`,
      )
      .all(Number(columnId), ...explained) as any[];

    variants = rows.length;
    for (const r of rows.slice(0, limit)) {
      const kind = String(r.status) as BlankKind;
      const nRows = Number(r.n);
      const message = r.msg ? redactSecrets(String(r.msg)) : null;
      shownFromExplained += nRows;
      groups.push({
        kind,
        errorType: r.error_type ?? null,
        message,
        count: nRows,
        sampleRows: sampleRowsFor(Number(columnId), String(r.status), r.error_type ?? null, r.msg ?? null),
        advice: adviceFor(kind, message, r.error_type ?? null, String(col.kind)),
        // Per class for an error, because whether a re-run helps is a fact about the failure and not
        // about the word "error". Note this routes a CLASSLESS error through `errorFacts(null)` too,
        // rather than through the set — "nothing recorded a reason" is its own answer (try it again,
        // the second failure usually says more) and it is not the same answer as any named class.
        fixedByRerunning:
          kind === "error"
            ? errorFacts((r.error_type ?? null) as ErrClass | null, String(col.kind)).rerunHelps
            : RERUN_HELPS.has(kind),
      });
    }
  }

  // Biggest first, so the answer is the first line rather than something to hunt for.
  groups.sort((a, b) => b.count - a.count);

  return {
    columnId: Number(columnId),
    columnName: String(col.name),
    total, filled, blank,
    groups,
    moreReasons: Math.max(0, variants - limit),
    moreRows: Math.max(0, explainedTotal - shownFromExplained),
  };
}

/** Three examples. `LIMIT 3` on an indexed lookup — never a scan of the group. */
function sampleRows(columnId: number, status: string, emptyValueOnly = false): number[] {
  return (db
    .prepare(
      `SELECT row_id FROM cells
        WHERE column_id = ? AND status = ?${emptyValueOnly ? " AND (value_text IS NULL OR value_text = '')" : ""}
        LIMIT 3`,
    )
    .all(columnId, status) as any[]).map((r) => Number(r.row_id));
}

function sampleRowsFor(columnId: number, status: string, errorType: string | null, msg: string | null): number[] {
  return (db
    .prepare(
      `SELECT row_id FROM cells
        WHERE column_id = ? AND status = ?
          AND error_type IS ? AND COALESCE(error_msg, note) IS ?
        LIMIT 3`,
    )
    .all(columnId, status, errorType, msg) as any[]).map((r) => Number(r.row_id));
}

/**
 * Rows this column has never touched.
 *
 * `NOT EXISTS` against the cells primary key rather than `NOT IN (SELECT ...)`, which would
 * materialize a million ids to answer a question about three.
 */
function sampleRowsWithoutCell(sheetId: string, columnId: number): number[] {
  return (db
    .prepare(
      `SELECT r.id FROM rows r
        WHERE r.sheet_id = ?
          AND NOT EXISTS (SELECT 1 FROM cells c WHERE c.row_id = r.id AND c.column_id = ?)
        ORDER BY r.position
        LIMIT 3`,
    )
    .all(sheetId, columnId) as any[]).map((r) => Number(r.id));
}
