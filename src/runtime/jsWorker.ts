// Worker thread that executes a generated JS transform over batches of rows.
//
// Isolation: the code is compiled with node:vm into a context holding NO globals — no require, no
// process, no fetch, no fs, no timers. It receives a row object and returns a value. That blocks
// casual reach-out; it is NOT a hardened security boundary against a determined attacker sharing a
// process, and it is not pretending to be one. The actual control is that every script is read and
// approved by a human before it can run, and pinned by content hash afterwards.
//
// Throughput comes from batching: the whole column streams through in chunks, so a million rows cost
// one worker and a few thousand messages rather than a process per row.

import { parentPort, workerData } from "node:worker_threads";
import { createContext, runInContext, Script } from "node:vm";

interface InitData {
  code: string;
  /** "transform" returns a value; "condition" returns a boolean gate. */
  hook: "transform" | "condition";
}

interface BatchMsg {
  id: number;
  rows: Array<{ rowId: number; values: Record<string, string | null> }>;
}

const { code, hook } = workerData as InitData;

// A frozen, empty-ish context. Only pure built-ins the transform legitimately needs.
const sandbox: Record<string, unknown> = {
  Math, JSON, Number, String, Boolean, Array, Object, Date, RegExp,
  parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
  URL,
};
const context = createContext(sandbox, {
  codeGeneration: { strings: false, wasm: false }, // no eval/Function inside the script
});

// The generated script defines `transform(row)` (or `condition(row)`). Wrapping it in an IIFE that
// returns the function keeps the user's code in one evaluated unit and gives a clear error if the
// expected entry point is missing.
type RowFn = (row: Record<string, unknown>) => unknown;

let fn: RowFn | null = null;
let initError: string | null = null;

try {
  const wrapper = `(function () {\n${code}\n;return typeof ${hook} === "function" ? ${hook} : null;})()`;
  const script = new Script(wrapper, { filename: `ferrum-${hook}.js` });
  // Named alias, not `typeof fn` — at this position TS has already narrowed fn to null, so
  // `as typeof fn` would assert it to null and every later call site becomes uncallable.
  fn = script.runInContext(context, { timeout: 2000 }) as RowFn | null;
  if (typeof fn !== "function") {
    initError = `The script must define a function named "${hook}(row)". None was found.`;
  }
} catch (e) {
  initError = e instanceof Error ? e.message : String(e);
}

parentPort?.postMessage({ type: "ready", error: initError });

parentPort?.on("message", (msg: BatchMsg) => {
  if (initError || !fn) {
    parentPort?.postMessage({ type: "batch", id: msg.id, error: initError });
    return;
  }

  const results: Array<{ rowId: number; value: unknown; error?: string }> = [];
  for (const r of msg.rows) {
    try {
      // Per-row timeout is not available on a plain function call, so a pathological regex can hang
      // this worker. The parent enforces a wall-clock cap on the whole batch and kills the worker,
      // which is why the worker is disposable and holds no state between columns.
      const value = fn(r.values as Record<string, unknown>);
      results.push({ rowId: r.rowId, value: value === undefined ? null : value });
    } catch (e) {
      // One bad row must not fail the other 999,999 — it becomes an error cell and the rest proceed.
      results.push({ rowId: r.rowId, value: null, error: e instanceof Error ? e.message : String(e) });
    }
  }
  parentPort?.postMessage({ type: "batch", id: msg.id, results });
});

// Keep the reference so a bundler cannot tree-shake the context away.
void runInContext;
