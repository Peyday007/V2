// The grade, and the gate it controls.
//
// This is the change that fixes the actual problem. Before it, any lead with a
// working main line went into the caller queue — so 111 live answers produced
// 6 owner conversations, because most of those answers were receptionists on a
// switchboard nobody had a name for.
//
// Now a lead is only call-ready if it carries a decision-maker AND a number
// that reaches them. C and D leads still exist, still get worked, but through
// a separate main-line campaign rather than mixed into the direct queue where
// they quietly halve the owner-conversation rate.

import {
  isDirectOwnerLine,
  PHONE_CLASS_RANK,
  type PhoneClass,
} from "./phoneIntel";
import { MIN_DM_CONFIDENCE } from "./decisionMaker";

export const GRADES = ["A", "B", "C", "D"] as const;
export type Grade = (typeof GRADES)[number];

export const GRADE_MEANING: Record<Grade, string> = {
  A: "Verified decision-maker with a verified mobile or direct line",
  B: "Confidently identified decision-maker with a probable mobile or direct line",
  C: "Decision-maker identified, but only the main business number",
  D: "No confidently identified decision-maker",
};

/** Only these reach the direct-call queue. */
export const CALL_READY_GRADES: Grade[] = ["A", "B"];

export function isCallReady(grade: Grade | null | undefined): boolean {
  return !!grade && CALL_READY_GRADES.includes(grade);
}

/** Confidence at which the decision-maker counts as verified rather than likely. */
export const VERIFIED_DM_CONFIDENCE = 0.8;

export type GradeInput = {
  decisionMakerName: string | null | undefined;
  decisionMakerConfidence: number | null | undefined;
  phoneClass: PhoneClass | null | undefined;
  /** A direct number exists and passed validation. */
  directPhone: string | null | undefined;
};

export type GradeResult = {
  grade: Grade;
  reason: string;
  callReady: boolean;
};

export function gradeLead(input: GradeInput): GradeResult {
  const name = (input.decisionMakerName || "").trim();
  const confidence = input.decisionMakerConfidence ?? 0;

  if (!name || confidence < MIN_DM_CONFIDENCE) {
    return {
      grade: "D",
      reason: name
        ? `A name was proposed but only scored ${confidence.toFixed(2)} — below the ${MIN_DM_CONFIDENCE} floor for asserting a decision-maker.`
        : "No decision-maker could be identified from any source.",
      callReady: false,
    };
  }

  const cls = input.phoneClass ?? "unknown";
  const hasDirect = !!input.directPhone && isDirectOwnerLine(cls);

  if (!hasDirect) {
    return {
      grade: "C",
      reason: `${name} was identified, but no direct number was found — only the main business line.`,
      callReady: false,
    };
  }

  const verifiedNumber =
    cls === "verified_owner_mobile" || cls === "verified_owner_direct";
  const verifiedPerson = confidence >= VERIFIED_DM_CONFIDENCE;

  if (verifiedNumber && verifiedPerson) {
    return {
      grade: "A",
      reason: `${name} verified, with a verified ${cls === "verified_owner_mobile" ? "mobile" : "direct line"}.`,
      callReady: true,
    };
  }

  return {
    grade: "B",
    reason: verifiedNumber
      ? `Verified number, but ${name} is identified at ${confidence.toFixed(2)} rather than verified.`
      : `${name} identified, with a probable direct number that no provider verified.`,
    callReady: true,
  };
}

/* -------------------------------------------------------------------------- */
/* the order callers work in                                                  */
/* -------------------------------------------------------------------------- */

export type AssignmentCandidate = {
  leadId: string;
  grade: Grade;
  phoneClass: PhoneClass;
  decisionMakerConfidence: number;
  /** ISO timestamp of the last successful validation. */
  validatedAt: string | null;
};

/**
 * Grade first, then number quality, then how sure we are of the person, then
 * freshness. Sorting on anything else — proximity, alphabetical, insertion
 * order — spends a caller's morning on the weakest records in the packet.
 */
export function compareForAssignment(
  a: AssignmentCandidate,
  b: AssignmentCandidate
): number {
  const grade = GRADES.indexOf(a.grade) - GRADES.indexOf(b.grade);
  if (grade !== 0) return grade;

  const cls = PHONE_CLASS_RANK[a.phoneClass] - PHONE_CLASS_RANK[b.phoneClass];
  if (cls !== 0) return cls;

  const conf = (b.decisionMakerConfidence ?? 0) - (a.decisionMakerConfidence ?? 0);
  if (Math.abs(conf) > 0.001) return conf;

  const at = a.validatedAt ? Date.parse(a.validatedAt) : 0;
  const bt = b.validatedAt ? Date.parse(b.validatedAt) : 0;
  return bt - at;
}

export function orderForAssignment<T extends AssignmentCandidate>(rows: T[]): T[] {
  return [...rows].sort(compareForAssignment);
}

/** Only A and B, in order. C and D belong to a main-line campaign. */
export function callReadyOnly<T extends AssignmentCandidate>(rows: T[]): T[] {
  return orderForAssignment(rows.filter((r) => isCallReady(r.grade)));
}

/* -------------------------------------------------------------------------- */
/* using the order against real lead rows                                      */
/* -------------------------------------------------------------------------- */

