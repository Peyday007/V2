// Where a lead has got to in enrichment, said explicitly.
//
// The old pipeline had one bit of information — enriched or not — and quietly
// turned "we found nothing" into "ready for calling". Every failure below is a
// named, visible, retryable state instead, because the failure mode that
// actually cost money was an incomplete record silently entering the queue.

export const ENRICHMENT_STATES = [
  "pending_owner_identification",
  "owner_identified",
  "pending_direct_number",
  "direct_number_found",
  "direct_number_validated",
  "call_ready",
  "no_owner_found",
  "no_direct_number",
  "ambiguous_match",
  "conflicting_information",
  "validation_failed",
  "provider_unavailable",
  "budget_exceeded",
  "manual_review",
] as const;

export type EnrichmentState = (typeof ENRICHMENT_STATES)[number];

export const ENRICHMENT_STATE_LABEL: Record<EnrichmentState, string> = {
  pending_owner_identification: "Looking for the owner",
  owner_identified: "Owner identified",
  pending_direct_number: "Looking for a direct number",
  direct_number_found: "Direct number found",
  direct_number_validated: "Direct number validated",
  call_ready: "Call-ready",
  no_owner_found: "No owner found",
  no_direct_number: "No direct number found",
  ambiguous_match: "Ambiguous match",
  conflicting_information: "Conflicting information",
  validation_failed: "Validation failed",
  provider_unavailable: "Provider unavailable",
  budget_exceeded: "Enrichment budget exceeded",
  manual_review: "Needs manual review",
};

/** States where the engine is still working. Not failures. */
export const IN_PROGRESS: EnrichmentState[] = [
  "pending_owner_identification",
  "owner_identified",
  "pending_direct_number",
  "direct_number_found",
];

/**
 * States that stopped short. Every one stays visible and retryable — a failure
 * that disappears is a failure nobody fixes.
 */
export const STALLED: EnrichmentState[] = [
  "no_owner_found",
  "no_direct_number",
  "ambiguous_match",
  "conflicting_information",
  "validation_failed",
  "provider_unavailable",
  "budget_exceeded",
  "manual_review",
];

/** The only state that may enter the direct-call queue. */
export function isCallReadyState(s: EnrichmentState | null | undefined): boolean {
  return s === "call_ready";
}

/** Worth trying again, once the reason it stopped has changed. */
export function isRetryable(s: EnrichmentState | null | undefined): boolean {
  return !!s && STALLED.includes(s);
}

/** What a person should do about it, in words. */
export const STATE_NEXT_STEP: Record<EnrichmentState, string> = {
  pending_owner_identification: "Waiting on the public-source search.",
  owner_identified: "Waiting to look for a direct number.",
  pending_direct_number: "Waiting on a contact provider.",
  direct_number_found: "Waiting on validation.",
  direct_number_validated: "Waiting to be graded.",
  call_ready: "In the queue.",
  no_owner_found:
    "Nothing credible names a decision-maker. Usable for a main-line campaign, or research it by hand.",
  no_direct_number:
    "The owner is known but no direct number was found. Callable on the main line, asking for them by name.",
  ambiguous_match:
    "Two or more people were claimed and none could be tied to this business. Needs a human eye.",
  conflicting_information: "Sources disagree. Nothing is asserted until somebody resolves it.",
  validation_failed: "A number was returned but did not survive validation.",
  provider_unavailable: "No contact provider was configured. Add one and re-run.",
  budget_exceeded: "The enrichment budget stopped this one. It will resume next period.",
  manual_review: "Flagged for a person to look at.",
};

/* -------------------------------------------------------------------------- */
/* the transition                                                             */
/* -------------------------------------------------------------------------- */

export type StageOutcome = {
  ownerIdentified: boolean;
  ambiguous: boolean;
  conflicting: boolean;
  directNumberFound: boolean;
  numberValidated: boolean;
  providerAvailable: boolean;
  budgetStopped: boolean;
};

/**
 * The single place a lead's enrichment state is decided.
 *
 * Order matters: budget and provider availability are reported ahead of "no
 * number found", because those are fixable configuration rather than a fact
 * about the business, and confusing the two sends someone hunting for a lead
 * problem that does not exist.
 */
export function nextState(o: StageOutcome): EnrichmentState {
  if (o.conflicting) return "conflicting_information";
  if (o.ambiguous) return "ambiguous_match";
  if (!o.ownerIdentified) return "no_owner_found";

  if (o.budgetStopped) return "budget_exceeded";
  if (!o.providerAvailable) return "provider_unavailable";

  if (!o.directNumberFound) return "no_direct_number";
  if (!o.numberValidated) return "validation_failed";
  return "call_ready";
}
