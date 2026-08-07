// Turning a stored value into what a person reads.
//
// The engine stores currency and percent as PLAIN NUMBERS — `coerce` strips the "$" and the "%" so
// the column sorts and filters numerically (see the number case in executor.ts). That is correct for
// the data and wrong for the eye: a currency column showed "29" instead of "$29.00" and a percent
// column showed "29" instead of "29%", which makes the type barely different from `number`. This is
// the display half the schema always intended — `columns.format` "carries the type's descriptor:
// currency code, decimals" and, until now, nothing read it.
//
// DISPLAY ONLY. It never changes what is stored, sorted, filtered, or copied — editing a cell shows
// the raw number, and the clipboard copies the raw number, so a formatted value pastes back into a
// spreadsheet as a number rather than as "$29.00". Formatting is the last step before the pixels and
// nowhere else.

import type { ValueType } from "./types.ts";

/**
 * A column's presentation descriptor, stored as JSON in `columns.format`.
 *
 * Everything optional: a currency column with no descriptor is still shown better than a bare number
 * (grouped, two decimals), and only GAINS a symbol once a code is chosen. That ordering is
 * deliberate — defaulting the symbol to "$" would print "$29" over a column of euros, which is worse
 * than printing "29".
 */
export interface ValueFormat {
  /** ISO 4217 code for a currency column, e.g. "USD". Absent → a grouped decimal with no symbol. */
  currency?: string;
  /** Fixed decimal places. Absent → the number's natural precision. */
  decimals?: number;
}

/** Clamp a decimals value to something Intl will accept, or undefined when not set. */
function decimalsOf(fmt: ValueFormat | null | undefined): number | undefined {
  const d = fmt?.decimals;
  if (d == null || !Number.isFinite(d)) return undefined;
  return Math.max(0, Math.min(10, Math.floor(d)));
}

/**
 * The value a person sees for a cell.
 *
 * Only `currency` and `percent` are transformed; every other type is returned unchanged, because its
 * stored form already IS its display form (a URL, an email, an ISO date that sorts lexically). An
 * unparseable value is never hidden — a currency cell that somehow holds "n/a" shows "n/a", not a
 * blank, because dropping a value the user can see is worse than an unformatted one.
 */
export function formatDisplay(raw: string | null | undefined, type: ValueType, fmt?: ValueFormat | null): string {
  if (raw == null || raw === "") return "";

  if (type === "currency") {
    const n = Number(raw);
    if (!Number.isFinite(n)) return raw;
    const decimals = decimalsOf(fmt) ?? 2;
    const code = fmt?.currency?.trim();
    if (code) {
      try {
        return new Intl.NumberFormat(undefined, {
          style: "currency", currency: code,
          minimumFractionDigits: decimals, maximumFractionDigits: decimals,
        }).format(n);
      } catch {
        // A code Intl does not recognise falls through to a grouped decimal rather than throwing —
        // the value still shows, just without a symbol.
      }
    }
    return new Intl.NumberFormat(undefined, {
      minimumFractionDigits: decimals, maximumFractionDigits: decimals,
    }).format(n);
  }

  if (type === "percent") {
    const n = Number(raw);
    if (!Number.isFinite(n)) return raw;
    // Percentage POINTS — the engine stores 29 for "29%", so the display appends the sign rather than
    // multiplying by 100. `toLocaleString` for grouping on large percentages, natural precision when
    // no decimals are configured.
    const d = decimalsOf(fmt);
    const body = d != null
      ? n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
      : n.toLocaleString(undefined, { maximumFractionDigits: 10 });
    return `${body}%`;
  }

  return raw;
}

/**
 * Clean a submitted format descriptor. Kept beside the formatter so the rule that STORES a descriptor
 * and the rule that READS it cannot drift. Returns `null` to store nothing (the column falls back to
 * the safe defaults above) rather than an empty object.
 */
export function normalizeFormat(input: unknown): ValueFormat | null {
  if (input == null || typeof input !== "object") return null;
  const src = input as Record<string, unknown>;
  const out: ValueFormat = {};

  if (typeof src.currency === "string") {
    // A 3-letter ISO code, upper-cased. Anything else is dropped rather than stored to fail later in
    // Intl — an unknown code just means "no symbol", which the formatter already handles.
    const code = src.currency.trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(code)) out.currency = code;
  }
  if (src.decimals != null && Number.isFinite(Number(src.decimals))) {
    out.decimals = Math.max(0, Math.min(10, Math.floor(Number(src.decimals))));
  }

  return Object.keys(out).length ? out : null;
}
