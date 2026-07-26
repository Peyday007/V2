// Adaptive analytics.
//
// Pure functions over call facts. No database, no network, no `server-only`,
// so every rule in here is testable and the same maths runs in tests and in
// production.
//
// The design rule for this file: it must never assert something the data does
// not support. Every rate carries a confidence interval, every comparison
// carries a significance test, and every conclusion carries a sample size and
// a "how many more calls until this is trustworthy" number. With two calls
// logged it says so plainly instead of inventing a trend.

/* -------------------------------------------------------------------------- */
/* statistics                                                                 */
/* -------------------------------------------------------------------------- */

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 via erf). */
export function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

export type Interval = { rate: number; low: number; high: number };

/**
 * Wilson score interval — the honest way to put error bars on a rate from a
 * small sample. 1 success in 3 tries is "somewhere between 2% and 87%", which
 * is exactly the message a two-call dataset should send.
 */
export function wilson(successes: number, trials: number, z = 1.96): Interval {
  if (trials <= 0) return { rate: 0, low: 0, high: 0 };
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denom;
  const half =
    (z / denom) *
    Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return {
    rate: p,
    low: Math.max(0, centre - half),
    high: Math.min(1, centre + half),
  };
}

/** Pooled two-proportion z test. Returns the z score. */
export function twoProportionZ(
  successesA: number,
  trialsA: number,
  successesB: number,
  trialsB: number
): number {
  if (trialsA <= 0 || trialsB <= 0) return 0;
  const pA = successesA / trialsA;
  const pB = successesB / trialsB;
  const pooled = (successesA + successesB) / (trialsA + trialsB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / trialsA + 1 / trialsB));
  if (se === 0) return 0;
  return (pA - pB) / se;
}

/** Two-sided p-value for a z score. */
export function pValue(z: number): number {
  return 2 * (1 - normalCdf(Math.abs(z)));
}

/**
 * Calls needed PER GROUP to detect the observed difference at 80% power and
 * a 5% significance level. This is what turns "not enough data" into an
 * actionable number instead of a shrug.
 */
export function samplePerGroupNeeded(pA: number, pB: number): number {
  const delta = Math.abs(pA - pB);
  if (delta < 1e-9) return Infinity;
  const K = 7.849; // (1.96 + 0.8416)^2
  return Math.ceil((K * (pA * (1 - pA) + pB * (1 - pB))) / (delta * delta));
}

/* -------------------------------------------------------------------------- */
/* confidence gating                                                          */
/* -------------------------------------------------------------------------- */

export type Confidence = "insufficient" | "directional" | "reliable";

/** Below this, a segment is not shown as a conclusion at all. */
export const MIN_DIRECTIONAL = 30;
/** At or above this, plus significance, a finding is called reliable. */
export const MIN_RELIABLE = 100;

export function confidenceFor(trials: number): Confidence {
  if (trials >= MIN_RELIABLE) return "reliable";
  if (trials >= MIN_DIRECTIONAL) return "directional";
  return "insufficient";
}

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  insufficient: "Not enough data",
  directional: "Early signal",
  reliable: "Reliable",
};

/* -------------------------------------------------------------------------- */
/* segments                                                                   */
/* -------------------------------------------------------------------------- */

export type Segment = {
  key: string;
  label: string;
  trials: number;
  successes: number;
  rate: number;
  low: number;
  high: number;
  confidence: Confidence;
};

export function buildSegment(key: string, label: string, successes: number, trials: number): Segment {
  const { rate, low, high } = wilson(successes, trials);
  return {
    key,
    label,
    trials,
    successes,
    rate,
    low,
    high,
    confidence: confidenceFor(trials),
  };
}

/** Group rows into segments by a key, counting a boolean success per row. */
export function segmentBy<T>(
  rows: T[],
  keyOf: (row: T) => string | null,
  successOf: (row: T) => boolean,
  opts?: { label?: (key: string) => string; order?: "rate" | "key" | "trials" }
): Segment[] {
  const buckets = new Map<string, { trials: number; successes: number }>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null || key === "") continue;
    const b = buckets.get(key) ?? { trials: 0, successes: 0 };
    b.trials += 1;
    if (successOf(row)) b.successes += 1;
    buckets.set(key, b);
  }

  const segments = [...buckets.entries()].map(([key, b]) =>
    buildSegment(key, opts?.label ? opts.label(key) : key, b.successes, b.trials)
  );

  const order = opts?.order ?? "rate";
  segments.sort((a, b) => {
    if (order === "key") return a.key.localeCompare(b.key, undefined, { numeric: true });
    if (order === "trials") return b.trials - a.trials;
    return b.rate - a.rate || b.trials - a.trials;
  });
  return segments;
}

