// Generated scripts: storage, the approval gate, and hash pinning.
//
// A script here is executable code that a model wrote. Two rules govern it, and neither is a
// setting:
//
//   1. NOTHING RUNS UNREVIEWED. A script is inert until a human has read it and approved it.
//   2. APPROVAL IS PINNED TO THE EXACT BYTES. Approval stores the sha256 of the code; before every
//      execution the hash is recomputed and compared. If they differ — a regeneration, an edit, a
//      tampered import — the approval is void and it will not run.
//
// Rule 2 is what stops "approve a harmless script, then swap the body" from being a viable attack,
// including via an imported template.

import { createHash } from "node:crypto";
import { db, tx } from "./db.ts";
import { parseRefs, parseRowAccesses, rebuildDeps, detectCycle } from "./refs.ts";
import type { GeneratedScript, HookName, ScriptRuntime } from "./types.ts";

export const hashCode = (code: string): string => createHash("sha256").update(code).digest("hex");

function toScript(r: any): GeneratedScript {
  return {
    id: String(r.id), columnId: String(r.column_id), hook: r.hook, runtime: r.runtime,
    intent: r.intent, code: r.code, hash: r.hash, version: r.version,
    approvedAt: r.approved_at ?? null,
    refs: JSON.parse(r.refs ?? "[]"),
    rationale: r.rationale ?? null,
    createdAt: r.created_at,
  };
}

export function getScript(id: number | string): GeneratedScript | null {
  const r = db.prepare("SELECT * FROM scripts WHERE id = ?").get(Number(id)) as any;
  return r ? toScript(r) : null;
}

export function listScripts(columnId: number, hook?: HookName): GeneratedScript[] {
  const rows = hook
    ? db.prepare("SELECT * FROM scripts WHERE column_id = ? AND hook = ? ORDER BY version DESC").all(columnId, hook)
    : db.prepare("SELECT * FROM scripts WHERE column_id = ? ORDER BY hook, version DESC").all(columnId);
  return (rows as any[]).map(toScript);
}

/**
 * The runtimes there is an execution path for, and the hooks a script can be attached to.
 *
 * Checked when a script is SAVED, not when it runs, because the run-time dispatch has no failure
 * branch: `runShell` tests for one value — powershell — and treats everything else as bash. So an
 * unrecognised runtime arriving in a request body was never rejected, it silently became a bash
 * script, and the interpreter that executes generated code was decided by an unvalidated string.
 *
 * Written as arrays with the type derived alongside, the same way `types.ts` declares COLUMN_KINDS:
 * a bare union exists only at compile time and has nothing for an HTTP request to be checked against.
 */
const RUNTIMES: readonly ScriptRuntime[] = ["js", "powershell", "bash"];
const HOOKS: readonly HookName[] = ["condition", "transform", "accept", "map", "key", "score", "filter"];

export interface SaveScriptInput {
  sheetId: string;
  columnId: number;
  hook: HookName;
  runtime: ScriptRuntime;
  intent: string;
  code: string;
  rationale?: string;
}

export interface SaveScriptResult {
  script: GeneratedScript;
  /** Populated when the save is rejected. */
  errors: string[];
  /** The previous version, so the review UI can diff against it. */
  previous: GeneratedScript | null;
}

/**
 * Save a new version of a script. Always UNAPPROVED — a regenerated script has to be re-reviewed,
 * because "it was fine last time" is exactly the assumption this gate exists to break.
 */
