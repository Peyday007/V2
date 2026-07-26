import { describe, it, expect } from "vitest";
import {
  wilson,
  twoProportionZ,
  pValue,
  normalCdf,
  samplePerGroupNeeded,
  confidenceFor,
  segmentBy,
  findBest,
  buildSegment,
  analyzeCalls,
  analyzeObjections,
  totalsFor,
  hourBucket,
  attemptBucket,
  MIN_DIRECTIONAL,
  type CallFact,
} from "../src/lib/analytics";

/**
 * The point of these tests is not that the arithmetic is pretty. It is that
 * the system REFUSES to state a conclusion it cannot support — which is the
 * whole reason to have a gating layer at all.
 */

function call(over: Partial<CallFact> = {}): CallFact {
  return {
    outcome: "no_answer",
    reached_dm: false,
    caller_name: "Jack",
    lead_industry: "roofing",
    lead_state: "MI",
    dialed_hour: 9,
    dialed_dow: 2,
    attempt_number: 1,
    duration_seconds: 40,
    owner_known_before: false,
    created_at: "2026-07-01T14:00:00Z",
    ...over,
  };
}

/** n calls in a segment, `wins` of which reached the owner. */
function calls(n: number, wins: number, over: Partial<CallFact> = {}): CallFact[] {
  return Array.from({ length: n }, (_, i) =>
    call({ ...over, reached_dm: i < wins, outcome: i < wins ? "dm_conversation" : "no_answer" })
  );
}

describe("normalCdf", () => {
  it("is 0.5 at zero and symmetric", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 5);
    expect(normalCdf(1.5) + normalCdf(-1.5)).toBeCloseTo(1, 4);
  });

  it("matches the known 1.96 tail", () => {
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
  });
});

describe("wilson intervals are honest about small samples", () => {
  it("1 for 1 is NOT reported as a certain 100%", () => {
    const w = wilson(1, 1);
    expect(w.rate).toBe(1);
    expect(w.low).toBeLessThan(0.3);
  });

  it("narrows as the sample grows", () => {
    const small = wilson(5, 10);
    const large = wilson(500, 1000);
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });

  it("an empty sample is all zeros, not NaN", () => {
    expect(wilson(0, 0)).toEqual({ rate: 0, low: 0, high: 0 });
  });

  it("stays inside 0 and 1", () => {
    const w = wilson(0, 3);
    expect(w.low).toBeGreaterThanOrEqual(0);
    expect(w.high).toBeLessThanOrEqual(1);
  });
});

describe("significance testing", () => {
  it("finds no difference between identical groups", () => {
    expect(pValue(twoProportionZ(50, 100, 50, 100))).toBeCloseTo(1, 5);
  });

  it("finds a large difference at scale significant", () => {
    const p = pValue(twoProportionZ(60, 100, 30, 100));
    expect(p).toBeLessThan(0.001);
  });

  it("does NOT call the same proportional difference significant on tiny samples", () => {
    const p = pValue(twoProportionZ(3, 5, 1, 5));
    expect(p).toBeGreaterThan(0.05);
  });

  it("an empty group produces no signal instead of dividing by zero", () => {
    expect(twoProportionZ(1, 0, 1, 10)).toBe(0);
  });
});

describe("samplePerGroupNeeded turns 'not enough data' into a number", () => {
  it("asks for more calls when the gap is small", () => {
    expect(samplePerGroupNeeded(0.22, 0.2)).toBeGreaterThan(
      samplePerGroupNeeded(0.5, 0.2)
    );
  });

  it("is infinite when there is no difference to detect", () => {
    expect(samplePerGroupNeeded(0.3, 0.3)).toBe(Infinity);
  });
});

describe("confidence gating", () => {
  it("two calls is never enough", () => {
    expect(confidenceFor(2)).toBe("insufficient");
  });
  it("thirty is a directional signal", () => {
    expect(confidenceFor(MIN_DIRECTIONAL)).toBe("directional");
  });
  it("a hundred is reliable", () => {
    expect(confidenceFor(100)).toBe("reliable");
  });
});

