// What the house has learned, in one place, for every tool to read.
//
// The system already learned things. It learned them in five separate places
// that never spoke to each other: analytics.ts knew which hours connect,
// scriptStats.ts knew which opener got past reception, callerProfile.ts knew
// who was good at what, benchmarks.ts knew whether the numbers were any good,
// and learning.ts could run an experiment. None of it fed back. The diagnostic
// still led with whatever it weighted highest a priori, the packet was still
// ordered by enrichment grade, and the sequence writer was still told the same
// thing on day one and day four hundred.
//
// This is the connective tissue. Every outcome the business produces — a call,
// a packet opened, a reply, a trial agreed — comes in here, and what comes out
// is a set of PRIORS that the tools consult at their decision points. The more
// the business is used, the sharper every part of it gets.
//
// FOUR RULES, and they are what stop this becoming a machine that confidently
// repeats its own early noise:
//
//   1. NOTHING IS APPLIED BELOW A SAMPLE FLOOR. A prior with nine observations
//      is a coincidence with an opinion. Every prior carries its sample size
//      and its confidence, and `applied` is false until both clear the bar.
//
//   2. EXPLORATION NEVER STOPS. A prior that has decided script B wins must
//      still send traffic to the others, or the moment the market shifts the
//      system is confidently wrong and has no data to notice with. The floor
//      is explicit, not emergent.
//
//   3. IT SAYS WHAT IT DOES NOT KNOW. `blindSpots` is as important as the
//      priors: "no evidence at all for roofing" is the thing that tells an
//      operator where the next hundred calls should go.
//
//   4. IT NEVER MOVES PRICES, CONSENT, OR A PERSON'S JOB. Those are the
//      standing exclusions. This produces evidence about them and stops.
//
// Pure. No database, no network — the I/O is in houseKnowledgeStore.ts.

import { wilson, confidenceFor, type Confidence, type Interval } from "./analytics";

/* -------------------------------------------------------------------------- */
/* what comes in                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One thing that happened, flattened.
 *
 * Deliberately one shape for every channel. A call that reached an owner and
 * an email that got a reply are the same kind of evidence about whether an
 * angle works, and keeping them in separate shapes is exactly how the five
 * silos happened.
 */
export type OutcomeFact = {
  /** call | email | packet */
  channel: "call" | "email" | "packet";
  /** When, so recency can be weighted and staleness spotted. */
  at: string;

  industry?: string | null;
  state?: string | null;
  /** The affordability band this lead was estimated at. */
  sizeBand?: string | null;

  /** Which gatekeeper opener ran, for a call. */
  scriptVersion?: string | null;
  /** True when the caller deliberately ran something other than the assigned
   *  arm. Excluded from the script comparison — see below. */
  scriptOverridden?: boolean | null;

  /** The diagnostic angles this lead was approached with. */
  angles?: string[] | null;
  /** The specific finding keys shown. */
  findingKeys?: string[] | null;

  /** Local hour of the attempt, 0-23. */
  hour?: number | null;
  /** 0 = Sunday. */
  dayOfWeek?: number | null;

  /** Did it do the thing we wanted? Null = not measurable, excluded. */
  reachedDecisionMaker?: boolean | null;
  /** The one that actually matters commercially. */
  converted?: boolean | null;

  /** For calibrating the size estimate against reality. */
  estimatedBand?: string | null;
  actualDealValue?: number | null;
};

/* -------------------------------------------------------------------------- */
/* the bar                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Below this a prior is recorded and NOT acted on.
 *
 * Thirty is not arbitrary: it is where analytics.ts already draws
 * "directional", and using a different number here would mean the Learning
 * page and the tools disagreed about whether something was known.
 */
export const MIN_SAMPLES_TO_APPLY = 30;

/** Below this, even a well-sampled difference is not worth acting on. */
export const MIN_LIFT_TO_APPLY = 0.15;

/**
 * The share of traffic that keeps going to non-winning options, forever.
 *
 * The single most important number in this file. A system that routes 100% to
 * the current best has no way to notice when the market moves — it will keep
 * winning at a game nobody is playing any more, and the data it would need to
 * see that is data it stopped collecting. Twenty percent is cheap insurance.
 */
export const EXPLORATION_FLOOR = 0.2;

