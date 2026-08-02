// Whether the enrichment is worth what it costs.
//
// One number decides that, and it is stated first everywhere it appears:
//
//     OWNER CONVERSATIONS PER 100 CALLS TO ENRICHED RECORDS.
//
// The batch that prompted this work scored 5.4 — 111 live answers, six owners.
// Discovery rates, provider accuracy and cost per number are all supporting
// evidence; if this one figure does not move, the enrichment is not working
// whatever the others say.
//
// Pure: rows in, figures out. No database, so the numbers on the page and the
// numbers in a test are produced by the same code.

import { GRADES, type Grade } from "./enrichmentGrade";
import { PHONE_CLASSES, type PhoneClass } from "./phoneIntel";
import { CONFIRMING, CONTRADICTING, type ContactOutcome } from "./contactFeedback";

/* -------------------------------------------------------------------------- */
/* inputs                                                                     */
/* -------------------------------------------------------------------------- */

export type LeadFact = {
  id: string;
  decision_maker_name?: string | null;
  direct_phone?: string | null;
  direct_phone_class?: string | null;
  enrichment_grade?: string | null;
  enrichment_state?: string | null;
  enrichment_cost_cents?: number | null;
  enriched_at?: string | null;
  created_at?: string | null;
};

export type CallFactForReport = {
  lead_id?: string | null;
  outcome: string;
  reached_dm?: boolean | null;
  spoke_with_role?: string | null;
  created_at?: string | null;
};

export type AttemptFact = {
  provider: string;
  stage?: string | null;
  attempted?: boolean | null;
  accepted?: boolean | null;
  phones_returned?: number | null;
  cost_cents?: number | null;
  skipped_reason?: string | null;
  error?: string | null;
};

export type FeedbackFact = {
  lead_id?: string | null;
  outcome: string;
  provider?: string | null;
  phone_class?: string | null;
};

/* -------------------------------------------------------------------------- */
/* small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** A rate expressed per 100, or null when the denominator is empty. */
export function per100(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return (numerator / denominator) * 100;
}

export function pct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

export function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Cost per unit, in cents, or null when nothing succeeded — never Infinity. */
export function costPer(totalCents: number, count: number): number | null {
  if (count <= 0) return null;
  return totalCents / count;
}

const VERIFIED_CLASSES: PhoneClass[] = ["verified_owner_mobile", "verified_owner_direct"];
const DIRECT_CLASSES: PhoneClass[] = [
  "verified_owner_mobile",
  "verified_owner_direct",
  "probable_owner_mobile",
  "probable_owner_direct",
];

function isDirectClass(c: string | null | undefined): boolean {
  return DIRECT_CLASSES.includes((c ?? "") as PhoneClass);
}
function isVerifiedClass(c: string | null | undefined): boolean {
  return VERIFIED_CLASSES.includes((c ?? "") as PhoneClass);
}

/** Did a human pick up? Same definition the caller analytics uses. */
const NO_CONTACT = ["no_answer", "voicemail", "bad_number"];
export function reachedLivePerson(c: CallFactForReport): boolean {
  if (c.spoke_with_role === "owner" || c.spoke_with_role === "gatekeeper") return true;
  if (c.spoke_with_role === "employee") return true;
  return !NO_CONTACT.includes(c.outcome);
}

/**
 * Did the call reach the decision-maker?
 *
 * `reached_dm` is the recorded field and is trusted when set. The role is a
 * fallback for older rows. An outcome of dm_conversation alone is NOT enough —
 * it is a button a caller can press optimistically, and inflating this number
 * would hide the exact failure this whole feature was built to fix.
 */
export function reachedOwner(c: CallFactForReport): boolean {
  if (c.reached_dm === true) return true;
  return c.spoke_with_role === "owner";
}

/* -------------------------------------------------------------------------- */
/* the funnel                                                                 */
/* -------------------------------------------------------------------------- */

export type Funnel = {
  businessesCollected: number;
  ownersIdentified: number;
  directNumbersFound: number;
  verifiedDirectNumbers: number;
  callReady: number;
  byGrade: Record<Grade, number>;
  /** Owners identified ÷ businesses collected. */
  ownerDiscoveryRate: number | null;
  /** Direct numbers ÷ owners identified — the step that actually gates calling. */
  directNumberDiscoveryRate: number | null;
  /** Call-ready ÷ businesses collected, end to end. */
  endToEndRate: number | null;
};

