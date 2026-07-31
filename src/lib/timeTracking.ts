// Time tracking, derived from work that actually happened.
//
// Nothing here asks anyone to clock in. Every call outcome carries a
// server-side timestamp the caller cannot edit, so the shape of a working day
// can be reconstructed from the work itself. That is harder to inflate than a
// self-reported timesheet, and it is the only thing the app genuinely
// witnesses.
//
// WHAT THIS CAN AND CANNOT SEE — stated up front because it decides how much
// weight the numbers deserve:
//
//   CAN   when each outcome was saved, in what order, and how long the dialer
//         had the lead open.
//   CAN   gaps between saved outcomes, and therefore idle stretches.
//   CANNOT whether someone was at their desk between two calls.
//   CANNOT whether a number was really dialed, or the outcome just clicked.
//
// So this produces evidence and questions, never proof. The flags are written
// as things to ask about, each with the innocent explanation alongside.

export type ActivityEvent = {
  callerName: string;
  /** When the outcome was saved. Server time; the caller cannot set it. */
  at: string;
  /** When the dialer handed them the lead, if the timer recorded it. */
  startedAt?: string | null;
  durationSeconds?: number | null;
  outcome: string;
};

/** A stretch of continuous work. A gap longer than this starts a new one. */
export const IDLE_BREAK_MINUTES = 20;
/** Two outcomes closer together than this were not two real phone calls. */
export const IMPLAUSIBLY_FAST_SECONDS = 25;
/** A gap this long inside a working day is worth seeing. */
export const NOTABLE_GAP_MINUTES = 45;

export type Session = {
  start: string;
  end: string;
  minutes: number;
  calls: number;
};

export type DayActivity = {
  date: string;
  callerName: string;
  sessions: Session[];
  /** Minutes inside a session — the defensible "was working" figure. */
  activeMinutes: number;
  /** First activity to last, including every gap. */
  spanMinutes: number;
  /** Span minus active. Time between sessions. */
  idleMinutes: number;
  calls: number;
  callsPerActiveHour: number;
  /** Time the dialer actually had a lead open, where the timer recorded it. */
  measuredCallMinutes: number;
  firstAt: string | null;
  lastAt: string | null;
};

const MIN = 60_000;

function ms(t: string): number {
  const v = new Date(t).getTime();
  return Number.isFinite(v) ? v : NaN;
}

/** The window a single call occupied, best effort. */
function spanOf(e: ActivityEvent): { start: number; end: number } | null {
  const end = ms(e.at);
  if (!Number.isFinite(end)) return null;
  const started = e.startedAt ? ms(e.startedAt) : NaN;
  if (Number.isFinite(started) && started <= end) return { start: started, end };
  const dur = typeof e.durationSeconds === "number" && e.durationSeconds > 0 ? e.durationSeconds : 0;
  return { start: end - dur * 1000, end };
}

/**
 * Group one caller's events into working sessions. Events closer together than
 * the idle break belong to the same stretch; a longer gap ends it.
 */
export function buildSessions(
  events: ActivityEvent[],
  idleBreakMinutes = IDLE_BREAK_MINUTES
): Session[] {
  const spans = events
    .map((e) => ({ e, s: spanOf(e) }))
    .filter((x): x is { e: ActivityEvent; s: { start: number; end: number } } => x.s !== null)
    .sort((a, b) => a.s.start - b.s.start);
  if (spans.length === 0) return [];

  const sessions: Session[] = [];
  let start = spans[0].s.start;
  let end = spans[0].s.end;
  let calls = 1;

  for (let i = 1; i < spans.length; i++) {
    const { s } = spans[i];
    if (s.start - end > idleBreakMinutes * MIN) {
      sessions.push({
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        minutes: Math.round((end - start) / MIN),
        calls,
      });
      start = s.start;
      end = s.end;
      calls = 1;
    } else {
      end = Math.max(end, s.end);
      calls += 1;
    }
  }
  sessions.push({
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    minutes: Math.round((end - start) / MIN),
    calls,
  });
  return sessions;
}