export type Prior = {
  key: string;
  /** What this is about, in words, for the Learning page. */
  label: string;
  /** How much better than the baseline, as a ratio. 0.3 = 30% better. */
  lift: number;
  rate: number;
  baselineRate: number;
  samples: number;
  interval: Interval;
  confidence: Confidence;
  /** Whether the tools are actually allowed to use it. */
  applied: boolean;
  /** Why it is or is not applied. Shown to a person. */
  reason: string;
};

function buildPrior(
  key: string,
  label: string,
  successes: number,
  trials: number,
  baselineRate: number
): Prior {
  const rate = trials > 0 ? successes / trials : 0;
  const lift = baselineRate > 0 ? (rate - baselineRate) / baselineRate : 0;
  const confidence = confidenceFor(trials);
  const enoughSamples = trials >= MIN_SAMPLES_TO_APPLY;
  const enoughLift = Math.abs(lift) >= MIN_LIFT_TO_APPLY;

  return {
    key,
    label,
    lift,
    rate,
    baselineRate,
    samples: trials,
    interval: wilson(successes, trials),
    confidence,
    applied: enoughSamples && enoughLift,
    reason: !enoughSamples
      ? `${trials} of the ${MIN_SAMPLES_TO_APPLY} needed before this is acted on.`
      : !enoughLift
        ? `Only ${(lift * 100).toFixed(0)}% different from average — inside the noise.`
        : `${(lift * 100).toFixed(0)}% ${lift > 0 ? "better" : "worse"} than average across ${trials}.`,
  };
}

/* -------------------------------------------------------------------------- */
/* the knowledge                                                              */
/* -------------------------------------------------------------------------- */

export type HouseKnowledge = {
  /** When this was computed, and off how much. */
  computedAt: string;
  totalFacts: number;

  /** Which diagnostic angle converts, overall and per industry. */
  angleLift: Prior[];
  /** angle → industry → prior. The specific beats the general when it exists. */
  angleByIndustry: Record<string, Record<string, Prior>>;

  /** Script arm performance, and the traffic split that follows from it. */
  scriptLift: Prior[];
  scriptWeights: Record<string, number>;

  /** When to call, per industry where there is enough to say. */
  timing: Prior[];

  /** Which trades actually turn into business. Feeds sourcing. */
  industryYield: Prior[];

  /** How well the size estimate matched reality. */
  bandCalibration: {
    band: string;
    estimated: number;
    closed: number;
    medianDealValue: number | null;
    verdict: string;
  }[];

  /** What it cannot answer yet, and what would fix that. */
  blindSpots: BlindSpot[];
};

export type BlindSpot = {
  area: string;
  detail: string;
  /** Roughly how many more observations would settle it. */
  needs: number;
};

const EMPTY: HouseKnowledge = {
  computedAt: new Date(0).toISOString(),
  totalFacts: 0,
  angleLift: [],
  angleByIndustry: {},
  scriptLift: [],
  scriptWeights: {},
  timing: [],
  industryYield: [],
  bandCalibration: [],
  blindSpots: [],
};

function rate(facts: OutcomeFact[], of: (f: OutcomeFact) => boolean | null | undefined): {
  successes: number;
  trials: number;
  rate: number;
} {
  let successes = 0;
  let trials = 0;
  for (const f of facts) {
    const v = of(f);
    // Null is "not measurable", not "no". Counting it as a failure would drag
    // every rate toward zero in proportion to how much data was missing.
    if (v === null || v === undefined) continue;
    trials += 1;
    if (v) successes += 1;
  }
  return { successes, trials, rate: trials > 0 ? successes / trials : 0 };
}

/**
 * Build everything the house knows from everything that has happened.
 *
 * One pass, one output, consumed by every tool. That is the ecosystem part:
 * there is no second opinion anywhere, so the packet, the dialer, the writer
 * and the sourcing planner cannot drift into disagreeing about what works.
 */
