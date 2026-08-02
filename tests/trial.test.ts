import { describe, it, expect } from "vitest";
import { scoreTrial, benchmarkFrom, type Benchmark } from "../src/lib/trial";
import type { CallFact } from "../src/lib/analytics";

function c(over: Partial<CallFact> = {}): CallFact {
  return {
    outcome: "no_answer",
    reached_dm: false,
    caller_name: "Candidate",
    lead_industry: "roofing",
    lead_state: "MI",
    dialed_hour: 9,
    dialed_dow: 2,
    attempt_number: 1,
    duration_seconds: 60,
    owner_known_before: false,
    created_at: "2026-07-20T14:00:00Z",
    spoke_with_role: "unknown",
    ...over,
  };
}

/** n calls spread over `days`, of which `talked` answered and `owners` reached the owner. */
function trialCalls(
  n: number,
  talked: number,
  owners: number,
  appts = 0,
  days = 5
): CallFact[] {
  return Array.from({ length: n }, (_, i) => {
    const day = String(20 + (i % days)).padStart(2, "0");
    const created_at = `2026-07-${day}T14:00:00Z`;
    if (i < appts) {
      return c({ created_at, spoke_with_role: "owner", reached_dm: true, outcome: "appointment_set" });
    }
    if (i < owners) {
      return c({ created_at, spoke_with_role: "owner", reached_dm: true, outcome: "dm_conversation" });
    }
    if (i < talked) return c({ created_at, spoke_with_role: "gatekeeper", outcome: "gatekeeper" });
    return c({ created_at });
  });
}

const TEAM: Benchmark = {
  dials: 800,
  talked: 600,
  ownerConversations: 240,
  appointments: 60,
  callsPerDay: 20,
};

describe("a trial in progress makes no judgement", () => {
  it("reports progress and nothing else", () => {
    const s = scoreTrial({ calls: trialCalls(40, 30, 12), targetCalls: 100, benchmark: TEAM });
    expect(s.recommendation.key).toBe("in_progress");
    expect(s.recommendation.action).toContain("60 calls to go");
    expect(s.headline).toBe("40 of 100 calls done");
    expect(s.percentComplete).toBe(40);
  });

  it("an untouched trial does not crash", () => {
    const s = scoreTrial({ calls: [], targetCalls: 100, benchmark: TEAM });
    expect(s.callsMade).toBe(0);
    expect(s.recommendation.key).toBe("in_progress");
  });
});

describe("it is explicit about what 100 calls cannot settle", () => {
  it("refuses to judge closing off a handful of owner conversations", () => {
    const s = scoreTrial({
      calls: trialCalls(100, 72, 12, 1),
      targetCalls: 100,
      benchmark: TEAM,
    });
    const closing = s.parts.find((p) => p.key === "closing")!;
    expect(closing.status).not.toBe("settled");
    expect(closing.note).toContain("hint, not a verdict");
  });

  it("lists every unsettled measure on the recommendation", () => {
    const s = scoreTrial({
      calls: trialCalls(100, 72, 12, 1),
      targetCalls: 100,
      benchmark: TEAM,
    });
    expect(s.recommendation.unresolved.some((u) => u.startsWith("Closing"))).toBe(true);
  });

  it("does settle getting-through and opening at 100 calls", () => {
    const s = scoreTrial({
      calls: trialCalls(100, 72, 40),
      targetCalls: 100,
      benchmark: TEAM,
    });
    expect(s.parts.find((p) => p.key === "connecting")!.status).toBe("settled");
    expect(s.parts.find((p) => p.key === "opening")!.status).toBe("settled");
  });
});

