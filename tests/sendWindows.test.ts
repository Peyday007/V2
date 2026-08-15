// Which sends, over which window, in whose day.
//
// THE PRODUCTION FAILURE: Instantly reported 51 sends on Friday 14 August.
// V2 reported 3 over an overlapping period. Both were computed correctly and
// neither was comparable to the other, which is worse than one simply being
// wrong — it made the send ledger untrustworthy exactly when somebody was
// using it to decide whether the campaign was alive.
//
// Three separate mismatches, none of them announced: rolling-24h compared
// against a calendar day; UTC midnight compared against the campaign's
// midnight; and the per-day breakdown summed away before anything could match
// a date at all.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  localDateKey,
  offsetMinutes,
  calendarDayWindow,
  todayWindow,
  rollingDayWindow,
  sentInWindow,
  reconcile,
  DEFAULT_REPORT_TIMEZONE,
} from "../src/lib/sendWindows";
import { dailyAnalyticsRows, sumDailyAnalytics } from "../src/lib/instantly/mapping";

const TZ = "America/Detroit";

/* -------------------------------------------------------------------------- */

describe("WHOSE MIDNIGHT", () => {
  it("Detroit is four hours behind UTC in August", () => {
    expect(offsetMinutes(new Date("2026-08-14T18:00:00Z"), TZ)).toBe(-240);
  });

  it("and five hours behind in January — DST is not assumed away", () => {
    expect(offsetMinutes(new Date("2026-01-14T18:00:00Z"), TZ)).toBe(-300);
  });

  it("THE OFF-BY-ONE: late UTC evening is still the previous day in Detroit", () => {
    // 01:00 UTC Saturday is 21:00 Friday in Detroit. A UTC-derived date key
    // calls this Saturday and misses Friday's sends entirely.
    const instant = new Date("2026-08-15T01:00:00Z");
    expect(instant.toISOString().slice(0, 10)).toBe("2026-08-15");
    expect(localDateKey(instant, TZ)).toBe("2026-08-14");
  });

  it("Friday in Detroit runs 04:00 Friday to 04:00 Saturday UTC", () => {
    const w = calendarDayWindow("2026-08-14", TZ);
    expect(w.fromIso).toBe("2026-08-14T04:00:00.000Z");
    expect(w.toIso).toBe("2026-08-15T04:00:00.000Z");
  });
});

describe("EVERY WINDOW IS LABELLED", () => {
  it("a calendar day names the day and the zone", () => {
    const w = calendarDayWindow("2026-08-14", TZ);
    expect(w.kind).toBe("calendar_day");
    expect(w.label).toMatch(/Friday/);
    expect(w.label).toMatch(/14 August/);
    expect(w.label).toContain(TZ);
    expect(w.timezone).toBe(TZ);
  });

  it("a rolling window says so, and says UTC", () => {
    const w = rollingDayWindow(new Date("2026-08-15T12:00:00Z"));
    expect(w.kind).toBe("rolling_24h");
    expect(w.label).toMatch(/rolling 24 hours/i);
    expect(w.timezone).toBe("UTC");
    expect(w.matchDate).toBeNull();
  });

  it("today is a calendar day that stops at now, not at midnight", () => {
    const now = new Date("2026-08-15T18:30:00Z");
    const w = todayWindow(now, TZ);
    expect(w.label).toMatch(/Today so far/);
    expect(w.toIso).toBe(now.toISOString());
  });

  it("THE REQUEST RANGE IS WIDENED, or the day can be missed", () => {
    // Their rows are keyed in the campaign's zone; a UTC-bounded request can
    // land either side of the day being asked about.
    const w = calendarDayWindow("2026-08-14", TZ);
    expect(w.requestFrom).toBe("2026-08-13");
    expect(w.requestTo).toBe("2026-08-15");
    expect(w.matchDate).toBe("2026-08-14");
  });

  it("the default zone is stated rather than assumed silently", () => {
    expect(DEFAULT_REPORT_TIMEZONE).toBe("America/Detroit");
    expect(calendarDayWindow("2026-08-14").timezone).toBe(DEFAULT_REPORT_TIMEZONE);
  });
});

/* -------------------------------------------------------------------------- */

