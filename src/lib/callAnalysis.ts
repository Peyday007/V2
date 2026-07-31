// Post-call analysis.
//
// Two rules shape this module:
//
//   1. The machine's reading NEVER overwrites a person's. Both are stored, the
//      human's wins, and the difference between them is the accuracy
//      measurement.
//   2. The reading says what it was based on. A conclusion drawn from a
//      recording and one drawn from a caller's own outcome form are not
//      equivalent evidence, and presenting them identically would let a guess
//      inherit a transcript's authority.
//
// Pure: the shape, the merge and the confidence rules are all testable.

export type AnalysisSource = "transcript" | "outcome_form";

export type InterestLevel = "strong" | "mild" | "unsure" | "none" | "unknown";
export type QualificationStatus =
  | "qualified"
  | "partially_qualified"
  | "not_qualified"
  | "unknown";
export type MeetingStatus = "booked" | "requested" | "declined" | "none";

/** Everything a reading can conclude. Every field may be absent. */
export type CallAnalysisResult = {
  personReached?: string | null;
  liveAnswer?: boolean | null;
  ownerReached?: boolean | null;
  objections?: string[];
  needsDiscovered?: string[];
  interestLevel?: InterestLevel;
  qualificationStatus?: QualificationStatus;
  meetingStatus?: MeetingStatus;
  meetingAt?: string | null;
  contactConfirmed?: string | null;
  followupRequested?: boolean | null;
  followupDeadline?: string | null;
  newInformation?: string[];
  doNotCallRequested?: boolean | null;
  callerStrengths?: string[];
  missedOpportunities?: string[];
  coachingPoint?: string | null;
};

export const ANALYSIS_FIELDS: (keyof CallAnalysisResult)[] = [
  "personReached",
  "liveAnswer",
  "ownerReached",
  "objections",
  "needsDiscovered",
  "interestLevel",
  "qualificationStatus",
  "meetingStatus",
  "meetingAt",
  "contactConfirmed",
  "followupRequested",
  "followupDeadline",
  "newInformation",
  "doNotCallRequested",
  "callerStrengths",
  "missedOpportunities",
  "coachingPoint",
];

export const FIELD_LABEL: Record<string, string> = {
  personReached: "Person reached",
  liveAnswer: "A live person answered",
  ownerReached: "Reached the owner or decision-maker",
  objections: "Objections",
  needsDiscovered: "Needs discovered",
  interestLevel: "Interest level",
  qualificationStatus: "Qualification",
  meetingStatus: "Meeting",
  meetingAt: "Meeting date and time",
  contactConfirmed: "Email or number confirmed",
  followupRequested: "Follow-up requested",
  followupDeadline: "Follow-up deadline",
  newInformation: "New information about the business",
  doNotCallRequested: "Asked not to be called",
  callerStrengths: "What the caller did well",
  missedOpportunities: "Missed opportunities",
  coachingPoint: "Coaching point",
};

/* -------------------------------------------------------------------------- */
/* reading a call the caller logged themselves                                */
/* -------------------------------------------------------------------------- */

export type OutcomeFormInput = {
  outcome: string;
  reachedDm?: boolean | null;
  spokeWithRole?: string | null;
  notes?: string | null;
  details: Record<string, string>;
  durationSeconds?: number | null;
};

const NO_CONTACT = ["no_answer", "voicemail", "bad_number"];

const INTEREST_MAP: Record<string, InterestLevel> = {
  "Strong interest": "strong",
  "Mild interest": "mild",
  Unsure: "unsure",
  "Not interested": "none",
};

/**
 * Read a call from what the caller recorded. Deterministic — no model call, so
 * it always runs, costs nothing and cannot hallucinate.
 *
 * Confidence is capped well below a transcript reading because a form records
 * what the caller chose to write, not what was said.
 */
