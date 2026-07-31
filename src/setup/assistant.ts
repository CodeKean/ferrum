// The table assistant — the conversational surface over everything else in the app.
//
// Clay calls theirs Sculptor. The parts worth copying are the parts that are hard: it is
// CONVERSATIONAL and ITERATIVE rather than one-shot, it can look at the table's actual state to
// answer questions and diagnose failures, and — the important one — it works against a sandbox that
// is published only when the user says so.
//
// That last property maps exactly onto the propose-then-apply pattern the column setup already
// uses, so it is not a new idea here, just a wider one. The assistant never writes to the table. It
// returns a REPLY plus, optionally, a list of proposed ACTIONS. Each action is one thing the user
// could have done by hand, rendered in the words of the screen that would have done it, and applied
// only on approval — individually, so a good suggestion and a bad one in the same answer do not
// have to be accepted together.
//
// ── What it is allowed to see ────────────────────────────────────────────────────────────────────
//
// Column names, modes, types, prompts, per-column completion and error counts, the errors' own
// messages, and a handful of sample values. Enough to say "the Industry column is failing on 84
// rows because the request is missing an API key" — which is the actual job — without shipping the
// contents of a million-row table into a prompt.
//
// ── What it is not allowed to do ─────────────────────────────────────────────────────────────────
//
// Run anything. Spend anything. Delete anything. There is no action kind here that removes a row, a
// column or a table, and none that starts a run: an assistant that can start a paid run from a
// sentence is one bad interpretation away from an expensive afternoon. It proposes the column; the
// user runs it, through the same confirmation every other run goes through.

import { sanitize } from "../agent/loop.ts";
import { designCall, resolveSetupProvider, SETUP_TIMEOUT_MS } from "./setupModel.ts";
import { gatherEvidence, describeEvidence } from "./evidence.ts";
import { PROPOSABLE_KINDS } from "./aiSetup.ts";
import { db, tx } from "../db.ts";
import { addColumn, getSheet, listColumns, readWindow } from "../store.ts";
import { setColumnHttpConfig, setColumnKind, setColumnPrompt, setColumnValueType } from "../store.ts";
import { DEFAULT_HTTP, normalizeHttpConfig } from "../http/httpColumn.ts";
import { safeHttp, storeRefs, refsToStored } from "./aiSetup.ts";
import { rebuildDeps } from "../refs.ts";
import { record } from "../undo.ts";
import { setConfig as setDedupe, preview as previewDedupe } from "../dedupe.ts";
import { isColumnKind, isValueType } from "../types.ts";
import type { ColumnKind, ValueType } from "../types.ts";

/**
 * Ceiling on a prompt, mirroring the one on PATCH /api/columns/:id.
 *
 * A prompt is sent on EVERY row, so its length is multiplied by the sheet. The hand-built path has
 * refused an over-long one from the start; an answer arriving through a model must clear the same
 * bar, or the cheapest way past the cap is to ask the assistant to write it.
 */
const MAX_PROMPT = 8000;

export interface Message {
  role: "user" | "assistant";
  text: string;
}

/**
 * One proposed change.
 *
 * Every kind here has a hand-built equivalent in the UI, and applying one does exactly what that
 * screen does. Nothing destructive is expressible.
 */
export type Action =
  | { kind: "add_column"; name: string; columnKind: ColumnKind; valueType: ValueType; prompt?: string; http?: Record<string, unknown>; why: string }
  | { kind: "set_prompt"; columnId: number; prompt: string; why: string }
  | { kind: "set_mode"; columnId: number; columnKind: ColumnKind; valueType?: ValueType; why: string }
  | { kind: "set_dedupe"; columnNames: string[]; keep: "oldest" | "newest"; why: string };

export interface AssistantReply {
  /** What it says. Plain English, no markdown headings — this renders in a chat bubble. */
  reply: string;
  actions: Action[];
}

const SYSTEM = `You are the assistant inside a spreadsheet tool where every column is either typed in, a rule, an HTTP request, or an AI prompt.

You help with four things:
  building a table — proposing the columns that answer the user's question
  enrichment — choosing which columns should look something up, and writing what they ask
  reading the table — answering questions about what is in it and what state it is in
  troubleshooting — explaining why a column is failing, from the error messages you are shown

How to answer:
  Be brief and concrete. Two or three sentences, then the actions.
  Propose actions ONLY when the user is asking for a change. A question gets an answer, not edits.
  Prefer the cheapest column that does the job. A value that can be typed or derived should not be
  an AI prompt, and an AI prompt with no need to look anything up on the web should not be an agent.
  In a prompt, refer to another column as /Column name.
  Never claim to have run, changed or deleted anything. You propose; the user applies.
  If you do not have enough information, say what you would need and ask for it.`;

const TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply"],
  properties: {
    reply: { type: "string" },
    actions: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "why"],
        properties: {
          kind: { type: "string", enum: ["add_column", "set_prompt", "set_mode", "set_dedupe"] },
          why: { type: "string", description: "One line, in the user's terms, on what this achieves." },
          name: { type: "string" },
          columnId: { type: "number" },
          // Derived, not written out again. This list was the third hand-maintained copy of the
          // column kinds and, like the other two, it had gone stale: `send` existed in the product
          // and in none of them, so the assistant could not propose the largest feature in the app.
          columnKind: { type: "string", enum: PROPOSABLE_KINDS },
          valueType: {
            type: "string",
            enum: ["text", "number", "boolean", "url", "email", "enum", "json", "date", "datetime", "currency", "percent", "phone", "array"],
          },
          prompt: { type: "string" },
          http: { type: "object", additionalProperties: true },
          columnNames: { type: "array", items: { type: "string" }, maxItems: 4 },
          keep: { type: "string", enum: ["oldest", "newest"] },
        },
      },
    },
  },
} as const;

/**
 * What the table currently looks like, as text.
 *
 * Counts and error messages rather than data. A per-column error summary is what turns "my column
 * is broken" into an answer, and it is three aggregates rather than a scan of the rows.
 */
export function describeTable(sheetId: string): string {
  const sheet = getSheet(sheetId);
  if (!sheet) return "That table no longer exists.";

  // Shared with the setup panel rather than built a second way here. A second implementation runs
  // its own aggregate query PER COLUMN and takes examples from row 1 only; the shared one does the
  // counts
  // in one query, samples from four places in the sheet, and reports a fill RATE — which is the fact
  // that decides whether referencing a column is a good idea, and neither surface had it.
  const ev = gatherEvidence(sheetId);
  if (!ev) return "That table no longer exists.";

  const lines: string[] = [describeEvidence(ev)];

  // Ids, which the description deliberately omits — the model needs them to target set_prompt and
  // set_mode at a specific column, and they are meaningless to the user reading the reply.
  const columns = listColumns(sheetId);
  lines.push("", "Column ids, for targeting a change:");
  for (const c of columns) {
    const bits = [`- [${c.id}] "${c.name}"`];
    if (c.prompt) bits.push(`instruction: ${String(c.prompt).slice(0, 160)}`);
    lines.push(bits.join(" · "));
  }

  const dd = previewDedupe(sheetId);
  if (dd.duplicates > 0) {
    lines.push("", `Duplicate rows under the current rule: ${dd.duplicates.toLocaleString()}.`);
  }

  return lines.join("\n");
}

/**
 * `opts.model` is gone on purpose.
 *
 * It came straight off the request body, so a caller could name any model and the free-only guard —
 * the setting whose whole promise is that designing a column cannot produce a charge — would never
 * see it. The assistant is a design surface like the setup panel, so it uses the same setup model,
 * chosen in Settings, subject to the same guard. Nothing in the app was passing it.
 */
export async function ask(
  sheetId: string,
  history: Message[],
  signal?: AbortSignal,
): Promise<AssistantReply> {
  const last = [...history].reverse().find((m) => m.role === "user")?.text?.trim();
  if (!last) throw new Error("Ask something first.");

  const lines = [
    describeTable(sheetId),
    "",
    "The conversation so far:",
    // Capped and sanitized: the transcript includes text the user pasted, and pasted text is where
    // "ignore the above" arrives, by accident as often as on purpose.
    ...history.slice(-12).map((m) => `${m.role === "user" ? "User" : "You"}: ${sanitize(m.text, 3000)}`),
  ];

  const { provider, model } = await resolveSetupProvider();
  // Through the shared design call, which copes with a model that cannot be FORCED to answer with a
  // tool — a capability the catalogue does not publish, and one many free models lack. Without it a
  // perfectly good free model produced a 503 and the chat said "something went wrong inside Ferrum".
  const res = await designCall(
    provider,
    model,
    {
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: lines.join("\n") },
      ],
      tools: [{ name: "respond", description: "Answer, and optionally propose changes.", parameters: TOOL_SCHEMA as never }],
      maxTokens: 1600,
      temperature: 0,
      // Its own deadline, like the setup panel's. A chat bubble stuck on "Thinking…" for two minutes
      // reads as broken, and the provider default is two minutes.
      signal: signal ?? AbortSignal.timeout(SETUP_TIMEOUT_MS),
    },
    "respond",
  );

  return parseReply(res.args, sheetId);
}

