// JSON path extraction, and expanding a JSON column into sibling columns.
//
// The economics this exists to serve: one enrichment returning {name, title, email, linkedin} is ONE
// unit of spend. Four separate prompt columns for the same four fields is four. So the JSON column
// has to be the cheap shape AND the convenient one, which means pulling fields out of it must be
// free — deterministic extraction, no model, no per-row cost.
//
// Paths are read-only projections of the source. Re-running the source updates every child column.

export type PathSegment = string | number;

/**
 * Parse a path like `contact.emails[0].address` into segments.
 *
 * Deliberately NOT eval or a JSONPath library: a path string can arrive from a template someone
 * imported, and the only safe parser is one that can express nothing but member access.
 */
export function parsePath(path: string): PathSegment[] {
  const segs: PathSegment[] = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  // `*` arrives as a plain name segment and is handled by getPath, not here — parsing stays a pure
  // description of the path and the traversal decides what a star means.
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    if (m[2] !== undefined) segs.push(Number(m[2]));
    else if (m[1] !== undefined) {
      const name = m[1].trim();
      // A bare integer between dots is an ARRAY INDEX. `a.0.b` is how most people write one, it is
      // what a JSONPath-lite library accepts, and it is what anyone copying a path off a JSON sample
      // reaches for first — but it parsed as the string "0", and `step` refuses a string against an
      // array, so it silently found nothing. Measured against a live endpoint: `Answer.0.data`
      // returned "No Answer.0.data in the response" while `Answer[0].data` on the identical payload
      // filled every row. An object whose key really is "0" still works — see `step`.
      segs.push(/^\d+$/.test(name) ? Number(name) : name);
    }
  }
  return segs;
}

const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Read a path out of a parsed JSON value.
 *
 * Returns `undefined` for a missing path, which the caller must distinguish from a stored `null` —
 * "the field was absent" and "the field was explicitly null" are different answers, and collapsing
 * them makes a not-found cell look like a real empty value.
 */
export function getPath(value: unknown, path: string): unknown {
  return walk(value, parsePath(path));
}

/**
 * Walk parsed segments, with `*` meaning "every item of this list".
 *
 * The reason this exists: a field inside a list cannot be a column at a fixed index, because
 * `contacts.0.email` is a different person on every row — but `contacts.*.email` is the same
 * QUESTION on every row ("everyone's email"), which is exactly what a column is. Without a star,
 * every field inside every list was unreachable, and the answer to "can I use this?" was no with no
 * reason given.
 *
 * The result of a star is a list, and the remaining segments are applied to each item. Missing
 * values are dropped rather than left as holes: "three of the five had an email" is the useful
 * answer, and a column reading "a, , , b," is not.
 */
function walk(value: unknown, segs: PathSegment[]): unknown {
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (seg === "*") {
      if (!Array.isArray(value)) return undefined;
      const rest = segs.slice(i + 1);
      const out = value
        .map((item) => (rest.length === 0 ? item : walk(item, rest)))
        .filter((v) => v !== undefined && v !== null);
      return out;
    }
    value = step(value, seg);
    if (value === undefined) return undefined;
  }
  return value;
}

/** One segment of member access, refusing prototype keys and type mismatches. */
function step(cur: unknown, seg: PathSegment): unknown {
  if (cur == null) return undefined;
  // Prototype keys are never data. Reading them would leak engine internals into a cell.
  if (typeof seg === "string" && PROTO_KEYS.has(seg)) return undefined;
  if (typeof seg === "number") {
    if (Array.isArray(cur)) return cur[seg];
    // A numeric segment against an OBJECT falls back to the string key, because `{"0": …}` is real
    // data — an API keyed by id, a year, a rank. Without this, teaching `a.0.b` to mean an index
    // would have taken that shape away, trading one silent nothing for another.
    if (typeof cur === "object") return (cur as Record<string, unknown>)[String(seg)];
    return undefined;
  }
  if (typeof cur !== "object" || Array.isArray(cur)) return undefined;
  return (cur as Record<string, unknown>)[seg];
}

/** Render an extracted value for `value_text` — the display, sort, export and interpolation form. */
export function toText(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // An array of scalars reads far better as "a, b, c" than as JSON in a 180px cell.
  if (Array.isArray(v) && v.every((x) => x == null || typeof x !== "object")) {
    return v.filter((x) => x != null).join(", ");
  }
  return JSON.stringify(v);
}

// ─────────────────────────────────────────────────────────────── discovering fields

