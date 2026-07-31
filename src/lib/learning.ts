// The coaching learning engine.
//
// The rule this module exists to enforce: the system does not rewrite its own
// production instructions. It gathers evidence, proposes a change with that
// evidence attached, waits for a person to approve it, tests it against the
// current baseline, and promotes it only if the primary metric improves AND
// nothing on the guardrail list gets worse.
//
// Two failure modes it is built to prevent:
//
//   Optimising toward activity. Meetings booked is a leading indicator; a
//   change that books more meetings and sells less is a regression. So the
//   guardrails include attended meetings and sales, and a proposal that
//   improves the primary metric while harming one of them is REJECTED, not
//   promoted with a caveat.
//
//   Learning from noise. Every proposal carries a minimum sample, a
//   significance test against the baseline, and the confounders it could and
//   could not control for.

import { twoProportionZ, pValue, wilson, type Interval } from "./analytics";

export type LearningDimension =
  | "opening"
  | "question"
  | "objection_response"
  | "followup_pattern"
  | "timing";

export type OutcomeType =
  | "live_answer"
  | "owner_conversation"
  | "qualified_opportunity"
  | "meeting_booked"
  | "meeting_attended"
  | "sale"
  | "refund"
  | "complaint"
  | "do_not_call";

/** Outcomes that must never get worse, whatever the primary metric does. */
export const GUARDRAIL_OUTCOMES: OutcomeType[] = [
  "meeting_attended",
  "sale",
  "complaint",
  "do_not_call",
  "refund",
];

/** Guardrails where MORE is worse. */
export const NEGATIVE_OUTCOMES: OutcomeType[] = ["complaint", "do_not_call", "refund"];

export type Observation = {
  callId: string;
  callerId?: string | null;
  dimension: LearningDimension;
  /** Which approach was used. The thing being compared. */
  variant: string;
  industry?: string | null;
  leadSource?: string | null;
  localHour?: number | null;
  outcomeType?: OutcomeType | null;
  succeeded?: boolean | null;
};

export type VariantStats = {
  variant: string;
  trials: number;
  successes: number;
  rate: number;
  interval: Interval;
  /** Distinct callers behind it — one caller's habit is not a finding. */
  callers: number;
  industries: number;
};

export function summariseVariants(
  observations: Observation[],
  primaryMetric: OutcomeType
): VariantStats[] {
  const groups = new Map<string, Observation[]>();
  for (const o of observations) {
    if (o.outcomeType && o.outcomeType !== primaryMetric) continue;
    if (o.succeeded === null || o.succeeded === undefined) continue;
    if (!groups.has(o.variant)) groups.set(o.variant, []);
    groups.get(o.variant)!.push(o);
  }

  return [...groups.entries()]
    .map(([variant, rows]) => {
      const successes = rows.filter((r) => r.succeeded).length;
      return {
        variant,
        trials: rows.length,
        successes,
        rate: rows.length > 0 ? successes / rows.length : 0,
        interval: wilson(successes, rows.length),
        callers: new Set(rows.map((r) => r.callerId).filter(Boolean)).size,
        industries: new Set(rows.map((r) => r.industry).filter(Boolean)).size,
      };
    })
    .sort((a, b) => b.rate - a.rate);
}

export type ProposalEvidence = {
  dimension: LearningDimension;
  baselineVariant: string;
  candidateVariant: string;
  baselineRate: number;
  candidateRate: number;
  sampleSize: number;
  pValue: number;
  confidence: number;
  supportingCallIds: string[];
  controlledFor: string[];
  notControlledFor: string[];
};

export type ProposalDecision =
  | { propose: true; evidence: ProposalEvidence; summary: string }
  | { propose: false; reason: string };

export type ProposeOptions = {
  minimumSample: number;
  primaryMetric: OutcomeType;
  /** Distinct callers required, so one person's style is not adopted as policy. */
  minimumCallers?: number;
};

