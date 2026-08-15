// Which sends, over which window, in whose day.
//
// WHY THIS EXISTS.
//
// Instantly reported 51 sends on Friday 14 August. V2 reported 3 over an
// overlapping period. Both numbers were computed correctly and neither was
// comparable to the other, which is worse than one of them simply being wrong:
// it made the whole send ledger untrustworthy at exactly the moment somebody
// was using it to decide whether the campaign was working.
//
// THREE SEPARATE MISMATCHES, all of them silent:
//
//   1. ROLLING VERSUS CALENDAR. V2 asked "how many in the last 24 hours" and
//      compared it to Instantly's "how many on Friday". At 9am on Saturday
//      those windows barely overlap.
//
//   2. WHOSE MIDNIGHT. campaignSendLedger derived its day from
//      `toISOString().slice(0, 10)`, which is the UTC date. Instantly's
//      dashboard reports in the campaign's own timezone. In August, Detroit is
//      UTC-4, so their Friday runs from 04:00 Friday to 04:00 Saturday UTC —
//      a UTC-day query straddles two of their days and matches neither.
//
//   3. SUMMED AWAY. The daily analytics response was collapsed to one total
//      before anything could look at which day was which, so the per-day
//      figure a person actually compares against did not survive parsing.
//
// The fix is not a better guess. It is to name every window — kind, timezone
// and both endpoints — and carry that label everywhere the number is shown, so
// two figures can never be compared without their definitions attached.

import type { DailyAnalyticsRow } from "./instantly/mapping";

/** The default when nobody has said otherwise. Stated, never assumed silently. */
export const DEFAULT_REPORT_TIMEZONE = "America/Detroit";

export type WindowKind = "calendar_day" | "rolling_24h";

export type SendWindow = {
  kind: WindowKind;
  /** Human label, always shown with the number. */
  label: string;
  /** IANA zone the day boundaries are drawn in. UTC for rolling windows. */
  timezone: string;
  /** Instant boundaries, for anything querying our own tables. */
  fromIso: string;
  toIso: string;
  /**
   * The date range to ask Instantly for, widened by a day either side.
   *
   * Their rows are keyed by date in the campaign's timezone, so a request
   * bounded by UTC instants can miss the very day being asked about. Asking
   * wide and matching the exact key is the only way to land on their Friday.
   */
  requestFrom: string;
  requestTo: string;
  /** The row key to match, for a calendar day. Null for rolling windows. */
  matchDate: string | null;
};

/** The calendar date at an instant, in a given zone. "2026-08-14". */
export function localDateKey(at: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, which is the shape the API returns.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** How far the zone is from UTC at that instant, in minutes. Handles DST. */
export function offsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second")
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

function shiftDateKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function prettyDay(key: string, timeZone: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(Date.UTC(y, m - 1, d, 12))) + ` (${timeZone})`;
}

/**
 * One named calendar day, in the campaign's own timezone.
 *
 * THE WINDOW THAT MATCHES THE INSTANTLY DASHBOARD. When somebody says
 * "Instantly shows 51 on Friday", this is the window that produces a number
 * comparable to theirs.
 */
export function calendarDayWindow(
  dayKey: string,
  timeZone: string = DEFAULT_REPORT_TIMEZONE
): SendWindow {
  const [y, m, d] = dayKey.split("-").map(Number);
  // Midnight local, resolved through the zone's offset on that date.
  const naive = Date.UTC(y, m - 1, d);
  const off = offsetMinutes(new Date(naive), timeZone);
  const from = new Date(naive - off * 60_000);
  const to = new Date(from.getTime() + 86_400_000);

  return {
    kind: "calendar_day",
    label: `${prettyDay(dayKey, timeZone)}, midnight to midnight`,
    timezone: timeZone,
    fromIso: from.toISOString(),
    toIso: to.toISOString(),
    requestFrom: shiftDateKey(dayKey, -1),
    requestTo: shiftDateKey(dayKey, 1),
    matchDate: dayKey,
  };
}

