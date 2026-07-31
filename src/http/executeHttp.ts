// The per-cell executor for HTTP and webhook columns.
//
// Kept apart from the model executor because they share the queue and nothing else. Routing an API
// call through the agent path would attach a system prompt and a finish tool to a request that has
// no use for either.

import { db } from "../db.ts";
import { listColumns } from "../store.ts";
import { callCost, callHttp, missingRequired, normalizeHttpConfig, type HttpConfig, type Pair, type RowValues } from "./httpColumn.ts";
import { noteSecretsUsed, resolveSecrets } from "../secrets.ts";
import type { CellJob, CellOutcome } from "../runs.ts";
import type { Column } from "../types.ts";
import { coerce } from "../agent/executor.ts";

/**
 * Everything a template can reference for one row, keyed BOTH ways.
 *
 * By id because that is what the UI writes and what survives a rename; by lowercased name because a
 * hand-written template reads far better as `{{Website}}` than as `{{col:17}}`, and a template
 * nobody can read is a template nobody checks.
 */
export function valuesFor(sheetId: string, rowId: number, exclude: number): RowValues {
  const cols = listColumns(sheetId).filter((c) => Number(c.id) !== exclude);
  const out: RowValues = new Map();
  if (cols.length === 0) return out;

  const rows = db
    .prepare(
      `SELECT column_id, value_text FROM cells
        WHERE row_id = ? AND column_id IN (${cols.map(() => "?").join(",")})`,
    )
    .all(rowId, ...cols.map((c) => Number(c.id))) as any[];

  const byId = new Map(cols.map((c) => [Number(c.id), c]));
  for (const r of rows) {
    const col = byId.get(Number(r.column_id));
    if (!col) continue;
    out.set(String(col.id), r.value_text ?? null);
    out.set(col.name.trim().toLowerCase(), r.value_text ?? null);
  }
  return out;
}

/**
 * A copy of the request with every `{{secret:Name}}` replaced by its stored value.
 *
 * Walks the whole config rather than a chosen field or two: a key is put in a header on most APIs,
 * in a query parameter on plenty of others, and in the body on a few — and picking which of those
 * to support would silently not work on the third.
 */
function resolveHttpSecrets(cfg: HttpConfig): { cfg: HttpConfig; missing: string[]; used: string[] } {
  const missing = new Set<string>();
  const used = new Set<string>();
  const sub = (s: string): string => {
    if (!s || !s.includes("{{")) return s;
    const r = resolveSecrets(s);
    for (const m of r.missing) missing.add(m);
    for (const u of r.used) used.add(u);
    return r.text;
  };
  const pairs = (list: Pair[]): Pair[] => list.map((p) => ({ name: sub(p.name), value: sub(p.value) }));

  return {
    cfg: {
      ...cfg,
      url: sub(cfg.url),
      body: sub(cfg.body),
      query: pairs(cfg.query),
      headers: pairs(cfg.headers),
      bodyFields: pairs(cfg.bodyFields),
    },
    missing: [...missing],
    used: [...used],
  };
}

/** A reference key back to a column name, so the skip reason names the column rather than an id. */
function nameOf(sheetId: string, key: string): string {
  const col = listColumns(sheetId).find(
    (c) => String(c.id) === key || c.name.trim().toLowerCase() === key,
  );
  return col ? `/${col.name}` : `/${key}`;
}

