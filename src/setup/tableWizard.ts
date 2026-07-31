// "Describe the table you want, and answer a few questions."
//
// The barrier this removes: a blank sheet is the hardest screen in the product. Knowing what you
// want is easy; knowing that it becomes a webhook source, four static columns, an HTTP column with
// a query parameter, and a fan-out to a second table is not — and none of that is knowledge anyone
// should need before their first useful table exists.
//
// ── An interview, not a one-shot ─────────────────────────────────────────────────────────────────
//
// A single prompt produces a plausible table built on guesses: which fields identify a record, where
// the data comes from, what leaves at the end. Those guesses are invisible in the result and
// expensive to unpick later. So the model is allowed exactly two moves — ASK, or PROPOSE — and it
// asks until it genuinely has enough. Each round costs one small call; the questions are answered in
// plain text.
//
// ── Pasted text, never fetched links ─────────────────────────────────────────────────────────────
//
// Answers are text the user typed or pasted, including API documentation. This module never
// dereferences a URL found in an answer. That is deliberate and worth stating plainly: fetching a
// link that appeared inside model-directed input would let the interview point the engine at any
// address it liked, from a machine that holds provider keys. A pasted page is data; a link is an
// instruction to go somewhere.
//
// ── Nothing is created until it is approved ──────────────────────────────────────────────────────
//
// The interview ends in a PLAN. The plan is rendered field by field, and `applyPlan` — which is
// ordinary code with no model in it, and is what the tests exercise — runs only when the user says
// so.

import { sanitize } from "../agent/loop.ts";
import { resolveProvider } from "../providers/resolve.ts";
import { tx } from "../db.ts";
import { addColumn, createSheet, listColumns, listSheets } from "../store.ts";
import { setConfig as setDedupe } from "../dedupe.ts";
import { createSource } from "../sources/webhook.ts";
import { DEFAULT_HTTP, normalizeHttpConfig } from "../http/httpColumn.ts";
import { safeHttp, storeRefs, refsToStored } from "./aiSetup.ts";
import { rebuildDeps } from "../refs.ts";
import { setColumnHttpConfig, setColumnKind, setColumnPrompt, setColumnValueType } from "../store.ts";
import { isColumnKind, isValueType } from "../types.ts";
import type { ColumnKind, Sheet, ValueType } from "../types.ts";

/** Ceiling on a prompt, mirroring the one on PATCH /api/columns/:id — it is sent once per row. */
const MAX_PROMPT = 8000;

/** One exchange in the interview. */
export interface Turn {
  role: "user" | "wizard";
  text: string;
}

export interface PlannedColumn {
  name: string;
  /** What fills it. `static` means typed or imported. */
  kind: ColumnKind;
  valueType: ValueType;
  /** Why this column exists, in the user's terms. Shown beside it in the review. */
  note?: string;
  /** For ai/agent columns. `/Other column` references are converted on apply. */
  prompt?: string;
  /** For http columns. Passed through the same normalizer as a hand-built request. */
  http?: Record<string, unknown>;
}

export interface TablePlan {
  name: string;
  /** Plain-English summary of what this table is for. */
  summary: string;
  columns: PlannedColumn[];
  /** How rows get in. */
  source: {
    kind: "manual" | "csv" | "webhook" | "from_table";
    /** For `from_table`: the name of an existing table in this workspace. */
    fromTable?: string;
    note: string;
  };
  /** How rows leave, if they do. Described only — nothing is wired up without a second decision. */
  destination: {
    kind: "none" | "to_table" | "http" | "export";
    toTable?: string;
    note: string;
  };
  /** Ordered dedupe key columns, by NAME — resolved to ids on apply. */
  dedupeOn?: string[];
  /** Anything the user still has to supply, such as an API key. */
  missing?: string[];
}

export type WizardStep =
  | { step: "ask"; questions: Array<{ question: string; why?: string }>; note?: string }
  | { step: "plan"; plan: TablePlan };

