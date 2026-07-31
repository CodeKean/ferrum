// What the engine did NOT spend.
//
// ── Why this exists ────────────────────────────────────────────────────────────────────────────
//
// The argument for this product over a per-row tool is that most rows do not need buying again: the
// inputs have not changed, or a condition excluded the row before any paid lane saw it. That
// argument is completely invisible today. A run that skips 940,000 of a million rows shows a smaller
// bill and no explanation, so the saving reads as the run having done less work rather than as the
// tool having done its job.
//
// ── What is recorded, and what is not ──────────────────────────────────────────────────────────
//
// Only spend that was genuinely AVOIDABLE — work the engine could have bought and chose not to. A
// script column costing nothing is not a saving, it is a free lane; counting it would turn this into
// a vanity number, which is the failure mode of every "money saved" figure ever put on a dashboard.
//
// The figure is an ESTIMATE and never pretends otherwise. It comes from `perRowCost` — the same
// function the run confirmation quotes from — so the two cannot drift apart. When a model has no
// usable price the cells are counted under `cellsUnpriced` instead of being priced at zero, so a
// total can say how much of itself it could not see rather than silently under-reporting.

import { db } from "./db.ts";
import { getColumn } from "./store.ts";
import { perRowCost } from "./estimate.ts";
import { cachedModels } from "./providers/catalog.ts";
import { effectiveDefaultModel } from "./providers/resolve.ts";
import { isLocalModel } from "./providers/local.ts";
import { perSearchUsd, chosenBackend } from "./search/registry.ts";

/**
 * Why the spend was avoided.
 *
 * A closed set, because these end up as words on a screen and "other" is not an explanation. Each
 * one names a mechanism the user can recognise and, if they want, turn off.
 */
export type SavingReason =
  /** The inputs to this cell have not changed since it last ran, so the old answer still stands. */
  | "unchanged"
  /** A run condition excluded the row before the paid lane saw it. */
  | "condition"
  /** An identical question had already been answered, so the stored answer was reused. */
  | "cache"
  /**
   * A cheaper first model answered confidently, so the expensive one was never asked.
   *
   * Priced at the EXPENSIVE model rate, which is the point: the saving is the call that did not
   * happen. perRowUsd reads the column model, and on a two-model column that is the one it escalates
   * TO — so this is already correct without a special case.
   */
  | "first_model";

export const SAVING_LABEL: Record<SavingReason, string> = {
  unchanged: "Nothing had changed",
  condition: "Excluded by a condition",
  cache: "Already answered",
  first_model: "Answered by the cheap model",
};

/** Only these lanes can produce a saving — the rest cost nothing to begin with. */
const PAID_KINDS = new Set(["ai", "agent"]);

/**
 * What one row of this column would have cost.
 *
 * Returns null when the column is not a paid lane, or runs on a local model, or has no usable
 * price. Null means "no saving to record", never "a saving of zero" — a zero would be counted, and
 * a total padded with zeroes is a total nobody can check.
 */
function perRowUsd(sheetId: string, columnId: number): number | null {
  const col = getColumn(columnId);
  if (!col || !PAID_KINDS.has(col.kind)) return null;

  const modelId = col.model && col.model !== "auto" ? col.model : effectiveDefaultModel();
  // A local model bills nothing, so not running it saves nothing. Recording one would make the
  // ledger a count of rows dressed up as money.
  if (isLocalModel(modelId)) return null;

  const agent = (col as any).agent?.search ?? {};
  const searching = col.kind === "agent" && (col.allowedTools ?? []).includes("web_search");

  const est = perRowCost({
    kind: col.kind as "ai" | "agent",
    modelId,
    promptText: col.prompt ?? "",
    sheetId,
    columnId,
    // The same shape the confirmation uses. Passed rather than re-derived so a change to the
    // estimator moves both numbers together.
    turns: Number(agent.maxTurns) > 0 ? Number(agent.maxTurns) : 4,
    searchPerCall: searching ? perSearchUsd(chosenBackend()) ?? 0 : 0,
    maxSearches: searching ? Number(agent.maxSearches) || 1 : 0,
    models: cachedModels(),
  });

  if (est.unpriced || !(est.perRow > 0)) return null;
  return est.perRow;
}

