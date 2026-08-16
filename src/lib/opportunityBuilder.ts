// Turning what we researched into what is holding the business back.
//
// THE INVERSION, in one file.
//
// diagnostic.ts still does the looking — it reads the listing, the crawl, the
// reviews, the map rank, and what a caller heard on the phone. All of that
// research is good and none of it is thrown away. What changes is the shape it
// comes out in.
//
// A Finding says "service: ai_receptionist, weight 0.8". An Opportunity says
// "the contact stage is leaking: demand is reaching you and stopping before it
// becomes a booking — and here is the evidence, here is what we are inferring
// rather than asserting, here is what only you can confirm, and here are the
// several ways it could be fixed, of which a reception system is one."
//
// Same underlying observation. Completely different thing to receive.

import {
  JOURNEY_STAGES,
  type Opportunity,
  type RankInputs,
  type JourneyStage,
  type SourceType,
  type Confidence,
} from "./opportunityModel";
import type { Finding, ServiceLine, DiagnosticInput } from "./diagnostic";

/* -------------------------------------------------------------------------- */
/* where each old service line actually leaks                                 */
/* -------------------------------------------------------------------------- */

/**
 * A product is not a problem. This maps each old ServiceLine to the stage of
 * the journey it was really a symptom of, so the finding can be re-expressed
 * as a constraint and ranked against constraints found any other way.
 */
const SERVICE_STAGE: Record<ServiceLine, JourneyStage> = {
  ai_receptionist: "contact",
  local_seo: "discovery",
  website_build: "evaluation",
  reputation: "review",
  booking: "booking",
  mobile_fix: "evaluation",
};

/**
 * The several ways each constraint could be answered.
 *
 * More than one on purpose. A single suggestion is a product recommendation
 * wearing a diagnosis; showing three makes it plain that the finding came
 * first and the response is a choice — which is both more honest and more
 * convincing.
 */
const SOLUTIONS: Record<JourneyStage, string[]> = {
  demand: [
    "Work out which services actually bring in the profitable jobs",
    "Reach the neighbourhoods and job types that pay best",
    "Stop spending on demand that never converts",
  ],
  discovery: [
    "Fix how the business appears when somebody searches for this trade locally",
    "Make the listing answer the questions buyers actually ask",
    "Understand which competitors are being chosen instead, and why",
  ],
  evaluation: [
    "Give people enough to decide without having to ring first",
    "Show proof of the work in the form buyers look for",
    "Remove whatever is making people hesitate before they get in touch",
  ],
  contact: [
    "Capture the enquiries that arrive when nobody can pick up",
    "Answer common questions without a person having to",
    "Route urgent work to a human immediately and everything else in order",
  ],
  qualification: [
    "Sort the work worth doing from the work that wastes a van",
    "Ask the qualifying questions before the diary is committed",
    "Send the wrong-fit enquiries somewhere useful instead of ignoring them",
  ],
  booking: [
    "Let people book without a phone call when the job is straightforward",
    "Chase estimates that were sent and never answered",
    "Take the friction out of confirming a slot",
  ],
  fulfilment: [
    "Reduce how much of the work only the owner can do",
    "Make the day's schedule visible to everyone who needs it",
    "Cut the back-and-forth between the office and the van",
  ],
  payment: [
    "Get invoices out the day the work is done",
    "Chase what is outstanding without anybody having to remember",
    "Understand which jobs actually make money",
  ],
  review: [
    "Ask for reviews at the moment people are most willing",
    "Answer the reviews that are costing work",
    "Learn what customers keep saying, and act on it",
  ],
  retention: [
    "Bring back customers who have not been seen in a while",
    "Turn one-off jobs into planned, recurring work",
    "Stay in front of past customers without nagging them",
  ],
  visibility: [
    "See what is actually happening week to week, without building a spreadsheet",
    "Know which work and which sources produce the money",
    "Get told when something is going wrong rather than finding out later",
  ],
};

/** What we can build privately, per stage, without touching their systems. */
const DEMOS: Partial<Record<JourneyStage, string>> = {
  contact: "A missed-enquiry capture and qualification example, built on your public details",
  discovery: "A competitor and local-search picture for your trade and area",
  evaluation: "A customer-journey prototype using your own services and reviews",
  booking: "An estimate follow-up and recovery workflow",
  review: "A review and customer-language analysis of what people already say about you",
  retention: "A dormant-customer reactivation example",
  visibility: "An operating dashboard sketched from the information you already produce",
  qualification: "An intake and qualification workflow for the enquiries you get",
  fulfilment: "An owner-dependency map showing what could run without you",
  payment: "A margin and decision-support view",
};

/* -------------------------------------------------------------------------- */
/* the conversion                                                             */
/* -------------------------------------------------------------------------- */

function confidenceFor(weight: number, hasOwnerWord: boolean): Confidence {
  if (hasOwnerWord) return "high";
  if (weight >= 0.7) return "high";
  if (weight >= 0.4) return "medium";
  return "low";
}

function sourceFor(basis: string[]): SourceType {
  const b = basis.join(" ").toLowerCase();
  if (b.includes("answering") || b.includes("caller") || b.includes("call")) return "call_notes";
  if (b.includes("review") || b.includes("rating")) return "reviews";
  if (b.includes("rank") || b.includes("map")) return "search_results";
  if (b.includes("site") || b.includes("website")) return "website";
  return "google_listing";
}

