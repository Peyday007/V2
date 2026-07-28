// Caller profiles.
//
// "Is this caller any good?" is really several different questions, and a
// single conversion rate hides all of them. Someone who never gets past a
// receptionist and someone who reaches owners constantly but never books a
// meeting have the same appointments-per-dial and need opposite coaching.
//
// So the profile splits the job into the skills it actually consists of:
//
//   Volume   — are they making the calls at all?
//   Opening  — once a human answers, do they get to the owner?
//   Closing  — once they have the owner, do they book the meeting?
//   Capture  — do they write down what they learned, for everyone else?
//
// Every comparison is against the rest of the team over the same period, and
// every one carries a significance test. A recommendation that could get
// somebody fired must never come from noise, so the bar for a negative
// judgement is deliberately higher than for a positive one.

import {
  type CallFact,
  type ObjectionFact,
  twoProportionZ,
  pValue,
  wilson,
  confidenceFor,
  segmentBy,
  type Confidence,
  type Interval,
} from "./analytics";

/* -------------------------------------------------------------------------- */
/* thresholds                                                                 */
/* -------------------------------------------------------------------------- */

/** Below this many calls, a caller gets no judgement at all. */
export const MIN_CALLS_FOR_PROFILE = 20;
/** Denominator needed before a specific skill is scored. */
export const MIN_FOR_SKILL = 15;
/** Denominator needed before an industry is called a strength. */
export const MIN_FOR_INDUSTRY = 12;
/** Praise needs this. */
export const P_POSITIVE = 0.05;
/**
 * Criticism needs this — stricter, because acting on it costs someone their
 * job. A one-in-twenty fluke is not grounds for that.
 */
export const P_NEGATIVE = 0.01;

/* -------------------------------------------------------------------------- */
/* skills                                                                     */
/* -------------------------------------------------------------------------- */

export type SkillKey = "opening" | "closing" | "connecting";

export type Skill = {
  key: SkillKey;
  label: string;
  /** What the numerator and denominator actually mean, in words. */
  meaning: string;
  successes: number;
  trials: number;
  rate: number;
  interval: Interval;
  /** The same rate for everyone else, over the same calls. */
  teamRate: number | null;
  teamTrials: number;
  /** Positive means better than the rest of the team. */
  delta: number | null;
  pValue: number | null;
  verdict: "strong" | "weak" | "on_par" | "not_enough_data";
  confidence: Confidence;
};

const NO_CONTACT = ["no_answer", "voicemail", "bad_number"];

/** Did a human pick up? Uses who they spoke with when recorded. */
export function talkedToSomeone(c: CallFact): boolean {
  if (c.spoke_with_role === "owner" || c.spoke_with_role === "gatekeeper") return true;
  if (c.spoke_with_role === "employee") return true;
  return !NO_CONTACT.includes(c.outcome);
}

function reachedOwnerOn(c: CallFact): boolean {
  return c.reached_dm === true;
}
function booked(c: CallFact): boolean {
  return c.outcome === "appointment_set";
}

function buildSkill(
  key: SkillKey,
  label: string,
  meaning: string,
  mine: { successes: number; trials: number },
  theirs: { successes: number; trials: number }
): Skill {
  const interval = wilson(mine.successes, mine.trials);
  const teamRate = theirs.trials > 0 ? theirs.successes / theirs.trials : null;
  const rate = mine.trials > 0 ? mine.successes / mine.trials : 0;

  let verdict: Skill["verdict"] = "not_enough_data";
  let p: number | null = null;

  if (mine.trials >= MIN_FOR_SKILL && theirs.trials >= MIN_FOR_SKILL && teamRate !== null) {
    p = pValue(twoProportionZ(mine.successes, mine.trials, theirs.successes, theirs.trials));
    if (rate > teamRate && p < P_POSITIVE) verdict = "strong";
    else if (rate < teamRate && p < P_NEGATIVE) verdict = "weak";
    else verdict = "on_par";
  }

  return {
    key,
    label,
    meaning,
    successes: mine.successes,
    trials: mine.trials,
    rate,
    interval,
    teamRate,
    teamTrials: theirs.trials,
    delta: teamRate === null ? null : rate - teamRate,
    pValue: p,
    verdict,
    confidence: confidenceFor(mine.trials),
  };
}