describe("THE PER-DAY BREAKDOWN SURVIVES PARSING", () => {
  const body = {
    items: [
      { date: "2026-08-13", sent: 12, replies: 1 },
      { date: "2026-08-14", sent: 51, replies: 3 },
      { date: "2026-08-15", sent: 4, replies: 0 },
    ],
  };

  it("rows come back keyed by date", () => {
    const rows = dailyAnalyticsRows(body)!;
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.date === "2026-08-14")!.sent).toBe(51);
  });

  it("a full timestamp is reduced to its date", () => {
    const rows = dailyAnalyticsRows([
      { date: "2026-08-14T00:00:00Z", sent: 51, replies: 3 },
    ])!;
    expect(rows[0].date).toBe("2026-08-14");
  });

  it("the three container shapes all parse", () => {
    const r = [{ date: "2026-08-14", sent: 51, replies: 3 }];
    for (const b of [r, { items: r }, { data: r }]) {
      expect(dailyAnalyticsRows(b)![0].sent).toBe(51);
    }
  });

  it("a row with no date is skipped rather than mis-attributed", () => {
    expect(dailyAnalyticsRows([{ sent: 9, replies: 0 }])).toEqual([]);
  });

  it("null when unreadable, never an empty day", () => {
    expect(dailyAnalyticsRows(null)).toBeNull();
    expect(dailyAnalyticsRows({ error: "unauthorised" })).toBeNull();
  });

  it("summing still works for callers that want a total", () => {
    expect(sumDailyAnalytics(body)).toEqual({ sent: 67, replies: 4 });
  });

  /* THE HEADLINE CASE. */
  it("FRIDAY RETURNS 51, MATCHING THE INSTANTLY DASHBOARD", () => {
    const w = calendarDayWindow("2026-08-14", TZ);
    const got = sentInWindow(dailyAnalyticsRows(body), w)!;
    expect(got.sent).toBe(51);
    expect(got.approximate).toBe(false);
    // Not the 67 that summing the whole requested range would have given.
    expect(got.sent).not.toBe(67);
  });

  it("a day Instantly has no row for really did send nothing", () => {
    const got = sentInWindow(dailyAnalyticsRows(body), calendarDayWindow("2026-08-01", TZ))!;
    expect(got.sent).toBe(0);
    expect(got.approximate).toBe(false);
  });

  it("a rolling window sums and ADMITS it is approximate", () => {
    const got = sentInWindow(
      dailyAnalyticsRows(body),
      rollingDayWindow(new Date("2026-08-15T12:00:00Z"))
    )!;
    expect(got.sent).toBe(67);
    expect(got.approximate).toBe(true);
  });

  it("unreadable rows give null, which is not zero", () => {
    expect(sentInWindow(null, calendarDayWindow("2026-08-14", TZ))).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe("RECONCILING THE TWO SOURCES OVER ONE NAMED WINDOW", () => {
  const w = calendarDayWindow("2026-08-14", TZ);

  it("THE PRODUCTION DISCREPANCY IS NAMED, not silently resolved", () => {
    // Instantly 51, our webhooks 3 — the exact numbers from 14 August.
    const r = reconcile({
      window: w,
      webhookSent: 3,
      ledger: { sent: 51, replies: 3, approximate: false },
    });
    expect(r.reported).toBe(51);
    expect(r.source).toBe("instantly_analytics");
    expect(r.discrepancy).toMatch(/51/);
    expect(r.discrepancy).toMatch(/3/);
    expect(r.discrepancy).toMatch(/48 missing/);
    expect(r.discrepancy).toMatch(/INSTANTLY_WEBHOOK_SECRET/);
  });

  it("the larger wins, because neither can be subtracted from the other", () => {
    expect(
      reconcile({ window: w, webhookSent: 60, ledger: { sent: 51, replies: 0, approximate: false } })
        .reported
    ).toBe(60);
  });

  it("a failed read leaves our figure alone and says which source it used", () => {
    const r = reconcile({ window: w, webhookSent: 3, ledger: null });
    expect(r.reported).toBe(3);
    expect(r.ledgerSent).toBeNull();
    expect(r.source).toBe("webhooks_only");
  });

  it("a couple of events in flight is not an alarm", () => {
    const r = reconcile({
      window: w,
      webhookSent: 49,
      ledger: { sent: 51, replies: 0, approximate: false },
    });
    expect(r.discrepancy).toBeNull();
  });

  it("but zero against anything is, however small", () => {
    const r = reconcile({
      window: w,
      webhookSent: 0,
      ledger: { sent: 2, replies: 0, approximate: false },
    });
    expect(r.discrepancy).not.toBeNull();
  });

  it("agreement produces no noise", () => {
    expect(
      reconcile({ window: w, webhookSent: 51, ledger: { sent: 51, replies: 3, approximate: false } })
        .discrepancy
    ).toBeNull();
  });

  it("the reconciliation carries its window everywhere", () => {
    const r = reconcile({ window: w, webhookSent: 3, ledger: null });
    expect(r.window.label).toMatch(/Friday/);
    expect(r.window.timezone).toBe(TZ);
  });
});

/* -------------------------------------------------------------------------- */

describe("THE ROUTE USES THE WINDOWED LEDGER, NOT THE UTC-DAY ONE", () => {
  const route = readFileSync(
    new URL("../src/app/api/funnel/route.ts", import.meta.url),
    "utf8"
  );

  it("it asks for rows and matches a date, rather than summing a range", () => {
    expect(route).toMatch(/campaignDailyRows\(/);
    expect(route).toMatch(/sentInWindow\(/);
    expect(route).toMatch(/reconcile\(/);
  });

  it("three named windows are reported, not one bare number", () => {
    expect(route).toMatch(/rollingDayWindow\(/);
    expect(route).toMatch(/todayWindow\(/);
    expect(route).toMatch(/calendarDayWindow\(/);
    expect(route).toMatch(/sendWindows:/);
  });

  it("each window ships its label, kind, zone and endpoints", () => {
    for (const field of ["label", "kind", "timezone", "from", "to", "discrepancy"]) {
      expect(route, field).toMatch(new RegExp(`${field}:`));
    }
  });

  it("and the page shows them with their labels", () => {
    const page = readFileSync(
      new URL("../src/app/(admin)/admin/email/page.tsx", import.meta.url),
      "utf8"
    );
    expect(page).toMatch(/Sends by window/);
    expect(page).toMatch(/w\.discrepancy/);
  });
});