export interface DiscoveredField {
  path: string;
  /** Inferred from the sampled values, so the created column gets a usable type immediately. */
  valueType: "text" | "number" | "boolean" | "url" | "email" | "json" | "array";
  /** Fraction of sampled rows where this path is present and non-null. */
  coverage: number;
  /** A real example, shown in the expand dialog so the choice is informed. */
  sample: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function inferType(values: unknown[]): DiscoveredField["valueType"] {
  const present = values.filter((v) => v != null);
  if (present.length === 0) return "text";
  const frac = (p: (v: unknown) => boolean) => present.filter(p).length / present.length;

  if (frac((v) => Array.isArray(v)) > 0.6) return "array";
  if (frac((v) => typeof v === "object") > 0.6) return "json";
  if (frac((v) => typeof v === "boolean") > 0.8) return "boolean";
  if (frac((v) => typeof v === "number") > 0.8) return "number";
  if (frac((v) => typeof v === "string" && EMAIL_RE.test(v)) > 0.8) return "email";
  if (frac((v) => {
    if (typeof v !== "string") return false;
    try { const u = new URL(v); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; }
  }) > 0.8) return "url";
  return "text";
}

/**
 * Walk sampled JSON objects and report the paths worth offering as columns.
 *
 * Only descends into nested objects, never into arrays — exploding `contacts[0].email`,
 * `contacts[1].email` … as columns is the wrong shape for list data. A list belongs in another
 * TABLE, via fan-out, which is what the write-target path is for.
 */
export function discoverFields(samples: unknown[], maxDepth = 2): DiscoveredField[] {
  const seen = new Map<string, unknown[]>();

  const walk = (v: unknown, prefix: string, depth: number): void => {
    if (v == null || typeof v !== "object" || Array.isArray(v)) return;
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (PROTO_KEYS.has(k)) continue;
      const path = prefix ? `${prefix}.${k}` : k;
      if (!seen.has(path)) seen.set(path, []);
      seen.get(path)!.push(child);
      // Descend only into plain objects, and only to the configured depth.
      if (depth < maxDepth && child != null && typeof child === "object" && !Array.isArray(child)) {
        walk(child, path, depth + 1);
      }
    }
  };

  for (const s of samples) walk(s, "", 1);

  const total = Math.max(1, samples.length);
  return [...seen.entries()]
    .map(([path, values]) => {
      const present = values.filter((v) => v != null);
      return {
        path,
        valueType: inferType(values),
        coverage: present.length / total,
        sample: present.length > 0 ? (toText(present[0]) ?? "").slice(0, 60) : null,
      };
    })
    // A path present in one sample out of fifty is noise, not a field. Offering it as a column
    // produces a column that is empty for 98% of rows.
    .filter((f) => f.coverage >= 0.1)
    .sort((a, b) => b.coverage - a.coverage || a.path.localeCompare(b.path));
}

// ─────────────────────────────────────────────────────────────── list handling

/**
 * Coerce a cell value into a list for a per-item run.
 *
 * Accepts a real JSON array, or a delimited string, because a model asked for "a list of titles"
 * returns either depending on the day and the prompt. Being strict here would surface as sporadic
 * empty fan-outs that look like a model failure rather than a parsing choice.
 */
export function toList(value: unknown): unknown[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return [];
    if (s.startsWith("[")) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed;
      } catch { /* fall through to delimiter splitting */ }
    }
    // Newlines first: a model listing items usually uses them, and a line may itself contain commas.
    if (s.includes("\n")) return s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (s.includes(";")) return s.split(";").map((x) => x.trim()).filter(Boolean);
    if (s.includes(",")) return s.split(",").map((x) => x.trim()).filter(Boolean);
    return [s];
  }
  if (typeof value === "object") return [value];
  return [value];
}

/** Collapse many values back into one cell, when they are not being written to another table. */
export function aggregate(values: unknown[], how: string | null | undefined): unknown {
  const present = values.filter((v) => v != null);
  switch (how) {
    case "first": return present[0] ?? null;
    case "count": return present.length;
    case "sum":   return present.reduce((a: number, v) => a + (Number(v) || 0), 0);
    case "min":   return present.length ? Math.min(...present.map((v) => Number(v)).filter(Number.isFinite)) : null;
    case "max":   return present.length ? Math.max(...present.map((v) => Number(v)).filter(Number.isFinite)) : null;
    case "join":  return present.map((v) => toText(v)).filter(Boolean).join(", ");
    // Default keeps the full list rather than silently dropping data — the user picks how to
    // collapse it, and until they do, nothing is lost.
    default:      return present;
  }
}
