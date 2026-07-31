import { describe, it, expect } from "vitest";
import {
  buildCallerProfile,
  buildAllProfiles,
  industryFit,
  talkedToSomeone,
  MIN_CALLS_FOR_PROFILE,
  MIN_FOR_SKILL,
} from "../src/lib/callerProfile";
import type { CallFact } from "../src/lib/analytics";

function c(over: Partial<CallFact> = {}): CallFact {
  return {
    outcome: "no_answer",
    reached_dm: false,
    caller_name: "Jack",
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

/** n calls where `talked` reached a human and `owners` of those reached the owner. */
function mix(
  n: number,
  talked: number,
  owners: number,
  appts = 0,
  over: Partial<CallFact> = {}
): CallFact[] {
  return Array.from({ length: n }, (_, i) => {
    if (i < appts) {
      return c({ ...over, spoke_with_role: "owner", reached_dm: true, outcome: "appointment_set" });
    }
    if (i < owners) {
      return c({ ...over, spoke_with_role: "owner", reached_dm: true, outcome: "dm_conversation" });
    }
    if (i < talked) {
      return c({ ...over, spoke_with_role: "gatekeeper", outcome: "gatekeeper" });
    }
    return c({ ...over, spoke_with_role: "unknown", outcome: "no_answer" });
  });
}

describe("talkedToSomeone", () => {
  it("counts a recorded conversation with anyone", () => {
    expect(talkedToSomeone(c({ spoke_with_role: "gatekeeper" }))).toBe(true);
    expect(talkedToSomeone(c({ spoke_with_role: "owner" }))).toBe(true);
    expect(talkedToSomeone(c({ spoke_with_role: "employee" }))).toBe(true);
  });

  it("does not count a dial nobody answered", () => {
    expect(talkedToSomeone(c({ outcome: "no_answer", spoke_with_role: "unknown" }))).toBe(false);
    expect(talkedToSomeone(c({ outcome: "voicemail", spoke_with_role: null }))).toBe(false);
    expect(talkedToSomeone(c({ outcome: "bad_number", spoke_with_role: null }))).toBe(false);
  });

  it("falls back to the outcome for calls logged before roles were recorded", () => {
    expect(talkedToSomeone(c({ outcome: "dm_conversation", spoke_with_role: null }))).toBe(true);
  });
});

describe("a thin record produces no judgement at all", () => {
  it("refuses to profile someone under the minimum", () => {
    const p = buildCallerProfile({
      callerName: "New",
      mine: mix(5, 4, 3, 1),
      others: mix(200, 150, 60, 10),
    });
    expect(p.recommendations).toHaveLength(1);
    expect(p.recommendations[0].key).toBe("not_enough_data");
    expect(p.headline).toContain("too few to judge");
  });

  it("scores no skill without enough of that skill's own denominator", () => {
    // Plenty of dials, but almost nobody ever picked up, so opening is unscored.
    const p = buildCallerProfile({
      callerName: "Unlucky",
      mine: mix(40, 3, 1),
      others: mix(300, 200, 90),
    });
    const opening = p.skills.find((s) => s.key === "opening")!;
    expect(opening.trials).toBeLessThan(MIN_FOR_SKILL);
    expect(opening.verdict).toBe("not_enough_data");
  });

  it("never says needs_review off a handful of calls", () => {
    const p = buildCallerProfile({
      callerName: "New",
      mine: mix(MIN_CALLS_FOR_PROFILE - 1, 10, 0),
      others: mix(400, 300, 150, 40),
    });
    expect(p.recommendations.some((r) => r.key === "needs_review")).toBe(false);
  });
});

describe("it separates opening from closing", () => {
  it("spots someone who reaches owners but cannot book them", () => {
    const p = buildCallerProfile({
      callerName: "Opener",
      // 200 calls, 160 answered, 120 reached the owner, only 2 booked.
      mine: mix(200, 160, 120, 2),
      // Team: fewer owners reached, but books a third of them.
      others: mix(400, 300, 120, 40),
    });
    const opening = p.skills.find((s) => s.key === "opening")!;
    const closing = p.skills.find((s) => s.key === "closing")!;
    expect(opening.verdict).toBe("strong");
    expect(closing.verdict).toBe("weak");
    expect(p.headline).toContain("Strong at opening");
    expect(p.recommendations.some((r) => r.key === "coach_closing")).toBe(true);
    expect(p.recommendations.some((r) => r.key === "strong_opener")).toBe(true);
  });

  it("spots the opposite — struggles to get through but closes what they get", () => {
    const p = buildCallerProfile({
      callerName: "Closer",
      mine: mix(200, 160, 30, 20),
      others: mix(400, 320, 200, 20),
    });
    expect(p.skills.find((s) => s.key === "opening")!.verdict).toBe("weak");
    expect(p.skills.find((s) => s.key === "closing")!.verdict).toBe("strong");
    expect(p.recommendations.some((r) => r.key === "strong_closer")).toBe(true);
  });

  it("recommends promotion only when both halves are ahead", () => {
    const strong = buildCallerProfile({
      callerName: "Star",
      mine: mix(300, 260, 200, 70),
      others: mix(600, 450, 150, 15),
    });
    expect(strong.recommendations.some((r) => r.key === "model_for_team")).toBe(true);

    const oneSided = buildCallerProfile({
      callerName: "Half",
      mine: mix(300, 260, 200, 20),
      others: mix(600, 450, 150, 45),
    });
    expect(oneSided.recommendations.some((r) => r.key === "model_for_team")).toBe(false);
  });

  it("says 'in line with the team' when nothing separates them", () => {
    const p = buildCallerProfile({
      callerName: "Average",
      mine: mix(200, 150, 75, 15),
      others: mix(400, 300, 150, 30),
    });
    for (const s of p.skills) expect(s.verdict).toBe("on_par");
    expect(p.headline).toContain("in line with the rest of the team");
  });
});

describe("criticism is held to a stricter bar than praise", () => {
  it("does not condemn on a difference that would count as praise", () => {
    // A gap that lands between p=0.01 and p=0.05 must not trigger "weak".
    const p = buildCallerProfile({
      callerName: "Slightly behind",
      mine: mix(120, 100, 38),
      others: mix(400, 340, 160),
    });
    const opening = p.skills.find((s) => s.key === "opening")!;
    if (opening.pValue !== null && opening.pValue < 0.05 && opening.pValue >= 0.01) {
      expect(opening.verdict).toBe("on_par");
    }
  });

  it("only reaches needs_review when both skills fail the strict bar", () => {
    const p = buildCallerProfile({
      callerName: "Struggling",
      mine: mix(200, 150, 40, 0),
      others: mix(600, 450, 280, 70),
    });
    expect(p.recommendations.some((r) => r.key === "needs_review")).toBe(true);
    const review = p.recommendations.find((r) => r.key === "needs_review")!;
    expect(review.severity).toBe("serious");
    // It must not tell the user to fire anyone.
    expect(review.action.toLowerCase()).not.toContain("fire");
    expect(review.action.toLowerCase()).not.toContain("drop");
    expect(review.evidence).toContain("coaching conversation first");
  });

  it("every recommendation carries its numbers", () => {
    const p = buildCallerProfile({
      callerName: "Anyone",
      mine: mix(200, 160, 120, 2),
      others: mix(400, 300, 120, 40),
    });
    for (const r of p.recommendations) {
      expect(r.evidence.length, r.key).toBeGreaterThan(20);
      expect(/\d/.test(r.evidence), r.key).toBe(true);
    }
  });
});

describe("volume is judged on its own, without a significance test", () => {
  it("flags someone dialing far less than the team", () => {
    const mine = Array.from({ length: 30 }, (_, i) =>
      c({ created_at: `2026-07-${String(1 + (i % 10)).padStart(2, "0")}T14:00:00Z` })
    );
    const p = buildCallerProfile({
      callerName: "Quiet",
      mine,
      others: mix(400, 300, 150, 30),
      teamCallsPerDay: 25,
    });
    const low = p.recommendations.find((r) => r.key === "low_volume");
    expect(low).toBeTruthy();
    expect(low?.evidence).toContain("cannot be compared fairly");
  });

  it("says nothing about volume when it is in range", () => {
    const mine = Array.from({ length: 40 }, () => c({ created_at: "2026-07-20T14:00:00Z" }));
    const p = buildCallerProfile({
      callerName: "Busy",
      mine,
      others: mix(400, 300, 150, 30),
      teamCallsPerDay: 25,
    });
    expect(p.recommendations.some((r) => r.key === "low_volume")).toBe(false);
  });
});

describe("industry fit drives packet routing", () => {
  it("finds a trade the caller is genuinely better at", () => {
    const mine = [
      ...mix(60, 55, 45, 0, { lead_industry: "hvac" }),
      ...mix(60, 50, 12, 0, { lead_industry: "roofing" }),
    ];
    const others = [
      ...mix(120, 100, 25, 0, { lead_industry: "hvac" }),
      ...mix(120, 100, 24, 0, { lead_industry: "roofing" }),
    ];
    const fits = industryFit(mine, others);
    const hvac = fits.find((f) => f.industry === "hvac")!;
    expect(hvac.verdict).toBe("strong");
  });

  it("routes only to trades that cleared the test", () => {
    const p = buildCallerProfile({
      callerName: "Specialist",
      mine: [
        ...mix(60, 55, 45, 0, { lead_industry: "hvac" }),
        ...mix(20, 15, 5, 0, { lead_industry: "plumbing" }),
      ],
      others: [
        ...mix(120, 100, 25, 0, { lead_industry: "hvac" }),
        ...mix(120, 90, 30, 0, { lead_industry: "plumbing" }),
      ],
    });
    expect(p.routeToIndustries).toContain("hvac");
    expect(p.routeToIndustries).not.toContain("plumbing");
  });

  it("routes nowhere when no trade has proven itself", () => {
    const p = buildCallerProfile({
      callerName: "Even",
      mine: mix(60, 45, 22, 0, { lead_industry: "hvac" }),
      others: mix(120, 90, 45, 0, { lead_industry: "hvac" }),
    });
    expect(p.routeToIndustries).toEqual([]);
  });

  it("will not call a trade a strength off a couple of calls", () => {
    const fits = industryFit(
      mix(3, 3, 3, 0, { lead_industry: "septic" }),
      mix(200, 150, 20, 0, { lead_industry: "septic" })
    );
    expect(fits[0].verdict).toBe("not_enough_data");
  });
});

describe("buildAllProfiles", () => {
  it("profiles every caller and compares each against the others", () => {
    const calls = [
      ...mix(200, 160, 120, 2, { caller_name: "Jack" }),
      ...mix(200, 150, 60, 20, { caller_name: "Sam" }),
    ];
    const profiles = buildAllProfiles(calls);
    expect(profiles.map((p) => p.callerName).sort()).toEqual(["Jack", "Sam"]);
    const jack = profiles.find((p) => p.callerName === "Jack")!;
    expect(jack.skills.find((s) => s.key === "opening")!.teamTrials).toBe(150);
  });

  it("orders by who has dialed most", () => {
    const calls = [
      ...mix(30, 20, 10, 0, { caller_name: "Few" }),
      ...mix(90, 60, 30, 0, { caller_name: "Many" }),
    ];
    expect(buildAllProfiles(calls)[0].callerName).toBe("Many");
  });

  it("handles a single caller with nobody to compare against", () => {
    const [p] = buildAllProfiles(mix(50, 40, 20, 5, { caller_name: "Solo" }));
    for (const s of p.skills) expect(s.verdict).toBe("not_enough_data");
    expect(p.recommendations.length).toBeGreaterThan(0);
  });

  it("returns nothing for an empty call log", () => {
    expect(buildAllProfiles([])).toEqual([]);
  });
});

describe("capture rate", () => {
  it("flags a caller who writes almost nothing down", () => {
    const p = buildCallerProfile({
      callerName: "Silent",
      mine: mix(100, 80, 40, 8),
      others: mix(200, 160, 80, 16),
      intelCaptureCount: 2,
    });
    const rec = p.recommendations.find((r) => r.key === "poor_capture");
    expect(rec).toBeTruthy();
    expect(rec?.evidence).toContain("rediscovered by the next caller");
  });

  it("says nothing when they are recording properly", () => {
    const p = buildCallerProfile({
      callerName: "Diligent",
      mine: mix(100, 80, 40, 8),
      others: mix(200, 160, 80, 16),
      intelCaptureCount: 55,
    });
    expect(p.recommendations.some((r) => r.key === "poor_capture")).toBe(false);
  });
});

/**
 * The complaint this answers: "it'll say these stats are good because everyone
 * else's stats aren't, but those stats aren't good from an industry standard."
 */
describe("beating a weak team is not reported as good", () => {
  const bar = (metric: string, value: number) => ({
    metric: metric as never,
    target: value,
    source: "set_by_operator",
    minimumSample: 30,
  });

  it("leads with the missed bar even when far ahead of the team", () => {
    const p = buildCallerProfile({
      callerName: "Best of a weak group",
      // 300 dials, 90 answered, 30 owners → 10% owner-reached per dial.
      mine: mix(300, 90, 30),
      others: mix(600, 120, 24),
      targets: [bar("owner_reach_rate", 0.3)],
    });
    const owner = p.absolute.find((a) => a.metric === "owner_reach_rate")!;
    expect(owner.vsTeam).toBe("above");
    expect(owner.vsTarget).toBe("below");
    expect(p.headline).toContain("under target on owner-reached rate");
    expect(p.recommendations.some((r) => r.key === "below_target")).toBe(true);
  });

  it("says the team is under the bar too rather than blaming the caller", () => {
    const p = buildCallerProfile({
      callerName: "Ahead",
      mine: mix(300, 90, 30),
      others: mix(600, 120, 24),
      targets: [bar("owner_reach_rate", 0.3)],
    });
    const rec = p.recommendations.find((r) => r.key === "below_target")!;
    expect(rec.evidence).toContain("the team is under the bar too");
    expect(rec.severity).toBe("info");
  });

  it("raises the severity when they are behind the team as well", () => {
    const p = buildCallerProfile({
      callerName: "Behind",
      mine: mix(300, 60, 12),
      others: mix(600, 300, 150),
      targets: [bar("owner_reach_rate", 0.3)],
    });
    const rec = p.recommendations.find((r) => r.key === "below_target")!;
    expect(rec.severity).toBe("attention");
    expect(rec.evidence).toContain("behind the rest of the team");
  });

  it("does not flag a missed bar when the bar is met", () => {
    const p = buildCallerProfile({
      callerName: "Genuinely good",
      mine: mix(300, 200, 120),
      others: mix(600, 300, 150),
      targets: [bar("owner_reach_rate", 0.3)],
    });
    expect(p.recommendations.some((r) => r.key === "below_target")).toBe(false);
    expect(p.headline).not.toContain("under target");
  });

  it("warns that nothing here is absolute when no target is set at all", () => {
    const p = buildCallerProfile({
      callerName: "Average",
      mine: mix(200, 150, 75, 15),
      others: mix(400, 300, 150, 30),
    });
    expect(p.recommendations.some((r) => r.key === "no_targets_set")).toBe(true);
    expect(p.headline).toContain("no targets set");
    expect(p.absolute.every((a) => a.vsTarget === "unknown")).toBe(true);
  });

  it("uses per-dial denominators for the bar, not the coaching denominators", () => {
    // 200 dials, 100 answered, 50 owners. Opening (owners per ANSWERED) is 50%,
    // owner-reach (owners per DIAL) is 25%. A 30% bar must be read against 25%.
    const p = buildCallerProfile({
      callerName: "Denominators",
      mine: mix(200, 100, 50),
      others: mix(400, 200, 100),
      targets: [bar("owner_reach_rate", 0.3)],
    });
    const owner = p.absolute.find((a) => a.metric === "owner_reach_rate")!;
    expect(owner.value).toBeCloseTo(0.25, 5);
    expect(owner.vsTarget).toBe("below");
  });

  it("passes targets through to every caller in the team view", () => {
    const calls = [
      ...mix(200, 60, 20).map((x) => ({ ...x, caller_name: "A" })),
      ...mix(200, 60, 20).map((x) => ({ ...x, caller_name: "B" })),
    ];
    const profiles = buildAllProfiles(calls, { targets: [bar("owner_reach_rate", 0.3)] });
    expect(profiles.length).toBe(2);
    for (const p of profiles) {
      expect(p.absolute.find((a) => a.metric === "owner_reach_rate")!.vsTarget).toBe("below");
      expect(p.recommendations.some((r) => r.key === "no_targets_set")).toBe(false);
    }
  });

  it("carries the borrowed caveat into the recommendation", () => {
    const p = buildCallerProfile({
      callerName: "Borrowed bar",
      mine: mix(300, 90, 30),
      others: mix(600, 120, 24),
      targets: [
        {
          metric: "owner_reach_rate" as never,
          target: 0.3,
          source: "starting benchmark — general cold calling, not your data",
          minimumSample: 30,
        },
      ],
    });
    const rec = p.recommendations.find((r) => r.key === "below_target")!;
    expect(rec.evidence).toContain("borrowed starting figure");
  });
});
