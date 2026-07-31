// Adaptive packet ordering.
//
// A packet used to be worked in the order it was built, which quietly wastes a
// caller's morning: someone starting at 9am in Michigan who hits a run of
// California plumbers is ringing them at 6am. Nobody answers, the leads burn an
// attempt each, and the data says "bad leads" when it was really bad timing.
//
// So the order is decided at the moment a lead is served, not when the packet
// was built. Everything is scored against the business's OWN clock, plus
// anything the team has already learned about when that specific business
// answers.
//
// Pure: no database, no network, so the rules are testable and the dialer and
// the admin preview cannot disagree about them.

import { localHourParts, timezoneForState } from "./callWindows";

export type DialCandidate = {
  leadId: string;
  packetId: string | null;
  /** Set when this came from a promised callback. */
  callbackId?: string | null;
  callbackDue?: string | null;

  state?: string | null;
  timezone?: string | null;
  industry?: string | null;

  /** What the team learned about when to catch them. */
  bestCallDay?: string | null;
  bestCallTime?: string | null;

  /** Retry schedule from the last outcome. */
  nextAttemptAt?: string | null;
  attemptCount?: number | null;

  /** Original packet position, used only to break ties. */
  position?: number | null;
};

export type WindowStatus = "prime" | "workable" | "early_or_late" | "closed" | "unknown";

export type ScoredCandidate = {
  candidate: DialCandidate;
  score: number;
  /** Their local hour, when we know their time zone. */
  localHour: number | null;
  localDayOfWeek: number | null;
  timezone: string | null;
  windowStatus: WindowStatus;
  /** Plain-language reasons, best first. Shown to the caller. */
  reasons: string[];
};

/** Hours, in the business's own time, when calling is worth doing. */
export const PRIME_HOURS: [number, number][] = [
  [8, 11],
  [13, 16],
];
export const WORKABLE_HOURS: [number, number][] = [
  [11, 13],
  [16, 17],
];
/** Callable but poor: someone might be there, most will not. */
export const FRINGE_HOURS: [number, number][] = [
  [7, 8],
  [17, 19],
];

function inAny(hour: number, ranges: [number, number][]): boolean {
  return ranges.some(([from, to]) => hour >= from && hour < to);
}

export function windowFor(hour: number | null, dayOfWeek: number | null): WindowStatus {
  if (hour === null || dayOfWeek === null) return "unknown";
  if (dayOfWeek === 0) return "closed"; // Sunday
  // Saturday: some trades work a morning, none of them well.
  if (dayOfWeek === 6) return hour >= 9 && hour < 14 ? "workable" : "closed";
  if (inAny(hour, PRIME_HOURS)) return "prime";
  if (inAny(hour, WORKABLE_HOURS)) return "workable";
  if (inAny(hour, FRINGE_HOURS)) return "early_or_late";
  return "closed";
}

const WINDOW_SCORE: Record<WindowStatus, number> = {
  prime: 100,
  workable: 60,
  // Deliberately negative: a 6am call is worse than not calling at all,
  // because it burns an attempt and annoys the business.
  early_or_late: -40,
  closed: -200,
  // No time zone known. Neutral, so these get worked but never preferred over
  // a business we know is open right now.
  unknown: 20,
};

export const WINDOW_LABEL: Record<WindowStatus, string> = {
  prime: "good time to call there",
  workable: "callable, not peak",
  early_or_late: "too early or too late there",
  closed: "closed there right now",
  unknown: "time zone unknown",
};

/** Does a free-text best-time note match the hour it is there now? */
export function matchesBestTime(hour: number, note: string | null | undefined): boolean {
  if (!note) return false;
  const t = note.toLowerCase();

  // An explicit hour is checked FIRST. "before 9am" contains "am", and a
  // coarse morning match would otherwise call 10am a hit.
  const m = t.match(/(\d{1,2})\s*(?::(\d{2}))?\s*(am|pm)?/);
  if (m) {
    let target = Number(m[1]);
    if (m[3] === "pm" && target < 12) target += 12;
    if (m[3] === "am" && target === 12) target = 0;
    if (/before/.test(t)) return hour < target;
    if (/after/.test(t)) return hour >= target;
    return Math.abs(hour - target) <= 1;
  }

  if (/morning|before noon|early/.test(t)) return hour >= 7 && hour < 12;
  if (/afternoon|after lunch|late/.test(t)) return hour >= 12 && hour < 17;
  return false;
}

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function matchesBestDay(dayOfWeek: number, note: string | null | undefined): boolean {
  if (!note) return false;
  const t = note.toLowerCase();
  if (/weekday|any day/.test(t)) return dayOfWeek >= 1 && dayOfWeek <= 5;
  return t.includes(DAY_NAMES[dayOfWeek]);
}

