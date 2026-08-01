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
