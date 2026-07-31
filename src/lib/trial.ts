// Caller tryouts.
//
// Give a candidate a standard packet, let them work it, then score them. The
// value is in being honest about what 100 calls can and cannot settle:
//
//   Effort          — a plain count. Answerable on day one.
//   Getting through — ~100 dials. Answerable.
//   Opening         — ~70 answered calls. Answerable.
//   Capture         — every call is an opportunity. Answerable.
//   Closing         — maybe 15 owner conversations. USUALLY NOT ANSWERABLE.
//
// A trial that quietly averaged those together would produce a confident
// verdict resting mostly on the one number too thin to trust. So each part is
// scored separately and every unanswerable part says so.
//
// The parts above are all scored against the EXISTING TEAM, frozen at the
// moment the trial began. That is the right comparison for "would they fit in
// here" and the wrong one for "are they any good" — a new team's numbers may
// simply be low, in which case matching them is not a reason to hire. So the
// dial-level rates are also scored against the absolute targets from
// ./benchmarks, and a candidate who beats the team while missing the bar gets
// "extend", not "add".

import {
  twoProportionZ,
  pValue,
  wilson,
  type CallFact,
  type Interval,
} from "./analytics";
import { talkedToSomeone, MIN_FOR_SKILL, P_POSITIVE, P_NEGATIVE } from "./callerProfile";
import { assess, type Assessment, type MetricKey, type Target } from "./benchmarks";

/**
 * Which absolute bars a trial is big enough to speak to.
 *
 * Appointment rate is deliberately absent. At a 2% target, a hundred dials
 * expects two bookings — missing the bar there is indistinguishable from bad
 * luck, and it must never contribute to a hiring decision.
 */
const ABSOLUTE_TRIAL_METRICS: MetricKey[] = ["connect_rate", "owner_reach_rate"];

/** Below this many dials, no absolute bar is applied to a trial at all. */
export const MIN_DIALS_FOR_ABSOLUTE = 80;

/** Team performance frozen when the trial began, as counts. */
export type Benchmark = {
  dials: number;
  talked: number;
  ownerConversations: number;
  appointments: number;
  /** Median calls per active day across the existing team. */
  callsPerDay: number | null;
};

export type TrialPartKey = "effort" | "connecting" | "opening" | "closing" | "capture";

export type TrialPart = {
  key: TrialPartKey;
  label: string;
  /** Plain-language description of the measurement. */
  meaning: string;
  successes: number;
  trials: number;
  rate: number | null;
  interval: Interval | null;
  benchmarkRate: number | null;
  pValue: number | null;
  /**
   * settled  — the trial produced enough of this to judge
   * unsettled — measured, but not enough to call either way
   * unmeasured — nothing to measure
   */
  status: "settled" | "unsettled" | "unmeasured";
  verdict: "above" | "below" | "on_par" | "unknown";
  /** Why it could not be settled, when it could not. */
  note?: string;
};

export type TrialRecommendation = {
  key: "add" | "cut" | "extend" | "in_progress";
  action: string;
  evidence: string;
  /** What this trial genuinely could not determine. Never empty in practice. */
  unresolved: string[];
};

export type TrialScore = {
  callsMade: number;
  targetCalls: number;
  percentComplete: number;
  daysActive: number;
  callsPerActiveDay: number;
  parts: TrialPart[];
  /** Dial-level rates against the absolute bar. Empty when no target is set. */
  absolute: Assessment[];
  recommendation: TrialRecommendation;
  headline: string;
};

