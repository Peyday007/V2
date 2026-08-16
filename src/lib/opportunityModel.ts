// What is holding this business back.
//
// WHY THIS REPLACES THE OLD DIAGNOSTIC.
//
// diagnostic.ts classifies findings by ServiceLine — receptionist, website,
// SEO, reviews. The top-level type is the product, so every packet was
// structurally a list of things to sell, reordered. An owner reading four of
// them in a row can tell, however accurate each number is, and what they take
// from it is "this is a template" rather than "they looked at my business".
//
// Here the top-level classification is the JOURNEY STAGE where the business
// leaks. A product appears only underneath, as one of several possible
// responses to a diagnosed constraint. That single inversion is the whole
// change: "you have no website" becomes "demand is reaching you and stopping
// before it converts, and here is where", and a website is then one answer
// among several rather than the finding itself.
//
// Pure. No database, no network, no model call — so the ranking, and more
// importantly the rules about what may never be claimed, are testable.

/* -------------------------------------------------------------------------- */
/* where a business leaks                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The eleven stages a customer passes through, in order.
 *
 * Deliberately not a product taxonomy. Every finding attaches to the place in
 * the journey where value is escaping, which is what makes two findings
 * comparable: "estimates are not recovered" and "no website" are both
 * conversion-stage problems and can be ranked against each other on evidence
 * and consequence rather than on which service line they belong to.
 */
export const JOURNEY_STAGES = [
  "demand",
  "discovery",
  "evaluation",
  "contact",
  "qualification",
  "booking",
  "fulfilment",
  "payment",
  "review",
  "retention",
  "visibility",
] as const;
export type JourneyStage = (typeof JOURNEY_STAGES)[number];

export const STAGE_LABEL: Record<JourneyStage, string> = {
  demand: "Demand",
  discovery: "Being found",
  evaluation: "Being chosen",
  contact: "Getting in touch",
  qualification: "Sorting good work from bad",
  booking: "Booking and estimates",
  fulfilment: "Doing the work",
  payment: "Getting paid",
  review: "Reputation",
  retention: "Repeat business",
  visibility: "Knowing what is happening",
};

export type Confidence = "low" | "medium" | "high";
export type Priority = "primary" | "supporting" | "context";

/**
 * Where a claim came from. Drives the wording on the public page — an owner is
 * owed the difference between "your listing says this" and "businesses like
 * yours usually".
 */
export type SourceType =
  | "google_listing"
  | "website"
  | "reviews"
  | "search_results"
  | "call_notes"
  | "owner_reported"
  | "sector_pattern";

export const SOURCE_LABEL: Record<SourceType, string> = {
  google_listing: "Your Google listing",
  website: "Your website",
  reviews: "Your public reviews",
  search_results: "Search results in your area",
  call_notes: "What you told us on the phone",
  owner_reported: "What you told us in the questionnaire",
  sector_pattern: "A pattern across similar businesses",
};

/* -------------------------------------------------------------------------- */
/* one opportunity                                                            */
/* -------------------------------------------------------------------------- */

export type Opportunity = {
  id: string;
  stage: JourneyStage;
  category: string;
  title: string;
  summary: string;

  /** What we actually saw. Never optional — see requireEvidence. */
  evidence: string;
  sourceType: SourceType;
  sourceDetail?: string | null;
  observedAt: string;

  /*
   * THE THREE COLUMNS THAT KEEP THIS HONEST.
   *
   * Rendered under three different headings on the public page. An inference
   * that drifts into `knownFacts` is the most damaging thing this system can
   * do — it turns a guess into a claim about somebody's business, made to
   * their face, in writing.
   */
  knownFacts: string[];
  inferences: string[];
  needsConfirmation: string[];
  wouldVerifyNext: string[];

  confidence: Confidence;

  /** Prose about consequence. Never a fabricated figure — see forbidden. */
  potentialEffect?: string | null;

  /** Could we build something for this without touching their systems? */
  demonstrable: boolean;
  demoLabel?: string | null;
  solutionDirections: string[];
  customBuildPotential?: string | null;

  priority: Priority;

  /** Operator-only. stripInternal removes it before anything is served. */
  internalNote?: string | null;
};