/* -------------------------------------------------------------------------- */
/* findings                                                                   */
/* -------------------------------------------------------------------------- */

export type Finding = {
  /** Plain-language conclusion, or the reason there isn't one yet. */
  headline: string;
  detail: string;
  confidence: Confidence;
  significant: boolean;
  pValue: number | null;
  lift: number | null;
  /** Total observations behind the comparison. */
  sampleSize: number;
  /** Additional calls needed per group before this could be trusted. */
  callsNeeded: number | null;
  /** Safe to act on: significant AND at least directional on both sides. */
  actionable: boolean;
};

function pct(v: number): string {
  return `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
}

/**
 * Compare the best-performing segment against everything else pooled.
 *
 * Returns a finding either way — when the data is too thin the finding says
 * so and reports how much more is needed. It never returns silence, because
 * silence gets misread as "nothing to see here".
 */
export function findBest(
  segments: Segment[],
  metricLabel: string,
  opts?: { minTrialsPerSide?: number }
): Finding {
  const minSide = opts?.minTrialsPerSide ?? MIN_DIRECTIONAL;
  const total = segments.reduce((n, s) => n + s.trials, 0);

  if (segments.length < 2) {
    return {
      headline: "Not enough variety to compare yet",
      detail:
        segments.length === 0
          ? "No calls have been logged with this information recorded."
          : `Every call so far falls into one group (${segments[0].label}). A comparison needs at least two.`,
      confidence: "insufficient",
      significant: false,
      pValue: null,
      lift: null,
      sampleSize: total,
      callsNeeded: null,
      actionable: false,
    };
  }

  // Rank by the LOWER bound of the interval, not the raw rate: a 100% rate
  // from one call must not beat a 40% rate from four hundred.
  const ranked = [...segments].sort((a, b) => b.low - a.low || b.trials - a.trials);
  const best = ranked[0];
  const restTrials = total - best.trials;
  const restSuccesses =
    segments.reduce((n, s) => n + s.successes, 0) - best.successes;
  const restRate = restTrials > 0 ? restSuccesses / restTrials : 0;

  const z = twoProportionZ(best.successes, best.trials, restSuccesses, restTrials);
  const p = pValue(z);
  const significant = p < 0.05 && best.rate > restRate;
  const lift = restRate > 0 ? best.rate / restRate : null;

  const thin = best.trials < minSide || restTrials < minSide;
  const needed = samplePerGroupNeeded(best.rate, restRate);
  const callsNeeded = Number.isFinite(needed)
    ? Math.max(0, needed - Math.min(best.trials, restTrials))
    : null;

  if (thin || !significant) {
    const reason = thin
      ? `only ${best.trials} call${best.trials === 1 ? "" : "s"} in the leading group and ${restTrials} in the rest`
      : `the difference is within normal random variation (p = ${p.toFixed(2)})`;
    return {
      headline: `No trustworthy difference yet — ${best.label} is ahead, but ${reason}`,
      detail:
        `${best.label} is at ${pct(best.rate)} ${metricLabel} (${best.successes}/${best.trials}), ` +
        `everything else at ${pct(restRate)} (${restSuccesses}/${restTrials}). ` +
        (callsNeeded && callsNeeded > 0
          ? `About ${callsNeeded} more calls per group would settle it.`
          : `Keep logging calls.`),
      confidence: confidenceFor(Math.min(best.trials, restTrials)),
      significant: false,
      pValue: p,
      lift,
      sampleSize: total,
      callsNeeded,
      actionable: false,
    };
  }

  const conf = confidenceFor(Math.min(best.trials, restTrials));
  return {
    headline:
      lift && lift >= 1.15
        ? `${best.label} performs ${lift.toFixed(1)}× better for ${metricLabel}`
        : `${best.label} leads on ${metricLabel}`,
    detail:
      `${pct(best.rate)} (${best.successes}/${best.trials}) versus ${pct(restRate)} ` +
      `(${restSuccesses}/${restTrials}) elsewhere. p = ${p.toFixed(3)}. ` +
      `True rate likely between ${pct(best.low)} and ${pct(best.high)}.`,
    confidence: conf,
    significant: true,
    pValue: p,
    lift,
    sampleSize: total,
    callsNeeded: 0,
    actionable: conf !== "insufficient",
  };
}

/* -------------------------------------------------------------------------- */
/* the report                                                                 */
/* -------------------------------------------------------------------------- */

/** One call, flattened to exactly the facts analysis needs. */
export type CallFact = {
  outcome: string;
  reached_dm: boolean;
  caller_name: string | null;
  lead_industry: string | null;
  lead_state: string | null;
  dialed_hour: number | null;
  dialed_dow: number | null;
  attempt_number: number | null;
  duration_seconds: number | null;
  owner_known_before: boolean | null;
  created_at: string;
};

export type DimensionReport = {
  key: string;
  label: string;
  /** The decision this dimension is meant to inform. */
  question: string;
  metricLabel: string;
  segments: Segment[];
  finding: Finding;
  /** Rows that had to be skipped because the field was never recorded. */
  missing: number;
};

export const HOUR_BUCKETS: { key: string; label: string; from: number; to: number }[] = [
  { key: "1_early", label: "7–9am", from: 7, to: 9 },
  { key: "2_morning", label: "9–11am", from: 9, to: 11 },
  { key: "3_midday", label: "11am–1pm", from: 11, to: 13 },
  { key: "4_afternoon", label: "1–3pm", from: 13, to: 15 },
  { key: "5_late", label: "3–5pm", from: 15, to: 17 },
  { key: "6_evening", label: "after 5pm", from: 17, to: 24 },
];

export function hourBucket(hour: number | null): string | null {
  if (hour === null || hour === undefined) return null;
  const b = HOUR_BUCKETS.find((x) => hour >= x.from && hour < x.to);
  return b ? b.key : null;
}

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function attemptBucket(n: number | null): string | null {
  if (!n || n < 1) return null;
  if (n >= 6) return "6+";
  return String(n);
}

const APPOINTMENT_OUTCOMES = ["appointment_set"];
const NO_CONTACT_OUTCOMES = ["no_answer", "voicemail", "bad_number"];

export function reachedOwner(c: CallFact): boolean {
  return c.reached_dm === true;
}
export function bookedAppointment(c: CallFact): boolean {
  return APPOINTMENT_OUTCOMES.includes(c.outcome);
}
export function connected(c: CallFact): boolean {
  return !NO_CONTACT_OUTCOMES.includes(c.outcome);
}

export type Totals = {
  calls: number;
  connects: number;
  ownerConversations: number;
  appointments: number;
  connectRate: Interval;
  ownerRate: Interval;
  appointmentRate: Interval;
  medianDurationSeconds: number | null;
  callsWithDuration: number;
};

export function totalsFor(calls: CallFact[]): Totals {
  const n = calls.length;
  const connects = calls.filter(connected).length;
  const owners = calls.filter(reachedOwner).length;
  const appts = calls.filter(bookedAppointment).length;
  const durations = calls
    .map((c) => c.duration_seconds)
    .filter((d): d is number => typeof d === "number" && d > 0)
    .sort((a, b) => a - b);
  return {
    calls: n,
    connects,
    ownerConversations: owners,
    appointments: appts,
    connectRate: wilson(connects, n),
    ownerRate: wilson(owners, n),
    appointmentRate: wilson(appts, n),
    medianDurationSeconds: durations.length
      ? durations[Math.floor(durations.length / 2)]
      : null,
    callsWithDuration: durations.length,
  };
}

function dimension(
  key: string,
  label: string,
  question: string,
  metricLabel: string,
  calls: CallFact[],
  keyOf: (c: CallFact) => string | null,
  successOf: (c: CallFact) => boolean,
  opts?: { label?: (k: string) => string; order?: "rate" | "key" | "trials" }
): DimensionReport {
  const missing = calls.filter((c) => keyOf(c) === null || keyOf(c) === "").length;
  const segments = segmentBy(calls, keyOf, successOf, opts);
  return {
    key,
    label,
    question,
    metricLabel,
    segments,
    finding: findBest(segments, metricLabel),
    missing,
  };
}

/** How much of each analysable field is actually populated. */
export type Coverage = { field: string; recorded: number; total: number; note: string };

export function coverageFor(calls: CallFact[]): Coverage[] {
  const total = calls.length;
  const count = (f: (c: CallFact) => boolean) => calls.filter(f).length;
  return [
    {
      field: "Call duration",
      recorded: count((c) => typeof c.duration_seconds === "number" && c.duration_seconds > 0),
      total,
      note: "Recorded automatically from the dialer. Calls logged before the timer existed have none.",
    },
    {
      field: "Industry",
      recorded: count((c) => !!c.lead_industry),
      total,
      note: "Snapshot taken at the moment of the call.",
    },
    {
      field: "Time of day",
      recorded: count((c) => c.dialed_hour !== null),
      total,
      note: "Local to the business where a time zone is known.",
    },
    {
      field: "Attempt number",
      recorded: count((c) => !!c.attempt_number),
      total,
      note: "Backfilled for historical calls from call order.",
    },
    {
      field: "Owner known before dialing",
      recorded: count((c) => c.owner_known_before !== null),
      total,
      note: "The measurement that tells you whether enrichment pays for itself.",
    },
  ];
}

export type AnalyticsReport = {
  totals: Totals;
  dimensions: DimensionReport[];
  coverage: Coverage[];
  /** Findings worth acting on, strongest first. Often empty. That is correct. */
  actionable: (Finding & { dimension: string })[];
  /** Calls still needed before the weakest dimension becomes usable. */
  generatedAt: string;
};

export function analyzeCalls(calls: CallFact[]): AnalyticsReport {
  const dimensions: DimensionReport[] = [
    dimension(
      "hour",
      "Time of day",
      "When should the team be dialing?",
      "owner reached",
      calls,
      (c) => hourBucket(c.dialed_hour),
      reachedOwner,
      {
        label: (k) => HOUR_BUCKETS.find((b) => b.key === k)?.label ?? k,
        order: "key",
      }
    ),
    dimension(
      "dow",
      "Day of week",
      "Which days are worth working?",
      "owner reached",
      calls,
      (c) => (c.dialed_dow === null ? null : String(c.dialed_dow)),
      reachedOwner,
      { label: (k) => DOW[Number(k)] ?? k, order: "key" }
    ),
    dimension(
      "industry",
      "Industry",
      "Which trades should we buy more leads in?",
      "owner reached",
      calls,
      (c) => c.lead_industry,
      reachedOwner,
      { order: "rate" }
    ),
    dimension(
      "industry_appt",
      "Industry → appointments",
      "Which trades actually book?",
      "appointment booked",
      calls,
      (c) => c.lead_industry,
      bookedAppointment,
      { order: "rate" }
    ),
    dimension(
      "caller",
      "Caller",
      "Who is converting, and what are they doing differently?",
      "owner reached",
      calls,
      (c) => c.caller_name,
      reachedOwner,
      { order: "rate" }
    ),
    dimension(
      "attempt",
      "Attempt number",
      "How many times is it worth calling the same company?",
      "owner reached",
      calls,
      (c) => attemptBucket(c.attempt_number),
      reachedOwner,
      { order: "key" }
    ),
    dimension(
      "enrichment",
      "Owner known before dialing",
      "Does enrichment pay for itself?",
      "owner reached",
      calls,
      (c) =>
        c.owner_known_before === null
          ? null
          : c.owner_known_before
            ? "known"
            : "unknown",
      reachedOwner,
      {
        label: (k) => (k === "known" ? "Owner name known" : "Owner unknown"),
        order: "rate",
      }
    ),
    dimension(
      "state",
      "State",
      "Is geography doing anything?",
      "owner reached",
      calls,
      (c) => c.lead_state,
      reachedOwner,
      { order: "trials" }
    ),
  ];

  const actionable = dimensions
    .filter((d) => d.finding.actionable)
    .map((d) => ({ ...d.finding, dimension: d.label }))
    .sort((a, b) => (a.pValue ?? 1) - (b.pValue ?? 1));

  return {
    totals: totalsFor(calls),
    dimensions,
    coverage: coverageFor(calls),
    actionable,
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* objections                                                                 */
/* -------------------------------------------------------------------------- */

export type ObjectionFact = {
  objection_key: string;
  objection_label: string | null;
  outcome: string | null;
  reached_dm: boolean | null;
};

export type ObjectionReport = {
  key: string;
  label: string;
  timesRaised: number;
  survivedToOwnerConversation: number;
  survivalRate: number;
  low: number;
  high: number;
  confidence: Confidence;
};

/**
 * Which objections kill calls. "Survived" means the call still ended in a
 * decision-maker conversation or an appointment after this objection came up.
 */
export function analyzeObjections(rows: ObjectionFact[]): ObjectionReport[] {
  const buckets = new Map<string, { label: string; n: number; survived: number }>();
  for (const r of rows) {
    const b = buckets.get(r.objection_key) ?? {
      label: r.objection_label || r.objection_key,
      n: 0,
      survived: 0,
    };
    b.n += 1;
    if (r.reached_dm === true || r.outcome === "appointment_set") b.survived += 1;
    buckets.set(r.objection_key, b);
  }
  return [...buckets.entries()]
    .map(([key, b]) => {
      const { rate, low, high } = wilson(b.survived, b.n);
      return {
        key,
        label: b.label,
        timesRaised: b.n,
        survivedToOwnerConversation: b.survived,
        survivalRate: rate,
        low,
        high,
        confidence: confidenceFor(b.n),
      };
    })
    .sort((a, b) => b.timesRaised - a.timesRaised);
}
