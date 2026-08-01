// Writing the candidate rule, and grading it.
//
// Split from promote.ts, which is the pure measuring half and imports nothing. This half talks to the
// database, the design model and the script runner. The separation matters because the measuring is
// the part that has to be trustworthy, and the part that has to be trustworthy should be the part
// that is easy to test.
//
// TWO RULES ABOUT MONEY, both of which this obeys by construction:
//
//   The rule is written by the DESIGN model, not the column's own. Same lane as the formula maker and
//   the setup panel — free or local by configuration — because this is a build-time act, not an
//   enrichment. It is also the whole point: a feature that exists to stop a column costing money must
//   not cost money to use.
//
//   It calls NOTHING per row. The examples are answers the column has already produced and been paid
//   for; grading re-runs only the candidate JavaScript, which is free. Promotion never re-asks the
//   model about a single row.

import { db } from "./db.ts";
import { getColumn, listColumns } from "./store.ts";
import { parseRefs } from "./refs.ts";
import { runScriptColumn } from "./runtime/scriptRunner.ts";
import { designCall, resolveSetupProvider, SETUP_TIMEOUT_MS } from "./setup/setupModel.ts";
import {
  MIN_EXAMPLES, chooseParsable, detectMemorisation, judge, scoreAgreement, splitExamples,
  type Example, type PromotionReport,
} from "./promote.ts";

export interface PromotionResult extends PromotionReport {
  code: string;
  /** Column names the rule reads, in the order the row object exposes them. */
  refColumnIds: number[];
  examplesUsed: number;
  model: string;
  /** Null when the design model runs locally, which is free rather than unknown. */
  costUsd: number | null;
}

/**
 * How many answered rows to learn from at most.
 *
 * A column with 400,000 answers does not make a better rule than one with 300 — it makes the same
 * rule and a prompt nobody can afford to send. The cap is on what goes to the model; the GRADING is
 * capped separately and higher, because more grading is strictly better and costs nothing.
 */
const MAX_EXAMPLES = 300;

/**
 * The rows this column has actually answered, with what they were answered from.
 *
 * Only `done` cells with a value, and only rows where at least one input is present: a row whose
 * inputs are all blank teaches a rule to return something from nothing, which is the one lesson it
 * must not learn.
 *
 * Spread across the sheet with a stride rather than taken from the top. The first 300 rows of a real
 * sheet are one import, and a rule fitted to one import is a rule about that import.
 */
export function gatherExamples(sheetId: string, columnId: number): { examples: Example[]; refColumnIds: number[]; inputNames: string[] } {
  const col = getColumn(columnId);
  if (!col) return { examples: [], refColumnIds: [], inputNames: [] };

  const cols = listColumns(sheetId);
  const byId = new Map(cols.map((c) => [Number(c.id), c.name]));

  // The columns the prompt actually reads. Falling back to every other column would hand the model
  // thirty fields to find a pattern in, and a pattern found in an unrelated field is a rule that
  // breaks the moment that field changes.
  const refs = parseRefs(col.prompt ?? "", { sheetId });
  const refColumnIds = refs.ids.map(Number).filter((id) => byId.has(id) && id !== columnId);
  if (refColumnIds.length === 0) return { examples: [], refColumnIds: [], inputNames: [] };

  const total = Number((db.prepare(
    `SELECT COUNT(*) AS c FROM cells WHERE column_id = ? AND status = 'done' AND value_text IS NOT NULL AND TRIM(value_text) <> ''`,
  ).get(columnId) as any).c);
  if (total === 0) return { examples: [], refColumnIds, inputNames: [] };

  // Every Nth answered row, so the sample spans the sheet instead of its first import.
  //
  // TWO STATEMENTS rather than one clever join. The single-query version pivoted the inputs with a
  // correlated sub-select and a GROUP BY, which was both unreadable and wrong — `row_id` was
  // ambiguous between the outer table and the join, and SQLite refused it outright. Picking the rows
  // first and fetching their inputs second is two indexed reads over at most 300 rows, which is
  // nothing, and it can be read by whoever comes next.
  const stride = Math.max(1, Math.floor(total / MAX_EXAMPLES));
  const picked = db.prepare(
    `SELECT row_id, value_text AS answer FROM (
       SELECT row_id, value_text, ROW_NUMBER() OVER (ORDER BY row_id) AS rn
         FROM cells
        WHERE column_id = ? AND status = 'done'
          AND value_text IS NOT NULL AND TRIM(value_text) <> ''
     )
     WHERE rn % ? = 0
     LIMIT ?`,
  ).all(columnId, stride, MAX_EXAMPLES) as Array<{ row_id: number; answer: string }>;

  const inputNames = refColumnIds.map((id) => byId.get(id)!);
  if (picked.length === 0) return { examples: [], refColumnIds, inputNames };

  const rowHoles = picked.map(() => "?").join(",");
  const colHoles = refColumnIds.map(() => "?").join(",");
  const inputRows = db.prepare(
    `SELECT row_id, column_id, value_text FROM cells
      WHERE row_id IN (${rowHoles}) AND column_id IN (${colHoles})`,
  ).all(...picked.map((p) => p.row_id), ...refColumnIds) as Array<{ row_id: number; column_id: number; value_text: string | null }>;

  const byRow = new Map<number, Map<number, string | null>>();
  for (const r of inputRows) {
    let m = byRow.get(Number(r.row_id));
    if (!m) { m = new Map(); byRow.set(Number(r.row_id), m); }
    m.set(Number(r.column_id), r.value_text ?? null);
  }

  const examples: Example[] = [];
  for (const p of picked) {
    const vals = byRow.get(Number(p.row_id));
    const inputs: Record<string, string | null> = {};
    let any = false;
    refColumnIds.forEach((id, i) => {
      const v = vals?.get(id) ?? null;
      inputs[inputNames[i]!] = v;
      if (v != null && String(v).trim() !== "") any = true;
    });
    // A row with nothing going in teaches the rule to produce something from nothing.
    if (!any) continue;
    examples.push({ rowId: Number(p.row_id), inputs, answer: String(p.answer ?? "") });
  }
  return { examples, refColumnIds, inputNames };
}

