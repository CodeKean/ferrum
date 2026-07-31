// The per-cell executor for `mcp` columns.
//
// The same shape as `src/http/executeHttp.ts`, in the same order, for the same reasons — read that
// file's comments alongside this one. The order is not incidental: what a row is charged for depends
// entirely on where in this sequence it stops.

import { bodyValue, callCost, missingRequired, type RowValues } from "../http/httpColumn.ts";
import { normalizeMcpConfig, refTemplates } from "./mcpColumn.ts";
import { McpError, poolForRun, type McpPool } from "./client.ts";
import { getMcpServer } from "./servers.ts";
import { valuesFor } from "../http/executeHttp.ts";
import { getPath } from "../jsonPath.ts";
import { listColumns } from "../store.ts";
import type { CellJob, CellOutcome } from "../runs.ts";
import type { ErrClass } from "../errorClass.ts";
import type { Column } from "../types.ts";
import { coerce } from "../agent/executor.ts";

/** A reference's display name, for a message a person reads. */
function nameOf(sheetId: string, key: string): string {
  const col = listColumns(sheetId).find((c) => String(c.id) === key || c.name.trim().toLowerCase() === key);
  return `/${col?.name ?? key}`;
}

export async function executeMcpCell(
  job: CellJob,
  column: Column,
  /** Injected by the tests. In a real run this is the run's own pool, shared by all six workers. */
  pool: McpPool = poolForRun(job.runId),
): Promise<CellOutcome> {
  let cfg;
  try {
    cfg = normalizeMcpConfig((column as any).mcpConfig);
  } catch (e) {
    // The column's fault, not the row's: the same answer on every row, and never retried because
    // retrying cannot fix it.
    return { status: "error", errorType: "schema", errorMsg: e instanceof Error ? e.message : String(e) };
  }

  if (!cfg.serverId) return { status: "skipped", errorMsg: "This column has no connected app chosen yet." };
  if (!cfg.tool) return { status: "skipped", errorMsg: "This column has no tool chosen yet." };

  // Checked before anything is spent, and it is a `schema` error rather than a skip: the column names
  // an app that is not set up, which somebody has to fix, whereas a skip reads as "nothing to do".
  if (!getMcpServer(cfg.serverId)) {
    return {
      status: "error",
      errorType: "schema",
      errorMsg: "The connected app this column uses is not set up any more. Add it again in Settings → Connected apps.",
    };
  }

  /**
   * What the call costs at the other end, attached to every outcome BELOW this line.
   *
   * Not to the skips above — a row that was never called was never charged, and counting it would
   * inflate the total in exactly the case the skip exists to save money in. It IS attached to the
   * failures below: a provider bills for the call, not for the answer.
   */
  const charge = (() => {
    const c = callCost(cfg.cost);
    return c.units > 0 ? { costUsd: c.usd || undefined, units: c.units, unit: c.unit } : {};
  })();

  const values: RowValues = valuesFor(job.sheetId, job.rowId, job.columnId);

  // A required reference with nothing behind it stops the row here. A tool called with a blank domain
  // still answers, and the answer is about nothing — once per row, at whatever that tool charges.
  const missing = missingRequired(refTemplates(cfg), values);
  if (missing.length > 0) {
    const names = missing.map((k) => nameOf(job.sheetId, k)).join(", ");
    return {
      status: "skipped",
      errorMsg: `Nothing in ${names} for this row. Mark the reference optional if it should run anyway.`,
    };
  }

  // Arguments are built as an OBJECT and the row's values go in as values, so a cell can never add an
  // argument the template did not name.
  //
  // `bodyValue` rather than `render`, because a tool's arguments are typed by a JSON schema the
  // server publishes: an authored `25` has to arrive as the number 25 and not the string "25", or a
  // schema expecting a number rejects the call. A field that DOES carry a row reference is always a
  // string, since a cell's text is not something to guess a type for.
  //
  // Single-pass on purpose, inherited from `render`: a recursive pass would let a cell containing
  // `{{col:7}}` — trivially achievable from a scraped page — read a column this column never named.
  const args: Record<string, unknown> = {};
  for (const a of cfg.args) args[a.name] = bodyValue(a.value, values);

  let result: unknown;
  try {
    result = await pool.callTool(cfg.serverId, cfg.tool, args, cfg.timeoutMs);
  } catch (e) {
    const kind = e instanceof McpError ? e.kind : "call";
    // Mapped onto the engine's classes so the retry policy and the adaptive pacer behave. A timeout
    // gets the full retry budget; a config fault is `schema`, which the engine caps at a single
    // retry, because retrying a wrong tool name a thousand times is a thousand identical failures.
    const errorType: ErrClass = kind === "timeout" ? "timeout" : kind === "config" ? "schema" : "tool";
    return {
      status: "error",
      errorType,
      errorMsg: e instanceof Error ? e.message : String(e),
      ...charge,
    };
  }

  const picked = cfg.responsePath ? getPath(result, cfg.responsePath) : result;

  // `undefined` means the path found nothing, which is not the same as a field that is there and
  // empty. Reported rather than written as blank: "the field moved" and "the field is empty" are
  // different problems and only one of them is about this row.
  if (picked === undefined) {
    return {
      status: "not_found",
      errorMsg: `The tool's answer had nothing at "${cfg.responsePath}".`,
      ...charge,
    };
  }
  if (picked === null) {
    return { status: "not_found", errorMsg: "The tool had no answer for this row.", ...charge };
  }

  // Coerced like any other value, so an MCP column declared as a number cannot quietly hold text.
  const { text, error } = coerce(picked, column.valueType, { enumValues: column.enumValues });
  if (error) return { status: "error", errorType: "schema", errorMsg: error, ...charge };

  // Coerced to nothing is `not_found`, matching the model and HTTP lanes: a `done` cell holding an
  // empty value is indistinguishable in the grid from one that was never run.
  if (text == null || text === "") {
    return { status: "not_found", errorMsg: "The tool had no answer for this row.", ...charge };
  }

  return { status: "done", valueText: text, ...charge };
}