/** Exactly what the public page is allowed to receive. */
export type PublicOpportunity = Omit<Opportunity, "internalNote">;

/**
 * The one function every public response must pass through.
 *
 * Hiding the note in the component would be a styling decision; removing it
 * here makes it absent from the payload, so it cannot leak through a view
 * source, a network tab, or the next component somebody writes.
 */
export function stripInternal(o: Opportunity): PublicOpportunity {
  const { internalNote: _drop, ...rest } = o;
  void _drop;
  return rest;
}

export function stripAllInternal(list: Opportunity[]): PublicOpportunity[] {
  return list.map(stripInternal);
}

/* -------------------------------------------------------------------------- */
/* what may never be claimed                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Claims that public data cannot support, however confident the wording.
 *
 * We can see a Google listing, a website and a set of reviews. We cannot see
 * call volume, conversion rate, revenue, margin or how many enquiries were
 * missed. Asserting any of them is not an overstatement — it is a made-up
 * number about somebody's livelihood, and an owner who knows their real figure
 * discovers in one glance that the whole assessment is invented.
 *
 * The permitted register is conditional: "may", "could", "likely", plus an
 * explicit statement of what we would need in order to actually calculate it.
 */
const FORBIDDEN_CLAIM_PATTERNS: { pattern: RegExp; why: string }[] = [
  {
    pattern: /(?:losing|lost|costing|missing out on)\s*(?:you|your business)?\s*[£$€]\s*[\d,]+/i,
    why: "states a currency amount the business is losing",
  },
  {
    pattern: /[£$€]\s*[\d,]+(?:\.\d+)?\s*(?:a|per)\s*(?:month|year|week|day)/i,
    why: "states a recurring currency amount",
  },
  {
    pattern: /\b(?:you|your business)\s+(?:are|is)\s+missing\s+\d+\b/i,
    why: "states a count of missed enquiries as fact",
  },
  {
    pattern: /\b\d+\s*(?:%|per ?cent)\s+of\s+(?:your|the)\s+(?:calls|leads|enquiries|customers|revenue)\b/i,
    why: "states a conversion or loss rate we cannot observe",
  },
  {
    pattern: /\byour (?:conversion rate|close rate|margin|profit|revenue|turnover) is\b/i,
    why: "states a private financial metric as fact",
  },
  {
    pattern: /\byou (?:miss|missed) \d+ calls?\b/i,
    why: "states a missed-call count as fact",
  },
];

export type ClaimProblem = { text: string; why: string };

/**
 * Anything in this opportunity that public evidence cannot support.
 *
 * Run over every field an owner can read, including model-generated copy —
 * validateOpportunity refuses the finding rather than publishing it, and the
 * deterministic fallback is used instead.
 */
export function forbiddenClaims(o: Partial<Opportunity>): ClaimProblem[] {
  const fields = [
    o.title,
    o.summary,
    o.evidence,
    o.potentialEffect,
    o.customBuildPotential,
    ...(o.knownFacts ?? []),
    ...(o.inferences ?? []),
    ...(o.needsConfirmation ?? []),
    ...(o.solutionDirections ?? []),
  ].filter((s): s is string => typeof s === "string" && s.length > 0);

  const found: ClaimProblem[] = [];
  for (const text of fields) {
    for (const { pattern, why } of FORBIDDEN_CLAIM_PATTERNS) {
      const m = text.match(pattern);
      if (m) found.push({ text: m[0], why });
    }
  }
  return found;
}

/**
 * Is this finding fit to show somebody?
 *
 * Evidence is mandatory. A finding with no evidence is an opinion, and an
 * opinion presented under the heading "what we observed" is a lie about where
 * it came from.
 */
export function validateOpportunity(o: Partial<Opportunity>): string[] {
  const problems: string[] = [];
  if (!o.title?.trim()) problems.push("A finding must have a title.");
  if (!o.summary?.trim()) problems.push("A finding must have a summary.");
  if (!o.evidence?.trim()) {
    problems.push("A finding must cite evidence. Without it this is an opinion, not an observation.");
  }
  if (!o.stage || !JOURNEY_STAGES.includes(o.stage)) {
    problems.push("A finding must attach to a stage of the customer journey.");
  }
  if ((o.knownFacts?.length ?? 0) === 0 && (o.inferences?.length ?? 0) === 0) {
    problems.push("A finding must separate what is known from what is inferred.");
  }
  for (const c of forbiddenClaims(o)) {
    problems.push(`"${c.text}" ${c.why} — public data cannot support that.`);
  }
  return problems;
}

