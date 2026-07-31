// One way to refer to another column: `/Column name`.
//
// Lives in the server tree and is re-exported by web/src/prompt/refs.ts, so the browser, the engine
// and the AI-setup proposal all agree on exactly one answer to "is this slash a reference?".
//
// ONE notation, on every screen. If `/` opens the picker in the rule editor while what it inserts —
// and what every placeholder, hint and example in the request screen shows — is `{{col:17}}` or
// `{{Website}}`, then the thing you type and the thing you see are different, and the thing you see
// changes again depending on which screen you are on. Three notations for one idea.
//
// ── What changed, and what deliberately did not ──────────────────────────────────────────────────
//
// The STORED form is still `{{col:<id>}}`. That is not a compromise, it is the point: an id survives
// a rename and a name does not, and a rule that silently breaks when someone tidies up a column
// heading is worse than any amount of notation. What changed is that the id form is now an internal
// wire format nobody is ever shown.
//
// Every field converts at its own edge — stored id in, `/Name` out, `/Name` in, stored id out — so
// the text in the box IS the text the user typed, and there is no cursor arithmetic anywhere.

/**
 * All this parser needs of a column, and deliberately no more.
 *
 * The engine's Column and the browser's Column are different shapes — the browser has no business
 * knowing about turn caps or budgets — and typing this against either one would have forced the
 * other to fake the fields it does not have. A structural minimum lets both pass their own type in
 * unchanged.
 */
export interface RefColumn {
  id: string | number;
  name: string;
  /**
   * Optional, and only consulted to decide whether a `.path` after the name is a PATH or prose.
   *
   * See `HOLDS_STRUCTURE`. Absent means "assume it cannot be drilled into", which is the safe
   * reading: a reference that fails to pick up a path renders as a whole value, and a reference that
   * wrongly picks one up eats the next word of somebody's sentence.
   */
  valueType?: string;
}

/**
 * The column types a `.path` may be read on.
 *
 * The reason this restriction exists at all: `"Ask about /Company. Then check the site."` A parser
 * that takes any dot as a path silently turns `.Then` into a field lookup, the sentence loses a word,
 * and nothing on screen says so. That is the same failure as a trailing `?` marking references
 * optional inside ordinary prose: punctuation reinterpreted as syntax.
 *
 * A text column cannot be drilled into, so on one a dot is always prose and is left alone. To reach
 * inside a value you declare the column holds structure, which is a thing you know and can set.
 */
const HOLDS_STRUCTURE = new Set(["json", "array", "multi_select"]);

/** One `.field` or `[0]` step. Deliberately narrow — no spaces, no quotes, no expressions. */
const PATH_STEP = /^(?:\.[A-Za-z0-9_$-]+|\[\d+\])/;

/**
 * How much of `text` from `i` is a path, given the column it follows.
 *
 * Returns "" for a column that cannot hold structure, which is what keeps prose safe.
 */
function pathAt(text: string, i: number, col: { valueType?: string }): string {
  if (!HOLDS_STRUCTURE.has(String(col.valueType ?? ""))) return "";
  let out = "";
  let rest = text.slice(i);
  for (;;) {
    const m = PATH_STEP.exec(rest);
    if (!m) break;
    out += m[0];
    rest = rest.slice(m[0].length);
  }
  return out;
}

/** `{{col:12}}` or `{{Website}}`. Both are accepted on the way in; only the first is ever written. */
/**
 * `{{col:12}}` or `{{Website}}`, each with an optional trailing `?`.
 *
 * The `?` is what makes a reference OPTIONAL. Without it a reference is required, and a row with
 * nothing in that column is skipped rather than run — because a request built around a blank domain
 * is not a request, it is a paid call against nothing, once per row.
 *
 * Required is the default because the two failures are not symmetric. A skipped row says so in the
 * cell. A row that ran against a blank input comes back with a confident wrong answer that was
 * charged for, and nothing anywhere says it happened.
 *
 * In the STORED form the marker sits inside the braces, where nothing else can be. In the DISPLAY
 * form it goes in front of the name — `/?Company`, not `/Company?` — and the reason is below at
 * `fromDisplay`. Both directions must agree, so the two are changed together or not at all.
 */
const STORED = /\{\{col:(\d+)((?:\.[A-Za-z0-9_$-]+|\[\d+\])*)(\?)?\}\}|\{\{([^}?]+)(\?)?\}\}/g;

/**
 * Characters a reference may follow.
 *
 * This is the whole reason `/Name` is safe to use inside a web address. The `/` in
 * `https://api.example.com/lookup` is preceded by `m`, which is not on this list, so it is never
 * read as a reference. The `/` in `?domain=/Website` is preceded by `=`, which is — and that is
 * exactly where a reference belongs.
 *
 * `:` is deliberately absent. Including it would make the first slash of `://` a candidate, and
 * while that only matters if a column happens to be named after a hostname, "only matters
 * sometimes" is not a property worth having in a parser that decides what gets sent to an API.
 */
