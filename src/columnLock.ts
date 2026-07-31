// Which columns you can type into, and why not.
//
// ── The rule ───────────────────────────────────────────────────────────────────────────────────
//
// You type into the columns you OWN — the ones you imported or filled in yourself. Everything else
// produces its own value, and a typed value that sits where a produced one should be is
// indistinguishable from it: same font, same cell, no mark that survives a reload. The column then
// looks like it worked, and the row it lied about is the one nobody goes back to check.
//
// This is what Clay does, and the reasoning is already written down in this repo. `mapJsonField` in
// derive.ts refuses to point a projection at a column that runs a rule, because doing so "would
// silently replace work with a projection, and the values would look the same until the next run did
// nothing". That is the same argument, one level down: at the cell rather than the column.
//
// ── It is a lock, not a wall ───────────────────────────────────────────────────────────────────
//
// A locked cell can still be written, deliberately, one at a time, through an override that says
// what it will cost you. Hand-correcting one wrong answer in ten thousand is a real thing people
// need to do — the run engine has a whole setting about whether to preserve those corrections. What
// was wrong was that it happened by ACCIDENT: a stray keystroke on a selected cell, and on a derived
// column, one Delete permanently orphaned that cell from its source with nothing on screen ever
// saying so.
//
// ── It imports nothing ─────────────────────────────────────────────────────────────────────────
//
// The grid asks the same question before it opens an editor, so this is read in the browser too. A
// test asserts there are no imports at all; see the note in errorClass.ts for what breaks otherwise.

/** Just enough of a column to decide. Loose on purpose, so both the server row and the API shape fit. */
export interface Lockable {
  kind?: string | null;
  /** Set when this column is a projection of another column's JSON. */
  sourceColumnId?: number | string | null;
  jsonPath?: string | null;
  /** Set when a generated rule writes this column's value. */
  transformScriptId?: number | string | null;
}

/** What each kind produces, in the words the cell panel already uses for the same thing. */
const PRODUCES: Record<string, string> = {
  script: "A rule works this out from the other columns on this row.",
  http: "This calls an API and puts the answer here.",
  mcp: "This asks a connected app for the answer.",
  ai: "A model reads this row and writes this answer.",
  agent: "A model researches this row and writes this answer.",
  send: "This records what was sent to another table — it is a receipt, not a value.",
  lookup: "This is copied across from a matching row in another table.",
  rollup: "This counts or totals matching rows in another table.",
};

/**
 * Why this column cannot be typed into, or null when it can.
 *
 * The order of the checks matters and is not the obvious one. A derived child is stored as
 * `kind: "script"`, so a kind-first rule would tell someone their projection is "a rule over the
 * other columns" — true of the storage and useless as an explanation. Its own sentence comes first.
 *
 * `sourceName` is passed in rather than looked up, because this function has no database. The server
 * knows the name; the browser is handed the finished sentence.
 */
export function lockReason(col: Lockable, sourceName?: string | null): string | null {
  // 1. A projection of another column's JSON.
  if (col.sourceColumnId != null && col.jsonPath) {
    const from = sourceName ? `"${sourceName}"` : "another column";
    return `This is pulled out of ${from} at ${col.jsonPath}, and is refilled from there.`;
  }

  // 2. A generated rule writes it.
  //
  // Checked before `kind`, because a column can carry a transform script while still being stored as
  // `static` — `mapJsonField` proves it, and without this check such a column would read as editable
  // while a rule overwrites whatever was typed on the next run.
  if (col.transformScriptId != null) {
    return "A rule you approved writes this column's value.";
  }

  // 3. Any lane that runs.
  const kind = String(col.kind ?? "static");
  if (kind !== "static") {
    return PRODUCES[kind] ?? "This column produces its own value.";
  }

  // 4. Yours.
  return null;
}

/** The plain question, for anywhere that does not need the sentence. */
export const isEditable = (col: Lockable): boolean => lockReason(col) === null;

/**
 * The extra thing an override costs, per kind — beyond "your value stays".
 *
 * Each of these is true and none of them is obvious, which is the test for whether a warning is
 * worth showing at all. The two that surprise people:
 *
 *   http and mcp — pinning protects the WRITE, not the CALL. The request is still made and still
 *   billed on the next run; the answer is simply thrown away. Somebody overriding a cell to stop
 *   paying for it would otherwise keep paying for it.
 *
 *   send — the cell is a receipt for something that already happened over in another table.
 *   Overriding it does not un-send anything; it makes the receipt disagree with the event. Nothing
 *   in the engine reads it back (checked: the send lane recomputes from the source columns and the
 *   destination every run), so this is safe to allow — it is just a note that is now wrong.
 */
export function overrideWarning(col: Lockable): string {
  if (col.sourceColumnId != null && col.jsonPath) {
    return "Your value stays here, and this cell is flagged whenever the source produces something different. You can put it back at any time.";
  }
  const kind = String(col.kind ?? "static");
  if (kind === "http" || kind === "mcp") {
    return "Runs will leave your value alone, but they will still make the call and still be billed for it — the answer is discarded rather than not fetched.";
  }
  if (kind === "send") {
    return "This cell is a receipt for rows already written to another table. Changing it does not un-send anything; it only makes the note disagree with what happened.";
  }
  if (kind === "lookup" || kind === "rollup") {
    return "This is a copy of something in another table. Change it there instead, or the two will disagree with each other.";
  }
  return "Runs will leave your value alone, unless you tick “also replace cells I typed in myself” when starting one.";
}
