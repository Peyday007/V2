import { describe, it, expect } from "vitest";
import {
  scoreCandidate,
  orderCandidates,
  windowFor,
  windowCoverage,
  matchesBestTime,
  matchesBestDay,
  type DialCandidate,
} from "../src/lib/dialOrder";

/**
 * The complaint this exists for: a caller starting at 9am in Michigan was
 * handed California businesses, ringing them at 6am. Nobody answers, every one
 * burns an attempt, and the data then blames the leads.
 */

// 14:00 UTC on Wednesday 22 July 2026.
//   New York 10am (prime)   Chicago 9am (prime)
//   Denver   8am (prime)    Los Angeles 7am (too early)
const NOW = new Date("2026-07-22T14:00:00Z");

function lead(over: Partial<DialCandidate> = {}): DialCandidate {
  return { leadId: Math.random().toString(36).slice(2), packetId: "p1", ...over };
}

describe("windowFor reads the business's own clock", () => {
  it("mid-morning on a weekday is prime", () => {
    expect(windowFor(9, 3)).toBe("prime");
    expect(windowFor(14, 3)).toBe("prime");
  });
  it("lunch and late afternoon are workable", () => {
    expect(windowFor(12, 3)).toBe("workable");
    expect(windowFor(16, 3)).toBe("workable");
  });
  it("very early and evening are fringe", () => {
    expect(windowFor(7, 3)).toBe("early_or_late");
  });
  it("before opening, after hours and Sunday are closed", () => {
    expect(windowFor(6, 3)).toBe("closed");
    expect(windowFor(21, 3)).toBe("closed");
    expect(windowFor(10, 0)).toBe("closed");
  });
  it("says unknown rather than guessing when there is no time zone", () => {
    expect(windowFor(null, null)).toBe("unknown");
  });
});

describe("THE BUG: a 6am call must not be served ahead of a 9am one", () => {
  it("puts the eastern business ahead of the californian one", () => {
    const ordered = orderCandidates(
      [
        lead({ leadId: "california", state: "CA", position: 0 }),
        lead({ leadId: "michigan", state: "MI", position: 1 }),
      ],
      { now: NOW }
    );
    expect(ordered[0].candidate.leadId).toBe("michigan");
    expect(ordered[0].windowStatus).toBe("prime");
  });

  it("scores an out-of-hours business negatively, not merely lower", () => {
    // Calling at 6am burns an attempt and annoys them — worse than not calling.
    const early = scoreCandidate(lead({ state: "CA" }), { now: NOW });
    expect(early.windowStatus).toBe("early_or_late");
    expect(early.score).toBeLessThan(0);
  });

  it("beats the packet's original order rather than obeying it", () => {
    const ordered = orderCandidates(
      [
        lead({ leadId: "first-in-list", state: "CA", position: 0 }),
        lead({ leadId: "tenth-in-list", state: "NY", position: 9 }),
      ],
      { now: NOW }
    );
    expect(ordered[0].candidate.leadId).toBe("tenth-in-list");
  });

  it("explains itself so the caller can see why the order changed", () => {
    const s = scoreCandidate(lead({ state: "MI" }), { now: NOW });
    expect(s.reasons.join(" ")).toContain("where they are");
    expect(s.reasons.join(" ")).toContain("good time to call there");
  });

  it("still orders sensibly when nobody has a time zone", () => {
    const ordered = orderCandidates(
      [lead({ leadId: "b", position: 1 }), lead({ leadId: "a", position: 0 })],
      { now: NOW }
    );
    expect(ordered.map((o) => o.candidate.leadId)).toEqual(["a", "b"]);
    expect(ordered[0].windowStatus).toBe("unknown");
  });

  it("prefers a known-open business over one with no time zone", () => {
    const ordered = orderCandidates(
      [lead({ leadId: "unknown-tz", position: 0 }), lead({ leadId: "open-now", state: "NY", position: 1 })],
      { now: NOW }
    );
    expect(ordered[0].candidate.leadId).toBe("open-now");
  });
});