describe("verdicts", () => {
  it("recommends adding a candidate who beats the bar on opening", () => {
    const s = scoreTrial({
      calls: trialCalls(100, 75, 55, 5),
      targetCalls: 100,
      benchmark: TEAM,
    });
    expect(s.parts.find((p) => p.key === "opening")!.verdict).toBe("above");
    expect(s.recommendation.key).toBe("add");
  });

  it("recommends adding someone who simply matched the team", () => {
    const s = scoreTrial({
      calls: trialCalls(100, 75, 30, 7),
      targetCalls: 100,
      benchmark: TEAM,
    });
    expect(s.recommendation.key).toBe("add");
    expect(s.recommendation.evidence).toContain("Nothing separates them");
  });

  it("recommends cutting only when TWO independent measures fail", () => {
    // Low effort (4/day against 20) and clearly behind on opening.
    const s = scoreTrial({
      calls: trialCalls(100, 75, 5, 0, 25),
      targetCalls: 100,
      benchmark: TEAM,
    });
    expect(s.parts.find((p) => p.key === "effort")!.verdict).toBe("below");
    expect(s.parts.find((p) => p.key === "opening")!.verdict).toBe("below");
    expect(s.recommendation.key).toBe("cut");
    expect(s.recommendation.evidence).toContain("Two independent measures");
  });

  it("extends rather than cuts when only one measure is weak", () => {
    // Effort fine, opening poor.
    const s = scoreTrial({
      calls: trialCalls(100, 75, 5, 0, 4),
      targetCalls: 100,
      benchmark: TEAM,
    });
    expect(s.parts.find((p) => p.key === "effort")!.verdict).not.toBe("below");
    expect(s.recommendation.key).toBe("extend");
    expect(s.recommendation.evidence).toContain("coin toss");
  });

  it("never tells you to fire anyone — a tryout decision is about hiring", () => {
    const s = scoreTrial({
      calls: trialCalls(100, 75, 5, 0, 25),
      targetCalls: 100,
      benchmark: TEAM,
    });
    const text = `${s.recommendation.action} ${s.recommendation.evidence}`.toLowerCase();
    expect(text).not.toContain("fire");
    expect(s.recommendation.action).toBe("Do not add them to the team");
  });
});

describe("effort is judged without a significance test", () => {
  it("is above the bar when they match the team's pace", () => {
    const s = scoreTrial({
      calls: trialCalls(100, 70, 30, 5, 5),
      targetCalls: 100,
      benchmark: TEAM,
    });
    expect(s.callsPerActiveDay).toBe(20);
    expect(s.parts.find((p) => p.key === "effort")!.verdict).toBe("above");
  });

  it("cannot judge effort with no team to compare against", () => {
    const s = scoreTrial({
      calls: trialCalls(100, 70, 30),
      targetCalls: 100,
      benchmark: { ...TEAM, callsPerDay: null },
    });
    const effort = s.parts.find((p) => p.key === "effort")!;
    expect(effort.verdict).toBe("unknown");
    expect(effort.note).toContain("No existing team");
  });
});

describe("capture", () => {
  it("flags a candidate who wrote nothing down", () => {
    const s = scoreTrial({
      calls: trialCalls(100, 70, 30, 5),
      targetCalls: 100,
      benchmark: TEAM,
      intelCaptureCount: 3,
    });
    expect(s.parts.find((p) => p.key === "capture")!.verdict).toBe("below");
  });

  it("is omitted entirely when not supplied", () => {
    const s = scoreTrial({ calls: trialCalls(100, 70, 30), targetCalls: 100, benchmark: TEAM });
    expect(s.parts.some((p) => p.key === "capture")).toBe(false);
  });
});

describe("benchmarkFrom freezes the bar", () => {
  it("counts the team's dials, conversations and appointments", () => {
    const b = benchmarkFrom(trialCalls(200, 150, 60, 12, 10));
    expect(b.dials).toBe(200);
    expect(b.talked).toBe(150);
    expect(b.ownerConversations).toBe(60);
    expect(b.appointments).toBe(12);
  });

  it("uses the median calls per day across callers", () => {
    const calls = [
      ...trialCalls(50, 40, 20, 0, 5).map((x) => ({ ...x, caller_name: "A" })),
      ...trialCalls(20, 15, 5, 0, 5).map((x) => ({ ...x, caller_name: "B" })),
    ];
    const b = benchmarkFrom(calls);
    expect(b.callsPerDay).toBeGreaterThan(0);
  });

  it("returns a null pace when there is no team history", () => {
    expect(benchmarkFrom([]).callsPerDay).toBeNull();
    expect(benchmarkFrom([]).dials).toBe(0);
  });

  it("a candidate scored against an empty bar gets no false verdicts", () => {
    const s = scoreTrial({
      calls: trialCalls(100, 70, 30, 5),
      targetCalls: 100,
      benchmark: benchmarkFrom([]),
    });
    for (const p of s.parts) {
      if (p.key === "capture") continue;
      expect(["unsettled", "unmeasured", "settled"], p.key).toContain(p.status);
      if (p.key !== "effort") expect(p.verdict, p.key).toBe("unknown");
    }
  });
});

/**
 * A trial decides whether someone gets hired. Team-relative alone is the wrong
 * basis for that when the team itself may be under the bar.
 */