const SYSTEM = [
  "You write ONE JavaScript function that reproduces what a language model has been doing to fill in",
  "a spreadsheet column.",
  "",
  "You are shown worked examples: the inputs, and the answer the model gave.",
  "",
  "Write `function transform(row) { ... }` returning the answer for any row of this shape.",
  "",
  "Do NOT use // comments. Write /* like this */ if you need one. Generated code often arrives on a",
  "single line, and a // comment there kills every statement after it.",
  "",
  "THE ONE THING THAT MAKES THIS WORTHLESS: writing the example answers into the code. A chain of",
  "comparisons returning the literal values scores perfectly on these examples and returns nothing",
  "for every row that comes later. It is detected and rejected. Work out the RULE, or say you",
  "cannot.",
  "",
  "If the answers are a judgement rather than a derivation — a summary, an opinion, a fact about the",
  "world that is not in the inputs — say so in `cannot` and write no code. That answer is useful and",
  "is not a failure.",
].join("\n");

const TOOL = {
  type: "object",
  properties: {
    code: {
      type: "string",
      description: "function transform(row) { ... }. Read inputs as row.<lowercased column name with underscores>.",
    },
    how: { type: "string", description: "One or two plain sentences: what rule you found, for a non-technical reader." },
    cannot: {
      type: "string",
      description:
        "Set this INSTEAD of code when the answers cannot be derived from the inputs — say why in one " +
        "sentence. Better than a rule that half works.",
    },
  },
  required: [],
} as const;

/** The examples, as text the model can read. Capped per field so one huge value cannot eat the call. */
function renderExamples(examples: Example[]): string {
  return examples
    .map((e) => {
      const ins = Object.entries(e.inputs)
        .map(([k, v]) => `${k}: ${v == null ? "" : String(v).slice(0, 200)}`)
        .join(" | ");
      return `${ins}  =>  ${e.answer.slice(0, 200)}`;
    })
    .join("\n");
}

/**
 * Write a rule from the column's own answers, then grade it on the ones it was not shown.
 *
 * Returns a report, never a change. Nothing is saved, nothing is switched, and the column is
 * untouched whatever the verdict — the decision is the user's, and it is a decision they can only
 * make from the numbers this produces.
 */