/**
 * Turn the model's answer into a reply and a list of actions this app will actually offer.
 *
 * Anything referring to a column that does not exist is DROPPED rather than shown. An action that
 * looks applicable and then errors on click is worse than one that was never offered — and a
 * column id the model invented is exactly that.
 *
 * This is also the validation the APPLY route runs, on the action it is handed rather than on the
 * one that was offered. The two are not the same object: what comes back on apply has been through
 * the browser, and a path that trusted it would accept a mode and a prompt length the hand-built
 * PATCH refuses.
 */
export function parseReply(raw: unknown, sheetId: string): AssistantReply {
  const a = (raw ?? {}) as any;
  const reply = String(a.reply ?? "").trim();
  if (!reply) throw new Error("The model returned an empty answer. Try again.");

  const columns = listColumns(sheetId);
  const valid = new Set(columns.map((c) => Number(c.id)));
  // Dedupe columns arrive by NAME, so they need the same existence check ids already get — and the
  // canonical spelling, so what is reported afterwards is what was actually matched.
  const byName = new Map(columns.map((c) => [c.name.trim().toLowerCase(), c.name]));
  const actions: Action[] = [];

  for (const r of Array.isArray(a.actions) ? a.actions : []) {
    const why = String(r?.why ?? "").trim();
    if (r?.kind === "add_column" && String(r.name ?? "").trim()) {
      const prompt = r.prompt ? String(r.prompt) : undefined;
      if (prompt && prompt.length > MAX_PROMPT) continue;
      actions.push({
        kind: "add_column",
        name: String(r.name).trim(),
        columnKind: isColumnKind(r.columnKind) ? r.columnKind : "static",
        valueType: isValueType(r.valueType) ? r.valueType : "text",
        prompt,
        http: r.http && typeof r.http === "object" ? r.http : undefined,
        why,
      });
    } else if (
      r?.kind === "set_prompt" && valid.has(Number(r.columnId)) &&
      String(r.prompt ?? "").trim() && String(r.prompt).length <= MAX_PROMPT
    ) {
      actions.push({ kind: "set_prompt", columnId: Number(r.columnId), prompt: String(r.prompt), why });
    } else if (r?.kind === "set_mode" && valid.has(Number(r.columnId)) && isColumnKind(r.columnKind)) {
      actions.push({
        kind: "set_mode",
        columnId: Number(r.columnId),
        columnKind: r.columnKind,
        valueType: isValueType(r.valueType) ? r.valueType : undefined,
        why,
      });
    } else if (r?.kind === "set_dedupe" && Array.isArray(r.columnNames) && r.columnNames.length > 0) {
      // Only the names that resolve. A key that quietly loses one of its columns is WEAKER than the
      // one that was approved — it matches on less — and the old code then reported the whole list
      // as applied, so the transcript said something that was not true.
      const names = r.columnNames
        .map((n: unknown) => byName.get(String(n).trim().toLowerCase()))
        .filter((n: string | undefined): n is string => !!n)
        .slice(0, 4);
      if (names.length === 0) continue;
      actions.push({ kind: "set_dedupe", columnNames: names, keep: r.keep === "newest" ? "newest" : "oldest", why });
    }
  }

  return { reply, actions };
}

/**
 * Apply ONE approved action.
 *
 * One at a time on purpose: a reply can hold a good suggestion and a wrong one, and accepting them
 * together is how the wrong one gets in. Returns a plain-English account of what changed, which is
 * what the chat then shows — so the transcript records what was done, not what was offered.
 */
