// Who has the last word on what happened during a call.
//
// The premise: 300 calls a day cannot be reviewed by hand. Asking a human to
// confirm every reading produces one of two outcomes, and both are worse than
// letting the machine decide — either the queue is ignored, or it is rubber
// stamped. So the AI's reading is applied by default and nobody is asked.
//
// Three things stop that from being reckless, and none of them require
// reviewing 300 calls:
//
//   ESCALATION. A small number of calls are surfaced: the ones the model was
//   unsure about, the ones where it contradicts the caller on something that
//   matters, and anything touching do-not-call or a complaint. That is a
//   handful a day, not hundreds.
//
//   A SPOT CHECK. A random slice is flagged whatever the confidence. Without
//   it, "the AI decides" quietly becomes "nobody can tell whether the AI is
//   any good" — accuracy stops being measurable the moment every reading is
//   accepted unseen.
//
//   A SHORT LIST OF THINGS IT NEVER DECIDES ALONE. Reversing a do-not-call,
//   changing a price or a script, sending anything to a prospect, or judging a
//   caller's job. These are not confidence problems; they are consequence
//   problems, and no confidence score makes them safe.
//
// Pure functions: no I/O, so the rules can be read and tested on their own.

import {
  ANALYSIS_FIELDS,
  FIELD_LABEL,
  LOW_CONFIDENCE,
  type CallAnalysisResult,
} from "./callAnalysis";

/* -------------------------------------------------------------------------- */
/* what the AI may never decide alone                                         */
/* -------------------------------------------------------------------------- */

/**
 * Not fields — actions. No confidence score makes any of these safe to do
 * without a person, so they are named rather than scored.
 */
export const NEVER_AUTONOMOUS = [
  "release_do_not_call",
  "change_price_or_discount",
  "change_script_or_prompt",
  "send_message_to_prospect",
  "judge_or_dismiss_a_caller",
  "change_consent_behaviour",
] as const;

export type NeverAutonomous = (typeof NEVER_AUTONOMOUS)[number];

/**
 * Fields where a human's typed answer beats the transcript even when the model
 * is confident.
 *
 * This is not deference for its own sake. A caller who wrote down an email
 * heard it spelled out; a transcript of "d-a-v-e at northside" is exactly
 * where speech-to-text fails, and this deployment records a phone speaker
 * across a desk. Where the caller left it blank the AI fills it in.
 */
export const HUMAN_WINS_WHEN_PRESENT: (keyof CallAnalysisResult)[] = [
  "contactConfirmed",
  "meetingAt",
];

/** Fields consequential enough that a disagreement gets looked at. */
export const MATERIAL_FIELDS: (keyof CallAnalysisResult)[] = [
  "ownerReached",
  "meetingStatus",
  "meetingAt",
  "qualificationStatus",
  "doNotCallRequested",
  "followupRequested",
];

/* -------------------------------------------------------------------------- */
/* settings                                                                   */
/* -------------------------------------------------------------------------- */

export type AuthoritySettings = {
  /** Off means the old behaviour: nothing applies until a human confirms. */
  aiDecides: boolean;
  /** Below this, the call is escalated rather than applied silently. */
  confidenceFloor: number;
  /** Share of confident calls flagged anyway, to keep accuracy measurable. */
  spotCheckRate: number;
};

export const DEFAULT_AUTHORITY: AuthoritySettings = {
  aiDecides: true,
  confidenceFloor: LOW_CONFIDENCE,
  // ~6 calls a day at 300. Enough to measure, small enough to actually do.
  spotCheckRate: 0.02,
};

/* -------------------------------------------------------------------------- */
/* comparing the two readings                                                 */
/* -------------------------------------------------------------------------- */

export type Disagreement = {
  field: keyof CallAnalysisResult;
  label: string;
  human: unknown;
  ai: unknown;
  material: boolean;
};