/** Today so far, in the campaign's timezone — the window the push cap uses. */
export function todayWindow(
  now: Date = new Date(),
  timeZone: string = DEFAULT_REPORT_TIMEZONE
): SendWindow {
  const key = localDateKey(now, timeZone);
  const w = calendarDayWindow(key, timeZone);
  return { ...w, label: `Today so far — ${prettyDay(key, timeZone)}`, toIso: now.toISOString() };
}

/** The last 24 hours from this instant. Deliberately NOT a day. */
export function rollingDayWindow(now: Date = new Date()): SendWindow {
  const from = new Date(now.getTime() - 86_400_000);
  return {
    kind: "rolling_24h",
    label: "Rolling 24 hours to now (UTC)",
    timezone: "UTC",
    fromIso: from.toISOString(),
    toIso: now.toISOString(),
    requestFrom: from.toISOString().slice(0, 10),
    requestTo: new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10),
    matchDate: null,
  };
}

/**
 * What Instantly's rows say for this window.
 *
 * A calendar window takes the single matching row — their number for that day,
 * exactly as their dashboard shows it. A rolling window has no single row to
 * match, so it sums every day the request touched, which OVERSTATES a 24-hour
 * period by including parts of days outside it. That overstatement is stated
 * rather than hidden: `approximate` says so, and callers label it.
 *
 * Null means the rows could not be read at all, which is not zero.
 */
export function sentInWindow(
  rows: DailyAnalyticsRow[] | null,
  window: SendWindow
): { sent: number; replies: number; approximate: boolean } | null {
  if (rows === null) return null;

  if (window.matchDate) {
    const row = rows.find((r) => r.date === window.matchDate);
    // A day Instantly has no row for genuinely sent nothing.
    if (!row) return { sent: 0, replies: 0, approximate: false };
    return { sent: row.sent, replies: row.replies, approximate: false };
  }

  let sent = 0;
  let replies = 0;
  for (const r of rows) {
    sent += r.sent;
    replies += r.replies;
  }
  return { sent, replies, approximate: true };
}

/* -------------------------------------------------------------------------- */
/* reconciling the two sources                                                */
/* -------------------------------------------------------------------------- */

export type Reconciliation = {
  window: SendWindow;
  /** Our own email_events count over the same instants. */
  webhookSent: number;
  /** Instantly's own figure, or null when it could not be asked. */
  ledgerSent: number | null;
  /** What to report: the larger, because neither can be subtracted. */
  reported: number;
  source: "instantly_analytics" | "webhooks_only";
  /** Set when the two disagree enough to matter. */
  discrepancy: string | null;
};

/**
 * Put both numbers side by side over ONE named window.
 *
 * The larger wins, for the reason it always has: a missed webhook reads as
 * zero and neither source can be subtracted from the other. What is new is
 * that the disagreement is reported rather than silently resolved — "Instantly
 * says 51, we recorded 3" is the sentence that would have exposed the broken
 * webhook months earlier.
 */
export function reconcile(input: {
  window: SendWindow;
  webhookSent: number;
  ledger: { sent: number; replies: number; approximate: boolean } | null;
}): Reconciliation {
  const { window, webhookSent, ledger } = input;
  const ledgerSent = ledger ? ledger.sent : null;
  const reported = ledgerSent === null ? webhookSent : Math.max(webhookSent, ledgerSent);

  let discrepancy: string | null = null;
  if (ledgerSent !== null && ledgerSent > webhookSent) {
    const missed = ledgerSent - webhookSent;
    // A couple of events in flight is normal; a large gap is a broken webhook.
    if (missed >= 5 || (webhookSent === 0 && ledgerSent > 0)) {
      discrepancy =
        `Instantly reports ${ledgerSent} sends for ${window.label} but only ${webhookSent} ` +
        `reached our webhook — ${missed} missing. The sends are real; our event log is not ` +
        `receiving them. Check INSTANTLY_WEBHOOK_SECRET and the webhook URL in Instantly.`;
    }
  }

  return {
    window,
    webhookSent,
    ledgerSent,
    reported,
    source: ledgerSent === null ? "webhooks_only" : "instantly_analytics",
    discrepancy,
  };
}
