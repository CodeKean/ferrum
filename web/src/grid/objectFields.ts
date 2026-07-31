// Turning a whole object into columns, in one go.
//
// ── What was wrong ─────────────────────────────────────────────────────────────────────────────
//
// The tree offered an action on a LEAF ("add this field as a column") and on an ARRAY ("use this
// list"), and nothing at all on an OBJECT. So a result shaped like
//
//   company: { name, domain, employees, founded, hq }
//
// meant opening the object and pressing the same button five times, and an object sitting inside a
// list — every "Item 1" in a research result — offered nothing whatsoever, with no explanation. A
// control that is absent for a good reason is indistinguishable from one that was forgotten.
//
// ── The two cases, which are genuinely different ───────────────────────────────────────────────
//
// An object at a fixed path has fields at fixed paths: `company.name` is the same question on every
// row, so all of them can become columns at once.
//
// An object INSIDE a list does not. `contacts.0` is a different person on every row, so no column
// built from it means anything — and that is a fact to state, not a button to grey out. The field
// underneath is still usable as `contacts.*.email`, which the leaf action already offers, so the
// explanation points there rather than being a dead end.

export interface FieldNode {
  path: string;
  label: string;
  kind: string;
  inArray?: boolean;
  placeholder?: boolean;
  children?: FieldNode[];
}

export interface PickedField {
  path: string;
  name: string;
}

/** Kinds that hold ONE value, and can therefore be a column on their own. */
const SCALAR = new Set(["text", "number", "boolean", "url", "null"]);

/**
 * Every field under this object that could be a column, with a suggested name.
 *
 * Nested objects are walked through — `company.hq.city` is as good a column as `company.name`, and
 * stopping at the first level would hide half the useful fields of any real API response.
 *
 * Arrays and anything inside one are NOT included: those need the list action, which asks a
 * different question (fan out into rows, or join into one cell) and cannot be answered in bulk here.
 */
export function fieldsUnder(node: FieldNode, limit = 40): PickedField[] {
  const out: PickedField[] = [];

  const walk = (n: FieldNode, trail: string[]) => {
    if (out.length >= limit) return;
    for (const c of n.children ?? []) {
      if (out.length >= limit) return;
      // The "…N more items not shown" row is prose. Its path resolves to nothing on every row.
      if (c.placeholder) continue;
      // A list needs its own decision, and an object inside one has no fixed path.
      if (c.kind === "array" || c.inArray) continue;

      const label = [...trail, c.label];
      if (SCALAR.has(c.kind)) {
        out.push({ path: c.path, name: label.join(" ") });
      } else if (c.kind === "object") {
        walk(c, label);
      }
    }
  };

  walk(node, []);
  return out;
}

/**
 * What the object row should offer, and what it should say.
 *
 * Returns the reason INSTEAD of a count when there is nothing to offer, so the row can never be
 * silently blank — which is the whole defect this replaces.
 */
export function objectOffer(node: FieldNode): { fields: PickedField[]; reason: string | null } {
  if (node.inArray) {
    return {
      fields: [],
      // Names the alternative rather than just refusing. Someone looking at "Item 1" wants the email
      // out of every contact, and that column exists — it is just spelled with a star.
      reason: "One of these per row, so it cannot be a column. Open it and add a field instead — that takes it from every item.",
    };
  }

  const fields = fieldsUnder(node);
  if (fields.length === 0) {
    return { fields: [], reason: "Nothing in here can be a column on its own." };
  }
  return { fields, reason: null };
}

/** "Add all 5 fields" — plural handled, and the count stated so nobody presses it blind. */
export const addAllLabel = (n: number): string => `Add ${n} field${n === 1 ? "" : "s"}`;