describe("hiring is not decided on beating a weak team", () => {
  const bar = (metric: string, value: number) => ({
    metric: metric as never,
    target: value,
    source: "set_by_operator",
    minimumSample: 30,
  });

  /** A team that is genuinely poor: 10% owner-reached per dial. */
  const WEAK_TEAM: Benchmark = {
    dials: 800,
    talked: 320,
    ownerConversations: 80,
    appointments: 8,
    callsPerDay: 20,
  };

  it("holds the hire when the candidate beats the team but misses the bar", () => {
    const score = scoreTrial({
      // 100 dials, 60 answered, 30 owners → 30% per dial, well ahead of 10%.
      calls: trialCalls(100, 60, 30),
      targetCalls: 100,
      benchmark: WEAK_TEAM,
      targets: [bar("owner_reach_rate", 0.5)],
    });
    expect(score.recommendation.key).toBe("extend");
    expect(score.recommendation.evidence).toContain("under your target");
    expect(score.recommendation.evidence).toContain(
      "Beating the current team is not the same as being good enough"
    );
    expect(score.headline).toContain("under target on owner-reached rate");
  });

  it("still hires when the bar is actually cleared", () => {
    const score = scoreTrial({
      calls: trialCalls(100, 60, 30),
      targetCalls: 100,
      benchmark: WEAK_TEAM,
      targets: [bar("owner_reach_rate", 0.2)],
    });
    expect(score.recommendation.key).toBe("add");
    expect(score.headline).not.toContain("under target");
  });

  it("never lets a hundred dials rule on appointment rate", () => {
    const score = scoreTrial({
      // Zero appointments — but at a 2% bar, 100 dials expects two.
      calls: trialCalls(100, 60, 30),
      targetCalls: 100,
      benchmark: WEAK_TEAM,
      targets: [bar("owner_reach_rate", 0.2), bar("appointment_rate", 0.02)],
    });
    expect(score.absolute.map((a) => a.metric)).not.toContain("appointment_rate");
    expect(score.recommendation.key).toBe("add");
  });

  it("applies no bar at all to a trial too small to speak to one", () => {
    const score = scoreTrial({
      calls: trialCalls(40, 20, 4),
      targetCalls: 40,
      benchmark: WEAK_TEAM,
      targets: [bar("owner_reach_rate", 0.5)],
    });
    expect(score.absolute).toEqual([]);
  });

  it("applies the borrowed bar when no target is set, and says the bar is borrowed", () => {
    // Previously a trial had no absolute bar until somebody visited the
    // Targets page, so hiring fell back to the team average by default.
    const score = scoreTrial({
      calls: trialCalls(100, 30, 0),
      targetCalls: 100,
      benchmark: WEAK_TEAM,
    });
    const owner = score.absolute.find((a) => a.metric === "owner_reach_rate")!;
    expect(owner.target).toBe(0.12);
    expect(owner.targetIsBorrowed).toBe(true);
    expect(
      score.recommendation.unresolved.some((u) => /borrowed starting figure/.test(u))
    ).toBe(true);
  });

  /**
   * The case from production: a candidate reached ZERO owners in 103 dials and
   * the scorecard still said "add them to the team", because the existing team
   * had barely reached any either.
   */
  it("does not hire someone who reached nobody, however weak the team is", () => {
    const score = scoreTrial({
      calls: trialCalls(103, 31, 0),
      targetCalls: 100,
      benchmark: { dials: 400, talked: 132, ownerConversations: 11, appointments: 0, callsPerDay: 52.5 },
    });
    expect(score.recommendation.key).not.toBe("add");
    expect(score.headline).toContain("under target on owner-reached rate");
  });

  it("says the bar is borrowed rather than calling it your target", () => {
    const score = scoreTrial({
      calls: trialCalls(103, 31, 0),
      targetCalls: 100,
      benchmark: { dials: 400, talked: 132, ownerConversations: 11, appointments: 0, callsPerDay: 52.5 },
    });
    expect(score.recommendation.evidence).toContain("the starting benchmark");
    expect(score.recommendation.evidence).not.toContain("under your target");
  });

  it("does not soften a cut — a missed bar never rescues a failing candidate", () => {
    const score = scoreTrial({
      // Low effort and poor opening against a strong team.
      calls: trialCalls(100, 60, 4, 0, 20),
      targetCalls: 100,
      benchmark: { dials: 800, talked: 600, ownerConversations: 300, appointments: 60, callsPerDay: 40 },
      targets: [bar("owner_reach_rate", 0.5)],
    });
    expect(score.recommendation.key).toBe("cut");
  });
});
