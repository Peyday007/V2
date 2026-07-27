/**
 * How many Google Places requests a target lead count needs.
 *
 * The target is a number of CALLABLE leads. Getting there costs more requests
 * than it looks: each request returns at most 20 businesses, overlapping
 * searches repeat a lot of them, and roughly half of what survives is then
 * discarded as too big, unreachable or closed.
 *
 * Budget on ~3 net-new callable leads per request, with a floor so tiny
 * campaigns still work and a hard ceiling so a typo can never authorize
 * runaway spend. At current Places pricing the ceiling is a few dollars.
 */
export const CALLABLE_LEADS_PER_REQUEST = 3;
export const MIN_REQUESTS = 5;
export const MAX_REQUESTS = 400;

export function requestBudgetFor(targetLeads: number): number {
  const target = Number.isFinite(targetLeads) ? targetLeads : 0;
  return Math.min(
    MAX_REQUESTS,
    Math.max(MIN_REQUESTS, Math.ceil(target / CALLABLE_LEADS_PER_REQUEST))
  );
}