export function saveScript(input: SaveScriptInput): SaveScriptResult {
  const errors: string[] = [];

  // Refused outright rather than collected into `errors`. Everything below is a reviewable problem
  // with a script that still gets stored so the review UI can show it; these two decide which
  // interpreter spawns and which slot on the column the code lands in, and neither is something to
  // store now and validate later.
  if (!(RUNTIMES as readonly string[]).includes(input.runtime)) {
    throw new Error(`Scripts run as js, powershell or bash — not "${String(input.runtime)}".`);
  }
  if (!(HOOKS as readonly string[]).includes(input.hook)) {
    throw new Error(`"${String(input.hook)}" is not a place a script can be attached.`);
  }

  // A stream-shaped script is required for the shell runtimes: one process must handle the whole
  // column. A script that only handles a single scalar would silently become one process per row.
  if (input.runtime !== "js" && !looksStreamShaped(input.code, input.runtime)) {
    errors.push(
      "A shell script must read rows as NDJSON from stdin in a loop and write one JSON result per line. " +
      "A script that handles a single value would be spawned once per row — at a million rows that is " +
      "days of process startup alone.",
    );
  }
  if (input.runtime === "js" && !new RegExp(`function\\s+${input.hook}\\b|${input.hook}\\s*=\\s*(function|\\()`).test(input.code)) {
    errors.push(`The script must define a function named "${input.hook}(row)".`);
  }

  // Two sources of dependency, and BOTH are required:
  //   - {{col:N}} in the intent or code (what the "/" menu inserts), and
  //   - `row.website` accesses in the generated code itself.
  // Generated scripts almost never contain {{col:N}} — they read the row object — so relying on
  // template references alone hands the script an empty row and every rule silently returns nothing.
  const { ids: templateIds, unknown } = parseRefs(`${input.intent}\n${input.code}`, {
    sheetId: input.sheetId,
    selfId: input.columnId,
  });
  const accessed = parseRowAccesses(input.code, input.sheetId);
  const ids = [...new Set([...templateIds, ...accessed])];
  if (unknown.length > 0) {
    errors.push(`Unknown column reference${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.`);
  }
  if (ids.includes(input.columnId)) {
    errors.push("A column cannot reference itself.");
  }

  const previous = latestScript(input.columnId, input.hook);

  const result = tx(() => {
    const version = (previous?.version ?? 0) + 1;
    const res = db
      .prepare(
        `INSERT INTO scripts (column_id, hook, runtime, intent, code, hash, version, refs, rationale)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.columnId, input.hook, input.runtime, input.intent, input.code,
        hashCode(input.code), version, JSON.stringify(ids), input.rationale ?? null,
      );

    const id = Number(res.lastInsertRowid);

    // Attach to the column so the dependency graph can see it, then re-derive edges. A condition's
    // references are real dependencies, exactly like a prompt's.
    const field = input.hook === "condition" ? "condition_script_id"
      : input.hook === "transform" ? "transform_script_id"
      : input.hook === "accept" ? "accept_script_id"
      : input.hook === "map" ? "map_script_id" : null;
    if (field) db.prepare(`UPDATE columns SET ${field} = ? WHERE id = ?`).run(id, input.columnId);

    rebuildDeps(input.sheetId, input.columnId);
    return id;
  });

  // Cycle detection runs AFTER the edges exist, and rolls the attachment back if it created a loop.
  const cycle = detectCycle(input.sheetId);
  if (!cycle.ok) {
    errors.push(`Circular reference: ${cycle.path?.join(" → ")}.`);
    db.prepare("DELETE FROM scripts WHERE id = ?").run(result);
    rebuildDeps(input.sheetId, input.columnId);
    return { script: getScript(result)!, errors, previous };
  }

  return { script: getScript(result)!, errors, previous };
}

export function latestScript(columnId: number, hook: HookName): GeneratedScript | null {
  const r = db
    .prepare("SELECT * FROM scripts WHERE column_id = ? AND hook = ? ORDER BY version DESC LIMIT 1")
    .get(columnId, hook) as any;
  return r ? toScript(r) : null;
}

/**
 * Approve a script for execution.
 *
 * The caller must pass the hash it reviewed. If the stored code has changed since the review UI
 * rendered it, the hashes disagree and approval is refused — you cannot approve bytes you did not
 * see.
 */
export function approveScript(id: number, reviewedHash: string): { ok: boolean; error?: string } {
  const s = getScript(id);
  if (!s) return { ok: false, error: "Script not found." };
  if (s.hash !== reviewedHash) {
    return { ok: false, error: "The script changed since you reviewed it. Re-read it and approve again." };
  }
  db.prepare("UPDATE scripts SET approved_at = datetime('now') WHERE id = ?").run(id);
  return { ok: true };
}

export function revokeApproval(id: number): void {
  db.prepare("UPDATE scripts SET approved_at = NULL WHERE id = ?").run(id);
}

/**
 * The gate every execution path must call. Re-hashes the stored code and compares it to what was
 * approved, so a script cannot be swapped after the fact.
 */
export function assertRunnable(id: number | string): GeneratedScript {
  const s = getScript(id);
  if (!s) throw new Error("Script not found.");
  if (!s.approvedAt) {
    throw new Error(`This ${s.hook} script has not been approved yet. Review it before running it.`);
  }
  if (hashCode(s.code) !== s.hash) {
    // Stored code no longer matches its recorded hash — treat as tampering and refuse.
    revokeApproval(Number(id));
    throw new Error("The stored script does not match its approved hash. Approval has been revoked.");
  }
  return s;
}

/**
 * Heuristic check that a shell script is written to stream the whole column, rather than to handle
 * one value. Deliberately conservative: it fails a script that has no read-loop at all, which is the
 * mistake that would turn one process into a million.
 */
function looksStreamShaped(code: string, runtime: ScriptRuntime): boolean {
  if (runtime === "powershell") {
    return /\$input\b/.test(code) || /\[Console\]::In\.ReadLine|Read-Host|process\s*\{/i.test(code);
  }
  return /while\s+(read|IFS=)|\bcat\b|\/dev\/stdin|read\s+-r/.test(code);
}

// ─────────────────────────────────────────────────────────────── codegen boundary
//
// The model call that WRITES a script lives behind this interface. Phase 2 fills it in with the BYOK
// provider layer; keeping it separate means the review gate, versioning, hashing, dependency graph
// and runtimes are all testable today with hand-written scripts and no model access at all.

export interface CodegenRequest {
  sheetId: string;
  columnId: number;
  hook: HookName;
  /** What the user typed, in plain English. */
  intent: string;
  /** Real sample values from the referenced columns — the model writes better rules when it can see
   *  whether Website holds "acme.com" or "https://acme.com/about". */
  samples: Array<Record<string, string | null>>;
  availableColumns: Array<{ id: number; name: string; key: string; valueType: string }>;
  preferredRuntime?: ScriptRuntime;
}

export interface CodegenResponse {
  code: string;
  runtime: ScriptRuntime;
  /** Why this runtime — shown in the review panel so the choice is auditable. */
  rationale: string;
}

export type Codegen = (req: CodegenRequest) => Promise<CodegenResponse>;

let codegen: Codegen | null = null;

export function registerCodegen(fn: Codegen): void { codegen = fn; }

export async function generateScript(req: CodegenRequest): Promise<CodegenResponse> {
  if (!codegen) {
    throw new Error(
      "No model provider is configured yet, so scripts cannot be generated. Add a provider in Settings, " +
      "or write the script by hand — it runs through the same review and approval gate either way.",
    );
  }
  return codegen(req);
}

/** Sample rows for the codegen prompt. Real values, not the first N which are often unrepresentative. */
export function sampleRows(sheetId: string, refColumnIds: number[], n = 8): Array<Record<string, string | null>> {
  if (refColumnIds.length === 0) return [];
  const keys = new Map<number, string>();
  for (const r of db.prepare("SELECT id, key FROM columns WHERE sheet_id = ? AND deleted_at IS NULL").all(sheetId) as any[]) {
    keys.set(Number(r.id), String(r.key).replace(/\s+/g, "_"));
  }
  // Prefer rows where the referenced columns are actually populated — sampling empty rows teaches
  // the model nothing about the data's real shape.
  const rows = db
    .prepare(
      `SELECT r.id FROM rows r
        WHERE r.sheet_id = ?
          AND EXISTS (SELECT 1 FROM cells c WHERE c.row_id = r.id AND c.column_id IN (${refColumnIds.map(() => "?").join(",")})
                        AND c.value_text IS NOT NULL AND c.value_text <> '')
        ORDER BY r.position LIMIT ?`,
    )
    .all(sheetId, ...refColumnIds, n) as any[];

  if (rows.length === 0) return [];
  const cells = db
    .prepare(
      `SELECT row_id, column_id, value_text FROM cells
        WHERE row_id IN (${rows.map(() => "?").join(",")})
          AND column_id IN (${refColumnIds.map(() => "?").join(",")})`,
    )
    .all(...rows.map((r) => r.id), ...refColumnIds) as any[];

  const byRow = new Map<number, Record<string, string | null>>();
  for (const r of rows) byRow.set(Number(r.id), {});
  for (const c of cells) {
    const k = keys.get(Number(c.column_id));
    if (k) byRow.get(Number(c.row_id))![k] = c.value_text;
  }
  return [...byRow.values()];
}