function tally(calls: CallFact[]) {
  const talked = calls.filter(talkedToSomeone);
  const owners = calls.filter(reachedOwnerOn);
  return {
    connecting: { successes: talked.length, trials: calls.length },
    opening: { successes: owners.length, trials: talked.length },
    closing: { successes: calls.filter(booked).length, trials: owners.length },
  };
}

/* -------------------------------------------------------------------------- */
/* industry affinity                                                          */
/* -------------------------------------------------------------------------- */

export type IndustryFit = {
  industry: string;
  calls: number;
  ownerConversations: number;
  rate: number;
  teamRate: number | null;
  pValue: number | null;
  verdict: "strong" | "weak" | "on_par" | "not_enough_data";
};

export function industryFit(mine: CallFact[], others: CallFact[]): IndustryFit[] {
  const mineByIndustry = segmentBy(mine, (c) => c.lead_industry, reachedOwnerOn, {
    order: "trials",
  });

  return mineByIndustry.map((seg) => {
    const theirs = others.filter((c) => c.lead_industry === seg.key);
    const teamSuccess = theirs.filter(reachedOwnerOn).length;
    const teamRate = theirs.length > 0 ? teamSuccess / theirs.length : null;

    let verdict: IndustryFit["verdict"] = "not_enough_data";
    let p: number | null = null;
    if (seg.trials >= MIN_FOR_INDUSTRY && theirs.length >= MIN_FOR_INDUSTRY && teamRate !== null) {
      p = pValue(twoProportionZ(seg.successes, seg.trials, teamSuccess, theirs.length));
      if (seg.rate > teamRate && p < P_POSITIVE) verdict = "strong";
      else if (seg.rate < teamRate && p < P_NEGATIVE) verdict = "weak";
      else verdict = "on_par";
    }

    return {
      industry: seg.key,
      calls: seg.trials,
      ownerConversations: seg.successes,
      rate: seg.rate,
      teamRate,
      pValue: p,
      verdict,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* recommendations                                                            */
/* -------------------------------------------------------------------------- */

export type RecommendationKey =
  | "not_enough_data"
  | "low_volume"
  | "coach_opening"
  | "coach_closing"
  | "strong_opener"
  | "strong_closer"
  | "route_industry"
  | "model_for_team"
  | "needs_review"
  | "poor_capture";

export type Recommendation = {
  key: RecommendationKey;
  /** What to do, in one line. */
  action: string;
  /** The numbers it rests on. Always present — no unsupported advice. */
  evidence: string;
  severity: "info" | "positive" | "attention" | "serious";
};

/* -------------------------------------------------------------------------- */
/* the profile                                                                */
/* -------------------------------------------------------------------------- */

export type CallerProfile = {
  callerName: string;
  calls: number;
  daysActive: number;
  callsPerActiveDay: number;
  ownerConversations: number;
  appointments: number;
  medianDurationSeconds: number | null;
  /** How often they saved something durable about the lead. */
  intelCaptureRate: number | null;
  objectionsHandled: number;
  objectionsSurvived: number;
  skills: Skill[];
  industries: IndustryFit[];
  recommendations: Recommendation[];
  /** Industries to bias this caller's next packet toward. Empty when unproven. */
  routeToIndustries: string[];
  headline: string;
};

function pctText(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function daysActiveIn(calls: CallFact[]): number {
  const days = new Set(calls.map((c) => c.created_at.slice(0, 10)));
  return days.size;
}

export type ProfileInput = {
  callerName: string;
  mine: CallFact[];
  others: CallFact[];
  /** Calls on which this caller recorded new lead intelligence. */
  intelCaptureCount?: number;
  objections?: ObjectionFact[];
  /** Team median calls per active day, for the volume check. */
  teamCallsPerDay?: number | null;
};

export function buildCallerProfile(input: ProfileInput): CallerProfile {
  const { mine, others, callerName } = input;
  const mineTally = tally(mine);
  const othersTally = tally(others);

  const skills: Skill[] = [
    buildSkill(
      "connecting",
      "Getting through",
      "How often a dial reaches a live person at all",
      mineTally.connecting,
      othersTally.connecting
    ),
    buildSkill(
      "opening",
      "Opening",
      "Once someone picks up, how often they get to the owner",
      mineTally.opening,
      othersTally.opening
    ),
    buildSkill(
      "closing",
      "Closing",
      "Once they have the owner, how often they book a meeting",
      mineTally.closing,
      othersTally.closing
    ),
  ];

  const industries = industryFit(mine, others);
  const days = daysActiveIn(mine);
  const perDay = days > 0 ? mine.length / days : 0;

  const durations = mine
    .map((c) => c.duration_seconds)
    .filter((d): d is number => typeof d === "number" && d > 0)
    .sort((a, b) => a - b);

  const objectionsHandled = (input.objections || []).length;
  const objectionsSurvived = (input.objections || []).filter(
    (o) => o.reached_dm === true || o.outcome === "appointment_set"
  ).length;

  const intelCaptureRate =
    input.intelCaptureCount !== undefined && mine.length > 0
      ? input.intelCaptureCount / mine.length
      : null;

  const recommendations = recommend({
    callerName,
    mine,
    skills,
    industries,
    perDay,
    teamCallsPerDay: input.teamCallsPerDay ?? null,
    intelCaptureRate,
  });

  const routeToIndustries = industries
    .filter((i) => i.verdict === "strong")
    .map((i) => i.industry);

  const strong = skills.filter((s) => s.verdict === "strong").map((s) => s.label.toLowerCase());
  const weak = skills.filter((s) => s.verdict === "weak").map((s) => s.label.toLowerCase());
  let headline: string;
  if (mine.length < MIN_CALLS_FOR_PROFILE) {
    headline = `${mine.length} calls so far — too few to judge anything`;
  } else if (strong.length && weak.length) {
    headline = `Strong at ${strong.join(" and ")}, weak at ${weak.join(" and ")}`;
  } else if (strong.length) {
    headline = `Strong at ${strong.join(" and ")}`;
  } else if (weak.length) {
    headline = `Struggling with ${weak.join(" and ")}`;
  } else {
    headline = "Performing in line with the rest of the team";
  }

  return {
    callerName,
    calls: mine.length,
    daysActive: days,
    callsPerActiveDay: Math.round(perDay * 10) / 10,
    ownerConversations: mine.filter(reachedOwnerOn).length,
    appointments: mine.filter(booked).length,
    medianDurationSeconds: durations.length
      ? durations[Math.floor(durations.length / 2)]
      : null,
    intelCaptureRate,
    objectionsHandled,
    objectionsSurvived,
    skills,
    industries,
    recommendations,
    routeToIndustries,
    headline,
  };
}

function recommend(ctx: {
  callerName: string;
  mine: CallFact[];
  skills: Skill[];
  industries: IndustryFit[];
  perDay: number;
  teamCallsPerDay: number | null;
  intelCaptureRate: number | null;
}): Recommendation[] {
  const out: Recommendation[] = [];
  const skill = (k: SkillKey) => ctx.skills.find((s) => s.key === k)!;

  if (ctx.mine.length < MIN_CALLS_FOR_PROFILE) {
    return [
      {
        key: "not_enough_data",
        action: "Nothing to judge yet — let them keep dialing",
        evidence: `${ctx.mine.length} calls logged. A profile needs at least ${MIN_CALLS_FOR_PROFILE}, and each individual skill needs ${MIN_FOR_SKILL} of its own.`,
        severity: "info",
      },
    ];
  }

  // Volume is a plain count, not a rate — no significance test needed, and it
  // is the one thing you can fairly raise on day one.
  if (ctx.teamCallsPerDay && ctx.perDay < ctx.teamCallsPerDay * 0.6) {
    out.push({
      key: "low_volume",
      action: "Ask about call volume before anything else",
      evidence: `${ctx.perDay.toFixed(1)} calls per working day against a team average of ${ctx.teamCallsPerDay.toFixed(1)}. Rates cannot be compared fairly until the volume is comparable.`,
      severity: "attention",
    });
  }

  const opening = skill("opening");
  const closing = skill("closing");

  if (opening.verdict === "weak") {
    out.push({
      key: "coach_opening",
      action: "Coach the opener — they are losing calls at the gatekeeper",
      evidence: `Reaches the owner on ${pctText(opening.rate)} of answered calls (${opening.successes}/${opening.trials}) against ${pctText(opening.teamRate ?? 0)} for the rest of the team. p = ${opening.pValue?.toFixed(3)}.`,
      severity: "attention",
    });
  }
  if (closing.verdict === "weak") {
    out.push({
      key: "coach_closing",
      action: "Coach the close — they get to owners but do not book them",
      evidence: `Books ${pctText(closing.rate)} of owner conversations (${closing.successes}/${closing.trials}) against ${pctText(closing.teamRate ?? 0)} for the rest of the team. p = ${closing.pValue?.toFixed(3)}.`,
      severity: "attention",
    });
  }
  if (opening.verdict === "strong") {
    out.push({
      key: "strong_opener",
      action: "Have them teach the others how they get past reception",
      evidence: `Reaches the owner on ${pctText(opening.rate)} of answered calls against ${pctText(opening.teamRate ?? 0)} for the rest of the team.`,
      severity: "positive",
    });
  }
  if (closing.verdict === "strong") {
    out.push({
      key: "strong_closer",
      action: "Give them the warm leads — callbacks and second attempts",
      evidence: `Books ${pctText(closing.rate)} of owner conversations against ${pctText(closing.teamRate ?? 0)} for the rest of the team.`,
      severity: "positive",
    });
  }

  for (const ind of ctx.industries.filter((i) => i.verdict === "strong")) {
    out.push({
      key: "route_industry",
      action: `Send them more ${ind.industry} leads`,
      evidence: `${pctText(ind.rate)} owner-reached in ${ind.industry} (${ind.ownerConversations}/${ind.calls}) against ${pctText(ind.teamRate ?? 0)} for everyone else.`,
      severity: "positive",
    });
  }

  if (opening.verdict === "strong" && closing.verdict === "strong") {
    out.push({
      key: "model_for_team",
      action: "Promote — they are ahead on both halves of the job",
      evidence: `Strong at opening and closing, over ${ctx.mine.length} calls.`,
      severity: "positive",
    });
  }

  if (opening.verdict === "weak" && closing.verdict === "weak") {
    out.push({
      key: "needs_review",
      action: "Sit in on their calls before deciding anything",
      evidence: `Behind the rest of the team on both opening and closing across ${ctx.mine.length} calls, each at p < ${P_NEGATIVE}. That is a real gap, but it is a coaching conversation first — this system cannot tell you whether it is fixable.`,
      severity: "serious",
    });
  }

  if (ctx.intelCaptureRate !== null && ctx.intelCaptureRate < 0.1 && ctx.mine.length >= MIN_CALLS_FOR_PROFILE) {
    out.push({
      key: "poor_capture",
      action: "Remind them to record what they learn on a call",
      evidence: `Saved new information about the business on ${pctText(ctx.intelCaptureRate)} of calls. Anything not written down is rediscovered by the next caller.`,
      severity: "attention",
    });
  }

  if (out.length === 0) {
    out.push({
      key: "not_enough_data",
      action: "No change needed",
      evidence: `Nothing separates them from the rest of the team by more than chance across ${ctx.mine.length} calls.`,
      severity: "info",
    });
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* team view                                                                  */
/* -------------------------------------------------------------------------- */

export function buildAllProfiles(
  calls: CallFact[],
  opts?: {
    intelCaptureByCaller?: Record<string, number>;
    objectionsByCaller?: Record<string, ObjectionFact[]>;
  }
): CallerProfile[] {
  const names = [...new Set(calls.map((c) => c.caller_name).filter((n): n is string => !!n))];

  // Team baseline for volume: median calls per active day across callers.
  const perDay = names
    .map((n) => {
      const mine = calls.filter((c) => c.caller_name === n);
      const d = daysActiveIn(mine);
      return d > 0 ? mine.length / d : 0;
    })
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const teamCallsPerDay = perDay.length ? perDay[Math.floor(perDay.length / 2)] : null;

  return names
    .map((name) =>
      buildCallerProfile({
        callerName: name,
        mine: calls.filter((c) => c.caller_name === name),
        others: calls.filter((c) => c.caller_name !== name),
        intelCaptureCount: opts?.intelCaptureByCaller?.[name],
        objections: opts?.objectionsByCaller?.[name],
        teamCallsPerDay,
      })
    )
    .sort((a, b) => b.calls - a.calls);
}
