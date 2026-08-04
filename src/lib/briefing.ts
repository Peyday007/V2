// The daily read-out.
//
// The analytics page only reports CONCLUSIONS — differences big enough and
// sampled well enough to be trusted. That is the right bar for "mornings beat
// afternoons", and with a few dozen calls nothing clears it, so the page
// correctly says nothing. But "nothing is proven" is not the same as "nothing
// is known", and the second one is what an operator actually wants each
// morning.
//
// This module reports what IS known: what happened, what the calls taught us,
// what needs a decision today, and which questions are close to answerable.
// Observations are labelled as observations and always carry their counts, so
// they can never be mistaken for findings.

import {
  type CallFact,
  type ObjectionFact,
  reachedOwner,
  bookedAppointment,
  connected,
  analyzeCalls,
  hourBucket,
  HOUR_BUCKETS,
  MIN_DIRECTIONAL,
} from "./analytics";
import {
  assess,
  METRICS,
  isBorrowed,
  type MetricKey,
  type Target,
} from "./benchmarks";

export type Tone = "fact" | "good" | "warn" | "action";

export type BriefingLine = {
  text: string;
  tone: Tone;
  /** Optional second line, quieter. */
  detail?: string;
};

export type BriefingSection = {
  key: string;
  title: string;
  /** Shown when the section has nothing in it. */
  emptyText: string;
  lines: BriefingLine[];
};

export type AppointmentFact = {
  scheduled_for: string;
  attendance_status: string | null;
  business_name?: string | null;
  caller_name?: string | null;
};

export type CallbackFact = {
  scheduled_for: string;
  status: string | null;
  business_name?: string | null;
  caller_name?: string | null;
};

export type LearnedFact = {
  ownerNames: number;
  bestCallTimes: number;
  directNumbers: number;
  answeringSetups: number;
  existingProviders: number;
  gatekeeperNames: number;
  totalLeadsTouched: number;
};

export type BriefingInput = {
  calls: CallFact[];
  objections: ObjectionFact[];
  appointments: AppointmentFact[];
  callbacks: CallbackFact[];
  learned: LearnedFact;
  readyToCall: number;
  pendingInPackets: number;
  /** Absolute bars, from Analytics. Empty means no bar is asserted. */
  targets?: Target[];
  now?: Date;
};

const DAY = 86_400_000;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function pct(part: number, whole: number): string {
  if (whole === 0) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}

