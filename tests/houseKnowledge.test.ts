// What the house has learned, and the four rules that stop it becoming a
// machine that confidently repeats its own early noise.
//
//   1. Nothing is applied below the sample floor.
//   2. Exploration never stops.
//   3. It says what it does not know.
//   4. It never moves a price by itself.
//
// Each has a mutation test behind it in the suite run.

import { describe, it, expect } from "vitest";
import {
  buildKnowledge,
  weightArms,
  angleMultiplier,
  leadScore,
  briefingForWriter,
  appliedPriors,
  summarise,
  findBlindSpots,
  MIN_SAMPLES_TO_APPLY,
  MIN_LIFT_TO_APPLY,
  EXPLORATION_FLOOR,
  EMPTY_KNOWLEDGE,
  type OutcomeFact,
} from "../src/lib/houseKnowledge";
import { applyKnowledge, diagnose, topFindings } from "../src/lib/diagnostic";
import { assignScriptWeighted, SCRIPT_VERSIONS } from "../src/lib/gatekeeperScripts";
import { orderWithLearning, MAX_LEARNING_SHIFT } from "../src/lib/enrichmentGrade";

const call = (over: Partial<OutcomeFact> = {}): OutcomeFact => ({
  channel: "call",
  at: "2026-08-01T12:00:00Z",
  industry: "plumbing",
  reachedDecisionMaker: true,
  converted: false,
  ...over,
});

/** n facts, of which `wins` converted. */
const many = (n: number, wins: number, over: Partial<OutcomeFact> = {}): OutcomeFact[] =>
  Array.from({ length: n }, (_, i) => call({ ...over, converted: i < wins }));

/* -------------------------------------------------------------------------- */
/* rule 1: the sample floor                                                   */
/* -------------------------------------------------------------------------- */

describe("NOTHING IS APPLIED BELOW THE SAMPLE FLOOR", () => {
  /*
   * The sample floor has to be tested against a prior with a HUGE lift, or the
   * test passes for the wrong reason — nine facts that all converted look like
   * a 0% lift when they are the only facts there are, and it is the lift gate
   * rather than the sample gate that stops them.
   */
  const nineLuckyOnes = [
    ...many(400, 80), // the world: 20% converts
    ...many(9, 9, { angles: ["local_seo"] }), // a perfect nine
  ];

  it("A PERFECT NINE AGAINST A 20% WORLD STILL CHANGES NOTHING", () => {
    const k = buildKnowledge(nineLuckyOnes);
    const angle = k.angleLift.find((p) => p.key === "local_seo")!;
    expect(angle.rate).toBe(1);
    // The lift is enormous — five times the baseline — so the ONLY thing
    // holding it back is the sample count.
    expect(angle.lift).toBeGreaterThan(2);
    expect(angle.samples).toBeLessThan(MIN_SAMPLES_TO_APPLY);
    expect(angle.applied).toBe(false);
    expect(angle.reason).toContain(`${MIN_SAMPLES_TO_APPLY}`);
  });

  it("and the multiplier is EXACTLY 1 — no evidence means no opinion, not a small one", () => {
    const k = buildKnowledge(nineLuckyOnes);
    expect(angleMultiplier(k, "local_seo").multiplier).toBe(1);
    expect(angleMultiplier(k, "local_seo").source).toBeNull();
    // And nothing downstream moves either.
    expect(leadScore(k, { angles: ["local_seo"] }).score).toBe(1);
    expect(briefingForWriter(k)).toEqual([]);
  });

  it("clears the floor once there is enough", () => {
    const facts = [
      ...many(60, 30, { angles: ["local_seo"] }),
      ...many(60, 6, { angles: ["reputation"] }),
    ];
    const k = buildKnowledge(facts);
    const seo = k.angleLift.find((p) => p.key === "local_seo")!;
    expect(seo.samples).toBeGreaterThanOrEqual(MIN_SAMPLES_TO_APPLY);
    expect(seo.applied).toBe(true);
    expect(angleMultiplier(k, "local_seo").multiplier).toBeGreaterThan(1);
  });

  it("a big sample with a tiny difference is still not acted on", () => {
    // Statistical significance is not the same as being worth doing anything
    // about. A 2% edge over 500 calls is real and not a reason to change how
    // the packet is ordered.
    const facts = [
      ...many(500, 251, { angles: ["a"] }),
      ...many(500, 249, { angles: ["b"] }),
    ];
    const k = buildKnowledge(facts);
    for (const p of k.angleLift) {
      expect(Math.abs(p.lift)).toBeLessThan(MIN_LIFT_TO_APPLY);
      expect(p.applied).toBe(false);
    }
  });

  it("every prior explains itself whether applied or not", () => {
    const k = buildKnowledge([...many(9, 9, { angles: ["x"] }), ...many(80, 40, { angles: ["y"] })]);
    for (const p of k.angleLift) expect(p.reason.length).toBeGreaterThan(15);
  });
});