function pctText(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function judge(
  successes: number,
  trials: number,
  benchSuccesses: number,
  benchTrials: number
): { p: number | null; verdict: TrialPart["verdict"]; status: TrialPart["status"] } {
  if (trials === 0) return { p: null, verdict: "unknown", status: "unmeasured" };
  if (trials < MIN_FOR_SKILL || benchTrials < MIN_FOR_SKILL) {
    return { p: null, verdict: "unknown", status: "unsettled" };
  }
  const rate = successes / trials;
  const benchRate = benchSuccesses / benchTrials;
  const p = pValue(twoProportionZ(successes, trials, benchSuccesses, benchTrials));
  if (rate > benchRate && p < P_POSITIVE) return { p, verdict: "above", status: "settled" };
  if (rate < benchRate && p < P_NEGATIVE) return { p, verdict: "below", status: "settled" };
  return { p, verdict: "on_par", status: "settled" };
}

function part(
  key: TrialPartKey,
  label: string,
  meaning: string,
  successes: number,
  trials: number,
  benchSuccesses: number,
  benchTrials: number,
  noteWhenThin: string
): TrialPart {
  const { p, verdict, status } = judge(successes, trials, benchSuccesses, benchTrials);
  return {
    key,
    label,
    meaning,
    successes,
    trials,
    rate: trials > 0 ? successes / trials : null,
    interval: trials > 0 ? wilson(successes, trials) : null,
    benchmarkRate: benchTrials > 0 ? benchSuccesses / benchTrials : null,
    pValue: p,
    status,
    verdict,
    note: status === "settled" ? undefined : noteWhenThin,
  };
}

export type TrialInput = {
  calls: CallFact[];
  targetCalls: number;
  benchmark: Benchmark;
  /** Calls on which the candidate recorded something durable. */
  intelCaptureCount?: number;
  /** Absolute bars, from /admin/targets. Empty means no bar is asserted. */
  targets?: Target[];
};

export function scoreTrial(input: TrialInput): TrialScore {
  const { calls, targetCalls, benchmark } = input;

  const talked = calls.filter(talkedToSomeone);
  const owners = calls.filter((c) => c.reached_dm === true);
  const appts = calls.filter((c) => c.outcome === "appointment_set");

  const days = new Set(calls.map((c) => c.created_at.slice(0, 10))).size;
  const perDay = days > 0 ? calls.length / days : 0;

  const parts: TrialPart[] = [
    part(
      "connecting",
      "Getting through",
      "How often a dial reached a live person",
      talked.length,
      calls.length,
      benchmark.talked,
      benchmark.dials,
      "Not enough dials yet to compare."
    ),
    part(
      "opening",
      "Opening",
      "Once someone picked up, how often they got to the owner",
      owners.length,
      talked.length,
      benchmark.ownerConversations,
      benchmark.talked,
      "Not enough answered calls yet to compare."
    ),
    part(
      "closing",
      "Closing",
      "Once they had the owner, how often they booked a meeting",
      appts.length,
      owners.length,
      benchmark.appointments,
      benchmark.ownerConversations,
      `Only ${owners.length} owner conversations came out of this trial. A trial this size almost never produces enough of them to judge closing — treat this number as a hint, not a verdict.`
    ),
  ];

  // Effort is a plain count. No significance test applies, and it is the one
  // thing a trial can always answer.
  const effortVerdict: TrialPart["verdict"] =
    benchmark.callsPerDay === null
      ? "unknown"
      : perDay >= benchmark.callsPerDay * 0.9
        ? "above"
        : perDay < benchmark.callsPerDay * 0.6
          ? "below"
          : "on_par";
  parts.unshift({
    key: "effort",
    label: "Effort",
    meaning: "Calls made per day worked",
    successes: calls.length,
    trials: Math.max(1, days),
    rate: perDay,
    interval: null,
    benchmarkRate: benchmark.callsPerDay,
    pValue: null,
    status: days > 0 ? "settled" : "unmeasured",
    verdict: effortVerdict,
    note:
      benchmark.callsPerDay === null
        ? "No existing team to compare against."
        : undefined,
  });

  if (input.intelCaptureCount !== undefined) {
    const rate = calls.length > 0 ? input.intelCaptureCount / calls.length : 0;
    parts.push({
      key: "capture",
      label: "Capture",
      meaning: "How often they wrote down something new about the business",
      successes: input.intelCaptureCount,
      trials: calls.length,
      rate,
      interval: calls.length > 0 ? wilson(input.intelCaptureCount, calls.length) : null,
      benchmarkRate: null,
      pValue: null,
      status: calls.length >= MIN_FOR_SKILL ? "settled" : "unsettled",
      verdict: rate >= 0.25 ? "above" : rate < 0.1 ? "below" : "on_par",
      note:
        calls.length < MIN_FOR_SKILL ? "Too few calls to read anything into this." : undefined,
    });
  }

  const percentComplete = Math.min(
    100,
    Math.round((calls.length / Math.max(1, targetCalls)) * 100)
  );

  /* --------------------------- against the bar --------------------------- */
  const targetBy = new Map((input.targets || []).map((t) => [t.metric, t]));
  const absolute: Assessment[] =
    calls.length < MIN_DIALS_FOR_ABSOLUTE
      ? []
      : ABSOLUTE_TRIAL_METRICS.map((metric) => {
          const successes =
            metric === "connect_rate" ? talked.length : owners.length;
          const teamSuccesses =
            metric === "connect_rate" ? benchmark.talked : benchmark.ownerConversations;
          return assess({
            metric,
            value: successes / calls.length,
            observations: calls.length,
            teamValue: benchmark.dials > 0 ? teamSuccesses / benchmark.dials : null,
            teamObservations: benchmark.dials,
            target: targetBy.get(metric) ?? null,
          });
        });

  return {
    callsMade: calls.length,
    targetCalls,
    percentComplete,
    daysActive: days,
    callsPerActiveDay: Math.round(perDay * 10) / 10,
    parts,
    absolute,
    recommendation: recommendOnTrial(calls.length, targetCalls, parts, absolute),
    headline: headlineFor(calls.length, targetCalls, parts, absolute),
  };
}

/** Bars this trial is genuinely big enough to have missed. */
function missedBars(absolute: Assessment[]): Assessment[] {
  return absolute.filter((a) => a.vsTarget === "below");
}

function headlineFor(
  made: number,
  target: number,
  parts: TrialPart[],
  absolute: Assessment[]
): string {
  if (made < target) return `${made} of ${target} calls done`;
  const above = parts.filter((p) => p.verdict === "above").map((p) => p.label.toLowerCase());
  const below = parts.filter((p) => p.verdict === "below").map((p) => p.label.toLowerCase());
  const missed = missedBars(absolute);

  let text: string;
  if (above.length && below.length) {
    text = `Trial complete — ahead on ${above.join(", ")}, behind on ${below.join(", ")}`;
  } else if (above.length) {
    text = `Trial complete — ahead on ${above.join(", ")}`;
  } else if (below.length) {
    text = `Trial complete — behind on ${below.join(", ")}`;
  } else {
    text = "Trial complete — matched the team";
  }

  // Matching or beating the team never gets the last word when a bar is missed.
  if (missed.length) {
    text += `, but under target on ${missed.map((a) => a.label.toLowerCase()).join(", ")}`;
  }
  return text;
}

/** Everything the trial genuinely could not answer, said plainly. */
function unresolvedFrom(parts: TrialPart[]): string[] {
  return parts
    .filter((p) => p.status !== "settled")
    .map((p) => `${p.label}: ${p.note || "not enough data in this trial."}`);
}

function recommendOnTrial(
  made: number,
  target: number,
  parts: TrialPart[],
  absolute: Assessment[]
): TrialRecommendation {
  const get = (k: TrialPartKey) => parts.find((p) => p.key === k);
  const unresolved = unresolvedFrom(parts);
  const missed = missedBars(absolute);
  const missedText = missed.map((a) => a.label.toLowerCase()).join(" and ");

  const noBarSet = absolute.every((a) => a.target === null);
  if (noBarSet && made >= target) {
    unresolved.push(
      "Whether any of this is good in absolute terms: every score above is relative to your existing team. Set targets on the Targets page and this trial will say whether the bar was cleared."
    );
  }

  /**
   * Turn an "add" into an "extend" when the candidate beat a team that is
   * itself under the bar. Hiring on that basis is how a weak team stays weak.
   */
  const holdForTargets = (evidence: string): TrialRecommendation | null => {
    if (missed.length === 0) return null;
    return {
      key: "extend",
      action: "Extend the trial before adding them",
      evidence:
        `${evidence} But they are under your target on ${missedText} — ` +
        missed.map((a) => a.verdict).join(" ") +
        ` Beating the current team is not the same as being good enough, and the ` +
        `team is under that bar too. Another block of calls will show whether this ` +
        `is the candidate or the list.`,
      unresolved,
    };
  };

  if (made < target) {
    return {
      key: "in_progress",
      action: `Still running — ${target - made} calls to go`,
      evidence: `${made} of ${target} calls made. Scores below firm up as the trial finishes.`,
      unresolved,
    };
  }

  const effort = get("effort");
  const opening = get("opening");
  const connecting = get("connecting");
  const capture = get("capture");

  const badEffort = effort?.verdict === "below";
  const badOpening = opening?.verdict === "below";
  const goodOpening = opening?.verdict === "above";
  const badCapture = capture?.verdict === "below";

  // The clear no: they did not do the work, or they could not get past a
  // gatekeeper across a full hundred calls.
  if (badEffort && badOpening) {
    return {
      key: "cut",
      action: "Do not add them to the team",
      evidence:
        `Behind on both effort (${effort?.rate?.toFixed(1)} calls a day against a team ` +
        `${effort?.benchmarkRate?.toFixed(1)}) and opening (${pctText(opening?.rate ?? 0)} of ` +
        `answered calls reached an owner against ${pctText(opening?.benchmarkRate ?? 0)}, ` +
        `p = ${opening?.pValue?.toFixed(3)}). Two independent measures pointing the same way.`,
      unresolved,
    };
  }

  if (goodOpening && !badEffort) {
    const evidence =
      `Reached an owner on ${pctText(opening?.rate ?? 0)} of answered calls against a team ` +
      `${pctText(opening?.benchmarkRate ?? 0)} (p = ${opening?.pValue?.toFixed(3)}), at ` +
      `${effort?.rate?.toFixed(1)} calls a day.`;
    return (
      holdForTargets(evidence) ?? {
        key: "add",
        action: "Add them to the team",
        evidence,
        unresolved,
      }
    );
  }

  if (badOpening || badEffort || badCapture) {
    const why = [
      badEffort && "effort was below the team",
      badOpening && "they struggled to get past gatekeepers",
      badCapture && "they recorded almost nothing they learned",
    ]
      .filter(Boolean)
      .join(", ");
    return {
      key: "extend",
      action: "Extend the trial before deciding",
      evidence:
        `One weak area — ${why} — but the rest is either fine or unresolved. ` +
        `Another hundred calls would settle it; deciding now would be a coin toss on ` +
        `whichever part this trial could not measure.`,
      unresolved,
    };
  }

  const evenEvidence =
    `Nothing separates them from the team by more than chance across ${made} calls, ` +
    `and ${connecting?.trials ?? made} dials is enough to say that with some confidence.`;
  return (
    holdForTargets(evenEvidence) ?? {
      key: "add",
      action: "Add them to the team",
      evidence: evenEvidence,
      unresolved,
    }
  );
}

/** Team baseline at the moment a trial starts, from the calls made so far. */
export function benchmarkFrom(calls: CallFact[]): Benchmark {
  const talked = calls.filter(talkedToSomeone);
  const owners = calls.filter((c) => c.reached_dm === true);
  const appts = calls.filter((c) => c.outcome === "appointment_set");

  const byCaller = new Map<string, Set<string>>();
  const countByCaller = new Map<string, number>();
  for (const c of calls) {
    const name = c.caller_name || "unknown";
    if (!byCaller.has(name)) byCaller.set(name, new Set());
    byCaller.get(name)!.add(c.created_at.slice(0, 10));
    countByCaller.set(name, (countByCaller.get(name) || 0) + 1);
  }
  const perDay = [...byCaller.entries()]
    .map(([name, days]) => (countByCaller.get(name) || 0) / Math.max(1, days.size))
    .sort((a, b) => a - b);

  return {
    dials: calls.length,
    talked: talked.length,
    ownerConversations: owners.length,
    appointments: appts.length,
    callsPerDay: perDay.length ? perDay[Math.floor(perDay.length / 2)] : null,
  };
}