/** One caller, one calendar day. */
export function dayActivity(
  callerName: string,
  date: string,
  events: ActivityEvent[],
  idleBreakMinutes = IDLE_BREAK_MINUTES
): DayActivity {
  const sessions = buildSessions(events, idleBreakMinutes);
  const activeMinutes = sessions.reduce((n, s) => n + s.minutes, 0);

  const times = events.map((e) => ms(e.at)).filter((v) => Number.isFinite(v));
  const firstAt = times.length ? new Date(Math.min(...times)).toISOString() : null;
  const lastAt = times.length ? new Date(Math.max(...times)).toISOString() : null;
  const spanMinutes =
    times.length > 1 ? Math.round((Math.max(...times) - Math.min(...times)) / MIN) : 0;

  const measuredSeconds = events.reduce(
    (n, e) => n + (typeof e.durationSeconds === "number" && e.durationSeconds > 0 ? e.durationSeconds : 0),
    0
  );

  return {
    date,
    callerName,
    sessions,
    activeMinutes,
    spanMinutes,
    idleMinutes: Math.max(0, spanMinutes - activeMinutes),
    calls: events.length,
    callsPerActiveHour:
      activeMinutes > 0 ? Math.round((events.length / (activeMinutes / 60)) * 10) / 10 : 0,
    measuredCallMinutes: Math.round(measuredSeconds / 60),
    firstAt,
    lastAt,
  };
}

/* -------------------------------------------------------------------------- */
/* integrity                                                                  */
/* -------------------------------------------------------------------------- */

export type FlagKey =
  | "rapid_fire"
  | "no_timer_data"
  | "idle_heavy"
  | "one_outcome_only"
  | "short_day";

export type Flag = {
  key: FlagKey;
  /** What to ask about. Phrased as a question, never as an accusation. */
  question: string;
  /** The numbers behind it. */
  evidence: string;
  /** The reasonable explanation, so nobody is hanged on a metric. */
  innocentExplanation: string;
  severity: "low" | "medium" | "high";
};

export type IntegrityInput = {
  callerName: string;
  events: ActivityEvent[];
  days: DayActivity[];
  /** Share of the team's calls that are no-answer, for comparison. */
  teamNoAnswerRate?: number | null;
};

const NO_CONTACT = ["no_answer", "voicemail", "bad_number"];

