// The question asked on behalf of one failed cell.
//
// The ordinary setup route takes an intent the user typed and knows nothing about any particular
// row. This one is the reverse: the user types nothing, and every word of the request is assembled
// from a single failure. So the assembly IS the feature — a vague brief produces a proposal that
// changes something unrelated and is applied anyway, because the person reading it came here
// precisely because they did not know what was wrong.
//
// Deterministic on purpose. The same cell in the same state produces the same brief, so a proposal
// that turns out to be wrong can be reasoned about rather than re-rolled.

/** How much of the sent prompt is quoted back. Enough to see the shape; not the whole essay. */
const PROMPT_CHARS = 1200;
/** How much of the provider's own complaint is quoted. Past this it is a stack trace, not a message. */
const MESSAGE_CHARS = 400;
/** How many of this row's input values are shown, and how long each may be. */
const INPUTS_SHOWN = 12;
const INPUT_CHARS = 120;

export interface FixInput {
  columnName: string;
  /** The lane, which decides what "fix it" can even mean. */
  kind: string;
  /** What the column is for, if anyone wrote it down. */
  purpose?: string | null;
  /** The engine's verdict on this failure. */
  errorType: string | null;
  /** The provider's own words. Must already be redacted by the caller. */
  errorMsg: string | null;
  /** How many times THIS row has been tried. One failure and nine are different problems. */
  attemptsHere: number;
  /** How the whole column's failures split by cause, commonest first. */
  columnErrorTypes: Array<{ type: string; rows: number }>;
  /** The instruction as it was actually sent, for this row. Must already be redacted. */
  renderedPrompt: string | null;
  /** This row's values, by column name. */
  inputs: Array<{ name: string; value: string }>;
}

const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more characters]` : s);

/**
 * The brief, in the order a person would want it: what broke, then the evidence, then the rules.
 *
 * The closing paragraph is not decoration. `proposeSetup` will happily return a different model or a
 * relaxed private-address setting if the failure seems to point that way, and both are decisions
 * that cost money or open a hole — neither is a thing to change on the strength of one failed row.
 */
export function buildFixIntent(i: FixInput): string {
  const lines: string[] = [];

  lines.push(
    `One cell in the "${i.columnName}" column failed and I need to know why, and what to change so it stops failing.`,
  );
  if (i.purpose) lines.push(`What this column is for: ${trim(i.purpose, 300)}`);
  lines.push("");

  lines.push("THE FAILURE");
  lines.push(`- kind of column: ${i.kind}`);
  lines.push(`- failure class the engine recorded: ${i.errorType ?? "none recorded"}`);
  if (i.errorMsg) lines.push(`- what came back: ${trim(i.errorMsg, MESSAGE_CHARS)}`);
  // The retry count is the difference between "unlucky" and "will never work", and it is the one
  // fact the message itself can never carry.
  lines.push(
    i.attemptsHere > 1
      ? `- this row has been tried ${i.attemptsHere} times and failed each time, so it is not a one-off`
      : "- this row has been tried once",
  );
  if (i.columnErrorTypes.length) {
    lines.push(
      `- across the whole column the failures split: ${i.columnErrorTypes.map((e) => `${e.rows} ${e.type}`).join(", ")}`,
    );
    // Said explicitly, because a proposal that fixes the row in front of it and breaks the other
    // nine hundred is the expensive way to be right.
    if (i.columnErrorTypes.length > 1 || (i.columnErrorTypes[0]?.rows ?? 0) > 1) {
      lines.push("  Fix the cause that accounts for most of those rows, not only this one row.");
    }
  }
  lines.push("");

  if (i.renderedPrompt) {
    lines.push("WHAT WAS ACTUALLY SENT FOR THIS ROW");
    lines.push(trim(i.renderedPrompt, PROMPT_CHARS));
    lines.push("");
  }

  if (i.inputs.length) {
    lines.push("THIS ROW'S VALUES");
    for (const v of i.inputs.slice(0, INPUTS_SHOWN)) {
      lines.push(`- ${v.name}: ${v.value === "" ? "(empty)" : trim(v.value, INPUT_CHARS)}`);
    }
    if (i.inputs.length > INPUTS_SHOWN) lines.push(`- …and ${i.inputs.length - INPUTS_SHOWN} more columns`);
    lines.push("");
  }

  // Said because it is the observed failure mode, not a hypothetical one. Diagnosing the same enum
  // column three times produced three correct explanations — "the instruction should name the
  // allowed values" — and twice attached no actual change, which the panel can do nothing with. An
  // explanation is not a fix.
  lines.push(
    "If the fix is a change to this column, RETURN THE CHANGE ITSELF — the new instruction, the new " +
      "data type, whatever it is. An explanation of what should change, with no changed value " +
      "attached, cannot be applied and is no use to me.",
  );
  lines.push("");
  lines.push(
    "Do not change the model, do not change any spending limit, and do not change whether private " +
      "addresses may be reached. Those are my decisions and one failed row is not a reason to revisit " +
      "them. Propose only the change that addresses the failure above.",
  );

  return lines.join("\n");
}