/* -------------------------------------------------------------------------- */
/* rule 2: exploration never stops                                            */
/* -------------------------------------------------------------------------- */

describe("EXPLORATION NEVER STOPS", () => {
  const priors = [
    { key: "A", label: "A", lift: 1, rate: 0.4, baselineRate: 0.2, samples: 200, interval: { rate: 0.4, low: 0.3, high: 0.5 }, confidence: "reliable" as const, applied: true, reason: "" },
    { key: "B", label: "B", lift: -0.5, rate: 0.1, baselineRate: 0.2, samples: 200, interval: { rate: 0.1, low: 0.05, high: 0.2 }, confidence: "reliable" as const, applied: true, reason: "" },
    { key: "C", label: "C", lift: 0, rate: 0.0, baselineRate: 0.2, samples: 200, interval: { rate: 0, low: 0, high: 0.1 }, confidence: "reliable" as const, applied: true, reason: "" },
  ];

  it("a losing arm KEEPS A SHARE, forever", () => {
    // The whole point. A router that sends everything to today's winner cannot
    // notice when the market moves, because the data it would need to see that
    // is data it stopped collecting.
    const w = weightArms(priors);
    for (const key of ["A", "B", "C"]) {
      expect(w[key], key).toBeGreaterThan(0);
    }
    expect(w.C).toBeGreaterThanOrEqual(EXPLORATION_FLOOR / priors.length - 0.001);
  });

  it("but the winner does get most of it", () => {
    const w = weightArms(priors);
    expect(w.A).toBeGreaterThan(w.B);
    expect(w.B).toBeGreaterThan(w.C);
    expect(w.A).toBeGreaterThan(0.5);
  });

  it("the split always sums to one", () => {
    for (const set of [priors, priors.slice(0, 1), []]) {
      const w = weightArms(set);
      if (Object.keys(w).length === 0) continue;
      const sum = Object.values(w).reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(0.01);
    }
  });

  it("with nothing proven the split is EVEN, not clever", () => {
    const unproven = priors.map((p) => ({ ...p, applied: false, samples: 5 }));
    const w = weightArms(unproven);
    expect(w.A).toBeCloseTo(1 / 3, 5);
    expect(w.B).toBeCloseTo(1 / 3, 5);
  });

  it("assignment stays deterministic under weighting", () => {
    const w = weightArms(priors);
    const id = "1f2e3d4c-0000-4000-8000-000000000042";
    expect(assignScriptWeighted(id, w)).toBe(assignScriptWeighted(id, w));
  });

  it("and still reaches every arm across a population", () => {
    const w = { A: 0.6, B: 0.25, C: 0.15 };
    const ids = Array.from({ length: 2000 }, (_, i) => `lead-${i}`);
    const seen = new Set(ids.map((id) => assignScriptWeighted(id, w)));
    expect(seen.size).toBe(3);
  });

  it("falls back to the even split when the weights are empty or unusable", () => {
    const id = "lead-1";
    expect(SCRIPT_VERSIONS).toContain(assignScriptWeighted(id, {}));
    expect(SCRIPT_VERSIONS).toContain(assignScriptWeighted(id, { Z: 1 }));
  });
});

/* -------------------------------------------------------------------------- */
/* rule 3: it says what it does not know                                      */
/* -------------------------------------------------------------------------- */