export async function proposePromotion(
  sheetId: string,
  columnId: number,
  signal?: AbortSignal,
): Promise<PromotionResult | { error: string }> {
  const col = getColumn(columnId);
  if (!col) return { error: "That column no longer exists." };
  if (col.kind !== "ai" && col.kind !== "agent") {
    return { error: "Only a column that asks a model can be turned into a rule — this one already runs for nothing." };
  }

  const { examples, refColumnIds, inputNames } = gatherExamples(sheetId, columnId);
  if (refColumnIds.length === 0) {
    return { error: "This column's instruction does not read any other column, so there is nothing for a rule to work from." };
  }
  if (examples.length < MIN_EXAMPLES) {
    return {
      error:
        `This column has answered ${examples.length} usable ${examples.length === 1 ? "row" : "rows"}, and a rule ` +
        `written from that few cannot be checked properly. Run it on at least ${MIN_EXAMPLES} rows first.`,
    };
  }

  const { train, holdout } = splitExamples(examples);

  const { provider, model, isLocal } = await resolveSetupProvider();
  const timer = signal ? null : AbortSignal.timeout(SETUP_TIMEOUT_MS);
  /**
   * A model that answers with no rule is a RESULT, not an error.
   *
   * Everywhere else in the app, "the model did not answer in the required shape" is a fault worth
   * showing — the user asked for a configuration and did not get one. Here it usually means the
   * honest thing: there is no rule, because the column is doing something a rule cannot do. Measured
   * on a column whose answers were deliberately underivable, the free model declined to fill the tool
   * in at all, and that surfaced as a red error page about picking a different model — blaming the
   * setup for the correct answer.
   *
   * So it is caught, and the column simply stays as it is, which is the outcome either way.
   */
  const res = await designCall(
    provider,
    model,
    {
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: [
            `The column is called "${col.name}" and holds ${col.valueType}.`,
            `Its instruction to the model is: ${(col.prompt ?? "").slice(0, 1000)}`,
            "",
            `Inputs, in order: ${inputNames.join(", ")}`,
            `Read them as: ${inputNames.map((n) => `row.${n.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`).join(", ")}`,
            "",
            "Worked examples:",
            renderExamples(train),
          ].join("\n"),
        },
      ],
      tools: [{ name: "write_rule", description: "The rule that reproduces these answers.", parameters: TOOL as never }],
      maxTokens: 1500,
      temperature: 0,
      signal: signal ?? timer ?? undefined,
    },
    "write_rule",
  ).catch(() => null);

  if (!res) {
    return {
      code: "", refColumnIds, examplesUsed: examples.length, model, costUsd: isLocal ? null : null,
      agreement: { checked: 0, agreed: 0, rate: 0, errored: 0, examples: [] },
      memorisation: { hits: 0, looked: 0, memorised: false },
      verdict: "no",
      summary:
        "No rule came back for this column, which usually means its answers are a judgement rather " +
        "than something that can be worked out from the other columns. It stays on the model.",
    };
  }

  const a = res.args as Record<string, unknown>;
  const raw = typeof a.code === "string" ? a.code.trim() : "";
  const cannot = typeof a.cannot === "string" ? a.cannot.trim() : "";

  /**
   * One retry when the code will not compile.
   *
   * Not politeness — measured necessity. This model returns code with every newline stripped, and on
   * one line both a `//` comment and a regex literal containing `//` are unrecoverable without a real
   * parser. Twice the rule it wrote was CORRECT and only its formatting made it unrunnable, and the
   * report would have concluded "this column is doing something a rule cannot reproduce" — the exact
   * opposite of the truth, about a column the user is paying for on every row.
   *
   * One retry, on the free design lane, costing nothing per row. Told precisely what broke, because
   * "try again" without the error is the same request that already failed.
   */
  let code = raw ? chooseParsable(raw) : null;
  if (raw && !code) {
    const retry = await designCall(
      provider, model,
      {
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `Your last answer did not compile:\n\n${raw}\n\nWrite it again as ONE LINE with no // comments and no regular-expression literals — use indexOf, split and slice instead. Same rule, same behaviour.` },
        ],
        tools: [{ name: "write_rule", description: "The rule that reproduces these answers.", parameters: TOOL as never }],
        maxTokens: 1500,
        temperature: 0,
        signal: signal ?? AbortSignal.timeout(SETUP_TIMEOUT_MS),
      },
      "write_rule",
    ).catch(() => null);
    const second = typeof (retry?.args as any)?.code === "string" ? String((retry!.args as any).code).trim() : "";
    if (second) code = chooseParsable(second);
  }
  const costUsd = isLocal ? null : null;

  // "I cannot" is a real answer and is reported as one. A model pushed into producing code it does
  // not believe in produces exactly the plausible-and-wrong rule this whole file exists to catch.
  if (!code) {
    return {
      code: "", refColumnIds, examplesUsed: examples.length, model: res.model, costUsd,
      agreement: { checked: 0, agreed: 0, rate: 0, errored: 0, examples: [] },
      memorisation: { hits: 0, looked: 0, memorised: false },
      verdict: "no",
      summary: cannot
        ? `No rule was written: ${cannot}`
        : raw
          // Distinguished from "no rule was written": the model DID write one and it would not compile,
          // twice. That is a different thing to tell someone, and it points at the model rather than
          // at their column.
          ? `${res.model} wrote a rule twice and neither version would compile. That is a limit of the model, not of this column — a stronger one under Settings → Models → What builds columns for you would likely manage it.`
          : "No rule could be written from these answers, so this column stays on the model.",
    };
  }

  // Checked BEFORE the rule is run. A memorised rule is not merely a low scorer — running it is
  // pointless, and its score would be the misleading part of the report.
  const memorisation = detectMemorisation(code, train);

  const produced = new Map<number, { value: string | null; error?: string }>();
  try {
    await runScriptColumn({
      sheetId,
      columnId,
      refColumnIds,
      code,
      runtime: "js",
      hook: "transform",
      rowIds: holdout.map((e) => e.rowId),
      skipUnchanged: false,
      signal,
      // Collect-only. Nothing is written to a cell — this is a candidate being graded, and a
      // candidate that overwrote the very answers it is being graded against would destroy the
      // evidence and score itself 100%.
      onResults: (rows) => {
        for (const r of rows) {
          produced.set(Number(r.rowId), {
            value: r.value == null ? null : typeof r.value === "string" ? r.value : JSON.stringify(r.value),
            error: r.error,
          });
        }
      },
    });
  } catch (e) {
    return {
      code, refColumnIds, examplesUsed: examples.length, model: res.model, costUsd,
      agreement: { checked: holdout.length, agreed: 0, rate: 0, errored: holdout.length, examples: [] },
      memorisation,
      verdict: "no",
      summary: `The rule would not run: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const agreement = scoreAgreement(holdout, produced);
  const report = judge(agreement, memorisation);

  return { ...report, code, refColumnIds, examplesUsed: examples.length, model: res.model, costUsd };
}
