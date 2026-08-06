// Why a run cannot be costed, and what that should DO.
//
// There are two reasons the estimate can come back without a figure, they need opposite handling, and
// the dialog used to collapse them into one:
//
//   1. A column points at a model the published list does not contain. That model is gone — providers
//      retire ids routinely — so every row of that run would fail. Refuse it, and say which column to
//      change.
//   2. The price list itself could not be read: no key configured yet, or the provider briefly down.
//      Nothing is known to be wrong with the column. Refusing here means no paid run can start at all
//      while a third party has a bad five minutes, and the advice on screen — "pick a model with a
//      price" — is impossible to follow, because in this state no model has one.
//
// The engine has always computed the difference (`catalogueReachable` in src/estimate.ts, whose own
// comment says case 2 must not block). It simply never sent it. This is where it gets used.
//
// Case 2 is not waved through either. The run proceeds WITHOUT a cost estimate, which is a thing the
// person pressing the button should have to notice, so it takes the type-it-out gate the dialog
// already uses for an expensive run.

export interface PricingInput {
  columns: Array<{ unpriced?: boolean }>;
  incomplete: boolean;
  /** Absent on an older engine, and read as reachable — the behaviour that preceded the field. */
  catalogueReachable?: boolean;
}

export interface PricingVerdict {
  /** Nothing could be priced, either way. The figure shown is "unknown" rather than a false $0. */
  unpriced: boolean;
  /** Refuse the run: a column names a model that has no price. Fixable, and only by the user. */
  blocked: boolean;
  /** Let it run, unestimated, behind a typed confirmation: the price list could not be read. */
  unknownCatalogue: boolean;
}

export function pricingVerdict(cost: PricingInput | null | undefined): PricingVerdict {
  if (!cost) return { unpriced: false, blocked: false, unknownCatalogue: false };

  // Both signals are read, not just the per-column flag, so a future estimate that sets one without
  // the other still fails closed rather than quietly pricing a run at zero.
  const unpriced = cost.columns.some((c) => c.unpriced) || cost.incomplete;
  if (!unpriced) return { unpriced: false, blocked: false, unknownCatalogue: false };

  const reachable = cost.catalogueReachable !== false;
  return { unpriced: true, blocked: reachable, unknownCatalogue: !reachable };
}
