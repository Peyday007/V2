import { describe, it, expect } from "vitest";
import {
  buildSessions,
  dayActivity,
  integrityFlags,
  buildTimesheet,
  IDLE_BREAK_MINUTES,
  IMPLAUSIBLY_FAST_SECONDS,
  type ActivityEvent,
} from "../src/lib/timeTracking";

const DAY = "2026-07-20";
/** An outcome saved at HH:MM on the test day. */
function at(hh: number, mm: number, over: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    callerName: "Jack",
    at: `${DAY}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.000Z`,
    durationSeconds: 120,
    outcome: "no_answer",
    ...over,
  };
}

describe("sessions are built from work that actually happened", () => {
  it("groups calls with small gaps into one stretch", () => {
    const s = buildSessions([at(9, 0), at(9, 10), at(9, 25), at(9, 40)]);
    expect(s).toHaveLength(1);
    expect(s[0].calls).toBe(4);
  });

  it("a long gap starts a new stretch, so breaks are not billed as work", () => {
    const s = buildSessions([at(9, 0), at(9, 10), at(12, 0), at(12, 10)]);
    expect(s).toHaveLength(2);
    expect(s[0].calls).toBe(2);
    expect(s[1].calls).toBe(2);
  });

  it("splits exactly at the idle threshold", () => {
    const under = buildSessions([at(9, 0), at(9, IDLE_BREAK_MINUTES - 1)]);
    const over = buildSessions([at(9, 0), at(9, 0), at(10, 0)]);
    expect(under).toHaveLength(1);
    expect(over).toHaveLength(2);
  });

  it("uses the dialer's own start time when the timer recorded it", () => {
    const s = buildSessions([
      at(9, 30, { startedAt: `${DAY}T09:00:00.000Z` }),
    ]);
    expect(s[0].minutes).toBe(30);
  });

  it("falls back to the recorded duration when there is no start time", () => {
    const s = buildSessions([at(9, 30, { durationSeconds: 600, startedAt: null })]);
    expect(s[0].minutes).toBe(10);
  });

  it("handles a single call and an empty day", () => {
    expect(buildSessions([at(9, 0)])).toHaveLength(1);
    expect(buildSessions([])).toEqual([]);
  });

  it("ignores unparseable timestamps rather than producing nonsense", () => {
    const s = buildSessions([at(9, 0), { ...at(9, 5), at: "not a date" }]);
    expect(s).toHaveLength(1);
    expect(s[0].calls).toBe(1);
  });

  it("is not fooled by events arriving out of order", () => {
    const s = buildSessions([at(9, 40), at(9, 0), at(9, 20)]);
    expect(s).toHaveLength(1);
    expect(s[0].calls).toBe(3);
  });
});

describe("a day separates active time from the span", () => {
  it("excludes the lunch break from active time", () => {
    // Two stints of steady dialing with three hours of nothing between them.
    const d = dayActivity("Jack", DAY, [
      at(9, 0),
      at(9, 10),
      at(9, 20),
      at(13, 0),
      at(13, 10),
      at(13, 20),
    ]);
    expect(d.spanMinutes).toBe(260); // 9:00 to 13:20
    expect(d.sessions).toHaveLength(2);
    expect(d.activeMinutes).toBeLessThan(60);
    expect(d.idleMinutes).toBeGreaterThan(180);
  });

  it("a gap between two calls longer than the break IS a separate stint", () => {
    // Deliberate: two short calls half an hour apart are not continuous work,
    // and counting the gap as active time is how a timesheet inflates.
    const d = dayActivity("Jack", DAY, [at(9, 0), at(9, 30)]);
    expect(d.sessions).toHaveLength(2);
    expect(d.activeMinutes).toBeLessThan(10);
  });

  it("reports calls per active hour, not per hour on the clock", () => {
    // 10 calls inside one hour of real activity, spread across a long day.
    const events = Array.from({ length: 10 }, (_, i) => at(9, i * 6));
    const d = dayActivity("Jack", DAY, events);
    expect(d.callsPerActiveHour).toBeGreaterThan(9);
  });

  it("shows measured phone time separately from active time", () => {
    const d = dayActivity("Jack", DAY, [at(9, 0, { durationSeconds: 300 })]);
    expect(d.measuredCallMinutes).toBe(5);
  });

  it("a day with no calls is all zeros, not NaN", () => {
    const d = dayActivity("Jack", DAY, []);
    expect(d.activeMinutes).toBe(0);
    expect(d.callsPerActiveHour).toBe(0);
    expect(d.firstAt).toBeNull();
  });
});