/**
 * How specific this finding is to THIS company rather than any company.
 *
 * The number that stops a generic recommendation leading the page. "No
 * website" is true of thousands of businesses and scores low however confident
 * it is; "your listing ranks eleventh for your own trade in your own city
 * while carrying more reviews than the three above you" is about one company
 * and scores high.
 */
function specificityOf(f: Finding, input: DiagnosticInput): number {
  let s = 0.25;
  const basis = f.basis.join(" ").toLowerCase();
  // A number drawn from their own record is specific by definition.
  if (basis.includes("rank") && typeof input.mapRank === "number") s += 0.3;
  if (basis.includes("review") && typeof input.reviewCount === "number") s += 0.2;
  if (basis.includes("rating") && typeof input.rating === "number") s += 0.15;
  // Something the owner said on the phone is the most specific evidence there is.
  if (basis.includes("answering") || basis.includes("provider")) s += 0.4;
  // A crawl of their actual site beats a sector assumption.
  if (basis.includes("site")) s += 0.2;
  return Math.min(1, s);
}

/** How unlikely they are to have been told this before. */
function distinctivenessOf(f: Finding): number {
  // The four things every agency opens with. True or not, they have heard them.
  const familiar: ServiceLine[] = ["website_build", "local_seo", "reputation", "mobile_fix"];
  return familiar.includes(f.service) ? 0.2 : 0.7;
}

const IMPORTANCE: Record<JourneyStage, number> = {
  contact: 0.95,
  booking: 0.9,
  qualification: 0.75,
  retention: 0.8,
  evaluation: 0.65,
  discovery: 0.6,
  review: 0.55,
  visibility: 0.7,
  fulfilment: 0.7,
  payment: 0.6,
  demand: 0.6,
};

export type BuiltOpportunity = Opportunity & { rank: RankInputs };

/**
 * Re-express a researched finding as a constraint.
 *
 * The old `talkTrack` is carried into `internalNote` — it was always
 * caller-only, and stripInternal keeps it that way.
 */
export function opportunityFromFinding(
  f: Finding,
  input: DiagnosticInput,
  now: Date = new Date()
): BuiltOpportunity {
  const stage = SERVICE_STAGE[f.service] ?? "contact";
  const ownerSaid = f.basis.some((b) => /answering|provider|caller/i.test(b));
  const confidence = confidenceFor(f.weight, ownerSaid);
  const where = [input.city, input.state].filter(Boolean).join(", ");

  /*
   * Known versus inferred, split at the source.
   *
   * `basis` names the fields the finding was computed from, so anything traced
   * to a real field is a fact and everything else — the consequence, the
   * "this probably means" — is explicitly an inference.
   */
  const knownFacts: string[] = [];
  if (f.basis.length > 0) {
    knownFacts.push(f.headline);
  }
  if (typeof input.rating === "number" && /rating/i.test(f.basis.join(" "))) {
    knownFacts.push(`Your public rating is ${input.rating}.`);
  }
  if (typeof input.reviewCount === "number" && /review/i.test(f.basis.join(" "))) {
    knownFacts.push(`You have ${input.reviewCount} public reviews.`);
  }
  if (typeof input.mapRank === "number" && /rank|map/i.test(f.basis.join(" "))) {
    knownFacts.push(
      `You appear at position ${input.mapRank} for your trade${where ? ` in ${where}` : ""}.`
    );
  }

  return {
    id: f.key,
    stage,
    category: f.service,
    title: f.headline,
    summary: f.detail,
    evidence: f.basis.join(", "),
    sourceType: sourceFor(f.basis),
    sourceDetail: where || null,
    observedAt: now.toISOString(),

    knownFacts,
    inferences: [
      // Deliberately hedged. This is the consequence we are reasoning to, not
      // something we watched happen.
      `${f.detail} We are reading that from the outside, so it is a reasonable reading rather than something we have measured.`,
    ],
    needsConfirmation: [
      "Whether this matches what you actually see day to day",
      "How often it happens, and what it costs you when it does",
    ],
    wouldVerifyNext: [
      "Ask you for the handful of internal numbers that would turn this from a reading into a measurement",
    ],

    confidence,
    potentialEffect: null,

    demonstrable: !!DEMOS[stage],
    demoLabel: DEMOS[stage] ?? null,
    solutionDirections: SOLUTIONS[stage] ?? [],
    customBuildPotential: null,

    priority: "supporting",
    internalNote: f.talkTrack,

    rank: {
      confidence,
      importance: IMPORTANCE[stage] ?? 0.6,
      specificity: specificityOf(f, input),
      distinctiveness: distinctivenessOf(f),
      demonstrable: !!DEMOS[stage],
      solvability: 0.7,
      customBuild: !["website_build", "mobile_fix"].includes(f.service),
    },
  };
}

/** Every finding, re-expressed. Ranking happens separately. */
export function opportunitiesFromFindings(
  findings: Finding[],
  input: DiagnosticInput,
  now: Date = new Date()
): BuiltOpportunity[] {
  return findings.map((f) => opportunityFromFinding(f, input, now));
}

/** Exported for tests and for the admin preview. */
export const STAGE_SOLUTIONS = SOLUTIONS;
export const STAGE_DEMOS = DEMOS;
export { JOURNEY_STAGES };