export async function executeHttpCell(job: CellJob, column: Column): Promise<CellOutcome> {
  let cfg;
  try {
    cfg = normalizeHttpConfig((column as any).httpConfig);
  } catch (e) {
    // A malformed config is the column's fault, not the row's, so it is the same answer on every
    // row — reported once per cell but never retried, because retrying cannot fix it.
    return { status: "error", errorType: "schema", errorMsg: e instanceof Error ? e.message : String(e) };
  }

  if (!cfg.url.trim()) {
    // Skipped rather than errored, matching the unconfigured-prompt case: a column nobody has set up
    // yet is not a failure of these rows, and marking a million of them as errors buries every real
    // failure underneath.
    return { status: "skipped", errorMsg: "This column has no URL yet." };
  }

  /**
   * What this call costs at the other end, if the column declares it.
   *
   * Computed here and attached to every outcome BELOW this point — that is, to every outcome that
   * follows a request actually being sent. Deliberately NOT attached to the skips above: a row that
   * was never called was never charged, and counting it would inflate the total in exactly the
   * situation the skip exists to save money in.
   *
   * It IS attached to the failures. A provider bills for the call, not for the answer, so a run
   * against a broken endpoint that burned two thousand credits must show two thousand credits.
   */
  const charge = (() => {
    const c = callCost(cfg.cost);
    return c.units > 0 ? { costUsd: c.usd || undefined, units: c.units, unit: c.unit } : {};
  })();

  const values = valuesFor(job.sheetId, job.rowId, job.columnId);

  // Checked BEFORE the call, and this is the whole point of marking a reference required. A template
  // with a blank domain still builds a well-formed request, the endpoint still answers, and the
  // answer is about nothing — once per row, at whatever that endpoint charges. Skipping is free and
  // says why; calling is not and does not.
  const missing = missingRequired(
    [cfg.url, cfg.body, ...cfg.query.map((p) => p.value), ...cfg.headers.map((p) => p.value), ...cfg.bodyFields.map((p) => p.value)],
    values,
  );
  if (missing.length > 0) {
    const names = missing.map((k) => nameOf(job.sheetId, k)).join(", ");
    return {
      status: "skipped",
      errorMsg: `Nothing in ${names} for this row. Mark the reference optional if it should run anyway.`,
    };
  }

  /**
   * Stored keys, put in at the LAST possible moment.
   *
   * Everything above this line — the skip messages, the missing-reference report, the dependency
   * work, anything that could be logged — has already happened against the config as WRITTEN, which
   * still says `{{secret:Prospeo}}`. Only the object handed to `callHttp` carries real values, and
   * it is a copy that is not stored anywhere and does not outlive this call.
   *
   * A reference to a key that is not there REFUSES the row rather than sending a request with the
   * placeholder still in it. That request would reach the provider, fail with a 401, and read as
   * "your key is wrong" — sending everyone to check a key that was never the problem. And on a
   * metered endpoint it would be billed.
   */
  const live = resolveHttpSecrets(cfg);
  if (live.missing.length > 0) {
    return {
      status: "error",
      errorType: "schema",
      errorMsg:
        `This column uses ${live.missing.map((n) => `"${n}"`).join(", ")}, which ${live.missing.length === 1 ? "is" : "are"} not in your saved keys. ` +
        "Add it in Settings → Keys, or correct the name.",
    };
  }

  const res = await callHttp(live.cfg, values, job.signal);
  // Counted once per request, whatever the outcome — a key that authenticated a call that then
  // failed was still used, and "last used" is how a key nobody needs any more is identified.
  if (live.used.length > 0) noteSecretsUsed(live.used);

  if (res.error) {
    // The column decides what is worth another go, and the answer is expressed as an error CLASS so
    // the engine's one retry path acts on it. A second retry loop living here would multiply against
    // that one — three engine attempts times three local ones is nine requests per row, and on a
    // metered API that is nine times the bill for a wall that was never going to move.
    //
    // A status the user did not list is terminal even if it is a 500: they said which ones to retry.
    //
    // Status 0 is the exception: it is not a status at all, it is "the request never completed" —
    // a timeout, a refused connection, a DNS failure. Those are genuinely transient and keep the
    // column's full retry budget.
    //
    // Everything else the user did not list is classified `schema`, which is the only class the
    // engine caps at a SINGLE retry. That matters most for the case that looks like a transport
    // failure and is not: a 2xx whose responsePath matched nothing, or whose body was not JSON, is a
    // typo in the column's configuration. It answers identically on every attempt and on every row,
    // and classing it `unknown` means three billed requests per row, forever, for a mistake no
    // number of retries can fix. (One retry is the floor reachable from here; a genuinely terminal
    // class needs a new entry in ErrClass and in the engine's retry policy.)
    const retryable = cfg.retryOnFailure && cfg.retryStatuses.includes(res.status);
    const errorType = res.status === 0
      ? "timeout"
      : !retryable
      ? "schema"
      : res.status === 429 ? "rate_limit"
      : res.status >= 500 ? "overloaded"
      : "timeout";
    return { status: "error", errorType, errorMsg: res.error, durationMs: res.durationMs, ...charge };
  }

  // Fire-and-forget: the point is that it landed, so the cell records that rather than a body
  // nobody asked for. Storing the response would fill a webhook column with acknowledgements.
  // Unless metadata was asked for, in which case callHttp already wrapped it and throwing that away
  // to write "sent" would make the setting do nothing on exactly the columns that use it most.
  if (cfg.fireAndForget) {
    return {
      status: "done",
      valueText: cfg.returnMetadata ? res.value : `sent · ${res.status}`,
      durationMs: res.durationMs,
      ...charge,
    };
  }

  if (res.value == null) {
    return { status: "not_found", errorMsg: "The response had no value at that path.", durationMs: res.durationMs, ...charge };
  }

  // Coerced like any other value, so an HTTP column declared as a number cannot quietly hold text.
  const { text, error } = coerce(res.value, column.valueType, { enumValues: column.enumValues });
  if (error) return { status: "error", errorType: "schema", errorMsg: error, durationMs: res.durationMs, ...charge };

  // An answer that coerces to nothing is `not_found`, matching the model lane. A `done` cell holding
  // null is indistinguishable in the grid, in an export and downstream from a real blank answer.
  if (text == null || text === "") {
    return { status: "not_found", errorMsg: "The response had no value at that path.", durationMs: res.durationMs, ...charge };
  }

  return { status: "done", valueText: text, durationMs: res.durationMs, ...charge };
}