/** Calls within the last `days` days. */
export function callsSince(calls: CallFact[], days: number, now = new Date()): CallFact[] {
  const cutoff = now.getTime() - days * DAY;
  return calls.filter((c) => {
    const t = new Date(c.created_at).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
}

/* -------------------------------------------------------------------------- */
/* 1. what happened                                                           */
/* -------------------------------------------------------------------------- */

export function activitySection(calls: CallFact[], now = new Date()): BriefingSection {
  const today = callsSince(calls, 1, now);
  const week = callsSince(calls, 7, now);
  const lines: BriefingLine[] = [];

  function summarize(label: string, subset: CallFact[]): BriefingLine | null {
    if (subset.length === 0) return null;
    const owners = subset.filter(reachedOwner).length;
    const appts = subset.filter(bookedAppointment).length;
    const conn = subset.filter(connected).length;
    return {
      text:
        `${label}: ${plural(subset.length, "call")}, ${conn} got through to a person ` +
        `(${pct(conn, subset.length)}), ${plural(owners, "owner conversation")}` +
        (appts > 0 ? `, ${plural(appts, "appointment")} booked` : ""),
      tone: appts > 0 ? "good" : "fact",
    };
  }

  const t = summarize("Last 24 hours", today);
  if (t) lines.push(t);
  const w = summarize("Last 7 days", week);
  if (w) lines.push(w);
  if (calls.length > week.length) {
    const all = summarize("All time", calls);
    if (all) lines.push(all);
  }

  // Who is actually dialing.
  const byCaller = new Map<string, CallFact[]>();
  for (const c of week) {
    const key = c.caller_name || "unknown";
    byCaller.set(key, [...(byCaller.get(key) || []), c]);
  }
  for (const [name, subset] of [...byCaller.entries()].sort(
    (a, b) => b[1].length - a[1].length
  )) {
    const owners = subset.filter(reachedOwner).length;
    lines.push({
      text: `${name} made ${plural(subset.length, "call")} this week, reaching an owner ${plural(owners, "time")}`,
      tone: "fact",
    });
  }

  const durations = calls
    .map((c) => c.duration_seconds)
    .filter((d): d is number => typeof d === "number" && d > 0);
  if (durations.length > 0) {
    const total = durations.reduce((a, b) => a + b, 0);
    lines.push({
      text: `${Math.round(total / 60)} minutes on the phone across ${plural(durations.length, "timed call")}`,
      tone: "fact",
      detail: `Average ${Math.round(total / durations.length)} seconds a call.`,
    });
  }

  return {
    key: "activity",
    title: "What happened",
    emptyText: "No calls logged yet.",
    lines,
  };
}

/* -------------------------------------------------------------------------- */
/* 2. what needs you                                                          */
/* -------------------------------------------------------------------------- */

export function attentionSection(input: BriefingInput): BriefingSection {
  const now = input.now || new Date();
  const lines: BriefingLine[] = [];

  const dueCallbacks = input.callbacks.filter(
    (c) => (c.status ?? "pending") === "pending" && new Date(c.scheduled_for) <= now
  );
  const soonCallbacks = input.callbacks.filter(
    (c) =>
      (c.status ?? "pending") === "pending" &&
      new Date(c.scheduled_for) > now &&
      new Date(c.scheduled_for).getTime() <= now.getTime() + DAY
  );
  if (dueCallbacks.length > 0) {
    lines.push({
      text: `${plural(dueCallbacks.length, "callback")} overdue`,
      tone: "warn",
      detail: dueCallbacks
        .slice(0, 4)
        .map((c) => c.business_name || "a lead")
        .join(", "),
    });
  }
  if (soonCallbacks.length > 0) {
    lines.push({
      text: `${plural(soonCallbacks.length, "callback")} due in the next 24 hours`,
      tone: "action",
    });
  }

  const past = input.appointments.filter(
    (a) =>
      new Date(a.scheduled_for) < now &&
      (!a.attendance_status || a.attendance_status === "scheduled")
  );
  if (past.length > 0) {
    lines.push({
      text: `${plural(past.length, "appointment")} happened but ${past.length === 1 ? "has" : "have"} not been marked held or no-show`,
      tone: "action",
      detail:
        "Show rate cannot be measured until these are marked on the Appointments tab.",
    });
  }

  const upcoming = input.appointments.filter(
    (a) =>
      new Date(a.scheduled_for) >= now &&
      (!a.attendance_status || a.attendance_status === "scheduled")
  );
  if (upcoming.length > 0) {
    lines.push({
      text: `${plural(upcoming.length, "appointment")} coming up`,
      tone: "good",
      detail: upcoming
        .slice(0, 4)
        .map(
          (a) =>
            `${a.business_name || "a lead"} — ${new Date(a.scheduled_for).toLocaleString(
              undefined,
              { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
            )}`
        )
        .join(" · "),
    });
  }

  if (input.pendingInPackets === 0 && input.readyToCall > 0) {
    lines.push({
      text: `Your callers have run out — ${plural(input.readyToCall, "lead")} ready to hand over`,
      tone: "warn",
    });
  } else if (input.pendingInPackets > 0 && input.pendingInPackets < 15) {
    lines.push({
      text: `Only ${plural(input.pendingInPackets, "lead")} left across all packets`,
      tone: "warn",
      detail: "Worth topping up before your callers run dry.",
    });
  }

  const badNumbers = input.calls.filter((c) => c.outcome === "bad_number").length;
  if (badNumbers >= 3) {
    const rate = pct(badNumbers, input.calls.length);
    lines.push({
      text: `${plural(badNumbers, "bad number")} so far (${rate} of all calls)`,
      tone: badNumbers / Math.max(1, input.calls.length) > 0.15 ? "warn" : "fact",
      detail:
        badNumbers / Math.max(1, input.calls.length) > 0.15
          ? "That is high enough to suspect the lead source rather than bad luck."
          : undefined,
    });
  }

  return {
    key: "attention",
    title: "Needs a decision from you",
    emptyText: "Nothing waiting on you.",
    lines,
  };
}

/* -------------------------------------------------------------------------- */
/* 3. what the calls taught us                                                */
/* -------------------------------------------------------------------------- */

export function learnedSection(input: BriefingInput): BriefingSection {
  const l = input.learned;
  const lines: BriefingLine[] = [];

  if (l.ownerNames > 0) {
    lines.push({
      text: `${plural(l.ownerNames, "owner")} now identified by name`,
      tone: "good",
      detail:
        "Every future caller sees the name before dialing, so nobody rediscovers it.",
    });
  }
  if (l.bestCallTimes > 0) {
    lines.push({
      text: `${plural(l.bestCallTimes, "lead")} with a best time to call recorded`,
      tone: "good",
    });
  }
  if (l.directNumbers > 0) {
    lines.push({
      text: `${plural(l.directNumbers, "direct number or extension")} captured`,
      tone: "good",
    });
  }
  if (l.gatekeeperNames > 0) {
    lines.push({
      text: `${plural(l.gatekeeperNames, "gatekeeper")} known by name`,
      tone: "fact",
    });
  }
  if (l.answeringSetups > 0) {
    lines.push({
      text: `${plural(l.answeringSetups, "business")} where we know how calls are currently answered`,
      tone: "fact",
      detail: "This is the qualifying question for the product, so it is worth having.",
    });
  }
  if (l.existingProviders > 0) {
    lines.push({
      text: `${plural(l.existingProviders, "business")} already using a competitor`,
      tone: "fact",
    });
  }

  // Objections, reported as raw counts — no significance claim.
  const byKey = new Map<string, { label: string; n: number }>();
  for (const o of input.objections) {
    const b = byKey.get(o.objection_key) || {
      label: o.objection_label || o.objection_key,
      n: 0,
    };
    b.n += 1;
    byKey.set(o.objection_key, b);
  }
  const top = [...byKey.values()].sort((a, b) => b.n - a.n).slice(0, 3);
  for (const o of top) {
    lines.push({
      text: `"${o.label}" came up ${plural(o.n, "time")}`,
      tone: "fact",
    });
  }

  return {
    key: "learned",
    title: "What the calls taught us",
    emptyText:
      "Nothing captured yet. Anything a caller learns on a call — an owner's name, a best time, an extension — is saved here permanently.",
    lines,
  };
}

/* -------------------------------------------------------------------------- */
/* 4. observations — patterns, explicitly not conclusions                     */
/* -------------------------------------------------------------------------- */

/** Minimum before an observation is worth printing at all. */
export const MIN_FOR_OBSERVATION = 5;

export function observationsSection(calls: CallFact[]): BriefingSection {
  const lines: BriefingLine[] = [];

  if (calls.length >= MIN_FOR_OBSERVATION) {
    // Time of day, as raw counts.
    const buckets = new Map<string, { n: number; owners: number }>();
    for (const c of calls) {
      const key = hourBucket(c.dialed_hour);
      if (!key) continue;
      const b = buckets.get(key) || { n: 0, owners: 0 };
      b.n += 1;
      if (reachedOwner(c)) b.owners += 1;
      buckets.set(key, b);
    }
    const ranked = [...buckets.entries()]
      .filter(([, b]) => b.n > 0)
      .sort((a, b) => b[1].owners / b[1].n - a[1].owners / a[1].n);
    if (ranked.length >= 2) {
      const [key, b] = ranked[0];
      const label = HOUR_BUCKETS.find((h) => h.key === key)?.label ?? key;
      lines.push({
        text: `Best hours so far: ${label} — ${b.owners} of ${b.n} calls reached an owner`,
        tone: "fact",
        detail: "Too few calls to call this a pattern yet. It is what has happened.",
      });
    }

    // Attempt number: does calling back work?
    const first = calls.filter((c) => c.attempt_number === 1);
    const later = calls.filter((c) => (c.attempt_number ?? 1) > 1);
    if (first.length >= 3 && later.length >= 3) {
      lines.push({
        text:
          `First attempts reached an owner ${first.filter(reachedOwner).length} of ${first.length} times; ` +
          `repeat attempts ${later.filter(reachedOwner).length} of ${later.length}`,
        tone: "fact",
      });
    }

    // Did knowing the owner's name help?
    const known = calls.filter((c) => c.owner_known_before === true);
    const unknown = calls.filter((c) => c.owner_known_before === false);
    if (known.length >= 3 && unknown.length >= 3) {
      lines.push({
        text:
          `When the owner's name was already known: ${known.filter(reachedOwner).length} of ${known.length} reached them. ` +
          `When it was not: ${unknown.filter(reachedOwner).length} of ${unknown.length}`,
        tone: "fact",
        detail: "This is the number that eventually tells you if enrichment pays for itself.",
      });
    }

    // Industries actually being dialed.
    const industries = new Map<string, number>();
    for (const c of calls) {
      if (c.lead_industry) industries.set(c.lead_industry, (industries.get(c.lead_industry) || 0) + 1);
    }
    if (industries.size > 1) {
      const top = [...industries.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      lines.push({
        text: `Most-called trades: ${top.map(([k, v]) => `${k} (${v})`).join(", ")}`,
        tone: "fact",
      });
    }
  }

  return {
    key: "observations",
    title: "Observations so far",
    emptyText: `Patterns start appearing here after about ${MIN_FOR_OBSERVATION} calls.`,
    lines,
  };
}

/* -------------------------------------------------------------------------- */
/* 5. what is nearly answerable                                               */
/* -------------------------------------------------------------------------- */

export function horizonSection(calls: CallFact[]): BriefingSection {
  const report = analyzeCalls(calls);
  const lines: BriefingLine[] = [];

  for (const d of report.dimensions) {
    if (d.finding.actionable) {
      lines.push({
        text: `${d.label}: ${d.finding.headline}`,
        tone: "good",
        detail: d.finding.detail,
      });
      continue;
    }
    const measured = d.segments.reduce((n, s) => n + s.trials, 0);
    if (measured === 0) continue;
    const needed = d.finding.callsNeeded;
    if (needed && needed > 0) {
      lines.push({
        text: `${d.label} — roughly ${plural(needed, "more call")} per group before this can be trusted`,
        tone: "fact",
      });
    } else if (measured < MIN_DIRECTIONAL) {
      lines.push({
        text: `${d.label} — ${plural(measured, "call")} measured, ${MIN_DIRECTIONAL - measured} more before any signal is worth reading`,
        tone: "fact",
      });
    }
  }

  return {
    key: "horizon",
    title: "Questions coming into focus",
    emptyText: "Nothing measured yet.",
    lines: lines.slice(0, 8),
  };
}

/* -------------------------------------------------------------------------- */
/* 6. against the bar                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Everything above this point is either a plain count or a comparison between
 * your own callers. Neither can answer "is this any good" — with a small team
 * the average is both noisy and possibly low, so the best of the group reads as
 * strong. This section is the only one that answers it, and only where a target
 * has actually been set.
 */
export function targetsSection(
  calls: CallFact[],
  targets: Target[] = []
): BriefingSection {
  const lines: BriefingLine[] = [];

  if (calls.length === 0) {
    return {
      key: "targets",
      title: "Against your targets",
      emptyText: "No calls logged yet.",
      lines,
    };
  }

  const byMetric = new Map(targets.map((t) => [t.metric, t]));
  const rate: Record<string, number> = {
    connect_rate: calls.filter(connected).length / calls.length,
    owner_reach_rate: calls.filter(reachedOwner).length / calls.length,
    appointment_rate: calls.filter(bookedAppointment).length / calls.length,
  };

  const scored: MetricKey[] = ["connect_rate", "owner_reach_rate", "appointment_rate"];
  let borrowedSeen = false;

  for (const metric of scored) {
    const target = byMetric.get(metric) ?? null;
    const a = assess({
      metric,
      value: rate[metric],
      observations: calls.length,
      target,
    });
    if (isBorrowed(target)) borrowedSeen = true;

    lines.push({
      text: `${a.label}: ${a.verdict}`,
      tone: a.alarm
        ? "warn"
        : a.vsTarget === "below"
          ? "warn"
          : a.vsTarget === "unknown"
            ? "fact"
            : "good",
      detail:
        a.alarm ??
        a.targetCaveat ??
        `Across ${plural(calls.length, "call")}.`,
    });
  }

  if (targets.length === 0) {
    lines.push({
      text: "No targets are set, so nothing above can be called good or bad",
      tone: "action",
      detail:
        "Every other number in this platform compares your callers to each other. " +
        "That says who is stronger, not whether anyone is good enough. Set targets on " +
        "the Targets page — starting figures are offered there if you have none of your own.",
    });
  } else if (targets.length < METRICS.length) {
    lines.push({
      text: `${METRICS.length - targets.length} metrics still have no target`,
      tone: "fact",
      detail: "Those are reported team-relative only until a bar is set for them.",
    });
  }

  if (borrowedSeen) {
    lines.push({
      text: "Some of these bars are borrowed starting figures, not your numbers",
      tone: "fact",
      detail:
        "They came from published cold-calling ranges, mostly measured on teams calling " +
        "office workers rather than owner-operated trades. Replace them once you have " +
        "enough of your own calls to know better.",
    });
  }

  return {
    key: "targets",
    title: "Against your targets",
    emptyText: "No calls logged yet.",
    lines,
  };
}

/* -------------------------------------------------------------------------- */

export type Briefing = {
  headline: string;
  subhead: string;
  sections: BriefingSection[];
  generatedAt: string;
};

export function buildBriefing(input: BriefingInput): Briefing {
  const now = input.now || new Date();
  const calls = input.calls;
  const today = callsSince(calls, 1, now);
  const owners = calls.filter(reachedOwner).length;
  const appts = calls.filter(bookedAppointment).length;

  let headline: string;
  if (calls.length === 0) {
    headline = "No calls logged yet";
  } else if (appts > 0) {
    headline = `${plural(calls.length, "call")}, ${plural(owners, "owner conversation")}, ${plural(appts, "appointment")}`;
  } else if (owners > 0) {
    headline = `${plural(calls.length, "call")} and ${plural(owners, "owner conversation")} so far`;
  } else {
    headline = `${plural(calls.length, "call")} logged, no owner reached yet`;
  }

  const subhead =
    calls.length === 0
      ? "Everything below fills in from the first call a caller saves."
      : today.length > 0
        ? `${plural(today.length, "call")} in the last 24 hours.`
        : "No calls in the last 24 hours.";

  return {
    headline,
    subhead,
    sections: [
      activitySection(calls, now),
      targetsSection(calls, input.targets || []),
      attentionSection(input),
      learnedSection(input),
      observationsSection(calls),
      horizonSection(calls),
    ],
    generatedAt: now.toISOString(),
  };
}