export function buildFunnel(leads: LeadFact[]): Funnel {
  const byGrade = Object.fromEntries(GRADES.map((g) => [g, 0])) as Record<Grade, number>;
  let ownersIdentified = 0;
  let directNumbersFound = 0;
  let verifiedDirectNumbers = 0;

  for (const l of leads) {
    const grade = (l.enrichment_grade ?? "") as Grade;
    if (GRADES.includes(grade)) byGrade[grade] += 1;

    if ((l.decision_maker_name || "").trim()) ownersIdentified += 1;
    if (l.direct_phone && isDirectClass(l.direct_phone_class)) {
      directNumbersFound += 1;
      if (isVerifiedClass(l.direct_phone_class)) verifiedDirectNumbers += 1;
    }
  }

  const callReady = byGrade.A + byGrade.B;
  return {
    businessesCollected: leads.length,
    ownersIdentified,
    directNumbersFound,
    verifiedDirectNumbers,
    callReady,
    byGrade,
    ownerDiscoveryRate: pct(ownersIdentified, leads.length),
    directNumberDiscoveryRate: pct(directNumbersFound, ownersIdentified),
    endToEndRate: pct(callReady, leads.length),
  };
}

/* -------------------------------------------------------------------------- */
/* what it cost                                                               */
/* -------------------------------------------------------------------------- */

export type CostReport = {
  totalCents: number;
  lookups: number;
  /** Attempts that produced a number the pipeline accepted. */
  hits: number;
  /** Cost per accepted direct number, in cents. */
  costPerNumberCents: number | null;
  /** Cost per number a provider actually verified. */
  costPerVerifiedNumberCents: number | null;
  /** Cost per lead that ended up call-ready. */
  costPerCallReadyLeadCents: number | null;
};

export function buildCost(
  attempts: AttemptFact[],
  funnel: Pick<Funnel, "directNumbersFound" | "verifiedDirectNumbers" | "callReady">
): CostReport {
  const totalCents = attempts.reduce((n, a) => n + (a.cost_cents ?? 0), 0);
  const lookups = attempts.filter((a) => a.attempted !== false).length;
  const hits = attempts.filter((a) => a.accepted === true).length;

  return {
    totalCents,
    lookups,
    hits,
    // Failed lookups stay in the numerator. Cost per number that ignores what
    // was paid for nothing is not a cost.
    costPerNumberCents: costPer(totalCents, funnel.directNumbersFound),
    costPerVerifiedNumberCents: costPer(totalCents, funnel.verifiedDirectNumbers),
    costPerCallReadyLeadCents: costPer(totalCents, funnel.callReady),
  };
}

/* -------------------------------------------------------------------------- */
/* the number that decides it                                                 */
/* -------------------------------------------------------------------------- */

export type CallOutcomeReport = {
  calls: number;
  livePersonReached: number;
  ownerConversations: number;
  meetings: number;
  /** THE headline. Owner conversations per 100 calls. */
  ownerConversationsPer100: number | null;
  livePersonPer100: number | null;
  meetingsPer100: number | null;
  /** Of the people who answered, how many were the owner. */
  ownerShareOfLiveAnswers: number | null;
};

export function buildCallOutcomes(calls: CallFactForReport[]): CallOutcomeReport {
  const live = calls.filter(reachedLivePerson).length;
  const owners = calls.filter(reachedOwner).length;
  const meetings = calls.filter((c) => c.outcome === "appointment_set").length;

  return {
    calls: calls.length,
    livePersonReached: live,
    ownerConversations: owners,
    meetings,
    ownerConversationsPer100: per100(owners, calls.length),
    livePersonPer100: per100(live, calls.length),
    meetingsPer100: per100(meetings, calls.length),
    ownerShareOfLiveAnswers: pct(owners, live),
  };
}

/**
 * The comparison the whole feature stands or falls on: calls to leads that
 * carry a direct number, against calls to leads that do not.
 *
 * Both sides are reported even when one is empty, because a missing side is
 * itself the answer — it means nothing has been called that way yet.
 */
export type SplitReport = {
  enriched: CallOutcomeReport;
  mainLine: CallOutcomeReport;
  /** Enriched minus main-line, in owner conversations per 100 calls. */
  liftPer100: number | null;
  verdict: string;
};