export type ScoreOptions = {
  now?: Date;
  /**
   * Hours that have actually worked for an industry, learned from real calls.
   * Only supply once the data supports it — otherwise this is superstition.
   */
  industryBestHours?: Record<string, number[]>;
};

export function scoreCandidate(c: DialCandidate, opts?: ScoreOptions): ScoredCandidate {
  const now = opts?.now ?? new Date();
  const tz = c.timezone || timezoneForState(c.state) || null;
  const parts = tz ? localHourParts(now, tz) : null;
  const localHour = parts?.timezone ? parts.hour : null;
  const localDow = parts?.timezone ? parts.dayOfWeek : null;

  const status = windowFor(localHour, localDow);
  let score = WINDOW_SCORE[status];
  const reasons: string[] = [];

  if (localHour !== null) {
    const shown = `${((localHour + 11) % 12) + 1}${localHour < 12 ? "am" : "pm"}`;
    reasons.push(`${shown} where they are — ${WINDOW_LABEL[status]}`);
  } else {
    reasons.push("No time zone on file for this business");
  }

  // A promised callback outranks everything except a closed business.
  if (c.callbackId) {
    score += 500;
    reasons.unshift("You promised them a callback");
  }

  // The retry schedule from the last outcome.
  if (c.nextAttemptAt) {
    const due = new Date(c.nextAttemptAt).getTime();
    if (Number.isFinite(due)) {
      if (due > now.getTime()) {
        score -= 120;
        reasons.push("Not due for another attempt yet");
      } else {
        score += 25;
        reasons.push("Due for another attempt");
      }
    }
  }

  // What this specific business told us.
  if (localHour !== null && matchesBestTime(localHour, c.bestCallTime)) {
    score += 90;
    reasons.unshift(`They said to call around now (${c.bestCallTime})`);
  }
  if (localDow !== null && c.bestCallDay && !matchesBestDay(localDow, c.bestCallDay)) {
    score -= 30;
    reasons.push(`They asked for ${c.bestCallDay}`);
  }

  // What the team has learned about this trade, if anything.
  const learned = c.industry ? opts?.industryBestHours?.[c.industry] : undefined;
  if (learned && localHour !== null && learned.includes(localHour)) {
    score += 40;
    reasons.push(`${c.industry} answers more around this hour`);
  }

  // Never-tried leads go first among equals; a lead on its sixth attempt waits.
  const attempts = c.attemptCount ?? 0;
  score -= Math.min(attempts, 6) * 6;
  if (attempts === 0) reasons.push("Never tried");

  // A closed business stays at the bottom whatever else is true of it. Without
  // this floor a promised callback could drag someone out of bed at 4am.
  if (status === "closed") score = Math.min(score, -150);

  return {
    candidate: c,
    score,
    localHour,
    localDayOfWeek: localDow,
    timezone: tz,
    windowStatus: status,
    reasons,
  };
}

/**
 * Best first. Ties fall back to the packet's original order, so a run of
 * equally-good leads still feels like a list rather than a shuffle.
 */
export function orderCandidates(
  candidates: DialCandidate[],
  opts?: ScoreOptions
): ScoredCandidate[] {
  return candidates
    .map((c) => scoreCandidate(c, opts))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.candidate.position ?? 0) - (b.candidate.position ?? 0)
    );
}

export type CoverageBucket = {
  status: WindowStatus;
  label: string;
  count: number;
};

/**
 * How much of a packet is worth calling right now. Lets an admin see that a
 * caller starting at 8am has nothing but west-coast leads in front of them.
 */
export function windowCoverage(
  candidates: DialCandidate[],
  opts?: ScoreOptions
): { buckets: CoverageBucket[]; callableNow: number; total: number } {
  const scored = candidates.map((c) => scoreCandidate(c, opts));
  const order: WindowStatus[] = ["prime", "workable", "unknown", "early_or_late", "closed"];
  const buckets = order
    .map((status) => ({
      status,
      label: WINDOW_LABEL[status],
      count: scored.filter((s) => s.windowStatus === status).length,
    }))
    .filter((b) => b.count > 0);

  return {
    buckets,
    callableNow: scored.filter(
      (s) => s.windowStatus === "prime" || s.windowStatus === "workable"
    ).length,
    total: candidates.length,
  };
}