const BOUNDARY = /[\s=&?,;({[<"'|+*-]/;

function canStartAt(text: string, i: number): boolean {
  if (i === 0) return true;
  return BOUNDARY.test(text[i - 1]!);
}

/** The name as it is written in a reference. Trailing punctuation is not part of it. */
function longestNameAt(text: string, i: number, names: Array<{ name: string; id: string }>): { name: string; id: string } | null {
  const rest = text.slice(i);
  const lower = rest.toLowerCase();
  // Longest first, so a sheet with both "Country" and "Country code" resolves `/Country code`
  // to the one that was meant rather than to its own prefix.
  for (const c of names) {
    if (lower.startsWith(c.name.toLowerCase())) return c;
  }
  return null;
}

function byLengthDesc(columns: RefColumn[]): Array<{ name: string; id: string }> {
  return columns
    .map((c) => ({ name: c.name, id: String(c.id) }))
    .filter((c) => c.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
}

/**
 * Stored → what the user reads.
 *
 * A reference to a column that no longer exists renders as a visible complaint rather than
 * vanishing: `/deleted column 12` is something you can act on, an empty string is not.
 */
export function toDisplay(stored: string, columns: RefColumn[]): string {
  if (!stored) return "";
  const byId = new Map(columns.map((c) => [String(c.id), c.name]));
  const byName = new Map(columns.map((c) => [c.name.trim().toLowerCase(), c.name]));
  const names = byLengthDesc(columns);

  const render = (id?: string, path?: string, idOpt?: string, name?: string, nameOpt?: string): string => {
    const mark = idOpt || nameOpt ? "?" : "";
    // The path rides along verbatim. It is not a name and never needs resolving — `.industry` means
    // the same thing whatever the column ends up being called.
    if (id) return `/${mark}${byId.get(id) ?? `deleted column ${id}`}${path ?? ""}`;
    const key = (name ?? "").trim().toLowerCase();
    return `/${mark}${byName.get(key) ?? name}`;
  };

  /**
   * Put the escape BACK on literal text that would otherwise read as a reference.
   *
   * This half was missing and it silently destroyed the escape. `//Website` means the literal text
   * `/Website`, and `fromDisplay` correctly stores it as `/Website` — but rendering that back
   * unchanged produced `/Website`, and the next keystroke ran `fromDisplay` over it again and turned
   * it into `{{col:1}}`. A deliberate literal became a live reference, one edit later, with nothing
   * said. The escape only works if it survives the round trip, so the round trip has to re-add it.
   *
   * Only slashes that WOULD be read as a reference are doubled — the same three tests `fromDisplay`
   * applies, in the same order — so an ordinary URL is left exactly as the user wrote it.
   */
  const escapeLiteral = (text: string): string => {
    let out = "";
    let i = 0;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch !== "/" || !canStartAt(text, i)) { out += ch; i++; continue; }
      const optional = text[i + 1] === "?";
      if (!longestNameAt(text, i + 1 + (optional ? 1 : 0), names)) { out += ch; i++; continue; }
      out += "//";
      i++;
    }
    return out;
  };

  // Walked by hand rather than with .replace(), because only the text BETWEEN references may be
  // escaped. Escaping the rendered references too would double the slash this function just wrote.
  let out = "";
  let last = 0;
  for (const m of stored.matchAll(STORED)) {
    out += escapeLiteral(stored.slice(last, m.index));
    out += render(m[1], m[2], m[3], m[4], m[5]);
    last = m.index + m[0].length;
  }
  return out + escapeLiteral(stored.slice(last));
}

/** One reference, as found in a template. */
export interface FoundRef {
  columnId: string | null;
  /** The name as written, for a reference to a column that no longer exists. */
  name: string;
  /** `.industry`, when the reference reaches inside the value rather than taking all of it. */
  path?: string;
  optional: boolean;
}

/**
 * Every reference in a template, in order.
 *
 * Used two ways: the editor lists them so each can be switched between required and optional, and
 * the engine checks the required ones against the row before deciding to spend anything on it.
 */
export function findRefs(stored: string, columns: RefColumn[]): FoundRef[] {
  if (!stored) return [];
  const byId = new Map(columns.map((c) => [String(c.id), c.name]));
  const out: FoundRef[] = [];
  for (const m of stored.matchAll(STORED)) {
    const [, id, path, idOpt, name, nameOpt] = m;
    out.push({
      columnId: id ?? null,
      name: id ? (byId.get(id) ?? `deleted column ${id}`) : (name ?? "").trim(),
      // Carried so the editor can show WHICH part of a value a reference reaches for — two
      // references to one column pulling different fields are two different things.
      path: path || undefined,
      optional: !!(idOpt || nameOpt),
    });
  }
  return out;
}

/**
 * Flip one reference between required and optional, by column id.
 *
 * Every occurrence of that column, because the same column referenced three times in one template is
 * one decision. Leaving some occurrences required and others optional would produce a template whose
 * behaviour nothing on screen explains.
 */
export function setRefOptional(stored: string, columnId: string, optional: boolean): string {
  // Built from a plain string rather than a template literal so the braces stay escaped. Written the
  // other way, `\{` collapses to a bare `{` and the pattern matches nothing at all — silently, which
  // reads as a toggle that does not work.
  const pattern = new RegExp("\\{\\{col:" + columnId + "\\??\\}\\}", "g");
  return stored.replace(pattern, `{{col:${columnId}${optional ? "?" : ""}}}`);
}

/**
 * What the user typed → stored.
 *
 * `//` is the escape: `//Website` means a literal `/Website` and is left alone. Without it there
 * would be no way to send a path segment that happens to share a column's name.
 */
export function fromDisplay(display: string, columns: RefColumn[]): string {
  if (!display) return "";
  const names = byLengthDesc(columns);
  const byId = new Map(columns.map((c) => [String(c.id), c]));
  let out = "";
  let i = 0;

  while (i < display.length) {
    const ch = display[i]!;
    if (ch !== "/") { out += ch; i++; continue; }

    // The boundary check comes FIRST, and the order matters more than it looks. Checking the escape
    // first turned `https://` into `https:/` — the two slashes of a scheme are not an escape, they
    // are two slashes, and only a slash that could have started a reference can be escaping one.
    if (!canStartAt(display, i)) { out += ch; i++; continue; }

    // Escaped: emit one slash and skip past both, so the second is never re-examined.
    if (display[i + 1] === "/") { out += "/"; i += 2; continue; }

    // The optional marker comes BEFORE the name — `/?Company`, not `/Company?`.
    //
    // It LEADS. A trailing "?" in prose is a question mark far more often than it is a marker, so
    // "How many people work at /Company?" would quietly parse as an OPTIONAL reference: the
    // sentence lost its question mark, and — the part that costs money — the row-is-empty skip
    // stopped applying to Company, so every row with a blank company ran anyway and was charged for
    // a question about nothing. Nothing on screen said the sentence had been reinterpreted.
    //
    // In front, the marker sits where English punctuation never does, so the two can never be
    // confused, and the round trip through the plain-text editor is still exact.
    const optional = display[i + 1] === "?";
    const nameAt = i + 1 + (optional ? 1 : 0);
    const hit = longestNameAt(display, nameAt, names);
    if (!hit) { out += ch; i++; continue; }

    // Anything after the name that looks like `.field` or `[0]` — but ONLY on a column that can
    // actually hold structure. On a text column the dot in "Ask about /Company. Then check." is
    // punctuation, and reading it as a field lookup would eat the next word of the sentence with
    // nothing on screen to say so.
    const afterName = nameAt + hit.name.length;
    const col = byId.get(hit.id);
    const path = col ? pathAt(display, afterName, col) : "";

    out += `{{col:${hit.id}${path}${optional ? "?" : ""}}}`;
    i = afterName + path.length;
  }

  return out;
}

/**
 * Where the picker should open, and what has been typed into it.
 *
 * Only `/` now. The `{{` trigger is gone from the editor along with the notation — a user who never
 * sees braces has no reason to type them, and leaving a second hidden trigger in place is how one
 * notation quietly becomes two again.
 */
export function detectTrigger(value: string, caret: number): { start: number; query: string } | null {
  const upto = value.slice(0, caret);
  const slash = upto.lastIndexOf("/");
  if (slash < 0) return null;
  // An escaped slash is not a trigger.
  if (slash > 0 && upto[slash - 1] === "/") return null;
  if (!canStartAt(upto, slash)) return null;
  // A leading "?" is the optional marker, not part of what is being searched for. Left in the query
  // it would match no column, so the picker would close the moment someone edits an already-optional
  // reference — the one case where they most need it open.
  const after = upto.slice(slash + 1).replace(/^\?/, "");
  // A name can contain spaces, but a query that has run past the end of a word is almost always
  // someone who has moved on. One space is allowed so "Country co" still finds "Country code".
  if ((after.match(/\s/g)?.length ?? 0) > 1 || after.includes("\n")) return null;
  return { start: slash, query: after };
}

/** The text to insert for a picked column, in display form. */
export function refText(column: RefColumn): string {
  return `/${column.name}`;
}
