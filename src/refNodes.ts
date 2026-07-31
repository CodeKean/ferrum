// A template as a SEQUENCE, not as a string.
//
// A reference does not live in the text. Typing `/Website` into a box that holds the literal
// `/Website`, with the chips that mark one required sitting outside the field in a list of their own,
// is not what a reference is. A reference is an object dropped into a sentence — it has a name, a type, a value it
// will resolve to, and a decision attached to it — and none of that is expressible in a run of
// characters.
//
// Everything that was awkward followed from the string:
//   - a `//` ESCAPE had to exist, because a real slash in a URL was ambiguous with a reference,
//   - the controls for a reference could not sit ON it, so they were listed beside the field and you
//     had to match them up by name, and
//   - a reference to a renamed column had to be re-derived by matching text.
//
// As a sequence of nodes none of that arises. A slash is a slash. A reference is one indivisible
// thing you can click, toggle and delete. Its name is looked up when it is drawn, so a rename is
// free.
//
// ── What is stored has NOT changed ─────────────────────────────────────────────────────────────
//
// `{{col:12}}` and `{{col:12?}}`, exactly as before. This is a change to how a template is edited
// and drawn, not to what it means — so nothing in the engine, no saved column and no template moves.

export interface RefColumnLite {
  id: string | number;
  name: string;
}

export type RefNode =
  | { type: "text"; text: string }
  | {
      type: "ref";
      /** Null for a reference written by name to a column that no longer exists. */
      columnId: string | null;
      /** Resolved at parse time for drawing; never the source of truth. */
      name: string;
      /** `.industry` — reaching inside a JSON value rather than taking all of it. */
      path: string;
      /** A row with nothing here is SKIPPED when this is false. See the toggle's own explanation. */
      optional: boolean;
    };

/** Matches the stored form, both spellings. Kept here so the parser and the writer cannot drift. */
const STORED = /\{\{\s*(?:col:(\d+)((?:\.[A-Za-z0-9_$-]+|\[\d+\])*)(\?)?|([^{}:?]+?)(\?)?)\s*\}\}/g;

/** Stored template → the sequence the editor draws. */
export function parseRefNodes(stored: string, columns: RefColumnLite[]): RefNode[] {
  const out: RefNode[] = [];
  if (!stored) return out;

  const byId = new Map(columns.map((c) => [String(c.id), c.name]));
  const byName = new Map(columns.map((c) => [c.name.trim().toLowerCase(), c]));

  let last = 0;
  STORED.lastIndex = 0;
  for (const m of stored.matchAll(STORED)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ type: "text", text: stored.slice(last, at) });

    const [, id, path, idOpt, rawName, nameOpt] = m;
    if (id) {
      out.push({
        type: "ref",
        columnId: id,
        // A reference whose column is gone still draws, and says so. Dropping it would silently
        // change what the template means; showing the id lets it be found and fixed.
        name: byId.get(id) ?? `deleted column ${id}`,
        path: path ?? "",
        optional: !!idOpt,
      });
    } else {
      const key = (rawName ?? "").trim().toLowerCase();
      const hit = byName.get(key);
      out.push({
        type: "ref",
        columnId: hit ? String(hit.id) : null,
        name: hit ? hit.name : (rawName ?? "").trim(),
        path: "",
        optional: !!nameOpt,
      });
    }
    last = at + m[0].length;
  }

  if (last < stored.length) out.push({ type: "text", text: stored.slice(last) });
  return out;
}

/**
 * The sequence → the stored template.
 *
 * A reference with no column id is written back BY NAME, unchanged. That is the only way a template
 * copied from somewhere else — or one whose column was deleted and will be recreated — survives a
 * round trip through this editor rather than being quietly emptied by it.
 */
export function serializeRefNodes(nodes: RefNode[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") { out += n.text; continue; }
    const mark = n.optional ? "?" : "";
    out += n.columnId
      ? `{{col:${n.columnId}${n.path}${mark}}}`
      : `{{${n.name}${mark}}}`;
  }
  return out;
}

/** Every reference in a template, deduplicated by column — one column is one decision. */
export function uniqueRefs(nodes: RefNode[]): Array<Extract<RefNode, { type: "ref" }>> {
  const seen = new Set<string>();
  const out: Array<Extract<RefNode, { type: "ref" }>> = [];
  for (const n of nodes) {
    if (n.type !== "ref") continue;
    const key = n.columnId ?? n.name;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}