export function analyzeFromOutcomeForm(input: OutcomeFormInput): {
  result: CallAnalysisResult;
  confidence: number;
} {
  const d = input.details || {};
  const outcome = input.outcome;
  const liveAnswer = !NO_CONTACT.includes(outcome);

  const objections: string[] = [];
  if (d.objection) objections.push(d.objection);
  if (outcome === "not_interested" && d.reason) objections.push(d.reason);

  const needs: string[] = [];
  if (d.main_problem && d.main_problem !== "No major problem identified") {
    needs.push(d.main_problem);
  }
  if (d.pain_point) needs.push(d.pain_point);

  const newInfo: string[] = [];
  for (const [k, label] of [
    ["answering_setup", "How calls are answered"],
    ["existing_provider", "Existing provider"],
    ["office_staff_count", "Office staff"],
    ["after_hours_process", "After hours"],
    ["best_call_time", "Best time to call"],
    ["extension", "Extension"],
    ["direct_number", "Direct number"],
  ] as const) {
    if (d[k]) newInfo.push(`${label}: ${d[k]}`);
  }

  const meetingStatus: MeetingStatus =
    outcome === "appointment_set"
      ? "booked"
      : outcome === "callback"
        ? "requested"
        : outcome === "not_interested"
          ? "declined"
          : "none";

  const result: CallAnalysisResult = {
    personReached: d.dm_name || d.gatekeeper_name || d.transferred_to_name || null,
    liveAnswer,
    ownerReached: input.reachedDm ?? false,
    objections,
    needsDiscovered: needs,
    interestLevel: INTEREST_MAP[d.interest_level] ?? (liveAnswer ? "unknown" : "unknown"),
    qualificationStatus:
      d.answering_setup && needs.length > 0
        ? "qualified"
        : d.answering_setup || needs.length > 0
          ? "partially_qualified"
          : "unknown",
    meetingStatus,
    meetingAt: combineDate(d.appt_date, d.appt_time),
    contactConfirmed: d.email || d.direct_number || d.phone || null,
    followupRequested: outcome === "callback" || d.try_again === "Yes",
    followupDeadline: combineDate(d.callback_date, d.callback_time) || combineDate(d.follow_up_date),
    newInformation: newInfo,
    doNotCallRequested: outcome === "do_not_call",
    callerStrengths: [],
    missedOpportunities: missedFrom(outcome, input.reachedDm ?? false, d),
    coachingPoint: null,
  };

  // A form is second-hand. Never let it read as certain.
  let confidence = 0.55;
  if (Object.keys(d).length >= 5) confidence += 0.1;
  if (input.notes && input.notes.length > 40) confidence += 0.05;
  if (!liveAnswer) confidence = 0.85; // "nobody answered" is hard to get wrong

  return { result, confidence: Math.min(0.9, confidence) };
}

function combineDate(date?: string, time?: string): string | null {
  if (!date) return null;
  const d = new Date(`${date}T${time || "09:00"}:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function missedFrom(
  outcome: string,
  reachedDm: boolean,
  d: Record<string, string>
): string[] {
  const missed: string[] = [];
  if (reachedDm && outcome !== "appointment_set") {
    missed.push("Reached the decision-maker but did not book a meeting");
  }
  if (reachedDm && !d.answering_setup) {
    missed.push("Did not find out how they handle calls today");
  }
  if (outcome === "gatekeeper" && !d.best_call_time && !d.best_call_day) {
    missed.push("Did not get a best time to reach the owner");
  }
  if (outcome === "gatekeeper" && d.owner_identified !== "Yes") {
    missed.push("Did not get the owner's name");
  }
  if (outcome === "not_interested" && d.said_by_role !== "Owner / decision-maker") {
    missed.push("Took a no from someone who may not decide");
  }
  return missed;
}

/* -------------------------------------------------------------------------- */
/* AI vs human                                                                */
/* -------------------------------------------------------------------------- */

export type FieldComparison = {
  field: string;
  label: string;
  ai: unknown;
  confirmed: unknown;
  changed: boolean;
};

function normalise(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).sort().join("|");
  return String(v).trim();
}

/** What the human changed. This is the accuracy record. */
export function compareResults(
  ai: CallAnalysisResult,
  confirmed: CallAnalysisResult
): FieldComparison[] {
  return ANALYSIS_FIELDS.map((field) => {
    const a = ai[field];
    const c = confirmed[field];
    return {
      field,
      label: FIELD_LABEL[field] ?? field,
      ai: a ?? null,
      confirmed: c ?? null,
      changed: normalise(a) !== normalise(c),
    };
  });
}

/** How often the machine agreed with the person, over fields it filled in. */
export function accuracyOf(comparisons: FieldComparison[]): {
  agreed: number;
  assessed: number;
  rate: number | null;
} {
  const assessed = comparisons.filter(
    (c) => normalise(c.ai) !== "" || normalise(c.confirmed) !== ""
  );
  const agreed = assessed.filter((c) => !c.changed).length;
  return {
    agreed,
    assessed: assessed.length,
    rate: assessed.length > 0 ? agreed / assessed.length : null,
  };
}

/**
 * Apply the human's confirmation on top of the machine's reading.
 *
 * Anything the person touched wins outright. Anything they left alone keeps
 * the machine's value — but the record still shows which was which, so a
 * confirmed result is never mistaken for a human-authored one.
 */
export function mergeConfirmed(
  ai: CallAnalysisResult,
  humanEdits: Partial<CallAnalysisResult>
): CallAnalysisResult {
  const merged: CallAnalysisResult = { ...ai };
  for (const field of ANALYSIS_FIELDS) {
    if (field in humanEdits) {
      // An explicit null from a person means "no, this is empty" and must be
      // honoured rather than treated as "unset, fall back to the AI".
      (merged as Record<string, unknown>)[field] = humanEdits[field] ?? null;
    }
  }
  return merged;
}

/** Below this, a reading is shown as a question rather than an answer. */
export const LOW_CONFIDENCE = 0.6;

export function confidenceLabel(confidence: number | null | undefined): string {
  if (confidence === null || confidence === undefined) return "not assessed";
  if (confidence >= 0.85) return "high";
  if (confidence >= LOW_CONFIDENCE) return "moderate";
  return "low — check every field";
}