/* -------------------------------------------------------------------------- */
/* ranking                                                                    */
/* -------------------------------------------------------------------------- */

export type RankInputs = {
  /** How sure we are of the evidence. */
  confidence: Confidence;
  /** How much it plausibly matters commercially, 0-1. */
  importance: number;
  /** How specific to THIS company rather than any company, 0-1. */
  specificity: number;
  /** How unlikely they are to have heard it before, 0-1. */
  distinctiveness: number;
  /** Could we show something without access? */
  demonstrable: boolean;
  /** Is it actually fixable, 0-1. */
  solvability: number;
  /** Does it justify a bespoke build rather than an off-the-shelf product? */
  customBuild: boolean;
};

const CONFIDENCE_WEIGHT: Record<Confidence, number> = { low: 0.4, medium: 0.75, high: 1 };

/**
 * Score a finding for the summary page.
 *
 * SPECIFICITY AND DISTINCTIVENESS CARRY REAL WEIGHT, and that is the deliberate
 * correction. "You should have a website" is high confidence, high importance
 * and completely generic — under a naive score it wins every time, which is
 * exactly how the old packet came to lead with the same recommendation for
 * everyone. Weighted this way a specific, consequential, evidenced constraint
 * beats a generic product recommendation, which is the stated requirement.
 */
export function rankScore(i: RankInputs): number {
  const clamp01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
  return (
    CONFIDENCE_WEIGHT[i.confidence] * 2.0 +
    clamp01(i.importance) * 2.5 +
    clamp01(i.specificity) * 2.5 +
    clamp01(i.distinctiveness) * 1.5 +
    (i.demonstrable ? 1.0 : 0) +
    clamp01(i.solvability) * 1.0 +
    (i.customBuild ? 0.75 : 0)
  );
}

export type ScoredOpportunity = Opportunity & { score: number };

/**
 * Order the findings and decide which leads.
 *
 * Returns at most `limit`, highest first, with priority assigned: the top one
 * is primary, the next two support it, the rest are context. Anything that
 * fails validation is dropped rather than shown — a finding we cannot stand
 * behind is worse than one fewer finding.
 */
export function rankOpportunities(
  candidates: (Opportunity & { rank: RankInputs })[],
  limit = 3
): ScoredOpportunity[] {
  const valid = candidates.filter((c) => validateOpportunity(c).length === 0);

  const scored = valid
    .map(({ rank, ...o }) => ({ ...o, score: rankScore(rank) }))
    .sort((a, b) => b.score - a.score);

  /*
   * One finding per stage in the headline set. Three variations on "people
   * cannot reach you" reads as one problem padded out, and costs the two
   * "I had not considered that" moments the summary exists to create.
   */
  const seen = new Set<JourneyStage>();
  const spread: ScoredOpportunity[] = [];
  const overflow: ScoredOpportunity[] = [];
  for (const o of scored) {
    if (seen.has(o.stage)) overflow.push(o);
    else {
      seen.add(o.stage);
      spread.push(o);
    }
  }

  return [...spread, ...overflow].slice(0, Math.max(1, limit)).map((o, idx) => ({
    ...o,
    priority: idx === 0 ? "primary" : idx <= 2 ? "supporting" : "context",
    position: idx,
  })) as ScoredOpportunity[];
}

/* -------------------------------------------------------------------------- */
/* how sure we are, said in words                                             */
/* -------------------------------------------------------------------------- */

/**
 * Restrained on purpose. "High" never becomes "certain", because the evidence
 * behind it is a public listing rather than their books.
 */
export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  low: "Worth checking — we are not sure",
  medium: "Reasonably confident, based on what is public",
  high: "Confident, based on what is public",
};

/** The sentence that must accompany any consequence we describe. */
export const EFFECT_CAVEAT =
  "We would need your own numbers to say what this is actually worth — this is what we can see from the outside.";
