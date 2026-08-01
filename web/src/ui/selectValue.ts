// What a Select trigger displays, separated from the component so it can be tested.
//
// The .tsx imports its own CSS, which the test runner cannot load — the same reason httpConfig.ts
// sits beside HttpSettings.tsx.

import type { SelectOption } from "./Select.tsx";

/**
 * The option a Select should show for `value`.
 *
 * When nothing matches, it shows the VALUE, never the first option. Falling back to `options[0]`
 * meant a value whose list had not loaded yet was displayed as whatever happened to be first — and
 * on the run-model picker the first entry is "Let the engine choose", so a workspace pinned to a
 * local model reported itself as running on automatic. Not a blank, not an error: a different
 * setting, entirely plausible, while the hint underneath correctly named the model it was really
 * running on.
 *
 * An empty value still falls back, because "" is how a picker spells "nothing chosen" and an empty
 * trigger says less than the first option does.
 */
export function resolveSelected<T extends string>(
  options: ReadonlyArray<SelectOption<T>>,
  value: T,
): SelectOption<T> | undefined {
  const match = options.find((o) => o.value === value);
  if (match) return match;
  return value ? { value, label: value } : options[0];
}

/**
 * Does this option match a search query?
 *
 * Every word must appear, in the label or the value, in any order. The whole query used to be one
 * substring, so `free nemotron 3 ultra` matched nothing while `NVIDIA: Nemotron 3 Ultra (free)` sat
 * in the list. Label and value are searched as one string, so "google flash" finds a model whose
 * family is in the id and whose variant is in the label.
 */
export function matchesQuery<T extends string>(o: { label: string; value: T }, q: string): boolean {
  if (!q) return true;
  const hay = `${o.label} ${String(o.value)}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}