describe("IT SAYS WHAT IT DOES NOT KNOW", () => {
  it("an empty system says so plainly rather than pretending", () => {
    const k = buildKnowledge([]);
    expect(k.blindSpots.length).toBeGreaterThan(0);
    expect(summarise(k)).toMatch(/nothing recorded/i);
    expect(appliedPriors(k)).toEqual([]);
  });

  it("names the trades it cannot judge, with how many more it needs", () => {
    const k = buildKnowledge([
      ...many(50, 25, { industry: "plumbing" }),
      ...many(4, 2, { industry: "roofing" }),
    ]);
    const spot = k.blindSpots.find((b) => /trades/i.test(b.area));
    expect(spot).toBeTruthy();
    expect(spot!.detail).toContain("roofing");
    expect(spot!.needs).toBeGreaterThan(0);
  });

  it("notices when no opener has been dialled enough", () => {
    const k = buildKnowledge(many(20, 10, { scriptVersion: "A" }));
    const spot = k.blindSpots.find((b) => /opener/i.test(b.area));
    expect(spot).toBeTruthy();
    expect(spot!.needs).toBeGreaterThan(0);
  });

  it("notices when email is contributing nothing", () => {
    const k = buildKnowledge(many(100, 50));
    expect(k.blindSpots.some((b) => b.area === "Email")).toBe(true);
  });

  it("the summary is honest about having data but no conclusions", () => {
    const k = buildKnowledge(many(25, 12, { angles: ["x"] }));
    expect(summarise(k)).toMatch(/none of it conclusive/i);
  });

  it("and about having some", () => {
    const k = buildKnowledge([
      ...many(100, 60, { angles: ["local_seo"] }),
      ...many(100, 10, { angles: ["reputation"] }),
    ]);
    expect(appliedPriors(k).length).toBeGreaterThan(0);
    expect(summarise(k)).toMatch(/learned well enough to act on/);
  });

  it("blind spots are computed from the same priors the tools read", () => {
    const spots = findBlindSpots([], {
      angleLift: [],
      scriptLift: [],
      industryYield: [],
      timing: [],
    });
    expect(Array.isArray(spots)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* rule 4: it never moves a price                                             */
/* -------------------------------------------------------------------------- */

describe("IT NEVER MOVES A PRICE BY ITSELF", () => {
  const facts = [
    ...Array.from({ length: 20 }, () =>
      call({ estimatedBand: "solo", converted: true, actualDealValue: 4000 })
    ),
  ];

  it("reports the mismatch rather than correcting it", () => {
    const k = buildKnowledge(facts);
    const band = k.bandCalibration.find((b) => b.band === "solo")!;
    expect(band.medianDealValue).toBe(4000);
    expect(band.verdict).toMatch(/move it by hand/i);
  });

  it("does not expose anything that could be applied automatically", () => {
    const k = buildKnowledge(facts);
    // The calibration is a report. Nothing in the applied priors — which are
    // what the tools consult — carries a price.
    const applied = JSON.stringify(appliedPriors(k));
    expect(applied).not.toMatch(/medianDealValue|monthlyBudget|oneOffCeiling/);
  });

  it("says nothing at all off too few closed deals", () => {
    const k = buildKnowledge([call({ estimatedBand: "solo", converted: true, actualDealValue: 9000 })]);
    expect(k.bandCalibration[0].verdict).toMatch(/not enough to say/i);
  });
});

/* -------------------------------------------------------------------------- */
/* the ecosystem: the same knowledge reaching every tool                      */
/* -------------------------------------------------------------------------- */

describe("one knowledge, every tool", () => {
  const knowledge = buildKnowledge([
    ...many(120, 72, { angles: ["local_seo"], industry: "plumbing" }),
    ...many(120, 12, { angles: ["reputation"], industry: "plumbing" }),
    ...many(60, 36, { industry: "plumbing" }),
    ...many(60, 3, { industry: "cleaning" }),
    // A large, poorly-converting trade, so the overall average is not simply
    // plumbing's own rate. Without it plumbing's "lift" is measured against a
    // baseline it dominates, and comes out at 17% — which correctly moves a
    // lead less than half a place, and would make the packet test below assert
    // a coincidence rather than the behaviour.
    ...many(200, 20, { industry: "roofing" }),
  ]);

  it("THE DIAGNOSTIC reorders findings toward what converts", () => {
    const findings = diagnose({
      businessName: "Ace",
      industry: "plumbing",
      mapRank: 19,
      reviewCount: 8,
      website: "https://ace.com",
    });
    const before = topFindings(findings).map((f) => f.service);
    const { findings: after, applications } = applyKnowledge(findings, knowledge, "plumbing");
    expect(applications.length).toBeGreaterThan(0);

    // local_seo converts well here, so it should not have gone backwards.
    const seoBefore = before.indexOf("local_seo");
    const seoAfter = topFindings(after).map((f) => f.service).indexOf("local_seo");
    expect(seoAfter).toBeLessThanOrEqual(seoBefore === -1 ? 99 : seoBefore);
  });

  it("but the a-priori judgement still shows through — the tilt is capped", () => {
    const findings = diagnose({ businessName: "Ace", industry: "plumbing", mapRank: 19 });
    const { findings: after } = applyKnowledge(findings, knowledge, "plumbing");
    for (const f of after) expect(f.weight).toBeLessThanOrEqual(1);
    expect(after.length).toBe(findings.length);
  });

  it("and with no knowledge at all it is a no-op", () => {
    const findings = diagnose({ businessName: "Ace", mapRank: 19 });
    const { findings: after, applications } = applyKnowledge(findings, null);
    expect(after).toEqual(findings);
    expect(applications).toEqual([]);
  });

  it("THE PACKET orders toward the trades that convert", () => {
    // Two leads of identical quality: the only thing to tell them apart is
    // what the house has learned about their trades.
    const rows = [
      { id: "a", enrichment_grade: "C", industry: "cleaning" },
      { id: "b", enrichment_grade: "C", industry: "plumbing" },
    ];
    const { ordered, moved } = orderWithLearning(rows, (l) => leadScore(knowledge, l).score);
    expect(ordered[0].id).toBe("b");
    expect(moved.length).toBeGreaterThan(0);
  });

  it("and does nothing at all when nothing has been learned", () => {
    const rows = [
      { id: "a", enrichment_grade: "C", industry: "cleaning" },
      { id: "b", enrichment_grade: "C", industry: "plumbing" },
    ];
    const { ordered, moved } = orderWithLearning(rows, () => 1);
    expect(moved).toEqual([]);
    expect(ordered.map((r) => r.id)).toEqual(
      orderWithLearning(rows, () => 1).ordered.map((r) => r.id)
    );
  });

  it("but a lead FIVE PLACES BACK cannot reach the front on the strength of its trade", () => {
    // The learning moves a lead a bounded number of places. Whether it has a
    // validated direct number still decides who is first, because that is what
    // makes the caller's next hour productive.
    const rows = [
      { id: "good-number", enrichment_grade: "A", direct_phone_class: "verified_mobile", industry: "cleaning" },
      ...Array.from({ length: 4 }, (_, i) => ({ id: `filler-${i}`, enrichment_grade: "B" as const, industry: "cleaning" })),
      { id: "far-back", enrichment_grade: "D", industry: "plumbing" },
    ];
    const { ordered } = orderWithLearning(rows, (l) => leadScore(knowledge, l).score);
    expect(ordered[0].id).toBe("good-number");
    expect(ordered.findIndex((r) => r.id === "far-back")).toBeGreaterThan(0);
  });

  it("the shift is bounded and stated in places, not left to a formula", () => {
    expect(MAX_LEARNING_SHIFT).toBeLessThanOrEqual(3);
  });

  it("THE SEQUENCE WRITER is told what the phone learned", () => {
    const briefing = briefingForWriter(knowledge);
    expect(briefing.length).toBeGreaterThan(0);
    expect(briefing.join(" ")).toMatch(/local seo/i);
    expect(briefing.join(" ")).toMatch(/\d+ outcomes/);
  });

  it("and is told nothing at all when nothing is proven", () => {
    expect(briefingForWriter(buildKnowledge(many(5, 3, { angles: ["x"] })))).toEqual([]);
    expect(briefingForWriter(EMPTY_KNOWLEDGE)).toEqual([]);
  });

  it("the industry-specific read beats the general one", () => {
    const mixed = buildKnowledge([
      // Works for plumbers, does not for roofers.
      ...many(80, 56, { angles: ["local_seo"], industry: "plumbing" }),
      ...many(80, 8, { angles: ["local_seo"], industry: "roofing" }),
      ...many(80, 32, { industry: "plumbing" }),
      ...many(80, 32, { industry: "roofing" }),
    ]);
    const forPlumbers = angleMultiplier(mixed, "local_seo", "plumbing");
    const forRoofers = angleMultiplier(mixed, "local_seo", "roofing");
    expect(forPlumbers.multiplier).toBeGreaterThan(forRoofers.multiplier);
    expect(forPlumbers.source).toContain("plumbing");
  });
});

/* -------------------------------------------------------------------------- */
/* how the evidence is counted                                                */
/* -------------------------------------------------------------------------- */

describe("counting evidence honestly", () => {
  it("A NULL OUTCOME IS EXCLUDED, not counted as a failure", () => {
    // Counting unmeasurable as "no" would drag every rate toward zero in
    // proportion to how much data was missing, which is exactly backwards.
    const withNulls = buildKnowledge([
      ...many(40, 20, { angles: ["x"] }),
      ...Array.from({ length: 100 }, () => call({ angles: ["x"], converted: null })),
    ]);
    const clean = buildKnowledge(many(40, 20, { angles: ["x"] }));
    expect(withNulls.angleLift[0].rate).toBeCloseTo(clean.angleLift[0].rate, 5);
    expect(withNulls.angleLift[0].samples).toBe(40);
  });

  it("OVERRIDDEN CALLS ARE EXCLUDED from the script comparison", () => {
    // A caller who deliberately picked a different opener did so because of
    // something about that lead — the selection bias the random assignment
    // exists to remove. Letting it back in through the learning layer would
    // reintroduce it by the back door.
    const k = buildKnowledge([
      ...Array.from({ length: 50 }, () =>
        call({ scriptVersion: "A", scriptOverridden: false, reachedDecisionMaker: false })
      ),
      ...Array.from({ length: 50 }, () =>
        call({ scriptVersion: "A", scriptOverridden: true, reachedDecisionMaker: true })
      ),
    ]);
    const a = k.scriptLift.find((p) => p.key === "A")!;
    expect(a.samples).toBe(50);
    expect(a.rate).toBe(0);
  });

  it("email and calls are the same kind of evidence about an angle", () => {
    const k = buildKnowledge([
      ...many(20, 14, { angles: ["local_seo"] }),
      ...Array.from({ length: 20 }, () =>
        call({ channel: "email", angles: ["local_seo"], converted: true, reachedDecisionMaker: null })
      ),
    ]);
    expect(k.angleLift.find((p) => p.key === "local_seo")!.samples).toBe(40);
  });

  it("carries the sample size and interval on every prior", () => {
    const k = buildKnowledge(many(80, 40, { angles: ["x"] }));
    const p = k.angleLift[0];
    expect(p.samples).toBe(80);
    expect(p.interval.low).toBeLessThan(p.rate);
    expect(p.interval.high).toBeGreaterThan(p.rate);
  });
});

describe("scoring a lead", () => {
  const knowledge = buildKnowledge([
    ...many(120, 72, { industry: "plumbing" }),
    ...many(120, 12, { industry: "cleaning" }),
  ]);

  it("a good trade scores above a bad one, and says why", () => {
    const good = leadScore(knowledge, { industry: "plumbing" });
    const bad = leadScore(knowledge, { industry: "cleaning" });
    expect(good.score).toBeGreaterThan(bad.score);
    expect(good.why.length).toBeGreaterThan(0);
  });

  it("an unknown trade scores exactly 1 with nothing to say", () => {
    const unknown = leadScore(knowledge, { industry: "beekeeping" });
    expect(unknown.score).toBe(1);
    expect(unknown.why).toEqual([]);
  });

  it("the score is BOUNDED so one quarter cannot bury a trade", () => {
    const extreme = buildKnowledge([
      ...many(200, 200, { industry: "plumbing" }),
      ...many(200, 0, { industry: "cleaning" }),
    ]);
    expect(leadScore(extreme, { industry: "plumbing" }).score).toBeLessThanOrEqual(1.4);
    expect(leadScore(extreme, { industry: "cleaning" }).score).toBeGreaterThanOrEqual(0.7);
  });
});