describe("promises and schedules outrank the clock", () => {
  it("a due callback comes first even against a prime-time lead", () => {
    const ordered = orderCandidates(
      [
        lead({ leadId: "prime", state: "NY", position: 0 }),
        lead({ leadId: "promised", state: "NY", callbackId: "cb1", position: 1 }),
      ],
      { now: NOW }
    );
    expect(ordered[0].candidate.leadId).toBe("promised");
    expect(ordered[0].reasons[0]).toContain("promised them a callback");
  });

  it("a lead not yet due for a retry drops down the list", () => {
    const notYet = scoreCandidate(
      lead({ state: "NY", nextAttemptAt: "2026-07-30T14:00:00Z" }),
      { now: NOW }
    );
    const due = scoreCandidate(
      lead({ state: "NY", nextAttemptAt: "2026-07-21T14:00:00Z" }),
      { now: NOW }
    );
    expect(due.score).toBeGreaterThan(notYet.score);
    expect(notYet.reasons.join(" ")).toContain("Not due");
  });

  it("even a promised callback does not resurrect a closed business ahead of an open one", () => {
    // 4am in California with a callback, against 10am in New York.
    const dawn = new Date("2026-07-22T11:00:00Z");
    const ordered = orderCandidates(
      [
        lead({ leadId: "asleep", state: "CA", callbackId: "cb1", position: 0 }),
        lead({ leadId: "awake", state: "NY", position: 1 }),
      ],
      { now: dawn }
    );
    expect(ordered[0].candidate.leadId).toBe("awake");
  });
});

describe("what the business itself told us wins", () => {
  it("promotes a lead whose stated best time is now", () => {
    const s = scoreCandidate(lead({ state: "MI", bestCallTime: "mornings" }), { now: NOW });
    expect(s.reasons[0]).toContain("They said to call around now");
  });

  it("penalises calling on a day they did not ask for", () => {
    const wrongDay = scoreCandidate(lead({ state: "MI", bestCallDay: "Monday" }), { now: NOW });
    const noPreference = scoreCandidate(lead({ state: "MI" }), { now: NOW });
    expect(wrongDay.score).toBeLessThan(noPreference.score);
  });

  it("reads common ways of writing a time", () => {
    expect(matchesBestTime(8, "mornings")).toBe(true);
    expect(matchesBestTime(15, "afternoon")).toBe(true);
    expect(matchesBestTime(8, "before 9am")).toBe(true);
    expect(matchesBestTime(10, "before 9am")).toBe(false);
    expect(matchesBestTime(17, "after 4pm")).toBe(true);
    expect(matchesBestTime(10, "around 10")).toBe(true);
    expect(matchesBestTime(9, null)).toBe(false);
    expect(matchesBestTime(9, "whenever")).toBe(false);
  });

  it("reads days, including 'weekdays'", () => {
    expect(matchesBestDay(3, "Wednesday")).toBe(true);
    expect(matchesBestDay(3, "weekdays")).toBe(true);
    expect(matchesBestDay(0, "weekdays")).toBe(false);
    expect(matchesBestDay(3, null)).toBe(false);
  });
});

describe("learned industry hours only apply when supplied", () => {
  it("boosts a trade that answers at this hour", () => {
    const withData = scoreCandidate(lead({ state: "MI", industry: "plumbing" }), {
      now: NOW,
      industryBestHours: { plumbing: [10] }, // Michigan is 10am at NOW
    });
    const without = scoreCandidate(lead({ state: "MI", industry: "plumbing" }), { now: NOW });
    expect(withData.score).toBeGreaterThan(without.score);
    expect(withData.reasons.join(" ")).toContain("answers more around this hour");
  });

  it("adds nothing when there is no learned data — no superstition", () => {
    const s = scoreCandidate(lead({ state: "MI", industry: "plumbing" }), { now: NOW });
    expect(s.reasons.join(" ")).not.toContain("answers more");
  });
});

describe("attempt fatigue", () => {
  it("prefers a fresh lead over one already chased six times", () => {
    const ordered = orderCandidates(
      [
        lead({ leadId: "tired", state: "MI", attemptCount: 8, position: 0 }),
        lead({ leadId: "fresh", state: "MI", attemptCount: 0, position: 1 }),
      ],
      { now: NOW }
    );
    expect(ordered[0].candidate.leadId).toBe("fresh");
    expect(ordered[0].reasons).toContain("Never tried");
  });
});

describe("windowCoverage tells an admin the packet is wrong-coast", () => {
  it("counts how many are callable right now", () => {
    const c = windowCoverage(
      [
        lead({ state: "NY" }),
        lead({ state: "MI" }),
        lead({ state: "CA" }),
        lead({ state: "CA" }),
      ],
      { now: NOW }
    );
    expect(c.total).toBe(4);
    expect(c.callableNow).toBe(2);
    expect(c.buckets.find((b) => b.status === "early_or_late")?.count).toBe(2);
  });

  it("reports zero callable for an all-west-coast packet at dawn", () => {
    const dawn = new Date("2026-07-22T11:00:00Z");
    const c = windowCoverage([lead({ state: "CA" }), lead({ state: "WA" })], { now: dawn });
    expect(c.callableNow).toBe(0);
  });

  it("handles an empty packet", () => {
    const c = windowCoverage([], { now: NOW });
    expect(c).toEqual({ buckets: [], callableNow: 0, total: 0 });
  });
});