describe("segmentBy", () => {
  it("counts trials and successes per key", () => {
    const rows = [...calls(4, 3, { lead_industry: "roofing" }), ...calls(2, 0, { lead_industry: "hvac" })];
    const segs = segmentBy(rows, (r) => r.lead_industry, (r) => r.reached_dm);
    const roofing = segs.find((s) => s.key === "roofing")!;
    expect(roofing.trials).toBe(4);
    expect(roofing.successes).toBe(3);
  });

  it("skips rows whose field was never recorded rather than bucketing them as unknown", () => {
    const rows = [call({ lead_industry: null }), call({ lead_industry: "hvac" })];
    const segs = segmentBy(rows, (r) => r.lead_industry, (r) => r.reached_dm);
    expect(segs).toHaveLength(1);
    expect(segs[0].key).toBe("hvac");
  });

  it("orders by key when asked, so hours read left to right", () => {
    const rows = [call({ dialed_hour: 16 }), call({ dialed_hour: 8 })];
    const segs = segmentBy(rows, (r) => hourBucket(r.dialed_hour), (r) => r.reached_dm, {
      order: "key",
    });
    expect(segs[0].key < segs[1].key).toBe(true);
  });
});

describe("findBest refuses to overclaim", () => {
  it("says so when there is only one group", () => {
    const f = findBest([buildSegment("a", "A", 5, 10)], "owner reached");
    expect(f.actionable).toBe(false);
    expect(f.headline).toMatch(/Not enough variety/i);
  });

  it("says so when there are no calls at all", () => {
    const f = findBest([], "owner reached");
    expect(f.actionable).toBe(false);
    expect(f.sampleSize).toBe(0);
  });

  it("a perfect 2-for-2 group does NOT beat a large solid group", () => {
    const f = findBest(
      [buildSegment("tiny", "Tiny", 2, 2), buildSegment("big", "Big", 120, 400)],
      "owner reached"
    );
    expect(f.actionable).toBe(false);
    expect(f.headline).toMatch(/No trustworthy difference/i);
  });

  it("reports how many more calls are needed", () => {
    const f = findBest(
      [buildSegment("a", "A", 4, 10), buildSegment("b", "B", 2, 10)],
      "owner reached"
    );
    expect(f.actionable).toBe(false);
    expect(f.callsNeeded).toBeGreaterThan(0);
    expect(f.detail).toMatch(/more calls per group/i);
  });

  it("DOES report a real, large, well-sampled difference", () => {
    const f = findBest(
      [buildSegment("morning", "7–9am", 120, 300), buildSegment("evening", "after 5pm", 30, 300)],
      "owner reached"
    );
    expect(f.significant).toBe(true);
    expect(f.actionable).toBe(true);
    expect(f.confidence).toBe("reliable");
    expect(f.lift).toBeGreaterThan(3);
  });

  it("never claims a finding when the winning side is thin, however big the gap", () => {
    const f = findBest(
      [buildSegment("a", "A", 5, 5), buildSegment("b", "B", 0, 500)],
      "owner reached"
    );
    expect(f.actionable).toBe(false);
  });
});

describe("totalsFor", () => {
  it("counts connects, owner conversations and appointments", () => {
    const rows = [
      call({ outcome: "no_answer" }),
      call({ outcome: "voicemail" }),
      call({ outcome: "gatekeeper" }),
      call({ outcome: "dm_conversation", reached_dm: true }),
      call({ outcome: "appointment_set", reached_dm: true }),
    ];
    const t = totalsFor(rows);
    expect(t.calls).toBe(5);
    expect(t.connects).toBe(3);
    expect(t.ownerConversations).toBe(2);
    expect(t.appointments).toBe(1);
  });

  it("reports no median duration when nothing was timed, rather than zero", () => {
    const t = totalsFor([call({ duration_seconds: null })]);
    expect(t.medianDurationSeconds).toBeNull();
    expect(t.callsWithDuration).toBe(0);
  });

  it("ignores untimed calls when computing the median", () => {
    const t = totalsFor([
      call({ duration_seconds: null }),
      call({ duration_seconds: 60 }),
      call({ duration_seconds: 62 }),
    ]);
    expect(t.callsWithDuration).toBe(2);
    expect(t.medianDurationSeconds).toBe(62);
  });
});