const SYSTEM = `You design spreadsheet tables for a tool where every column is either typed in, a rule, an HTTP request, or an AI prompt.

You have exactly two moves:
  ask   — you do not yet know enough. Ask up to four short questions, in plain language.
  plan  — you know enough. Return the finished table.

Ask about anything that changes the shape of the table and that you cannot infer:
  how rows get IN (typed, a CSV, a webhook from another tool, or built from an existing table)
  what identifies a record, so duplicates can be spotted
  which fields are needed, and which of those are looked up rather than supplied
  whether anything leaves at the end, and where it goes

Rules:
  Ask about ONE thing per question. Never ask two things in one sentence.
  Never ask for a link or a URL to documentation. If you need an API's details, ask the user to
  paste the relevant part of the documentation as text.
  Stop asking once you can build something useful. Three rounds is plenty. A table that exists and
  is 80% right beats an interview nobody finishes.
  Prefer static columns. Only make a column an AI prompt or an HTTP request when the value genuinely
  has to be looked up or generated.
  In a prompt, refer to another column as /Column name.
  Keep every name short and in sentence case.`;

const TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["step"],
  properties: {
    step: { type: "string", enum: ["ask", "plan"] },
    questions: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question"],
        properties: {
          question: { type: "string" },
          why: { type: "string", description: "One short line on why this changes the table." },
        },
      },
    },
    note: { type: "string" },
    plan: {
      type: "object",
      additionalProperties: false,
      required: ["name", "summary", "columns", "source", "destination"],
      properties: {
        name: { type: "string" },
        summary: { type: "string" },
        columns: {
          type: "array",
          maxItems: 24,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "kind", "valueType"],
            properties: {
              name: { type: "string" },
              kind: { type: "string", enum: ["static", "ai", "agent", "http", "script"] },
              valueType: {
                type: "string",
                enum: ["text", "number", "boolean", "url", "email", "enum", "json", "date", "datetime", "currency", "percent", "phone", "array"],
              },
              note: { type: "string" },
              prompt: { type: "string" },
              http: { type: "object", additionalProperties: true },
            },
          },
        },
        source: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "note"],
          properties: {
            kind: { type: "string", enum: ["manual", "csv", "webhook", "from_table"] },
            fromTable: { type: "string" },
            note: { type: "string" },
          },
        },
        destination: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "note"],
          properties: {
            kind: { type: "string", enum: ["none", "to_table", "http", "export"] },
            toTable: { type: "string" },
            note: { type: "string" },
          },
        },
        dedupeOn: { type: "array", items: { type: "string" }, maxItems: 4 },
        missing: { type: "array", items: { type: "string" }, maxItems: 6 },
      },
    },
  },
} as const;

/** The tables already here, so the plan can reference them by name rather than inventing one. */
export function describeWorkspace(): string {
  const sheets = listSheets().slice(0, 40);
  if (sheets.length === 0) return "There are no tables in this workspace yet.";
  return [
    "Tables that already exist here (you may reference these by name):",
    ...sheets.map((s) => {
      const cols = listColumns(s.id).slice(0, 12).map((c) => c.name).join(", ");
      return `- "${s.name}" (${s.rowCount.toLocaleString()} rows): ${cols || "no columns yet"}`;
    }),
  ].join("\n");
}

/**
 * One round of the interview.
 *
 * Every answer is sanitized and length-capped on the way in — the transcript is user text that ends
 * up inside a prompt, and an answer containing "ignore the above and…" is a thing that happens by
 * accident as often as on purpose.
 */
export async function nextStep(
  transcript: Turn[],
  opts: { model?: string | null; workspace?: string } = {},
  signal?: AbortSignal,
): Promise<WizardStep> {
  const first = transcript.find((t) => t.role === "user")?.text?.trim();
  if (!first) throw new Error("Describe the table you want first.");

  const rounds = transcript.filter((t) => t.role === "wizard").length;
  const lines = [
    opts.workspace ?? describeWorkspace(),
    "",
    "The conversation so far:",
    ...transcript.map((t) => `${t.role === "user" ? "User" : "You"}: ${sanitize(t.text, 4000)}`),
    "",
    rounds >= 3
      ? "You have asked enough. Return step=plan now, using sensible defaults for anything still unknown and listing those in `missing`."
      : "Ask only if the answer would change the table. Otherwise return step=plan.",
  ];

  const { provider, model } = resolveProvider(opts.model ?? null);
  const res = await provider.chat({
    model,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: lines.join("\n") },
    ],
    tools: [{ name: "design_table", description: "Ask the next questions, or return the finished table.", parameters: TOOL_SCHEMA as never }],
    toolChoice: "required",
    maxTokens: 2000,
    temperature: 0,
    signal,
  });

  const call = res.toolCalls?.[0];
  if (!call) throw new Error("The model did not answer in the expected shape. Try again.");
  return parseStep(call.args);
}