export function buildKnowledge(
  facts: OutcomeFact[],
  now: Date = new Date()
): HouseKnowledge {
  if (facts.length === 0) {
    return {
      ...EMPTY,
      computedAt: now.toISOString(),
      blindSpots: [
        {
          area: "Everything",
          detail:
            "Nothing has been recorded yet. Every tool is running on its starting assumptions, which is fine — they just are not yours.",
          needs: MIN_SAMPLES_TO_APPLY,
        },
      ],
    };
  }

  const converted = (f: OutcomeFact) => f.converted;
  const overall = rate(facts, converted);

  /* ---------------------------- diagnostic angles ---------------------------- */

  const angleFacts = new Map<string, OutcomeFact[]>();
  for (const f of facts) {
    for (const a of f.angles || []) {
      if (!angleFacts.has(a)) angleFacts.set(a, []);
      angleFacts.get(a)!.push(f);
    }
  }

  const angleLift = [...angleFacts.entries()]
    .map(([angle, rows]) => {
      const r = rate(rows, converted);
      return buildPrior(angle, `Leading with ${angle.replace(/_/g, " ")}`, r.successes, r.trials, overall.rate);
    })
    .sort((a, b) => b.lift - a.lift);

  // The same, cut by industry. A ranking pitch that works on roofers and not
  // on plumbers is the finding worth having, and the overall average hides it.
  const angleByIndustry: Record<string, Record<string, Prior>> = {};
  for (const [angle, rows] of angleFacts) {
    const byIndustry = new Map<string, OutcomeFact[]>();
    for (const f of rows) {
      const key = (f.industry || "").trim();
      if (!key) continue;
      if (!byIndustry.has(key)) byIndustry.set(key, []);
      byIndustry.get(key)!.push(f);
    }
    for (const [industry, industryRows] of byIndustry) {
      const industryBaseline = rate(
        facts.filter((f) => f.industry === industry),
        converted
      ).rate;
      const r = rate(industryRows, converted);
      angleByIndustry[angle] ??= {};
      angleByIndustry[angle][industry] = buildPrior(
        `${angle}:${industry}`,
        `${angle.replace(/_/g, " ")} for ${industry.replace(/_/g, " ")}`,
        r.successes,
        r.trials,
        industryBaseline
      );
    }
  }

  /* -------------------------------- scripts --------------------------------- */

  /*
   * Overridden calls are excluded outright.
   *
   * A caller who deliberately picked a different opener did so because of
   * something about that lead, which is the selection bias the random
   * assignment exists to remove. Letting those rows back in through the
   * learning layer would reintroduce it by the back door.
   */
  const scriptFacts = facts.filter(
    (f) => f.channel === "call" && f.scriptVersion && !f.scriptOverridden
  );
  const scriptBaseline = rate(scriptFacts, (f) => f.reachedDecisionMaker).rate;

  const byScript = new Map<string, OutcomeFact[]>();
  for (const f of scriptFacts) {
    const v = f.scriptVersion!;
    if (!byScript.has(v)) byScript.set(v, []);
    byScript.get(v)!.push(f);
  }

  const scriptLift = [...byScript.entries()]
    .map(([version, rows]) => {
      const r = rate(rows, (f) => f.reachedDecisionMaker);
      return buildPrior(version, `Script ${version}`, r.successes, r.trials, scriptBaseline);
    })
    .sort((a, b) => b.rate - a.rate);

  const scriptWeights = weightArms(scriptLift);

  /* -------------------------------- timing ---------------------------------- */

  const timing: Prior[] = [];
  const byHourBucket = new Map<string, OutcomeFact[]>();
  for (const f of facts) {
    if (f.channel !== "call" || typeof f.hour !== "number") continue;
    const bucket = f.hour < 12 ? "morning" : f.hour < 15 ? "early afternoon" : "late afternoon";
    if (!byHourBucket.has(bucket)) byHourBucket.set(bucket, []);
    byHourBucket.get(bucket)!.push(f);
  }
  const callBaseline = rate(
    facts.filter((f) => f.channel === "call"),
    (f) => f.reachedDecisionMaker
  ).rate;
  for (const [bucket, rows] of byHourBucket) {
    const r = rate(rows, (f) => f.reachedDecisionMaker);
    timing.push(buildPrior(bucket, `Calling in the ${bucket}`, r.successes, r.trials, callBaseline));
  }
  timing.sort((a, b) => b.lift - a.lift);

  /* ------------------------------ which trades ------------------------------ */

  const industryYield: Prior[] = [];
  const byIndustry = new Map<string, OutcomeFact[]>();
  for (const f of facts) {
    const key = (f.industry || "").trim();
    if (!key) continue;
    if (!byIndustry.has(key)) byIndustry.set(key, []);
    byIndustry.get(key)!.push(f);
  }
  for (const [industry, rows] of byIndustry) {
    const r = rate(rows, converted);
    industryYield.push(
      buildPrior(industry, industry.replace(/_/g, " "), r.successes, r.trials, overall.rate)
    );
  }
  industryYield.sort((a, b) => b.lift - a.lift);

  /* --------------------------- was the size right? -------------------------- */

  const bandCalibration = calibrateBands(facts);

  return {
    computedAt: now.toISOString(),
    totalFacts: facts.length,
    angleLift,
    angleByIndustry,
    scriptLift,
    scriptWeights,
    timing,
    industryYield,
    bandCalibration,
    blindSpots: findBlindSpots(facts, { angleLift, scriptLift, industryYield, timing }),
  };
}