/**
 * Look for a change worth proposing. Returns a refusal far more often than a
 * proposal, which is correct — most differences are noise.
 */
export function proposeChange(
  observations: Observation[],
  opts: ProposeOptions
): ProposalDecision {
  const minCallers = opts.minimumCallers ?? 2;
  const stats = summariseVariants(observations, opts.primaryMetric);

  if (stats.length < 2) {
    return {
      propose: false,
      reason:
        stats.length === 0
          ? "No usable observations yet."
          : `Only one approach has been tried (${stats[0].variant}). There is nothing to compare it against.`,
    };
  }

  // Rank by the LOWER bound: a small perfect sample must not win.
  const ranked = [...stats].sort((a, b) => b.interval.low - a.interval.low);
  const candidate = ranked[0];
  const baseline = [...stats].sort((a, b) => b.trials - a.trials)[0];

  if (candidate.variant === baseline.variant) {
    return {
      propose: false,
      reason: `The most-used approach (${baseline.variant}) is also the best performing. Nothing to change.`,
    };
  }

  if (candidate.trials < opts.minimumSample || baseline.trials < opts.minimumSample) {
    const short = Math.max(
      opts.minimumSample - candidate.trials,
      opts.minimumSample - baseline.trials
    );
    return {
      propose: false,
      reason: `Not enough calls yet — about ${short} more needed before this could be judged (minimum ${opts.minimumSample} per approach).`,
    };
  }

  if (candidate.callers < minCallers) {
    return {
      propose: false,
      reason: `Only ${candidate.callers} caller has used "${candidate.variant}". That is one person's style, not a better approach.`,
    };
  }

  const z = twoProportionZ(
    candidate.successes,
    candidate.trials,
    baseline.successes,
    baseline.trials
  );
  const p = pValue(z);
  if (candidate.rate <= baseline.rate || p >= 0.05) {
    return {
      propose: false,
      reason: `"${candidate.variant}" is ahead of "${baseline.variant}" but the difference is within normal variation (p = ${p.toFixed(2)}).`,
    };
  }

  const observationsFor = observations.filter(
    (o) => o.variant === candidate.variant || o.variant === baseline.variant
  );
  const controlled: string[] = [];
  const notControlled: string[] = [];
  for (const [name, key] of [
    ["caller", "callerId"],
    ["industry", "industry"],
    ["lead source", "leadSource"],
    ["time of day", "localHour"],
  ] as const) {
    const values = new Set(
      observationsFor.map((o) => (o as unknown as Record<string, unknown>)[key]).filter(Boolean)
    );
    // Spread across several values means the difference is not just that one
    // value. A single value means the comparison is confounded by it.
    if (values.size >= 2) controlled.push(name);
    else notControlled.push(name);
  }

  return {
    propose: true,
    summary: `Use "${candidate.variant}" instead of "${baseline.variant}" for ${opts.primaryMetric.replace(/_/g, " ")}.`,
    evidence: {
      dimension: observationsFor[0]?.dimension ?? "opening",
      baselineVariant: baseline.variant,
      candidateVariant: candidate.variant,
      baselineRate: baseline.rate,
      candidateRate: candidate.rate,
      sampleSize: candidate.trials + baseline.trials,
      pValue: p,
      confidence: 1 - p,
      supportingCallIds: observationsFor.map((o) => o.callId).slice(0, 500),
      controlledFor: controlled,
      notControlledFor: notControlled,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* experiments                                                                */
/* -------------------------------------------------------------------------- */

/** Stable arm assignment: the same call always lands in the same arm. */
export function assignArm(
  callId: string,
  trafficPercent: number
): "baseline" | "candidate" {
  let hash = 0;
  for (let i = 0; i < callId.length; i++) {
    hash = (hash * 31 + callId.charCodeAt(i)) >>> 0;
  }
  return hash % 100 < trafficPercent ? "candidate" : "baseline";
}

export type ArmResult = {
  trials: number;
  successes: number;
};

export type GuardrailResult = {
  outcome: OutcomeType;
  baseline: ArmResult;
  candidate: ArmResult;
  worse: boolean;
  detail: string;
};

export type ExperimentVerdict = {
  decision: "promote" | "keep_running" | "abandon";
  reason: string;
  primaryImproved: boolean;
  primaryPValue: number | null;
  guardrails: GuardrailResult[];
};

export type EvaluateInput = {
  primaryMetric: OutcomeType;
  baseline: ArmResult;
  candidate: ArmResult;
  guardrails: { outcome: OutcomeType; baseline: ArmResult; candidate: ArmResult }[];
  minimumSample: number;
};

/**
 * Decide an experiment. Promotion requires BOTH a real improvement in the
 * primary metric AND no guardrail moving the wrong way — a change that books
 * more meetings while fewer of them are attended is a regression dressed up as
 * a win.
 */
export function evaluateExperiment(input: EvaluateInput): ExperimentVerdict {
  const { baseline, candidate, primaryMetric, minimumSample } = input;

  const guardrails: GuardrailResult[] = input.guardrails.map((g) => {
    const bRate = g.baseline.trials > 0 ? g.baseline.successes / g.baseline.trials : 0;
    const cRate = g.candidate.trials > 0 ? g.candidate.successes / g.candidate.trials : 0;
    const moreIsWorse = NEGATIVE_OUTCOMES.includes(g.outcome);
    const enough = g.baseline.trials >= 10 && g.candidate.trials >= 10;
    // A guardrail only trips on a meaningful move, not on a rounding wobble.
    const delta = cRate - bRate;
    const worse = enough && (moreIsWorse ? delta > 0.02 : delta < -0.02);
    return {
      outcome: g.outcome,
      baseline: g.baseline,
      candidate: g.candidate,
      worse,
      detail: `${(bRate * 100).toFixed(0)}% → ${(cRate * 100).toFixed(0)}%${
        enough ? "" : " (too few to judge)"
      }`,
    };
  });

  const tripped = guardrails.filter((g) => g.worse);
  if (tripped.length > 0) {
    return {
      decision: "abandon",
      reason: `Guardrail moved the wrong way: ${tripped
        .map((g) => `${g.outcome.replace(/_/g, " ")} ${g.detail}`)
        .join("; ")}. The change is not promoted even if the primary metric improved.`,
      primaryImproved: false,
      primaryPValue: null,
      guardrails,
    };
  }

  if (baseline.trials < minimumSample || candidate.trials < minimumSample) {
    return {
      decision: "keep_running",
      reason: `Needs ${minimumSample} calls per arm; currently ${baseline.trials} and ${candidate.trials}.`,
      primaryImproved: false,
      primaryPValue: null,
      guardrails,
    };
  }

  const bRate = baseline.successes / baseline.trials;
  const cRate = candidate.successes / candidate.trials;
  const p = pValue(
    twoProportionZ(candidate.successes, candidate.trials, baseline.successes, baseline.trials)
  );

  if (cRate > bRate && p < 0.05) {
    return {
      decision: "promote",
      reason: `${primaryMetric.replace(/_/g, " ")} rose from ${(bRate * 100).toFixed(0)}% to ${(cRate * 100).toFixed(0)}% (p = ${p.toFixed(3)}) with no guardrail harmed.`,
      primaryImproved: true,
      primaryPValue: p,
      guardrails,
    };
  }

  if (cRate < bRate && p < 0.05) {
    return {
      decision: "abandon",
      reason: `The change performed worse: ${(bRate * 100).toFixed(0)}% → ${(cRate * 100).toFixed(0)}% (p = ${p.toFixed(3)}).`,
      primaryImproved: false,
      primaryPValue: p,
      guardrails,
    };
  }

  return {
    decision: "keep_running",
    reason: `No clear difference yet (p = ${p.toFixed(2)}).`,
    primaryImproved: false,
    primaryPValue: p,
    guardrails,
  };
}
