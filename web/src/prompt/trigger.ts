// The "/" trigger rule, in ONE place.
//
// It used to be written out twice inside RefField — once to decide whether the menu opens, and once
// to decide what the chip replaces. Two copies of a regular expression that MUST agree: if the
// opener matches and the replacer does not, the menu appears, you pick a column, and nothing is
// inserted with nothing said. That is a silent failure by construction, so the rule lives here and
// both callers ask the same function.

/** Where a trigger starts and what has been typed since. */
export interface Trigger {
  /** Offset in the text where the "/" itself sits. The replacement starts here. */
  start: number;
  /** What has been typed after the "/", used to filter the menu. */
  query: string;
}

/**
 * Find a "/" trigger immediately before the caret.
 *
 * `text` is everything in the caret's own text node up to the caret. Returns null when there is no
 * live trigger there.
 *
 * The slash must START A WORD. Without that rule every URL in a prompt — "https://acme.com" — opens
 * the column menu mid-typing. And because a slash is never consumed, there is no escape syntax to
 * learn: a slash that is not at a word boundary is simply a slash.
 *
 * The query stops at whitespace and at another slash, so a path typed after a picked column does not
 * keep the menu open over text that is no longer a column name.
 */
export function findTrigger(text: string): Trigger | null {
  const m = /(^|\s)\/([^/\s]*)$/.exec(text);
  if (!m) return null;
  // m.index is where the match begins, which includes the leading space when there is one.
  const start = m.index + m[1]!.length;
  return { start, query: m[2] ?? "" };
}