export function applyAction(sheetId: string, action: Action): string {
  switch (action.kind) {
    case "add_column": {
      // Read BEFORE the column exists, for two reasons: it is the list the model was shown, and a
      // prompt saying "/Headcount" on the column called Headcount would otherwise resolve into a
      // reference to itself.
      const others = listColumns(sheetId);
      return tx(() => {
        const col = addColumn(sheetId, { name: action.name, kind: action.columnKind, valueType: action.valueType });
        let note = `Added "${col.name}". Nothing has run yet — use Run when you are ready.`;

        if (action.prompt && (action.columnKind === "ai" || action.columnKind === "agent")) {
          setColumnPrompt(col.id, storeRefs(action.prompt, others));
        }
        if (action.http && action.columnKind === "http") {
          try {
            // Through the SAME two filters a proposal goes through: `/Company` becomes the stored
            // reference, and the settings a language model does not get an opinion about — private
            // addresses above all — are taken from the defaults rather than from its answer.
            const cfg = safeHttp(refsToStored(action.http, others), normalizeHttpConfig(DEFAULT_HTTP));
            setColumnHttpConfig(col.id, cfg as unknown as Record<string, unknown>);
          } catch {
            setColumnKind(col.id, "static");
            note = `Added "${col.name}", but the request could not be built — it is a plain column for now.`;
          }
        }
        // The references just stored are what the run order and the stale cascade are built from, so
        // the edges have to be derived here. Without it a proposed column referencing /Company came
        // out at depth 0 — running before Company, against an empty value, on the paid lane.
        rebuildDeps(sheetId, Number(col.id));

        // Undoable, like every hand-made change. Model-authored edits were the only ones with no way
        // back, which is exactly backwards: they are the ones the user did not type.
        record(sheetId, "column.create", `Add column "${col.name}"`,
          { columnIds: [Number(col.id)], deletedAt: nowStamp() });
        // Never run here. The column exists and is ready; starting it is a spend, and a spend goes
        // through the same confirmation as every other run.
        return note;
      });
    }
    case "set_prompt": {
      const cols = listColumns(sheetId);
      const col = cols.find((c) => Number(c.id) === action.columnId);
      if (!col) return "That column no longer exists.";
      const next = storeRefs(action.prompt, cols.filter((c) => Number(c.id) !== action.columnId));
      return tx(() => {
        setColumnPrompt(col.id, next);
        // A new instruction is a new set of references, so the edges are re-derived from it — the
        // same call the hand-built PATCH makes after writing a prompt.
        rebuildDeps(sheetId, Number(col.id));
        record(sheetId, "column.field", `Change the instruction for "${col.name}"`,
          { columnId: Number(col.id), field: "prompt", from: col.prompt ?? null, to: next.trim() ? next : null });
        return `Updated what "${col.name}" asks. Existing values are unchanged until it runs again.`;
      });
    }
    case "set_mode": {
      const col = listColumns(sheetId).find((c) => Number(c.id) === action.columnId);
      if (!col) return "That column no longer exists.";
      return tx(() => {
        setColumnKind(col.id, action.columnKind);
        record(sheetId, "column.field", `Set how "${col.name}" runs`,
          { columnId: Number(col.id), field: "kind", from: col.kind, to: action.columnKind });
        if (action.valueType) {
          setColumnValueType(col.id, action.valueType);
          record(sheetId, "column.field", `Set "${col.name}" to ${action.valueType}`,
            { columnId: Number(col.id), field: "value_type", from: col.valueType, to: action.valueType });
        }
        return `"${col.name}" is now ${action.columnKind}.`;
      });
    }
    case "set_dedupe": {
      const byName = new Map(listColumns(sheetId).map((c) => [c.name.trim().toLowerCase(), Number(c.id)]));
      const resolved = action.columnNames.map((n) => ({ name: n, id: byName.get(n.trim().toLowerCase()) }));
      const missing = resolved.filter((r) => r.id == null).map((r) => r.name);
      // All or nothing. Applying the subset that resolved would leave a key that matches on LESS
      // than the one that was approved — quietly weaker, and reported as if it were the whole thing.
      if (missing.length > 0) {
        return `Nothing changed: this table has no column called ${missing.map((m) => `"${m}"`).join(" or ")}.`;
      }
      setDedupe(sheetId, { columnIds: resolved.map((r) => r.id as number), keep: action.keep, auto: false });
      const p = previewDedupe(sheetId);
      return `Set to match on ${action.columnNames.join(", then ")}. ${p.duplicates.toLocaleString()} rows would be removed — nothing has been removed yet.`;
    }
  }
}

/** SQLite's own clock, so an undone creation carries the same shape of timestamp as a real delete. */
function nowStamp(): string {
  return String((db.prepare("SELECT datetime('now') AS t").get() as any).t);
}
