// The contrast guarantee, enforced rather than asserted in a comment.
//
// A review measured the grid's row numbers at 2.19:1 and a skipped cell's label at 4.32:1 — both
// under the 4.5:1 that text this size needs, in both themes. The values were fixed; nothing stopped
// the next nudge from undoing it, because a colour token is a string and a string always compiles.
//
// So this reads the real stylesheet and computes the real ratios. It is deliberately a test of
// tokens.css itself, not of a component: the token layer is where the guarantee has to hold, and
// every surface below it inherits whatever this file says.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "tokens.css"), "utf8");

/** The declarations inside one rule, as a map. Blocks in this file have no nested braces. */
function block(selector: string): Map<string, string> {
  const at = css.indexOf(selector);
  assert.notEqual(at, -1, `tokens.css no longer contains "${selector}"`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  const out = new Map<string, string>();
  for (const m of css.slice(open + 1, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

const LIGHT = block(":root {");
// The dark override only restates what changes, so anything it omits comes from the light block.
const DARK = new Map([...LIGHT, ...block(':root[data-theme="dark"]')]);

function value(theme: Map<string, string>, name: string): string {
  const v = theme.get(name);
  assert.ok(v, `${name} is not defined`);
  return v;
}

// ── WCAG 2.1 relative luminance ──────────────────────────────────

function rgb(colour: string): [number, number, number] {
  const hex = colour.trim().replace("#", "");
  assert.match(hex, /^[0-9a-f]{6}$/i, `${colour} is not a six-digit hex colour`);
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(colour: string): number {
  const [r, g, b] = rgb(colour).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** `rgba(r, g, b, a)` painted over an opaque colour, as the browser composites it. */
function composite(band: string, bg: string): string {
  const m = band.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/);
  assert.ok(m, `${band} is not an rgba() colour`);
  const alpha = m[4] === undefined ? 1 : Number(m[4]);
  const over = rgb(bg);
  return (
    "#" +
    [Number(m[1]), Number(m[2]), Number(m[3])]
      .map((c, i) => Math.round(c * alpha + over[i]! * (1 - alpha)).toString(16).padStart(2, "0"))
      .join("")
  );
}

// ── the matrix ───────────────────────────────────────────────────

/** Tokens used for CONTENT. --ink-faint is not here on purpose: it is documented as placeholder and
 *  decoration only, and the fix for the finding was to stop using it for content, not to raise it. */
const INK = ["--ink", "--ink-secondary", "--ink-mute", "--ink-mute-2"];

/**
 * Every RESTING surface a label can land on.
 *
 * `--control-active` is excluded, and the reason is worth stating: it is the sub-200ms background of
 * a row being pressed, and the only value that would clear 4.5:1 on it lands within one step of
 * --ink-mute — which would collapse the two mute levels into the same grey and cost the distinction
 * they exist for. Everything a reader actually reads text on is here.
 */
const SURFACES = [
  "--canvas",
  "--canvas-soft",
  "--canvas-sunk",
  "--grid-header-bg",
  "--grid-gutter-bg",
  "--row-hover",
  "--control-hover",
  "--row-selected",
];

/**
 * The soft status bands that actually sit BEHIND muted text, painted over a surface rather than
 * replacing it. Grounded in what Cell.css paints and what Cell.tsx renders on top of it: a queued,
 * running, blocked or skipped cell shows a `.cc-cell__meta` label in --ink-mute-2 over its band.
 *
 * --band-error is not here because an error cell renders `.cc-cell__err` in a solid status colour
 * instead, and --band-done / --band-preview never appear behind a grid cell at all. Listing them
 * would be testing a composite nothing renders — and it constrains --ink-mute-2 hard enough to
 * collapse it into --ink-mute, which costs a real distinction to guard an imaginary surface.
 */
const BANDS = ["--band-queued", "--band-running", "--band-skipped"];

for (const [name, theme] of [["light", LIGHT], ["dark", DARK]] as const) {
  test(`${name}: every content ink token clears AA on every resting surface`, () => {
    for (const ink of INK) {
      for (const surface of SURFACES) {
        const ratio = contrast(value(theme, ink), value(theme, surface));
        assert.ok(
          ratio >= 4.5,
          `${ink} on ${surface} is ${ratio.toFixed(2)}:1 in the ${name} theme — AA needs 4.5:1`,
        );
      }
    }
  });

  test(`${name}: a status band over a hovered row does not push a label under AA`, () => {
    // The exact case the review caught: a Skipped cell carries --band-skipped, and the row under it
    // is hovered, so the label is reading through two layers rather than one.
    for (const band of BANDS) {
      for (const under of ["--canvas", "--row-hover"]) {
        const bg = composite(value(theme, band), value(theme, under));
        for (const ink of INK) {
          const ratio = contrast(value(theme, ink), bg);
          assert.ok(
            ratio >= 4.5,
            `${ink} on ${band} over ${under} is ${ratio.toFixed(2)}:1 in the ${name} theme — AA needs 4.5:1`,
          );
        }
      }
    }
  });
}

test("--ink-faint stays labelled as decoration, so nobody reaches for it as a content colour", () => {
  // It is genuinely below AA by design — the guard is the comment beside it, and this fails if that
  // comment is ever quietly deleted while the token stays in the file.
  assert.match(css, /--ink-faint:[^;]+;\s*\/\*[^*]*ONLY[^*]*\*\//);
  assert.ok(
    contrast(value(LIGHT, "--ink-faint"), value(LIGHT, "--canvas")) < 4.5,
    "--ink-faint now passes AA — either promote it in the comment or fold it into --ink-mute-2",
  );
});

test("the focus ring clears the 3:1 that WCAG 1.4.11 asks of a non-text indicator", () => {
  // A dozen rules across the app set `outline: none` and lean on this alone, so a ring nobody can
  // see is the same as no focus indicator at all.
  for (const [name, theme] of [["light", LIGHT], ["dark", DARK]] as const) {
    const ring = value(theme, "--focus-ring");
    for (const surface of ["--canvas", "--canvas-soft", "--grid-header-bg"]) {
      const over = value(theme, surface);
      const ratio = contrast(composite(ring, over), over);
      assert.ok(ratio >= 3, `--focus-ring on ${surface} is ${ratio.toFixed(2)}:1 in ${name} — needs 3:1`);
    }
  }
});