export function buildSplit(
  calls: CallFactForReport[],
  leads: LeadFact[]
): SplitReport {
  const direct = new Set(
    leads.filter((l) => l.direct_phone && isDirectClass(l.direct_phone_class)).map((l) => l.id)
  );
  const enrichedCalls = calls.filter((c) => c.lead_id && direct.has(c.lead_id));
  const otherCalls = calls.filter((c) => !c.lead_id || !direct.has(c.lead_id));

  const enriched = buildCallOutcomes(enrichedCalls);
  const mainLine = buildCallOutcomes(otherCalls);

  const lift =
    enriched.ownerConversationsPer100 !== null && mainLine.ownerConversationsPer100 !== null
      ? enriched.ownerConversationsPer100 - mainLine.ownerConversationsPer100
      : null;

  let verdict: string;
  if (enriched.calls < MIN_CALLS_FOR_A_VERDICT) {
    verdict = `Only ${enriched.calls} calls have been made to enriched records — too few to judge. ${MIN_CALLS_FOR_A_VERDICT} is the bar.`;
  } else if (mainLine.calls < MIN_CALLS_FOR_A_VERDICT) {
    verdict = `${enriched.ownerConversationsPer100!.toFixed(1)} owner conversations per 100 calls to enriched records. Nothing to compare it against yet.`;
  } else if (lift === null) {
    verdict = "Not enough data on both sides to compare.";
  } else if (lift > 0) {
    verdict = `Enriched records reach ${lift.toFixed(1)} more owners per 100 calls than main-line records.`;
  } else {
    verdict = `Enriched records are reaching ${Math.abs(lift).toFixed(1)} FEWER owners per 100 calls. The enrichment is not paying for itself.`;
  }

  return { enriched, mainLine, liftPer100: lift, verdict };
}

/** Below this, no comparison is offered. A verdict off twelve calls is noise. */
export const MIN_CALLS_FOR_A_VERDICT = 50;

/* -------------------------------------------------------------------------- */
/* what the callers found out                                                 */
/* -------------------------------------------------------------------------- */

export type AccuracyReport = {
  judged: number;
  confirmed: number;
  wrongPerson: number;
  wrongNumber: number;
  wrongPersonRate: number | null;
  wrongNumberRate: number | null;
  accuracy: number | null;
};

export function buildAccuracy(feedback: FeedbackFact[]): AccuracyReport {
  const confirming = new Set<string>(CONFIRMING);
  const contradicting = new Set<string>(CONTRADICTING);

  const judged = feedback.filter(
    (f) => confirming.has(f.outcome) || contradicting.has(f.outcome)
  ).length;
  const confirmed = feedback.filter((f) => confirming.has(f.outcome)).length;
  const wrongPerson = feedback.filter(
    (f) => f.outcome === "wrong_person" || f.outcome === "owner_no_longer_there"
  ).length;
  const wrongNumber = feedback.filter(
    (f) => f.outcome === "wrong_number" || f.outcome === "disconnected"
  ).length;

  return {
    judged,
    confirmed,
    wrongPerson,
    wrongNumber,
    wrongPersonRate: pct(wrongPerson, judged),
    wrongNumberRate: pct(wrongNumber, judged),
    accuracy: pct(confirmed, judged),
  };
}

/* -------------------------------------------------------------------------- */
/* by grade, by provider, by number type                                       */
/* -------------------------------------------------------------------------- */

export type GradeRow = {
  grade: Grade;
  leads: number;
  calls: number;
  ownerConversations: number;
  meetings: number;
  ownerConversationsPer100: number | null;
  meetingsPer100: number | null;
};

export function buildByGrade(leads: LeadFact[], calls: CallFactForReport[]): GradeRow[] {
  const gradeOf = new Map<string, string>();
  for (const l of leads) if (l.enrichment_grade) gradeOf.set(l.id, l.enrichment_grade);

  return GRADES.map((grade) => {
    const mine = calls.filter((c) => c.lead_id && gradeOf.get(c.lead_id) === grade);
    const owners = mine.filter(reachedOwner).length;
    const meetings = mine.filter((c) => c.outcome === "appointment_set").length;
    return {
      grade,
      leads: leads.filter((l) => l.enrichment_grade === grade).length,
      calls: mine.length,
      ownerConversations: owners,
      meetings,
      ownerConversationsPer100: per100(owners, mine.length),
      meetingsPer100: per100(meetings, mine.length),
    };
  });
}

export type NumberTypeRow = {
  phoneClass: PhoneClass;
  leads: number;
  calls: number;
  ownerConversations: number;
  ownerConversationsPer100: number | null;
};

