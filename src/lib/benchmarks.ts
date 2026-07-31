// Absolute targets, alongside team-relative comparison.
//
// The flaw this module fixes: everything was measured against the team's own
// average. With three callers that average is noisy, possibly bad, and built
// from the same people being judged against it — so poor habits become the
// standard, and "ahead of the team" reads as "good" when it may mean "best of
// a bad set".
//
// Two rules:
//
//   Every target carries its provenance. Starting figures borrowed from
//   published cold-calling numbers are available (see SUGGESTED_TARGETS) so a
//   new team is not stuck with an empty form — but they are labelled borrowed
//   everywhere they appear, and the app asks to replace them once there is
//   enough of your own data to know better. What is never allowed is a number
//   that looks like it was measured here when it wasn't.
//
//   No team average from noise. Below a minimum sample the team baseline is
//   not reported at all, rather than computed and quietly treated as a bar.

export type MetricKey =
  | "connect_rate"
  | "owner_reach_rate"
  | "qualified_rate"
  | "appointment_rate"
  | "attendance_rate"
  | "calls_per_day"
  | "followup_minutes";

export type MetricKind = "rate" | "count" | "duration_minutes";

export type MetricDef = {
  key: MetricKey;
  label: string;
  kind: MetricKind;
  /** What it means, so a target can be set knowingly. */
  meaning: string;
  /** Higher is better, except where noted. */
  lowerIsBetter?: boolean;
};

export const METRICS: MetricDef[] = [
  {
    key: "connect_rate",
    label: "Connect rate",
    kind: "rate",
    meaning: "Dials that reach a live person, of any kind.",
  },
  {
    key: "owner_reach_rate",
    label: "Owner-reached rate",
    kind: "rate",
    meaning: "Dials that reach the owner or a confirmed decision-maker.",
  },
  {
    key: "qualified_rate",
    label: "Qualified rate",
    kind: "rate",
    meaning: "Dials that produce a qualified opportunity.",
  },
  {
    key: "appointment_rate",
    label: "Appointment rate",
    kind: "rate",
    meaning: "Dials that end with a meeting booked.",
  },
  {
    key: "attendance_rate",
    label: "Meeting attendance",
    kind: "rate",
    meaning: "Booked meetings that were actually held.",
  },
  {
    key: "calls_per_day",
    label: "Calls per working day",
    kind: "count",
    meaning: "Dials a caller makes on a day they work.",
  },
  {
    key: "followup_minutes",
    label: "Follow-up response time",
    kind: "duration_minutes",
    meaning: "Minutes from a warm call ending to the follow-up going out.",
    lowerIsBetter: true,
  },
];

export const METRIC_MAP: Record<string, MetricDef> = Object.fromEntries(
  METRICS.map((m) => [m.key, m])
);

export type Target = {
  metric: MetricKey;
  target: number;
  source: string;
  note?: string | null;
  minimumSample: number;
};

/* -------------------------------------------------------------------------- */
/* starting points                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Rough starting bars, from the figures commonly published for outbound B2B
 * cold calling.
 *
 * WHAT THESE ARE: approximate mid-points of ranges quoted across sales
 * literature and vendor benchmark reports. They are a place to start when you
 * have no numbers of your own.
 *
 * WHAT THESE ARE NOT: measured on this business. Almost all published cold-call
 * benchmarks come from B2B software teams calling office workers. This team
 * calls owner-operated home-service businesses, where the owner often answers
 * their own phone — connect and owner-reach rates should run HIGHER than the
 * published figures, and appointment rates may differ in either direction.
 *
 * So they are deliberately labelled as borrowed, the app shows that provenance
 * wherever the target is used, and it prompts to replace them with your own
 * numbers once you have enough calls to know better.
 */
export type SuggestedTarget = {
  metric: MetricKey;
  value: number;
  /** The range the published figures actually span. */
  low: number;
  high: number;
  basis: string;
};

export const SUGGESTED_SOURCE = "starting benchmark — general cold calling, not your data";