function normalise(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map((x) => String(x).trim().toLowerCase()).sort().join("|");
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v).trim().toLowerCase();
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "string") return v.trim() === "";
  // A deliberate `false` is an answer, not an absence.
  return false;
}

export function disagreements(
  human: CallAnalysisResult,
  ai: CallAnalysisResult
): Disagreement[] {
  const out: Disagreement[] = [];
  for (const field of ANALYSIS_FIELDS) {
    const h = human[field];
    const a = ai[field];
    // Silence is not disagreement. The form only ever knew what it asked.
    if (isEmpty(h) || isEmpty(a)) continue;
    if (normalise(h) === normalise(a)) continue;
    out.push({
      field,
      label: FIELD_LABEL[field] ?? field,
      human: h,
      ai: a,
      material: MATERIAL_FIELDS.includes(field),
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* the decision                                                               */
/* -------------------------------------------------------------------------- */

export type EscalationReason =
  | "low_confidence"
  | "material_disagreement"
  | "do_not_call_heard"
  | "dnc_reversal_attempted"
  | "complaint_heard"
  | "spot_check"
  | "no_transcript";

export const ESCALATION_LABEL: Record<EscalationReason, string> = {
  low_confidence: "The model was not sure",
  material_disagreement: "The model and the caller disagree on something that matters",
  do_not_call_heard: "Someone asked not to be called again",
  dnc_reversal_attempted: "The model wanted to undo a do-not-call",
  complaint_heard: "This sounded like a complaint",
  spot_check: "Random spot check, to keep accuracy measurable",
  no_transcript: "There was no transcript to read",
};

/*
 * The reasons that are a JOB FOR A PERSON, as opposed to a fact about the
 * system.
 *
 * `no_transcript` is the odd one out and it broke the review queue. With
 * recording switched off — which is the normal state, and the only lawful
 * state in the fourteen all-party consent states — EVERY call has no
 * transcript. So every call got flagged, and the queue filled with items that
 * said "there was nothing to read" and offered a human the choice of "read it
 * right" or "got it wrong" about a reading that was never made. Thirty in a
 * day, and it would have been three hundred by the end of the week.
 *
 * It is still recorded on the call, because it is true and it explains why the
 * reading came from the outcome form. It just is not work. What it actually
 * means — "you are not recording, so nothing can be read from calls" — is one
 * fact about a setting, and it belongs at the top of the page once rather than
 * on every row forever.
 */
export const SYSTEM_STATE_REASONS: EscalationReason[] = ["no_transcript"];

/** Does this call actually need a human, or is it just describing the setup? */
export function needsAPerson(reasons: readonly string[]): boolean {
  return reasons.some((r) => !(SYSTEM_STATE_REASONS as readonly string[]).includes(r));
}

/** The reasons worth showing as work, with the system-state ones removed. */
export function actionableReasons(reasons: readonly string[]): string[] {
  return reasons.filter((r) => !(SYSTEM_STATE_REASONS as readonly string[]).includes(r));
}

export type AuthorityDecision = {
  /** What gets written to the call record without anyone being asked. */
  applied: CallAnalysisResult;
  /** Fields the AI wanted but did not get, and why. */
  held: { field: keyof CallAnalysisResult; reason: string }[];
  /** Where the two readings differ. Kept whether or not it escalates. */
  disagreements: Disagreement[];
  /** Should a person look at this one? */
  escalate: boolean;
  reasons: EscalationReason[];
  /** Actions this call implies that a person must take. Never done for them. */
  blockedActions: NeverAutonomous[];
  /** Who the record says decided. */
  authority: "ai" | "human" | "form_only";
};

export type DecideInput = {
  /** What the caller's outcome form said. Always present. */
  human: CallAnalysisResult;
  /** What the model read from the transcript. Absent when there is none. */
  ai?: CallAnalysisResult | null;
  aiConfidence?: number | null;
  settings?: Partial<AuthoritySettings>;
  /** 0-1. Injected so the spot check is deterministic in tests. */
  sample?: number;
};

export function decideAuthority(input: DecideInput): AuthorityDecision {
  const settings = { ...DEFAULT_AUTHORITY, ...(input.settings || {}) };
  const human = input.human;
  const ai = input.ai ?? null;
  const confidence = input.aiConfidence ?? 0;

  // No transcript: the form is all there is, and it stands.
  if (!ai) {
    return {
      applied: human,
      held: [],
      disagreements: [],
      escalate: false,
      reasons: [],
      blockedActions: [],
      authority: "form_only",
    };
  }

  const diffs = disagreements(human, ai);
  const reasons: EscalationReason[] = [];
  const held: { field: keyof CallAnalysisResult; reason: string }[] = [];
  const blockedActions: NeverAutonomous[] = [];

  // Nothing applies on its own while the setting is off.
  if (!settings.aiDecides) {
    return {
      applied: human,
      held: ANALYSIS_FIELDS.filter((f) => !isEmpty(ai[f])).map((field) => ({
        field,
        reason: "AI authority is switched off — a person confirms every reading.",
      })),
      disagreements: diffs,
      escalate: true,
      reasons: ["material_disagreement"],
      blockedActions,
      authority: "human",
    };
  }

  /* ------------------------------ build the result ----------------------- */
  const applied: CallAnalysisResult = { ...human };

  for (const field of ANALYSIS_FIELDS) {
    const aiValue = ai[field];
    if (isEmpty(aiValue)) continue;

    // Undoing a do-not-call is never the machine's call. Suppression is the
    // safe direction; coming back out of it is not.
    if (
      field === "doNotCallRequested" &&
      human.doNotCallRequested === true &&
      aiValue === false
    ) {
      held.push({
        field,
        reason: "A do-not-call is never lifted automatically.",
      });
      blockedActions.push("release_do_not_call");
      reasons.push("dnc_reversal_attempted");
      continue;
    }

    // Where the caller typed something and the field is one speech-to-text is
    // bad at, their answer stands.
    if (HUMAN_WINS_WHEN_PRESENT.includes(field) && !isEmpty(human[field])) {
      held.push({
        field,
        reason: "The caller wrote this down; a transcript is unreliable here.",
      });
      continue;
    }

    (applied as Record<string, unknown>)[field] = aiValue;
  }

  /* ------------------------------- escalation ---------------------------- */
  if (confidence < settings.confidenceFloor) reasons.push("low_confidence");
  if (diffs.some((d) => d.material)) reasons.push("material_disagreement");
  if (ai.doNotCallRequested === true || human.doNotCallRequested === true) {
    reasons.push("do_not_call_heard");
  }
  if ((ai.objections || []).some((o) => /complaint|lawyer|legal|harass/i.test(o))) {
    reasons.push("complaint_heard");
  }

  const sample = input.sample ?? Math.random();
  if (reasons.length === 0 && sample < settings.spotCheckRate) {
    reasons.push("spot_check");
  }

  return {
    applied,
    held,
    disagreements: diffs,
    escalate: reasons.length > 0,
    reasons: [...new Set(reasons)],
    blockedActions: [...new Set(blockedActions)],
    authority: "ai",
  };
}

/* -------------------------------------------------------------------------- */
/* what the queue says                                                        */
/* -------------------------------------------------------------------------- */

/** One line explaining why this call is in front of a human. */
export function escalationSummary(reasons: EscalationReason[]): string {
  if (reasons.length === 0) return "Applied automatically. Nothing needed looking at.";
  return reasons.map((r) => ESCALATION_LABEL[r]).join(". ") + ".";
}

/**
 * How much of the day's work actually reaches a person. Shown on the review
 * screen so the promise "you will not review 300 calls" stays checkable.
 */
export function reviewLoad(total: number, escalated: number): string {
  if (total === 0) return "No calls analysed yet.";
  const pct = Math.round((escalated / total) * 100);
  return `${escalated} of ${total} calls need a look — ${pct}% of them. The rest were applied automatically.`;
}
