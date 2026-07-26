// Retry scheduling. Never call the same business at the same time twice in a
// row — rotate through the day so a business that never answers at 9am gets
// tried at 2pm and 4pm before we give up on it.

export type CallWindow = {
  key: string;
  label: string;
  /** Local hour the window opens (24h). */
  startHour: number;
  endHour: number;
};

export const CALL_WINDOWS: CallWindow[] = [
  { key: "early_morning", label: "Early morning", startHour: 8, endHour: 10 },
  { key: "late_morning", label: "Late morning", startHour: 10, endHour: 12 },
  { key: "early_afternoon", label: "Early afternoon", startHour: 13, endHour: 15 },
  { key: "late_afternoon", label: "Late afternoon", startHour: 15, endHour: 17 },
];

/** Which window to use for the next attempt, rotating by attempt number. */
export function windowForAttempt(attemptCount: number): CallWindow {
  return CALL_WINDOWS[attemptCount % CALL_WINDOWS.length];
}

/** Hours to wait before trying again, based on what happened last time. */
const DELAY_HOURS: Record<string, number> = {
  no_answer: 20,
  voicemail: 26,
  gatekeeper: 18,
  callback: 0, // an explicit time always wins
  transferred: 20,
};

export function shouldScheduleRetry(outcome: string): boolean {
  return outcome in DELAY_HOURS;
}

/**
 * Next attempt time. Rotates the calling window, respects business hours
 * Mon-Fri, and never lands on a weekend.
 *
 * `explicitTime` (a caller-agreed callback) always overrides the schedule.
 */
export function nextAttemptAt(opts: {
  outcome: string;
  attemptCount: number;
  now?: Date;
  explicitTime?: Date | null;
}): { at: Date; window: string } | null {
  if (opts.explicitTime) {
    return { at: opts.explicitTime, window: "requested callback" };
  }
  if (!shouldScheduleRetry(opts.outcome)) return null;

  const now = opts.now ? new Date(opts.now) : new Date();
  const win = windowForAttempt(opts.attemptCount);
  const minDelay = DELAY_HOURS[opts.outcome] ?? 20;

  const at = new Date(now.getTime() + minDelay * 3600 * 1000);
  // Land inside the chosen window.
  at.setHours(win.startHour, 0, 0, 0);
  if (at.getTime() <= now.getTime()) {
    at.setDate(at.getDate() + 1);
    at.setHours(win.startHour, 0, 0, 0);
  }
  // Skip weekends — these are weekday businesses.
  while (at.getDay() === 0 || at.getDay() === 6) {
    at.setDate(at.getDate() + 1);
  }
  return { at, window: win.label };
}

/** Is the business likely open right now, given its local hour? */
export function looksOpen(localHour: number, dayOfWeek: number): boolean {
  if (dayOfWeek === 0) return false;
  if (dayOfWeek === 6) return localHour >= 9 && localHour < 14;
  return localHour >= 8 && localHour < 17;
}

/** Rough timezone from a US state, used only to show local time. */
const STATE_TZ: Record<string, string> = {
  ME: "America/New_York", NH: "America/New_York", VT: "America/New_York",
  MA: "America/New_York", RI: "America/New_York", CT: "America/New_York",
  NY: "America/New_York", NJ: "America/New_York", PA: "America/New_York",
  DE: "America/New_York", MD: "America/New_York", DC: "America/New_York",
  VA: "America/New_York", WV: "America/New_York", NC: "America/New_York",
  SC: "America/New_York", GA: "America/New_York", FL: "America/New_York",
  OH: "America/New_York", MI: "America/New_York", IN: "America/New_York",
  KY: "America/New_York",
  IL: "America/Chicago", WI: "America/Chicago", MN: "America/Chicago",
  IA: "America/Chicago", MO: "America/Chicago", AR: "America/Chicago",
  LA: "America/Chicago", MS: "America/Chicago", AL: "America/Chicago",
  TN: "America/Chicago", OK: "America/Chicago", KS: "America/Chicago",
  NE: "America/Chicago", SD: "America/Chicago", ND: "America/Chicago",
  TX: "America/Chicago",
  MT: "America/Denver", WY: "America/Denver", CO: "America/Denver",
  NM: "America/Denver", UT: "America/Denver", ID: "America/Denver",
  AZ: "America/Phoenix",
  NV: "America/Los_Angeles", CA: "America/Los_Angeles",
  OR: "America/Los_Angeles", WA: "America/Los_Angeles",
  AK: "America/Anchorage", HI: "Pacific/Honolulu",
};

export function timezoneForState(state: string | null | undefined): string | null {
  if (!state) return null;
  return STATE_TZ[state.toUpperCase()] || null;
}

/**
 * Hour and day of week AT THE BUSINESS, not at the caller.
 *
 * "Call roofers before 9am" is only a usable finding in the roofer's time
 * zone; a Michigan caller dialing California at 8am local is really calling
 * at 5am. Falls back to the server's own clock when no zone is known, and
 * says which it used so the analytics page does not overclaim.
 */
export function localHourParts(
  when: Date,
  timezone: string | null | undefined
): { hour: number; dayOfWeek: number; timezone: string | null } {
  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "numeric",
        hour12: false,
        weekday: "short",
      }).formatToParts(when);
      const hourPart = parts.find((p) => p.type === "hour")?.value;
      const dayPart = parts.find((p) => p.type === "weekday")?.value;
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const hour = Number(hourPart);
      const dayOfWeek = days.indexOf(dayPart || "");
      if (Number.isFinite(hour) && dayOfWeek >= 0) {
        // Intl renders midnight as 24 in some runtimes.
        return { hour: hour % 24, dayOfWeek, timezone };
      }
    } catch {
      // fall through to the server clock
    }
  }
  return { hour: when.getUTCHours(), dayOfWeek: when.getUTCDay(), timezone: null };
}