export function integrityFlags(input: IntegrityInput): Flag[] {
  const { events, days } = input;
  const flags: Flag[] = [];
  if (events.length === 0) return flags;

  const sorted = [...events]
    .map((e) => ({ e, t: ms(e.at) }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);

  /* --------------------------- outcomes too fast --------------------------- */
  let rapid = 0;
  for (let i = 1; i < sorted.length; i++) {
    if ((sorted[i].t - sorted[i - 1].t) / 1000 < IMPLAUSIBLY_FAST_SECONDS) rapid += 1;
  }
  if (rapid >= 3) {
    const share = Math.round((rapid / Math.max(1, sorted.length - 1)) * 100);
    flags.push({
      key: "rapid_fire",
      question: `Were these really separate calls? ${rapid} outcomes were saved less than ${IMPLAUSIBLY_FAST_SECONDS} seconds after the previous one.`,
      evidence: `${rapid} of ${sorted.length - 1} consecutive pairs (${share}%) are under ${IMPLAUSIBLY_FAST_SECONDS} seconds apart.`,
      innocentExplanation:
        "Dead numbers and instant voicemails genuinely resolve in seconds, and a run of them is normal. It is the sustained pattern that is worth asking about.",
      severity: share > 40 ? "high" : share > 20 ? "medium" : "low",
    });
  }

  /* ------------------------- nothing measured at all ------------------------ */
  const timed = events.filter(
    (e) => typeof e.durationSeconds === "number" && e.durationSeconds > 0
  ).length;
  if (events.length >= 10 && timed / events.length < 0.5) {
    flags.push({
      key: "no_timer_data",
      question: "Why is there no timing on most of these calls?",
      evidence: `Only ${timed} of ${events.length} calls recorded any time on the lead.`,
      innocentExplanation:
        "Calls logged before the timer existed have none, and a refreshed page loses the clock. If these are recent, it is worth a look.",
      severity: "low",
    });
  }

  /* ------------------------------- idle heavy ------------------------------- */
  const heavy = days.filter((d) => d.spanMinutes > 120 && d.activeMinutes < d.spanMinutes * 0.4);
  if (heavy.length > 0) {
    const worst = heavy.sort((a, b) => b.idleMinutes - a.idleMinutes)[0];
    flags.push({
      key: "idle_heavy",
      question: "What was happening in the gaps on these days?",
      evidence: `${heavy.length} day${heavy.length === 1 ? "" : "s"} where less than 40% of the working span had any activity. Worst: ${worst.date}, ${Math.round(worst.activeMinutes / 60 * 10) / 10}h active across a ${Math.round(worst.spanMinutes / 60 * 10) / 10}h span.`,
      innocentExplanation:
        "Meetings, breaks, admin and research all look like silence here — the app only sees logged outcomes.",
      severity: "medium",
    });
  }

  /* --------------------------- one outcome only ---------------------------- */
  if (events.length >= 20) {
    const counts = new Map<string, number>();
    for (const e of events) counts.set(e.outcome, (counts.get(e.outcome) || 0) + 1);
    const [topOutcome, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const share = topCount / events.length;
    const teamRate = input.teamNoAnswerRate;
    const wellAbove =
      NO_CONTACT.includes(topOutcome) && teamRate !== null && teamRate !== undefined
        ? share > teamRate + 0.25
        : share > 0.9;
    if (share > 0.85 && wellAbove) {
      flags.push({
        key: "one_outcome_only",
        question: `Nearly everything is logged as "${topOutcome.replace(/_/g, " ")}" — is the dialing going as it should?`,
        evidence:
          `${topCount} of ${events.length} calls (${Math.round(share * 100)}%)` +
          (teamRate != null ? `, against ${Math.round(teamRate * 100)}% for the team.` : "."),
        innocentExplanation:
          "A bad batch of numbers, or calling at the wrong time of day, produces this honestly. Check the lead source before the person.",
        severity: "medium",
      });
    }
  }

  /* -------------------------------- short days ------------------------------ */
  const workingDays = days.filter((d) => d.calls > 0);
  const shortDays = workingDays.filter((d) => d.activeMinutes < 60);
  if (workingDays.length >= 3 && shortDays.length / workingDays.length > 0.5) {
    flags.push({
      key: "short_day",
      question: "Are these full days being billed?",
      evidence: `${shortDays.length} of ${workingDays.length} days show under an hour of activity.`,
      innocentExplanation:
        "Part-time hours, or a day spent on something other than dialing. Compare against what was invoiced rather than assuming.",
      severity: "medium",
    });
  }

  return flags;
}

/* -------------------------------------------------------------------------- */
/* the timesheet                                                              */
/* -------------------------------------------------------------------------- */

export type CallerTimesheet = {
  callerName: string;
  days: DayActivity[];
  totalActiveHours: number;
  totalCalls: number;
  averageCallsPerActiveHour: number;
  daysWorked: number;
  flags: Flag[];
};

export function buildTimesheet(
  events: ActivityEvent[],
  opts?: { idleBreakMinutes?: number }
): CallerTimesheet[] {
  const idle = opts?.idleBreakMinutes ?? IDLE_BREAK_MINUTES;

  const teamNoAnswer =
    events.length > 0
      ? events.filter((e) => NO_CONTACT.includes(e.outcome)).length / events.length
      : null;

  const byCaller = new Map<string, ActivityEvent[]>();
  for (const e of events) {
    if (!e.callerName) continue;
    if (!byCaller.has(e.callerName)) byCaller.set(e.callerName, []);
    byCaller.get(e.callerName)!.push(e);
  }

  return [...byCaller.entries()]
    .map(([callerName, mine]) => {
      const byDay = new Map<string, ActivityEvent[]>();
      for (const e of mine) {
        const day = e.at.slice(0, 10);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day)!.push(e);
      }
      const days = [...byDay.entries()]
        .map(([date, dayEvents]) => dayActivity(callerName, date, dayEvents, idle))
        .sort((a, b) => b.date.localeCompare(a.date));

      const totalActiveMinutes = days.reduce((n, d) => n + d.activeMinutes, 0);
      const totalCalls = days.reduce((n, d) => n + d.calls, 0);

      return {
        callerName,
        days,
        totalActiveHours: Math.round((totalActiveMinutes / 60) * 10) / 10,
        totalCalls,
        averageCallsPerActiveHour:
          totalActiveMinutes > 0
            ? Math.round((totalCalls / (totalActiveMinutes / 60)) * 10) / 10
            : 0,
        daysWorked: days.filter((d) => d.calls > 0).length,
        flags: integrityFlags({
          callerName,
          events: mine,
          days,
          teamNoAnswerRate: teamNoAnswer,
        }),
      };
    })
    .sort((a, b) => b.totalActiveHours - a.totalActiveHours);
}
