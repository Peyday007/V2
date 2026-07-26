/**
 * How many Google Places requests a target lead count needs.
 *
 * Each request returns at most 20 businesses, and overlapping searches plus
 * qualification failures mean net-new yield is well below that. Budget on
 * ~6 net-new per request, with a floor so tiny campaigns still work and a
 * hard ceiling so a typo can never authorize runaway spend.
 */
export function requestBudgetFor(targetLeads: number): number {
  const target = Number.isFinite(targetLeads) ? targetLeads : 0;
  return Math.min(400, Math.max(5, Math.ceil(target / 6)));
}
