// Where "ask for help" goes.
//
// Its own file, away from the component, for the reason `selectValue.ts` and `commandMatch.ts` are:
// a test that imports a `.tsx` pulls its stylesheet in with it, and Node cannot load a `.css`. Pure
// logic tested on its own is also the only part of this worth testing.

/** Country code and number, as a person would write it. Formatting is stripped below. */
export const SUPPORT_NUMBER = "+91 98441 90125";

/** Pre-filled so the first message says which app it is about, rather than "hi". */
export const SUPPORT_GREETING = "Hi — I have a question about Ferrum.";

/**
 * The chat link.
 *
 * `wa.me` takes DIGITS ONLY. Give it a `+`, a space or a dash and it does not error — it opens a
 * page saying the number is invalid. So a link built from a formatted number renders correctly,
 * clicks correctly and goes nowhere, and the only person who finds out is the one who never
 * arrives. Stripping here rather than storing a bare digit string keeps the constant above legible
 * to whoever has to check it against a phone.
 */
export function supportLink(number = SUPPORT_NUMBER, text = SUPPORT_GREETING): string {
  return `https://wa.me/${number.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;
}