export const SUGGESTED_TARGETS: SuggestedTarget[] = [
  {
    metric: "connect_rate",
    value: 0.25,
    low: 0.15,
    high: 0.35,
    basis:
      "Published cold-call connect rates cluster around 15-30%. Small local businesses on direct lines should beat that.",
  },
  {
    metric: "owner_reach_rate",
    value: 0.12,
    low: 0.05,
    high: 0.2,
    basis:
      "Decision-maker contact is usually quoted well under connect rate. Owner-operated trades should run higher, since the owner often is the person answering.",
  },
  {
    metric: "qualified_rate",
    value: 0.04,
    low: 0.02,
    high: 0.08,
    basis: "Qualified conversations per dial are commonly quoted in the low single digits.",
  },
  {
    metric: "appointment_rate",
    value: 0.02,
    low: 0.01,
    high: 0.03,
    basis: "Meetings booked per cold dial are widely quoted at 1-3%.",
  },
  {
    metric: "attendance_rate",
    value: 0.7,
    low: 0.6,
    high: 0.8,
    basis:
      "Show rates for cold-set meetings are typically quoted at 60-80%. Confirming in writing moves this more than anything else.",
  },
  {
    metric: "calls_per_day",
    value: 50,
    low: 40,
    high: 80,
    basis:
      "Manual dialling without a power dialer is usually quoted at 40-80 a day. Higher figures assume automated dialling.",
  },
  {
    metric: "followup_minutes",
    value: 10,
    low: 5,
    high: 30,
    basis:
      "Lead-response research consistently finds a steep drop-off after the first few minutes; 5-10 minutes is the usual target.",
  },
];

export const SUGGESTED_MAP: Record<string, SuggestedTarget> = Object.fromEntries(
  SUGGESTED_TARGETS.map((s) => [s.metric, s])
);

/** True when a target is still a borrowed figure rather than your own. */
export function isBorrowed(target: Target | null | undefined): boolean {
  return !!target && target.source === SUGGESTED_SOURCE;
}

/**
 * Once there are enough of your own calls, a borrowed bar should be replaced
 * by what you actually achieve. Returns the prompt to do that, or null.
 */
export const OWN_DATA_THRESHOLD = 500;

export function replaceBorrowedPrompt(
  target: Target | null | undefined,
  observedValue: number,
  observations: number
): string | null {
  if (!isBorrowed(target) || observations < OWN_DATA_THRESHOLD) return null;
  const def = METRIC_MAP[target!.metric];
  const kind = def?.kind ?? "rate";
  const fmt = (v: number) =>
    kind === "rate" ? `${Math.round(v * 100)}%` : String(Math.round(v * 10) / 10);
  return `You now have ${observations} calls of your own. This target is still the borrowed starting figure (${fmt(
    target!.target
  )}); you are actually achieving ${fmt(observedValue)}. Worth replacing it with a number you set deliberately.`;
}

/* -------------------------------------------------------------------------- */
/* sanity floors                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Floors that need no benchmark because they are arithmetic, not industry
 * data. Reaching nobody across eighty dials is a problem whatever the team
 * average happens to be.
 *
 * These are deliberately extreme. They exist to catch a broken list, a broken
 * phone setup or a caller who is not really calling — not to grade anybody.
 */
export type SanityFloor = {
  metric: MetricKey;
  minimumObservations: number;
  floor: number;
  message: string;
};

export const SANITY_FLOORS: SanityFloor[] = [
  {
    metric: "connect_rate",
    minimumObservations: 80,
    floor: 0.05,
    message:
      "Fewer than 1 in 20 dials reached anybody at all. That points at the numbers or the time of day, not the caller.",
  },
  {
    metric: "owner_reach_rate",
    minimumObservations: 80,
    floor: 0.01,
    message:
      "Almost no dials reached a decision-maker across a large number of attempts. Something upstream is wrong.",
  },
];

export function sanityBreach(
  metric: MetricKey,
  value: number,
  observations: number
): SanityFloor | null {
  const floor = SANITY_FLOORS.find((f) => f.metric === metric);
  if (!floor) return null;
  if (observations < floor.minimumObservations) return null;
  return value < floor.floor ? floor : null;
}

/* -------------------------------------------------------------------------- */
/* the assessment                                                             */
/* -------------------------------------------------------------------------- */

export type Comparison = "above" | "below" | "on_par" | "unknown";

export type Assessment = {
  metric: MetricKey;
  label: string;
  value: number;
  observations: number;

  /** Against the rest of the team, when there is enough of a team to compare. */
  teamValue: number | null;
  vsTeam: Comparison;
  /** Why the team comparison is missing, when it is. */
  teamUnavailableReason?: string;

  /** Against the operator's own bar, when one is set. */
  target: number | null;
  targetSource: string | null;
  vsTarget: Comparison;
  /** True when the bar is still a borrowed starting figure, not your own. */
  targetIsBorrowed: boolean;
  /** Shown wherever a borrowed bar is used, so it is never mistaken for measured. */
  targetCaveat?: string;

  /** The honest one-line reading. Never says "good" on team position alone. */
  verdict: string;
  /** Set when beating the team still is not good enough. */
  warning?: string;
  /** An arithmetic floor was breached. Outranks everything else. */
  alarm?: string;
};

const NEAR = 0.05; // within 5% of the bar counts as meeting it

