/**
 * The same path, asked of every item rather than of one.
 *
 * A field inside a list cannot be a column at a fixed index — `contacts.0.email` is a different
 * person on every row — but `contacts.*.email` is the same question on every row, which is exactly
 * what a column is. Every numeric segment in a JSON path is an array index (object keys arrive as
 * names), so turning each one into a star is precisely "do this for each item, at every level".
 *
 * Its own module rather than a helper inside the panel, so it can be tested: Node strips types from
 * `.ts` but not from `.tsx`, and an untestable one-liner is how the lost-backslash version of this
 * shipped and silently produced empty columns.
 */
export function starPath(path: string): string {
  return path.split(".").map((seg) => (/^[0-9]+$/.test(seg) ? "*" : seg)).join(".");
}