export interface RecordSaving {
  runId?: string | null;
  sheetId: string;
  columnId: number;
  reason: SavingReason;
  /** How many cells were not bought. */
  cells: number;
}

/**
 * Note that some cells were not bought.
 *
 * Silent on anything it cannot price honestly: a free lane, a local model, an unknown rate. The
 * caller does not have to know which of those applies, which is what keeps the recording call at
 * each skip site to one line and stops the rule being restated three times.
 *
 * Never throws. A ledger is a record OF the work, not part of it — a failure to write one must not
 * fail the run it is describing.
 */
export function recordSaving(input: RecordSaving): void {
  try {
    const cells = Math.max(0, Math.floor(input.cells));
    if (cells === 0) return;

    const usdPerRow = perRowUsd(input.sheetId, input.columnId);
    const col = getColumn(input.columnId);
    // Not a paid lane at all: nothing to record, not even as unpriced. Only a column that COULD have
    // cost something belongs in a ledger of what was not spent.
    if (!col || !PAID_KINDS.has(col.kind)) return;

    // Priced or not, both are recorded — but in different columns. A paid column whose model has no
    // published rate has genuinely saved something; refusing to record it would understate the
    // total, and pricing it at zero would misstate it. Counting the cells separately says exactly
    // what is known and what is not.
    const priced = usdPerRow != null;

    db.prepare(
      `INSERT INTO savings (run_id, sheet_id, column_id, reason, cells, cells_unpriced, usd)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.runId ?? null,
      input.sheetId,
      input.columnId,
      input.reason,
      priced ? cells : 0,
      priced ? 0 : cells,
      priced ? usdPerRow! * cells : 0,
    );
  } catch {
    /* see above: the ledger never breaks the run it describes. */
  }
}

export interface SavingsTotals {
  usd: number;
  cells: number;
  /** Cells that were genuinely avoided but whose price is unknown — see the note at the top. */
  cellsUnpriced: number;
  byReason: Array<{ reason: SavingReason; label: string; usd: number; cells: number; cellsUnpriced: number }>;
}

const EMPTY: SavingsTotals = { usd: 0, cells: 0, cellsUnpriced: 0, byReason: [] };

/**
 * What has not been spent, for a table or for everything.
 *
 * `sheetId` of null means the whole workspace, matching how the usage report is scoped.
 */
export function savingsFor(sheetId: string | null, sinceIso?: string | null): SavingsTotals {
  try {
    const where: string[] = [];
    const params: string[] = [];
    if (sheetId) { where.push("sheet_id = ?"); params.push(sheetId); }
    if (sinceIso) { where.push("at >= ?"); params.push(sinceIso); }
    const sql = `SELECT reason, SUM(usd) AS usd, SUM(cells) AS cells, SUM(cells_unpriced) AS unpriced
                   FROM savings
                  ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                  GROUP BY reason`;

    const rows = db.prepare(sql).all(...params) as any[];
    const byReason = rows
      .filter((r) => SAVING_LABEL[r.reason as SavingReason])
      .map((r) => ({
        reason: r.reason as SavingReason,
        label: SAVING_LABEL[r.reason as SavingReason],
        usd: Number(r.usd ?? 0),
        cells: Number(r.cells ?? 0),
        cellsUnpriced: Number(r.unpriced ?? 0),
      }))
      .sort((a, b) => b.usd - a.usd || b.cells - a.cells);

    return {
      usd: byReason.reduce((n, r) => n + r.usd, 0),
      cells: byReason.reduce((n, r) => n + r.cells, 0),
      cellsUnpriced: byReason.reduce((n, r) => n + r.cellsUnpriced, 0),
      byReason,
    };
  } catch {
    return EMPTY;
  }
}
