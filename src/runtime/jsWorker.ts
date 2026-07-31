// Worker thread that executes a generated JS transform over batches of rows.
//
// Isolation, stated precisely because the previous version of this comment was wrong:
//
//   * The code runs in a node:vm context of its OWN realm. Nothing reachable from the script — not a
//     global, not the row object, not a thrown value — is an object from this realm. That is the
//     whole boundary. It used to be breached by the sandbox itself: the context was populated with
//     THIS realm's `Object`, `JSON`, `Math` and friends, and `Object.constructor` is the host
//     `Function`, so `Object.constructor("return process")()` compiled and ran host code with the
//     full Node API. Nothing built from this realm may be handed in again — that includes helpers
//     and error objects, which is why the URL bridge below returns plain fields and never throws
//     across the line.
//   * A fresh context has the ECMAScript intrinsics and nothing else: no require, no process, no
//     fetch, no fs, no timers, no console, no Buffer. `codeGeneration` then disables the context's
//     own eval/Function, so the script cannot compile new code even in its own realm.
//   * NOT covered: CPU and memory. A script can burn either. Compilation gets a 2s timeout; per-row
//     calls cannot be timed out at all, so the parent caps the whole batch at BATCH_TIMEOUT_MS and
//     kills the worker — which is why the worker is disposable and holds no state between columns.
//   * NOT a substitute for review. Every script is read and approved by a human before it can run,
//     and pinned by content hash afterwards. That remains the primary control.
//
// Throughput comes from batching: the whole column streams through in chunks, so a million rows cost
// one worker and a few thousand messages rather than a process per row.

import { parentPort, workerData } from "node:worker_threads";
import { createContext, Script } from "node:vm";

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

// An empty context. Its global object already carries that realm's own Math, JSON, Object, Array,
// Date, RegExp, parseInt, ... — the built-ins a transform legitimately needs — so there is nothing
// to hand it and everything to gain by handing it nothing.
const context = createContext(undefined, {
  codeGeneration: { strings: false, wasm: false }, // no eval/Function inside the script
});

/**
 * The one capability the script gets that its realm does not already have: URL parsing.
 *
 * Handing it Node's `URL` would undo the whole boundary — `URL.constructor` is the host `Function`.
 * So the parse happens here and only STRINGS cross back; a failure comes back as null rather than as
 * a host `TypeError`, because a thrown host object is a host object like any other. The class the
 * script actually sees is built inside the context, from the fields these strings carry.
 */
function parseUrl(input: string, base: string | undefined): Record<string, string> | null {
  try {
    const u = base === undefined ? new URL(input) : new URL(input, base);
    return {
      href: u.href, origin: u.origin, protocol: u.protocol, username: u.username,
      password: u.password, host: u.host, hostname: u.hostname, port: u.port,
      pathname: u.pathname, search: u.search, hash: u.hash,
    };
  } catch {
    return null;
  }
}

/**
 * Installs the sandbox's own URL/URLSearchParams and returns the helpers the host needs.
 *
 * A function expression evaluated INSIDE the context, so everything it creates belongs to the
 * context's realm. `parseUrl` reaches it as a closed-over argument and is never a property of
 * anything the script can name, so the script has no path to it or to its `.constructor`.
 */
const BOOTSTRAP = `(function (parse) {
  "use strict";
  const FIELDS = ["href","origin","protocol","username","password","host","hostname","port","pathname","search","hash"];
  function decode(s) { try { return decodeURIComponent(s.replace(/\\+/g, " ")); } catch (e) { return s; } }
  class URLSearchParams {
    constructor(init) {
      this._pairs = [];
      const q = String(init == null ? "" : init).replace(/^[?]/, "");
      for (const part of q.split("&")) {
        if (!part) continue;
        const i = part.indexOf("=");
        this._pairs.push(i < 0 ? [decode(part), ""] : [decode(part.slice(0, i)), decode(part.slice(i + 1))]);
      }
    }
    get(k) { for (const p of this._pairs) if (p[0] === k) return p[1]; return null; }
    getAll(k) { return this._pairs.filter((p) => p[0] === k).map((p) => p[1]); }
    has(k) { return this.get(k) !== null; }
    forEach(f, self) { for (const p of this._pairs) f.call(self, p[1], p[0], this); }
    keys() { return this._pairs.map((p) => p[0])[Symbol.iterator](); }
    values() { return this._pairs.map((p) => p[1])[Symbol.iterator](); }
    entries() { return this._pairs.map((p) => [p[0], p[1]])[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
    toString() {
      return this._pairs.map((p) => encodeURIComponent(p[0]) + "=" + encodeURIComponent(p[1])).join("&");
    }
  }
  class URL {
    constructor(input, base) {
      const f = parse(String(input), base === undefined ? undefined : String(base));
      if (f === null) throw new TypeError("Invalid URL: " + String(input));
      for (const k of FIELDS) this[k] = f[k];
      this.searchParams = new URLSearchParams(this.search);
    }
    toString() { return this.href; }
    toJSON() { return this.href; }
  }
  globalThis.URL = URL;
  globalThis.URLSearchParams = URLSearchParams;
  // The row the script is handed is built HERE, for the same reason as everything else: a plain
  // object made by the host carries the host's Object.prototype, and that is a way out.
  return {
    row(src) {
      const out = {};
      for (const k of Object.keys(src)) out[k] = src[k];
      return out;
    },
  };
})`;

interface Kernel {
  row(src: Record<string, string | null>): Record<string, unknown>;
}

const kernel = (
  new Script(BOOTSTRAP, { filename: "ferrum-sandbox.js" }).runInContext(context) as (
    p: typeof parseUrl,
  ) => Kernel
)(parseUrl);

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
      const value = fn(kernel.row(r.values));
      results.push({ rowId: r.rowId, value: value === undefined ? null : value });
    } catch (e) {
      // One bad row must not fail the other 999,999 — it becomes an error cell and the rest proceed.
      results.push({ rowId: r.rowId, value: null, error: e instanceof Error ? e.message : String(e) });
    }
  }
  parentPort?.postMessage({ type: "batch", id: msg.id, results });
});