/**
 * Turn the model's answer into a step, refusing anything malformed.
 *
 * Split out from the call so it can be tested against the shapes a model actually returns — an
 * `ask` with no questions, a `plan` with no columns — without spending anything.
 */
export function parseStep(raw: unknown): WizardStep {
  const a = (raw ?? {}) as any;
  if (a.step === "ask") {
    const questions = (Array.isArray(a.questions) ? a.questions : [])
      .map((q: any) => ({ question: String(q?.question ?? "").trim(), why: q?.why ? String(q.why).trim() : undefined }))
      .filter((q: any) => q.question)
      .slice(0, 4);
    // An "ask" with nothing in it would stall the interview on a screen with no way forward.
    if (questions.length === 0) throw new Error("The model asked nothing and proposed nothing. Try again.");
    return { step: "ask", questions, note: a.note ? String(a.note) : undefined };
  }

  const p = a.plan ?? {};
  const columns: PlannedColumn[] = (Array.isArray(p.columns) ? p.columns : [])
    .map((c: any) => ({
      name: String(c?.name ?? "").trim(),
      // Anything unrecognised becomes a plain column rather than being rejected. A typo in a mode
      // name should cost a checkbox, not the whole plan.
      kind: (isColumnKind(c?.kind) ? c.kind : "static") as ColumnKind,
      valueType: (isValueType(c?.valueType) ? c.valueType : "text") as ValueType,
      note: c?.note ? String(c.note) : undefined,
      // Capped rather than truncated: a prompt is sent once per row, and silently shortening one
      // would change what the column asks without saying so. Over the cap, the column keeps its
      // place in the plan and arrives with no instruction, which is visible.
      prompt: c?.prompt && String(c.prompt).length <= MAX_PROMPT ? String(c.prompt) : undefined,
      http: c?.http && typeof c.http === "object" ? c.http : undefined,
    }))
    .filter((c: PlannedColumn) => c.name)
    .slice(0, 24);

  if (columns.length === 0) throw new Error("The plan had no columns in it. Try describing the table again.");

  const srcKind = ["manual", "csv", "webhook", "from_table"].includes(p.source?.kind) ? p.source.kind : "manual";
  const dstKind = ["none", "to_table", "http", "export"].includes(p.destination?.kind) ? p.destination.kind : "none";

  return {
    step: "plan",
    plan: {
      name: String(p.name ?? "New table").trim() || "New table",
      summary: String(p.summary ?? "").trim(),
      columns,
      source: {
        kind: srcKind,
        fromTable: p.source?.fromTable ? String(p.source.fromTable) : undefined,
        note: String(p.source?.note ?? "").trim(),
      },
      destination: {
        kind: dstKind,
        toTable: p.destination?.toTable ? String(p.destination.toTable) : undefined,
        note: String(p.destination?.note ?? "").trim(),
      },
      dedupeOn: Array.isArray(p.dedupeOn) ? p.dedupeOn.map(String).slice(0, 4) : undefined,
      missing: Array.isArray(p.missing) ? p.missing.map(String).slice(0, 6) : undefined,
    },
  };
}

export interface ApplyResult {
  sheet: Sheet;
  columnsCreated: number;
  /** The webhook address, when the plan said rows arrive from another tool. */
  webhookToken?: string;
  dedupeOn: string[];
  /** What the plan described but did not wire up, so the review can say so honestly. */
  notWired: string[];
}

/**
 * Build the table.
 *
 * Ordinary code, no model. Everything it does is something the user could have done by hand, which
 * is the property that makes it safe to run from one click: there is no configuration here that
 * could not have been typed into the same screens.
 *
 * ONE TRANSACTION. A build is a table, its columns, its dedupe rule and — when rows arrive from
 * another tool — a live webhook token. Half of that is not a usable table, and the half most likely
 * to be left behind is the token: an address that accepts data into something incomplete.
 */