/* -------------------------------------------------------------------------- */
/* turning what is known into how traffic is split                            */
/* -------------------------------------------------------------------------- */

/**
 * How much traffic each arm should get.
 *
 * NOT winner-takes-all, and the exploration floor is the reason. An arm that
 * is currently losing keeps a share, so if it starts working — a new market, a
 * different kind of gatekeeper, a season — the system finds out. A router that
 * sends everything to today's winner is optimising itself into a corner it
 * cannot see out of.
 *
 * Until an arm clears the sample floor, the split is even. There is nothing to
 * be clever with yet, and being clever with nine observations is how a good
 * variant gets killed before it was ever measured.
 */
export function weightArms(priors: Prior[]): Record<string, number> {
  const weights: Record<string, number> = {};
  if (priors.length === 0) return weights;

  const usable = priors.filter((p) => p.applied);
  if (usable.length === 0) {
    const even = 1 / priors.length;
    for (const p of priors) weights[p.key] = even;
    return weights;
  }

  // The exploration share, spread evenly over everything.
  const explore = EXPLORATION_FLOOR / priors.length;

  // The rest, distributed by rate among the arms that have earned it.
  const total = usable.reduce((sum, p) => sum + Math.max(0, p.rate), 0);
  for (const p of priors) {
    const earned =
      total > 0 && p.applied ? ((1 - EXPLORATION_FLOOR) * Math.max(0, p.rate)) / total : 0;
    weights[p.key] = Number((explore + earned).toFixed(4));
  }

  // Normalise, so rounding cannot make the split sum to something other than 1.
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (sum > 0) for (const k of Object.keys(weights)) weights[k] = Number((weights[k] / sum).toFixed(4));
  return weights;
}

/**
 * Pick an arm for a lead, honouring the weights and staying deterministic.
 *
 * Same contract as the flat assignment it replaces: the same lead always lands
 * in the same arm, so a callback opens the way the first call did. The weights
 * change the SHAPE of the split, not its stability — a lead can move arm when
 * the weights are recomputed, which is correct, and is why the assignment is
 * recorded on the call rather than inferred later.
 */
export function pickWeighted(
  hash: number,
  weights: Record<string, number>,
  fallback: string[]
): string {
  const keys = Object.keys(weights);
  if (keys.length === 0) return fallback[hash % fallback.length];

  const point = (hash % 10000) / 10000;
  let running = 0;
  for (const key of keys) {
    running += weights[key];
    if (point < running) return key;
  }
  return keys[keys.length - 1];
}

/* -------------------------------------------------------------------------- */
/* calibration                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Did the size estimate match what people actually paid?
 *
 * Reported, never applied. The bands in affordability.ts stay where they are
 * until a person moves them, because a system that quietly re-prices itself
 * off twelve closed deals is the failure mode that the "prices are never
 * changed automatically" rule exists to prevent. What this does is put the
 * evidence in front of somebody who can decide.
 */
