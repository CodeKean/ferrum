// Ranking for the command palette.
//
// Pure and separate from the component, because the ordering is the whole product here. A palette
// whose first result is not the thing you typed the first three letters of is a palette people stop
// opening — and ordering is exactly the part that is invisible in a screenshot and easy to get
// subtly wrong.
//
// Subsequence matching, not `includes`. "adcol" has to find "Add column" and "expjs" has to find
// "Expand JSON", because that is how people actually type into one of these.

export interface Ranked<T> {
  item: T;
  score: number;
  /** Indices in the label that matched, so the UI can mark them. */
  hits: number[];
}

/**
 * Score one candidate against a query.
 *
 * Returns null when the query is not a subsequence of the text at all — a non-match, which is
 * different from a match that scored zero.
 *
 * The scoring rewards, in order of weight:
 *   - a run of adjacent characters, so "colu" beats a scattered c-o-l-u across the string;
 *   - a match at the start of a word, so "ac" finds "Add column" over "Cancel";
 *   - a match near the front of the string.
 */
export function score(text: string, query: string): { score: number; hits: number[] } | null {
  if (query === "") return { score: 0, hits: [] };
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();

  let s = 0;
  let prev = -2;
  const hits: number[] = [];
  let at = 0;

  for (const ch of needle) {
    // Spaces in the query are separators, not characters to find: "add col" should behave like
    // "addcol" rather than demanding the literal space be in the label.
    if (ch === " ") continue;
    const found = hay.indexOf(ch, at);
    if (found === -1) return null;
    hits.push(found);

    if (found === prev + 1) s += 8;                                    // adjacent run
    if (found === 0 || /[\s\-_/(]/.test(hay[found - 1] ?? "")) s += 6; // start of a word
    s += Math.max(0, 4 - Math.floor(found / 8));                       // near the front

    prev = found;
    at = found + 1;
  }
  // Shorter labels win ties: with "run" in the query, "Run" is a better answer than "Run this row
  // again with the strong model".
  s += Math.max(0, 12 - Math.floor(text.length / 4));
  return { score: s, hits };
}

/**
 * Rank a list.
 *
 * `keywords` are matched too but never contribute their own hit indices — they exist so "sheet"
 * finds "Table" and "csv" finds "Export", without the UI trying to underline letters of a word that
 * is not on screen. A keyword-only match scores lower than a label match on purpose: the label is
 * what the user is reading.
 */
export function rank<T>(
  items: T[],
  query: string,
  label: (t: T) => string,
  keywords: (t: T) => string = () => "",
): Array<Ranked<T>> {
  const q = query.trim();
  const out: Array<Ranked<T>> = [];

  for (const item of items) {
    const direct = score(label(item), q);
    if (direct) { out.push({ item, score: direct.score, hits: direct.hits }); continue; }
    const kw = q === "" ? null : score(keywords(item), q);
    if (kw) out.push({ item, score: kw.score - 20, hits: [] });
  }

  // A STABLE sort on ties, which `Array.prototype.sort` guarantees. It matters: with an empty query
  // every item scores the same, and an unstable order would reshuffle the whole palette on every
  // keystroke that clears the box.
  return out.sort((a, b) => b.score - a.score);
}