export function applyPlan(plan: TablePlan, opts: { workbookId?: string | null } = {}): ApplyResult {
  return tx(() => {
    const sheet = createSheet(plan.name, opts.workbookId ?? null);
    const notWired: string[] = [];

    // Every column first, THEN the prompts and requests that reference them. A plan's third column
    // routinely refers to its fourth, and converting `/Domain` before Domain exists leaves the
    // reference as literal text — which the engine does not read as a reference at all.
    //
    // Paired by the id `addColumn` returned rather than by name: it de-duplicates a repeated name
    // into "Domain (2)", and looking the name up afterwards would point two planned columns at one
    // real one.
    const created = plan.columns.map((c) => ({
      planned: c,
      id: Number(addColumn(sheet.id, { name: c.name, kind: c.kind, valueType: c.valueType }).id),
    }));

    const made = listColumns(sheet.id);
    const byName = new Map(made.map((c) => [c.name.trim().toLowerCase(), Number(c.id)]));

    for (const { planned: c, id: colId } of created) {
      // The column itself is left out of its own reference table: a prompt naming the column it
      // fills is a mistake, and resolving it would build a cycle out of one.
      const others = made.filter((m) => Number(m.id) !== colId);

      if (c.prompt && (c.kind === "ai" || c.kind === "agent")) {
        setColumnPrompt(colId, storeRefs(c.prompt, others));
      }
      if (c.http && c.kind === "http") {
        try {
          // References converted, and the settings a language model does not get an opinion about —
          // private addresses, retries, timeouts — taken from the defaults rather than its answer.
          setColumnHttpConfig(
            colId,
            safeHttp(refsToStored(c.http, others), normalizeHttpConfig(DEFAULT_HTTP)) as unknown as Record<string, unknown>,
          );
        } catch {
          // A malformed request definition degrades the column to "needs configuring" rather than
          // failing the whole build — everything else in the plan is still worth having.
          setColumnKind(colId, "static");
          setColumnValueType(colId, c.valueType);
          notWired.push(`The request for "${c.name}" could not be built, so it is a plain column for now.`);
        }
      }

      // The whole reason the references above are converted is so the engine can SEE them, and it
      // sees them through `column_deps`. A plan's third column routinely reads its fourth; without
      // this the built table has no edges at all, so every column comes out at depth 0 and the run
      // order is the order they happen to be enumerated in.
      if (c.prompt || c.http) rebuildDeps(sheet.id, colId);
    }

    const dedupeOn = (plan.dedupeOn ?? [])
      .map((n) => ({ name: n, id: byName.get(n.trim().toLowerCase()) }))
      .filter((x): x is { name: string; id: number } => x.id != null);
    if (dedupeOn.length > 0) {
      // Configured, and deliberately NOT switched to automatic. Removing rows on arrival is a decision
      // the owner of the table makes, not one a plan makes on their behalf.
      setDedupe(sheet.id, { columnIds: dedupeOn.map((d) => d.id), keep: "oldest", auto: false });
    }

    let webhookToken: string | undefined;
    if (plan.source.kind === "webhook") {
      webhookToken = createSource(sheet.id, `${plan.name} intake`).token;
    }
    if (plan.source.kind === "from_table") {
      notWired.push(
        // Names the feature as it exists NOW, not by the wording of a modal that no longer exists.
        // The one instruction the user is given must not point at a menu item they cannot find.
        `Rows are meant to come from "${plan.source.fromTable ?? "another table"}". Set that up on that table by adding a "Send to table" column pointing here.`,
      );
    }
    if (plan.destination.kind !== "none") {
      notWired.push(
        plan.destination.kind === "to_table"
          ? `Sending rows on to "${plan.destination.toTable ?? "another table"}" is not wired up — add it as a column when the data is ready.`
          : `Sending data out (${plan.destination.note || plan.destination.kind}) is not wired up yet.`,
      );
    }

    return { sheet, columnsCreated: made.length, webhookToken, dedupeOn: dedupeOn.map((d) => d.name), notWired };
  });
}