function calibrateBands(facts: OutcomeFact[]): HouseKnowledge["bandCalibration"] {
  const bands = new Map<string, { estimated: number; closed: number; values: number[] }>();
  for (const f of facts) {
    const band = (f.estimatedBand || f.sizeBand || "").trim();
    if (!band) continue;
    const entry = bands.get(band) || { estimated: 0, closed: 0, values: [] };
    entry.estimated += 1;
    if (f.converted) entry.closed += 1;
    if (typeof f.actualDealValue === "number" && f.actualDealValue > 0) {
      entry.values.push(f.actualDealValue);
    }
    bands.set(band, entry);
  }

  return [...bands.entries()].map(([band, e]) => {
    const sorted = [...e.values].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    return {
      band,
      estimated: e.estimated,
      closed: e.closed,
      medianDealValue: median,
      verdict:
        e.values.length < 5
          ? `Only ${e.values.length} closed deal${e.values.length === 1 ? "" : "s"} — not enough to say whether the band is right.`
          : `Median closed at ${median}. Compare that with the band in the settings and move it by hand if it is wrong.`,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* what it does not know                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The honest half.
 *
 * A learning system that only reports what it has figured out is a system that
 * quietly stops improving, because nobody can see where the next improvement
 * would come from. This says where the evidence runs out, and roughly how much
 * more would settle it — which turns "we should call more roofers" from a hunch
 * into a number.
 */
export function findBlindSpots(
  facts: OutcomeFact[],
  built: {
    angleLift: Prior[];
    scriptLift: Prior[];
    industryYield: Prior[];
    timing: Prior[];
  }
): BlindSpot[] {
  const spots: BlindSpot[] = [];

  const unappliedScripts = built.scriptLift.filter((p) => p.samples < MIN_SAMPLES_TO_APPLY);
  if (built.scriptLift.length > 0 && unappliedScripts.length === built.scriptLift.length) {
    const most = Math.max(...built.scriptLift.map((p) => p.samples));
    spots.push({
      area: "Which opener works",
      detail: `No opener has enough calls behind it yet — the best has ${most}. Traffic stays evenly split until one does.`,
      needs: MIN_SAMPLES_TO_APPLY - most,
    });
  } else if (unappliedScripts.length > 0) {
    spots.push({
      area: "Openers still unproven",
      detail: `${unappliedScripts.map((p) => p.key).join(", ")} ${unappliedScripts.length === 1 ? "has" : "have"} not been dialled enough to judge.`,
      needs: Math.max(1, ...unappliedScripts.map((p) => MIN_SAMPLES_TO_APPLY - p.samples)),
    });
  }

  /*
   * Short on SAMPLES specifically.
   *
   * Not the same as "not applied". A trade with two hundred calls behind it
   * and no measurable difference from average is not a blind spot — that is a
   * finding, and reporting it as "we need more data" would send somebody off
   * to gather data that will say the same thing. Only genuine ignorance goes
   * in here, and `needs` is therefore always positive.
   */
  const thinIndustries = built.industryYield.filter((p) => p.samples < MIN_SAMPLES_TO_APPLY);
  if (thinIndustries.length > 0) {
    spots.push({
      area: "Trades with no read",
      detail: `${thinIndustries
        .slice(0, 5)
        .map((p) => `${p.label} (${p.samples})`)
        .join(", ")} — not enough to know whether they are worth sourcing.`,
      needs: Math.min(...thinIndustries.map((p) => MIN_SAMPLES_TO_APPLY - p.samples)),
    });
  }

  const thinAngles = built.angleLift.filter((p) => !p.applied);
  if (built.angleLift.length > 0 && thinAngles.length === built.angleLift.length) {
    spots.push({
      area: "Which angle to lead with",
      detail:
        "No diagnostic angle has enough outcomes behind it, so findings are still ordered by their starting weights rather than by what actually converts here.",
      needs: MIN_SAMPLES_TO_APPLY,
    });
  }

  const emails = facts.filter((f) => f.channel === "email").length;
  if (emails < MIN_SAMPLES_TO_APPLY) {
    spots.push({
      area: "Email",
      detail: `Only ${emails} email outcome${emails === 1 ? "" : "s"} recorded, so nothing from the inbox is feeding back into anything yet.`,
      needs: MIN_SAMPLES_TO_APPLY - emails,
    });
  }

  if (built.timing.every((p) => !p.applied)) {
    spots.push({
      area: "Best time to call",
      detail: "Not enough calls spread across the day to tell the hours apart.",
      needs: MIN_SAMPLES_TO_APPLY,
    });
  }

  return spots;
}

/* -------------------------------------------------------------------------- */
/* what the tools ask                                                         */
/* -------------------------------------------------------------------------- */

/**
 * How much to move a diagnostic finding up or down, given what converts.
 *
 * Returns a multiplier on the finding's own weight, so the a-priori ordering
 * still shows through — the evidence tilts the list, it does not replace the
 * judgement in diagnostic.ts. Capped both ways so one strong quarter cannot
 * bury an angle entirely.
 */
export function angleMultiplier(
  knowledge: HouseKnowledge,
  angle: string,
  industry?: string | null
): { multiplier: number; source: string | null } {
  // The industry-specific read beats the general one when it has earned it.
  const specific = industry ? knowledge.angleByIndustry[angle]?.[industry] : undefined;
  if (specific?.applied) {
    return {
      multiplier: clamp(1 + specific.lift, 0.5, 1.8),
      source: `${specific.samples} outcomes for this angle in ${industry}`,
    };
  }

  const general = knowledge.angleLift.find((p) => p.key === angle);
  if (general?.applied) {
    return {
      multiplier: clamp(1 + general.lift, 0.6, 1.6),
      source: `${general.samples} outcomes for this angle`,
    };
  }

  return { multiplier: 1, source: null };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * What the sequence writer should be told, in plain language.
 *
 * This is the ecosystem working: the cold-email copy gets written knowing what
 * the phone learned. Only applied priors make it in, so the writer is never
 * told to lean on something with eleven observations behind it.
 */
export function briefingForWriter(knowledge: HouseKnowledge): string[] {
  const lines: string[] = [];

  const goodAngles = knowledge.angleLift.filter((p) => p.applied && p.lift > 0).slice(0, 3);
  for (const p of goodAngles) {
    lines.push(
      `${p.label} converts ${(p.lift * 100).toFixed(0)}% above average here (${p.samples} outcomes). Lean on it.`
    );
  }

  const badAngles = knowledge.angleLift.filter((p) => p.applied && p.lift < 0).slice(0, 2);
  for (const p of badAngles) {
    lines.push(
      `${p.label} converts ${Math.abs(p.lift * 100).toFixed(0)}% below average here (${p.samples} outcomes). Do not lead with it.`
    );
  }

  const goodTrades = knowledge.industryYield.filter((p) => p.applied && p.lift > 0).slice(0, 3);
  if (goodTrades.length > 0) {
    lines.push(
      `Best-converting trades so far: ${goodTrades.map((p) => `${p.label} (${(p.rate * 100).toFixed(0)}%)`).join(", ")}.`
    );
  }

  return lines;
}

/**
 * How much better a lead looks than average, for ordering a packet.
 *
 * Multiplicative and bounded, so it nudges the order rather than rewriting it.
 * A caller's first hour is their best one and it should be spent on the leads
 * the evidence likes — but "the evidence" here is a handful of priors, not a
 * model, and it should not be trusted to reorder a whole packet on its own.
 */
export function leadScore(
  knowledge: HouseKnowledge,
  lead: { industry?: string | null; angles?: string[] | null }
): { score: number; why: string[] } {
  let score = 1;
  const why: string[] = [];

  const industry = knowledge.industryYield.find((p) => p.key === (lead.industry || ""));
  if (industry?.applied) {
    score *= clamp(1 + industry.lift, 0.7, 1.4);
    why.push(`${industry.label} runs ${(industry.lift * 100).toFixed(0)}% ${industry.lift > 0 ? "above" : "below"} average`);
  }

  for (const angle of lead.angles || []) {
    const m = angleMultiplier(knowledge, angle, lead.industry);
    if (m.multiplier !== 1) {
      score *= clamp(m.multiplier, 0.85, 1.25);
      if (m.source) why.push(`${angle.replace(/_/g, " ")}: ${m.source}`);
    }
  }

  return { score: Number(score.toFixed(3)), why };
}

/** Everything currently being acted on, for the Learning page. */
export function appliedPriors(knowledge: HouseKnowledge): Prior[] {
  return [
    ...knowledge.angleLift,
    ...knowledge.scriptLift,
    ...knowledge.timing,
    ...knowledge.industryYield,
  ].filter((p) => p.applied);
}

/**
 * One line for the top of the Learning page.
 *
 * Written to make the compounding visible: the number that matters is not how
 * clever it is today, it is that it was less clever last month.
 */
export function summarise(knowledge: HouseKnowledge): string {
  const applied = appliedPriors(knowledge).length;
  if (knowledge.totalFacts === 0) {
    return "Nothing recorded yet. Every tool is running on its starting assumptions.";
  }
  if (applied === 0) {
    return `${knowledge.totalFacts} outcomes recorded, none of it conclusive yet. Nothing has been changed on the strength of it.`;
  }
  return `${knowledge.totalFacts} outcomes recorded. ${applied} thing${applied === 1 ? "" : "s"} learned well enough to act on, and ${knowledge.blindSpots.length} still open.`;
}

export const EMPTY_KNOWLEDGE = EMPTY;
