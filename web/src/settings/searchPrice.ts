// Formatting a per-search price.
//
// Its own file so it can be tested. Search.tsx imports CSS, which the test runner cannot load, and
// this is precisely the code that must not be checked by eye: every figure here is between $0.0001
// and $0.01, where one wrong character is a factor of ten and every rendering looks plausible.
// The first version of this shipped with a regex that turned $0.005 into "0.00" — visible in a
// browser, invisible in a diff.

/**
 * Enough places to be exact, no trailing zeros.
 *
 * A fixed five places prints "$0.00500", which reads as noise beside "$0.005". Rounding to two, the
 * obvious alternative, prints "$0.01" for a $0.005 search and "$0.00" for a $0.001 one — collapsing
 * the entire range this screen exists to compare.
 */
export function price(n: number | null): string {
  if (n == null) return "price not set";
  if (n === 0) return "free";
  // Six places covers the cheapest engine here ($0.00035) with room to spare.
  const fixed = n.toFixed(6);
  const trimmed = fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
  return `$${trimmed}`;
}

/**
 * The same rate as a total for a million rows.
 *
 * The number that actually decides anything. "$0.005" and "$0.001" look like the same tiny amount
 * until they are "$5,000" and "$1,000", which is the comparison somebody is really making.
 */
export function perMillion(n: number | null): string | null {
  if (n == null) return null;
  if (n === 0) return "nothing";
  return `$${Math.round(n * 1_000_000).toLocaleString("en-US")}`;
}