describe("analyzeCalls end to end", () => {
  it("produces a complete report from zero calls without throwing", () => {
    const r = analyzeCalls([]);
    expect(r.totals.calls).toBe(0);
    expect(r.actionable).toEqual([]);
    expect(r.dimensions.length).toBeGreaterThan(0);
    for (const d of r.dimensions) expect(d.finding.actionable).toBe(false);
  });

  it("surfaces nothing actionable from two calls", () => {
    const r = analyzeCalls([
      call({ reached_dm: true, outcome: "dm_conversation", lead_industry: "roofing" }),
      call({ lead_industry: "hvac" }),
    ]);
    expect(r.actionable).toEqual([]);
  });

  it("surfaces a genuine industry difference once the volume is there", () => {
    const r = analyzeCalls([
      ...calls(300, 120, { lead_industry: "roofing" }),
      ...calls(300, 30, { lead_industry: "hvac" }),
    ]);
    const industry = r.dimensions.find((d) => d.key === "industry")!;
    expect(industry.finding.actionable).toBe(true);
    expect(r.actionable.some((f) => f.dimension === "Industry")).toBe(true);
  });

  it("counts rows skipped for a missing field so thin data is visible", () => {
    const r = analyzeCalls([
      ...calls(10, 5, { lead_industry: null }),
      ...calls(10, 5, { lead_industry: "hvac" }),
    ]);
    expect(r.dimensions.find((d) => d.key === "industry")!.missing).toBe(10);
  });

  it("reports coverage honestly when a field was never captured", () => {
    const r = analyzeCalls(calls(5, 1, { duration_seconds: null }));
    const dur = r.coverage.find((c) => c.field === "Call duration")!;
    expect(dur.recorded).toBe(0);
    expect(dur.total).toBe(5);
  });

  it("orders actionable findings strongest first", () => {
    const r = analyzeCalls([
      ...calls(400, 200, { lead_industry: "roofing", caller_name: "Jack" }),
      ...calls(400, 20, { lead_industry: "hvac", caller_name: "Sam" }),
    ]);
    const ps = r.actionable.map((f) => f.pValue ?? 1);
    expect([...ps].sort((a, b) => a - b)).toEqual(ps);
  });
});

describe("bucketing", () => {
  it("maps hours into calling windows", () => {
    expect(hourBucket(8)).toBe("1_early");
    expect(hourBucket(20)).toBe("6_evening");
  });
  it("returns null for an unrecorded hour instead of guessing", () => {
    expect(hourBucket(null)).toBeNull();
  });
  it("collapses long attempt tails into 6+", () => {
    expect(attemptBucket(1)).toBe("1");
    expect(attemptBucket(9)).toBe("6+");
    expect(attemptBucket(null)).toBeNull();
  });
});

describe("analyzeObjections", () => {
  it("counts how often each objection appears and whether the call survived", () => {
    const rows = [
      { objection_key: "cost", objection_label: "How much?", outcome: "dm_conversation", reached_dm: true },
      { objection_key: "cost", objection_label: "How much?", outcome: "not_interested", reached_dm: false },
      { objection_key: "send_info", objection_label: "Send info", outcome: "no_answer", reached_dm: false },
    ];
    const [cost] = analyzeObjections(rows);
    expect(cost.key).toBe("cost");
    expect(cost.timesRaised).toBe(2);
    expect(cost.survivedToOwnerConversation).toBe(1);
    expect(cost.confidence).toBe("insufficient");
  });

  it("counts an appointment as surviving even if reached_dm was not set", () => {
    const [o] = analyzeObjections([
      { objection_key: "cost", objection_label: null, outcome: "appointment_set", reached_dm: null },
    ]);
    expect(o.survivedToOwnerConversation).toBe(1);
    expect(o.label).toBe("cost");
  });

  it("orders by how often the objection comes up", () => {
    const rows = [
      { objection_key: "a", objection_label: "A", outcome: "no_answer", reached_dm: false },
      { objection_key: "b", objection_label: "B", outcome: "no_answer", reached_dm: false },
      { objection_key: "b", objection_label: "B", outcome: "no_answer", reached_dm: false },
    ];
    expect(analyzeObjections(rows)[0].key).toBe("b");
  });
});