/**
 * The columns a packet query must select for the order above to mean anything.
 * Kept next to the comparator so a query cannot quietly stop sorting because
 * somebody trimmed a select list.
 */
export const ASSIGNMENT_COLUMNS =
  "enrichment_grade, direct_phone_class, decision_maker_confidence, direct_phone_validated_at";

/**
 * Does this error mean the enrichment columns simply are not there?
 *
 * Every column in ASSIGNMENT_COLUMNS arrives with migration 0023. Selecting or
 * ordering by one before that migration has run is a hard query error, and
 * because packet creation and packet top-up both do exactly that, the entire
 * lead pipeline returned a 500 for anybody who had not run it. Pressing "Add
 * leads" appeared to do nothing and the packet stayed empty.
 *
 * Enrichment is an ENHANCEMENT to ordering. It must never be the reason a
 * caller cannot be given work, so its queries fall back to a plain select when
 * the columns are absent.
 */
export function isMissingColumnError(
  err: { message?: string | null } | null | undefined
): boolean {
  const message = err?.message || "";
  if (!message) return false;
  return /column .* does not exist|could not find the .* column|schema cache/i.test(message);
}

export type EnrichedLeadRow = {
  id: string;
  enrichment_grade?: string | null;
  direct_phone_class?: string | null;
  decision_maker_confidence?: number | null;
  direct_phone_validated_at?: string | null;
  /** For the learning tilt below. Both optional; absent means no tilt. */
  industry?: string | null;
  diagnostic_findings?: { service?: string }[] | null;
};

/**
 * The same order, tilted by what actually converts.
 *
 * A caller's first hour is their best one, so which lead is at the top of the
 * packet is a real decision. The evidence-based order goes on top of the
 * quality order rather than replacing it: `leadScore` is bounded and
 * multiplicative, so a well-evidenced lead with a bad number still loses to a
 * good number, and a lead in a trade with no data is untouched.
 *
 * The scorer is injected rather than imported so this file stays pure and the
 * caller decides whether learning is switched on at all.
 */
/** The most places the evidence may move a lead. Deliberately small. */
export const MAX_LEARNING_SHIFT = 2;

export function orderWithLearning<T extends EnrichedLeadRow>(
  rows: T[],
  score: (lead: { industry?: string | null; angles?: string[] | null }) => number
): { ordered: T[]; moved: { id: string; from: number; to: number; score: number }[] } {
  const baseline = orderLeadsForAssignment(rows);
  const positionBefore = new Map(baseline.map((r, i) => [r.id, i]));

  const scored = baseline.map((row, index) => {
    const s = score({
      industry: row.industry ?? null,
      angles: (row.diagnostic_findings || [])
        .map((f) => f?.service)
        .filter((v): v is string => !!v),
    });
    /*
     * The learning moves a lead a bounded number of PLACES, and no more.
     *
     * Stated as positions rather than as a multiplier on purpose: "the
     * evidence can move a lead up to two places" is a sentence somebody can
     * check, whereas a divisor produces knife-edges where a 2x score exactly
     * ties with being one position further back, and nobody can predict when.
     *
     * The consequence is the one that matters: a lead five places down cannot
     * reach the front on the strength of its trade. Whether it has a validated
     * direct number still decides that, because that is what actually makes
     * the caller's next hour productive.
     */
    return { row, rank: index + 1 - (s - 1) * MAX_LEARNING_SHIFT };
  });

  scored.sort((a, b) => a.rank - b.rank);
  const ordered = scored.map((s) => s.row);

  const moved: { id: string; from: number; to: number; score: number }[] = [];
  ordered.forEach((row, to) => {
    const from = positionBefore.get(row.id) ?? to;
    if (from !== to) {
      moved.push({
        id: row.id,
        from,
        to,
        score: Number((scored.find((s) => s.row.id === row.id)?.rank ?? 0).toFixed(3)),
      });
    }
  });

  return { ordered, moved };
}

/**
 * Order lead rows the way a caller should work them: the best-evidenced owner
 * with the best number first.
 *
 * Anything ungraded sorts last rather than being dropped — the availability
 * filter is what decides who gets into a packet at all, and having two places
 * able to exclude a lead is how a packet silently comes back empty.
 */
export function orderLeadsForAssignment<T extends EnrichedLeadRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    compareForAssignment(
      {
        leadId: a.id,
        grade: (GRADES as readonly string[]).includes(a.enrichment_grade ?? "")
          ? (a.enrichment_grade as Grade)
          : "D",
        phoneClass: (a.direct_phone_class as PhoneClass) ?? "unknown",
        decisionMakerConfidence: a.decision_maker_confidence ?? 0,
        validatedAt: a.direct_phone_validated_at ?? null,
      },
      {
        leadId: b.id,
        grade: (GRADES as readonly string[]).includes(b.enrichment_grade ?? "")
          ? (b.enrichment_grade as Grade)
          : "D",
        phoneClass: (b.direct_phone_class as PhoneClass) ?? "unknown",
        decisionMakerConfidence: b.decision_maker_confidence ?? 0,
        validatedAt: b.direct_phone_validated_at ?? null,
      }
    )
  );
}