export function buildByNumberType(
  leads: LeadFact[],
  calls: CallFactForReport[]
): NumberTypeRow[] {
  const classOf = new Map<string, string>();
  for (const l of leads) if (l.direct_phone_class) classOf.set(l.id, l.direct_phone_class);

  return PHONE_CLASSES.map((phoneClass) => {
    const mine = calls.filter((c) => c.lead_id && classOf.get(c.lead_id) === phoneClass);
    const owners = mine.filter(reachedOwner).length;
    return {
      phoneClass,
      leads: leads.filter((l) => l.direct_phone_class === phoneClass).length,
      calls: mine.length,
      ownerConversations: owners,
      ownerConversationsPer100: per100(owners, mine.length),
    };
  }).filter((r) => r.leads > 0 || r.calls > 0);
}

export type ProviderRow = {
  provider: string;
  lookups: number;
  hits: number;
  errors: number;
  hitRate: number | null;
  costCents: number;
  costPerHitCents: number | null;
  /** Owner conversations on numbers this provider supplied. */
  ownerConversations: number;
  contradicted: number;
  /** Cost, in cents, per owner conversation this provider produced. */
  costPerOwnerConversationCents: number | null;
  verdict: string;
};

/** Below this many lookups, a provider's figures are reported but not judged. */
export const MIN_LOOKUPS_TO_JUDGE_PROVIDER = 25;

export function buildByProvider(
  attempts: AttemptFact[],
  feedback: FeedbackFact[]
): ProviderRow[] {
  const names = [
    ...new Set([
      ...attempts.map((a) => a.provider),
      ...feedback.map((f) => f.provider).filter((p): p is string => !!p),
    ]),
  ];
  const confirming = new Set<string>(CONFIRMING);
  const contradicting = new Set<string>(CONTRADICTING);

  return names
    .map((provider) => {
      const mine = attempts.filter((a) => a.provider === provider);
      const lookups = mine.filter((a) => a.attempted !== false).length;
      const hits = mine.filter((a) => a.accepted === true).length;
      const errors = mine.filter((a) => !!a.error).length;
      const costCents = mine.reduce((n, a) => n + (a.cost_cents ?? 0), 0);

      const judged = feedback.filter((f) => f.provider === provider);
      const owners = judged.filter((f) => confirming.has(f.outcome)).length;
      const contradicted = judged.filter((f) => contradicting.has(f.outcome)).length;

      const verdict =
        lookups < MIN_LOOKUPS_TO_JUDGE_PROVIDER
          ? `${lookups} lookups so far — reported, but too few to judge on.`
          : owners + contradicted === 0
            ? `${hits} numbers supplied, none judged by a caller yet.`
            : `${owners} of ${owners + contradicted} judged calls reached the right person.`;

      return {
        provider,
        lookups,
        hits,
        errors,
        hitRate: pct(hits, lookups),
        costCents,
        costPerHitCents: costPer(costCents, hits),
        ownerConversations: owners,
        contradicted,
        costPerOwnerConversationCents: costPer(costCents, owners),
        verdict,
      };
    })
    .sort((a, b) => b.lookups - a.lookups);
}

/* -------------------------------------------------------------------------- */
/* everything at once                                                         */
/* -------------------------------------------------------------------------- */

export type EnrichmentReport = {
  funnel: Funnel;
  cost: CostReport;
  overall: CallOutcomeReport;
  split: SplitReport;
  accuracy: AccuracyReport;
  byGrade: GradeRow[];
  byNumberType: NumberTypeRow[];
  byProvider: ProviderRow[];
  headline: string;
};

export function buildEnrichmentReport(input: {
  leads: LeadFact[];
  calls: CallFactForReport[];
  attempts: AttemptFact[];
  feedback: FeedbackFact[];
}): EnrichmentReport {
  const funnel = buildFunnel(input.leads);
  const cost = buildCost(input.attempts, funnel);
  const overall = buildCallOutcomes(input.calls);
  const split = buildSplit(input.calls, input.leads);

  const headline =
    overall.calls === 0
      ? "No calls recorded yet, so there is nothing to judge the enrichment on."
      : `${overall.ownerConversationsPer100!.toFixed(1)} owner conversations per 100 calls, across ${overall.calls} calls.`;

  return {
    funnel,
    cost,
    overall,
    split,
    accuracy: buildAccuracy(input.feedback),
    byGrade: buildByGrade(input.leads, input.calls),
    byNumberType: buildByNumberType(input.leads, input.calls),
    byProvider: buildByProvider(input.attempts, input.feedback),
    headline,
  };
}

/** Feedback outcomes, typed, for callers that want to narrow. */
export type { ContactOutcome };