function compare(value: number, against: number, lowerIsBetter: boolean): Comparison {
  const ratio = against === 0 ? (value === 0 ? 1 : Infinity) : value / against;
  const within = Math.abs(ratio - 1) <= NEAR;
  if (within) return "on_par";
  if (lowerIsBetter) return value < against ? "above" : "below";
  return value > against ? "above" : "below";
}

function format(value: number, kind: MetricKind): string {
  if (kind === "rate") return `${Math.round(value * 100)}%`;
  if (kind === "duration_minutes") return `${Math.round(value)} min`;
  return String(Math.round(value * 10) / 10);
}

export type AssessInput = {
  metric: MetricKey;
  value: number;
  observations: number;
  /** The rest of the team, and how many observations sit behind it. */
  teamValue?: number | null;
  teamObservations?: number;
  target?: Target | null;
};

/**
 * Combine both readings into one honest sentence.
 *
 * The rule: a team-relative result may never be reported as success on its
 * own. If a target exists and is missed, that fact leads — however far ahead
 * of the team the caller is.
 */
export function assess(input: AssessInput): Assessment {
  const def = METRIC_MAP[input.metric];
  const lower = !!def?.lowerIsBetter;
  const label = def?.label ?? input.metric;
  const kind = def?.kind ?? "rate";
  const shown = format(input.value, kind);

  const minSample = input.target?.minimumSample ?? 30;

  /* ------------------------------ vs the team ----------------------------- */
  let vsTeam: Comparison = "unknown";
  let teamUnavailableReason: string | undefined;
  const teamObs = input.teamObservations ?? 0;

  if (input.teamValue === null || input.teamValue === undefined) {
    teamUnavailableReason = "Nobody else has enough calls to compare against.";
  } else if (teamObs < minSample) {
    // The heart of the fix: refuse to compute a bar out of noise.
    teamUnavailableReason = `The rest of the team has only ${teamObs} calls — too few to be a meaningful average, so no comparison is shown.`;
  } else {
    vsTeam = compare(input.value, input.teamValue, lower);
  }

  /* ----------------------------- vs the target ---------------------------- */
  let vsTarget: Comparison = "unknown";
  if (input.target) {
    vsTarget = compare(input.value, input.target.target, lower);
  }

  /* ------------------------------- the words ------------------------------ */
  const alarm = sanityBreach(input.metric, input.value, input.observations)?.message;

  let verdict: string;
  let warning: string | undefined;

  if (input.observations === 0) {
    verdict = `No ${label.toLowerCase()} recorded yet.`;
  } else if (input.target && vsTarget === "below") {
    // Missing the bar leads, whatever the team is doing.
    verdict = `${shown} — below your target of ${format(input.target.target, kind)}.`;
    if (vsTeam === "above") {
      warning =
        "Ahead of the rest of the team, but the team is below target too. Being the best of the group is not the same as being good enough.";
    }
  } else if (input.target && (vsTarget === "above" || vsTarget === "on_par")) {
    verdict = `${shown} — ${vsTarget === "above" ? "above" : "at"} your target of ${format(input.target.target, kind)}.`;
  } else if (vsTeam !== "unknown") {
    // No target set. Say only what is true: a relative position.
    const rel =
      vsTeam === "above"
        ? "ahead of the rest of the team"
        : vsTeam === "below"
          ? "behind the rest of the team"
          : "in line with the rest of the team";
    verdict = `${shown} — ${rel}. No target set, so there is nothing to say about whether that is good.`;
  } else {
    verdict = `${shown} — no target set and no team average to compare against.`;
  }

  const borrowed = isBorrowed(input.target);
  const replace = replaceBorrowedPrompt(input.target, input.value, input.observations);

  return {
    metric: input.metric,
    label,
    value: input.value,
    observations: input.observations,
    teamValue: input.teamValue ?? null,
    vsTeam,
    teamUnavailableReason,
    target: input.target?.target ?? null,
    targetSource: input.target?.source ?? null,
    vsTarget,
    targetIsBorrowed: borrowed,
    targetCaveat: borrowed
      ? replace ??
        "This bar is a borrowed starting figure from general cold-calling numbers, not measured on your business."
      : undefined,
    verdict,
    warning,
    alarm,
  };
}

/**
 * Does the TEAM as a whole clear its own bar? Answering this separately is
 * what stops a weak team quietly becoming the standard.
 */
export function assessTeam(
  metric: MetricKey,
  teamValue: number,
  observations: number,
  target: Target | null
): Assessment {
  return assess({ metric, value: teamValue, observations, target });
}

/** Metrics with no target set, so the gap is visible rather than silent. */
export function missingTargets(targets: Target[]): MetricDef[] {
  const set = new Set(targets.map((t) => t.metric));
  return METRICS.filter((m) => !set.has(m.key));
}
