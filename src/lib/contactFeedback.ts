// What the caller found out, fed back into the data.
//
// A caller who dialled the number is the best evidence there is about whether
// it was right — better than any provider's confidence score, because they
// actually tried it. So the feedback does three things: corrects this lead,
// suppresses data known to be wrong, and shifts which provider gets tried
// first next time.
//
// One asymmetry, deliberately: confirmation raises confidence a little,
// contradiction drops it a lot. Being told "wrong number" is near-certain;
// being told "right person" could be a caller ticking the easy box.

import { MIN_DM_CONFIDENCE } from "./decisionMaker";
import type { PhoneClass } from "./phoneIntel";

export const CONTACT_OUTCOMES = [
  "correct_owner_reached",
  "wrong_person",
  "wrong_number",
  "disconnected",
  "main_line_not_direct",
  "gatekeeper_reached",
  "owner_no_longer_there",
  "owner_declined",
  "appointment_booked",
] as const;

export type ContactOutcome = (typeof CONTACT_OUTCOMES)[number];

export const CONTACT_OUTCOME_LABEL: Record<ContactOutcome, string> = {
  correct_owner_reached: "Reached the right owner",
  wrong_person: "Wrong person",
  wrong_number: "Wrong number",
  disconnected: "Number disconnected",
  main_line_not_direct: "It was the main line, not a direct number",
  gatekeeper_reached: "Reached a gatekeeper",
  owner_no_longer_there: "Owner no longer with the business",
  owner_declined: "Owner declined",
  appointment_booked: "Appointment booked",
};

/** Outcomes that prove the enrichment was right. */
export const CONFIRMING: ContactOutcome[] = [
  "correct_owner_reached",
  "appointment_booked",
  // A refusal from the right person still confirms we found the right person.
  "owner_declined",
];

/** Outcomes that prove the data is wrong and must stop being handed out. */
export const CONTRADICTING: ContactOutcome[] = [
  "wrong_person",
  "wrong_number",
  "disconnected",
  "main_line_not_direct",
  "owner_no_longer_there",
];

export type FeedbackEffect = {
  /** Multiply the stored decision-maker confidence by this. */
  confidenceMultiplier: number;
  /** Stop offering this number as a direct line. */
  suppressPhone: boolean;
  /** Stop asserting this person is the decision-maker. */
  suppressDecisionMaker: boolean;
  /** The number was real but not a direct line. */
  reclassifyAs: PhoneClass | null;
  /** Queue this lead for another enrichment pass. */
  requeue: boolean;
  /** Counts for or against the provider that supplied it. */
  providerCredit: 1 | 0 | -1;
  explanation: string;
};

export function effectOf(outcome: ContactOutcome): FeedbackEffect {
  switch (outcome) {
    case "correct_owner_reached":
    case "appointment_booked":
      return {
        confidenceMultiplier: 1.1,
        suppressPhone: false,
        suppressDecisionMaker: false,
        reclassifyAs: null,
        requeue: false,
        providerCredit: 1,
        explanation: "The number reached the person it was supposed to.",
      };

    case "owner_declined":
      return {
        confidenceMultiplier: 1.1,
        suppressPhone: false,
        suppressDecisionMaker: false,
        reclassifyAs: null,
        requeue: false,
        providerCredit: 1,
        explanation: "The right person answered and said no — the data was correct.",
      };

    case "gatekeeper_reached":
      // Neutral. Reaching reception on a direct line is disappointing but says
      // nothing conclusive about whose number it is.
      return {
        confidenceMultiplier: 1,
        suppressPhone: false,
        suppressDecisionMaker: false,
        reclassifyAs: null,
        requeue: false,
        providerCredit: 0,
        explanation: "A gatekeeper answered. Not proof either way.",
      };

    case "main_line_not_direct":
      return {
        confidenceMultiplier: 0.8,
        suppressPhone: true,
        suppressDecisionMaker: false,
        reclassifyAs: "main_business_line",
        requeue: true,
        providerCredit: -1,
        explanation:
          "The provider sold back the switchboard. The number is reclassified and the lead re-enriched.",
      };

    case "wrong_person":
      return {
        confidenceMultiplier: 0.3,
        suppressPhone: true,
        suppressDecisionMaker: true,
        reclassifyAs: null,
        requeue: true,
        providerCredit: -1,
        explanation: "Someone else answered — both the name and the number are in doubt.",
      };

    case "wrong_number":
    case "disconnected":
      return {
        confidenceMultiplier: 0.5,
        suppressPhone: true,
        suppressDecisionMaker: false,
        reclassifyAs: null,
        requeue: true,
        providerCredit: -1,
        explanation: "The number does not work. The person may still be right.",
      };

    case "owner_no_longer_there":
      return {
        confidenceMultiplier: 0.2,
        suppressPhone: true,
        suppressDecisionMaker: true,
        reclassifyAs: null,
        requeue: true,
        providerCredit: -1,
        explanation: "They have left the business. Everything about this contact is stale.",
      };
  }
}

/** Apply the multiplier, and say when the result no longer supports a claim. */
export function correctedConfidence(
  current: number | null | undefined,
  outcome: ContactOutcome
): { confidence: number; stillAsserted: boolean } {
  const effect = effectOf(outcome);
  const next = Math.max(0, Math.min(0.98, (current ?? 0.5) * effect.confidenceMultiplier));
  return { confidence: next, stillAsserted: next >= MIN_DM_CONFIDENCE };
}

/* -------------------------------------------------------------------------- */
/* which provider to try first next time                                      */
/* -------------------------------------------------------------------------- */

export type ProviderTally = {
  provider: string;
  confirmed: number;
  contradicted: number;
  neutral: number;
};

/** Below this many judged calls, a provider's record is not used to rank it. */
export const MIN_CALLS_TO_RANK_PROVIDER = 20;

export type ProviderScore = {
  provider: string;
  judged: number;
  accuracy: number | null;
  verdict: string;
};

/**
 * A provider's accuracy, from calls that actually settled something.
 *
 * Withheld below the minimum, because reordering the waterfall — and therefore
 * the spend — off four calls is how a good provider gets dropped for a bad run.
 */
export function scoreProviders(tallies: ProviderTally[]): ProviderScore[] {
  return tallies
    .map((t) => {
      const judged = t.confirmed + t.contradicted;
      if (judged < MIN_CALLS_TO_RANK_PROVIDER) {
        return {
          provider: t.provider,
          judged,
          accuracy: null,
          verdict: `Only ${judged} calls have settled either way — too few to rank on.`,
        };
      }
      const accuracy = t.confirmed / judged;
      return {
        provider: t.provider,
        judged,
        accuracy,
        verdict: `${Math.round(accuracy * 100)}% of ${judged} judged calls reached the right person.`,
      };
    })
    .sort((a, b) => (b.accuracy ?? -1) - (a.accuracy ?? -1));
}