describe("flags are questions, never accusations", () => {
  it("every flag carries evidence and an innocent explanation", () => {
    const events = Array.from({ length: 30 }, (_, i) => at(9, 0, { durationSeconds: null }));
    const days = [dayActivity("Jack", DAY, events)];
    const flags = integrityFlags({ callerName: "Jack", events, days });
    expect(flags.length).toBeGreaterThan(0);
    for (const f of flags) {
      expect(f.question.length, f.key).toBeGreaterThan(10);
      expect(f.evidence, f.key).toMatch(/\d/);
      expect(f.innocentExplanation.length, f.key).toBeGreaterThan(20);
    }
  });

  it("spots outcomes saved too fast to be real calls", () => {
    const events = [at(9, 0), at(9, 0), at(9, 0), at(9, 0), at(9, 0)];
    const flags = integrityFlags({ callerName: "Jack", events, days: [] });
    const rapid = flags.find((f) => f.key === "rapid_fire");
    expect(rapid).toBeTruthy();
    expect(rapid?.evidence).toContain(String(IMPLAUSIBLY_FAST_SECONDS));
  });

  it("does not flag a normal working rhythm", () => {
    const events = Array.from({ length: 12 }, (_, i) => at(9, i * 5));
    const days = [dayActivity("Jack", DAY, events)];
    const flags = integrityFlags({ callerName: "Jack", events, days });
    expect(flags.some((f) => f.key === "rapid_fire")).toBe(false);
  });

  it("needs at least three fast pairs before saying anything", () => {
    const events = [at(9, 0), at(9, 0), at(9, 30), at(10, 0)];
    expect(
      integrityFlags({ callerName: "Jack", events, days: [] }).some((f) => f.key === "rapid_fire")
    ).toBe(false);
  });

  it("notices a long span with little activity in it", () => {
    const events = [at(8, 0), at(8, 10), at(17, 0), at(17, 10)];
    const days = [dayActivity("Jack", DAY, events)];
    const flags = integrityFlags({ callerName: "Jack", events, days });
    const idle = flags.find((f) => f.key === "idle_heavy");
    expect(idle).toBeTruthy();
    expect(idle?.innocentExplanation).toContain("Meetings");
  });

  it("compares a lopsided outcome mix against the team, not an absolute", () => {
    const events = Array.from({ length: 30 }, (_, i) => at(9, i * 3));
    // When the whole team is at 90% no-answer, one person at 100% is not news.
    const withTeam = integrityFlags({
      callerName: "Jack",
      events,
      days: [],
      teamNoAnswerRate: 0.9,
    });
    expect(withTeam.some((f) => f.key === "one_outcome_only")).toBe(false);

    const aloneInIt = integrityFlags({
      callerName: "Jack",
      events,
      days: [],
      teamNoAnswerRate: 0.4,
    });
    expect(aloneInIt.some((f) => f.key === "one_outcome_only")).toBe(true);
  });

  it("blames the lead source before the person", () => {
    const events = Array.from({ length: 30 }, (_, i) => at(9, i * 3));
    const flag = integrityFlags({
      callerName: "Jack",
      events,
      days: [],
      teamNoAnswerRate: 0.3,
    }).find((f) => f.key === "one_outcome_only");
    expect(flag?.innocentExplanation).toContain("Check the lead source before the person");
  });

  it("says nothing at all when there is no activity", () => {
    expect(integrityFlags({ callerName: "Jack", events: [], days: [] })).toEqual([]);
  });
});

describe("buildTimesheet", () => {
  it("splits by caller and by day", () => {
    const events = [
      at(9, 0, { callerName: "Jack" }),
      at(9, 10, { callerName: "Jack" }),
      { ...at(9, 0, { callerName: "Sam" }), at: "2026-07-21T09:00:00.000Z" },
    ];
    const sheets = buildTimesheet(events);
    expect(sheets.map((s) => s.callerName).sort()).toEqual(["Jack", "Sam"]);
    expect(sheets.find((s) => s.callerName === "Jack")!.days).toHaveLength(1);
  });

  it("totals active hours rather than time between first and last call", () => {
    const events = [at(9, 0), at(9, 30), at(15, 0), at(15, 30)];
    const [sheet] = buildTimesheet(events);
    expect(sheet.totalActiveHours).toBeLessThan(2);
    expect(sheet.daysWorked).toBe(1);
  });

  it("orders by who logged the most active time", () => {
    const events = [
      at(9, 0, { callerName: "Busy" }),
      at(9, 30, { callerName: "Busy" }),
      at(11, 0, { callerName: "Quiet" }),
    ];
    expect(buildTimesheet(events)[0].callerName).toBe("Busy");
  });

  it("skips events with no caller attached", () => {
    expect(buildTimesheet([at(9, 0, { callerName: "" })])).toEqual([]);
  });

  it("returns nothing for an empty window", () => {
    expect(buildTimesheet([])).toEqual([]);
  });
});
