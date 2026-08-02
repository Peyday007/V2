import { describe, it, expect } from "vitest";
import {
  assess,
  assessTeam,
  sanityBreach,
  missingTargets,
  METRICS,
  METRIC_MAP,
  SANITY_FLOORS,
  SUGGESTED_TARGETS,
  SUGGESTED_SOURCE,
  SUGGESTED_MAP,
  OWN_DATA_THRESHOLD,
  isBorrowed,
  replaceBorrowedPrompt,
  effectiveTarget,
  impliedStageBar,
  type Target,
} from "../src/lib/benchmarks";

const target = (over: Partial<Target> = {}): Target => ({
  metric: "owner_reach_rate",
  target: 0.3,
  source: "set_by_operator",
  minimumSample: 30,
  ...over,
});

/**
 * The flaw this fixes: every comparison was against the team's own average, so
 * "ahead of the team" read as "good" even when the whole team was poor.
 */

describe("THE FIX: beating a weak team is not success", () => {
  it("leads with the missed target even when far ahead of the team", () => {
    const a = assess({
      metric: "owner_reach_rate",
      value: 0.18,
      observations: 200,
      teamValue: 0.08,
      teamObservations: 400,
      target: target({ target: 0.3 }),
    });
    expect(a.vsTeam).toBe("above");
    expect(a.vsTarget).toBe("below");
    expect(a.verdict).toContain("below your target");
    expect(a.warning).toContain("best of the group is not the same as being good enough");
  });

  it("does not warn when the target is met", () => {
    const a = assess({
      metric: "owner_reach_rate",
      value: 0.35,
      observations: 200,
      teamValue: 0.08,
      teamObservations: 400,
      target: target({ target: 0.3 }),
    });
    expect(a.vsTarget).toBe("above");
    expect(a.warning).toBeUndefined();
    expect(a.verdict).toContain("above your target");
  });

  it("refuses to call a relative position good when no target exists", () => {
    const a = assess({
      metric: "owner_reach_rate",
      value: 0.18,
      observations: 200,
      teamValue: 0.08,
      teamObservations: 400,
    });
    expect(a.verdict).toContain("ahead of the rest of the team");
    expect(a.verdict).toContain("nothing to say about whether that is good");
    expect(a.verdict).not.toMatch(/\bgood\b(?!\.)/i);
  });

  it("judges the TEAM against the target too, so it cannot become the standard", () => {
    const t = assessTeam("owner_reach_rate", 0.08, 400, target({ target: 0.3 }));
    expect(t.vsTarget).toBe("below");
    expect(t.verdict).toContain("below your target");
  });
});

describe("a team average is never computed from noise", () => {
  it("withholds the comparison below the minimum sample", () => {
    const a = assess({
      metric: "owner_reach_rate",
      value: 0.4,
      observations: 50,
      teamValue: 0.05,
      teamObservations: 4,
      target: null,
    });
    expect(a.vsTeam).toBe("unknown");
    expect(a.teamUnavailableReason).toContain("only 4 calls");
    expect(a.teamUnavailableReason).toContain("too few to be a meaningful average");
  });

  it("says so when there is no team at all", () => {
    const a = assess({
      metric: "owner_reach_rate",
      value: 0.4,
      observations: 50,
      teamValue: null,
    });
    expect(a.vsTeam).toBe("unknown");
    expect(a.teamUnavailableReason).toContain("Nobody else");
  });

  it("still assesses against the target when the team is unusable", () => {
    const a = assess({
      metric: "owner_reach_rate",
      value: 0.4,
      observations: 50,
      teamValue: 0.05,
      teamObservations: 3,
      target: target({ target: 0.3 }),
    });
    expect(a.vsTeam).toBe("unknown");
    expect(a.vsTarget).toBe("above");
  });

  it("honours a per-target minimum sample", () => {
    const a = assess({
      metric: "owner_reach_rate",
      value: 0.4,
      observations: 200,
      teamValue: 0.2,
      teamObservations: 60,
      target: target({ minimumSample: 100 }),
    });
    expect(a.vsTeam).toBe("unknown");
  });
});

describe("borrowed starting figures", () => {
  it("offers a starting point for every metric, so the form is never empty", () => {
    expect(SUGGESTED_TARGETS.length).toBe(METRICS.length);
    for (const m of METRICS) expect(SUGGESTED_MAP[m.key], m.key).toBeTruthy();
  });

  it("keeps every suggestion inside the range it claims", () => {
    for (const s of SUGGESTED_TARGETS) {
      expect(s.low, s.metric).toBeLessThanOrEqual(s.value);
      expect(s.high, s.metric).toBeGreaterThanOrEqual(s.value);
      expect(s.low, s.metric).toBeLessThan(s.high);
    }
  });

  it("gives each one a stated basis, so it is never mistaken for measured", () => {
    for (const s of SUGGESTED_TARGETS) {
      expect(s.basis.length, s.metric).toBeGreaterThan(30);
    }
  });

  it("keeps rate suggestions as fractions, not percentages", () => {
    for (const s of SUGGESTED_TARGETS) {
      if (METRIC_MAP[s.metric].kind !== "rate") continue;
      expect(s.value, s.metric).toBeGreaterThan(0);
      expect(s.value, s.metric).toBeLessThanOrEqual(1);
    }
  });

  it("marks a borrowed target as borrowed everywhere it is used", () => {
    const borrowed = target({ source: SUGGESTED_SOURCE });
    expect(isBorrowed(borrowed)).toBe(true);
    expect(isBorrowed(target({ source: "our 2025 numbers" }))).toBe(false);
    expect(isBorrowed(null)).toBe(false);

    const a = assess({
      metric: "owner_reach_rate",
      value: 0.4,
      observations: 100,
      target: borrowed,
    });
    expect(a.targetIsBorrowed).toBe(true);
    expect(a.targetCaveat).toContain("not measured on your business");
  });

  it("does not mark a target you set yourself as borrowed", () => {
    const a = assess({
      metric: "owner_reach_rate",
      value: 0.4,
      observations: 100,
      target: target({ source: "what our best month looked like" }),
    });
    expect(a.targetIsBorrowed).toBe(false);
    expect(a.targetCaveat).toBeUndefined();
  });

  it("asks for a replacement once there is enough of your own data", () => {
    const borrowed = target({ source: SUGGESTED_SOURCE, target: 0.12 });
    expect(replaceBorrowedPrompt(borrowed, 0.2, OWN_DATA_THRESHOLD - 1)).toBeNull();
    const prompt = replaceBorrowedPrompt(borrowed, 0.2, OWN_DATA_THRESHOLD);
    expect(prompt).toContain("12%");
    expect(prompt).toContain("20%");
    expect(prompt).toContain(String(OWN_DATA_THRESHOLD));
  });

  it("never asks to replace a target you set yourself", () => {
    const mine = target({ source: "our 2025 numbers" });
    expect(replaceBorrowedPrompt(mine, 0.2, 5000)).toBeNull();
  });

  it("says the figures are general rather than measured here", () => {
    expect(SUGGESTED_SOURCE).toMatch(/not your data/i);
  });
});

describe("no invented benchmarks ship silently", () => {
  it("every metric is defined without a built-in target value", () => {
    // Starting figures live in SUGGESTED_TARGETS, where they carry provenance.
    // A number baked onto the metric itself would apply with none.
    for (const m of METRICS) {
      expect(m).not.toHaveProperty("default");
      expect(m).not.toHaveProperty("industryStandard");
    }
  });

  it("an assessment with no target says so rather than assuming one", () => {
    const a = assess({ metric: "appointment_rate", value: 0.02, observations: 300 });
    expect(a.target).toBeNull();
    expect(a.vsTarget).toBe("unknown");
    expect(a.verdict).toContain("no target set");
  });

  it("reports which metrics still have no bar", () => {
    const missing = missingTargets([target({ metric: "owner_reach_rate" })]);
    expect(missing.map((m) => m.key)).not.toContain("owner_reach_rate");
    expect(missing.length).toBe(METRICS.length - 1);
  });

  it("records where each target came from", () => {
    const a = assess({
      metric: "owner_reach_rate",
      value: 0.4,
      observations: 100,
      target: target({ source: "our 2025 numbers" }),
    });
    expect(a.targetSource).toBe("our 2025 numbers");
  });
});

describe("sanity floors are arithmetic, not benchmarks", () => {
  it("fires only on a genuinely broken result over a large sample", () => {
    expect(sanityBreach("connect_rate", 0.02, 200)).toBeTruthy();
    expect(sanityBreach("connect_rate", 0.02, 20)).toBeNull();
    expect(sanityBreach("connect_rate", 0.3, 200)).toBeNull();
  });

  it("blames the list rather than the person", () => {
    const breach = sanityBreach("connect_rate", 0.01, 200);
    expect(breach?.message).toContain("numbers or the time of day, not the caller");
  });

  it("surfaces on the assessment, above everything else", () => {
    const a = assess({
      metric: "connect_rate",
      value: 0.01,
      observations: 200,
      teamValue: 0.005,
      teamObservations: 300,
      target: target({ metric: "connect_rate", target: 0.4 }),
    });
    expect(a.alarm).toBeTruthy();
  });

  it("is set deliberately low, so it catches breakage and does not grade", () => {
    for (const f of SANITY_FLOORS) {
      expect(f.floor).toBeLessThan(0.1);
      expect(f.minimumObservations).toBeGreaterThanOrEqual(50);
    }
  });
});

describe("lower-is-better metrics are not inverted", () => {
  it("a faster follow-up beats a slower one", () => {
    const a = assess({
      metric: "followup_minutes",
      value: 6,
      observations: 40,
      teamValue: 25,
      teamObservations: 100,
      target: target({ metric: "followup_minutes", target: 10 }),
    });
    expect(a.vsTeam).toBe("above");
    expect(a.vsTarget).toBe("above");
  });

  it("a slower follow-up is below target", () => {
    const a = assess({
      metric: "followup_minutes",
      value: 45,
      observations: 40,
      target: target({ metric: "followup_minutes", target: 10 }),
    });
    expect(a.vsTarget).toBe("below");
  });
});

describe("edges", () => {
  it("says nothing about a metric with no observations", () => {
    const a = assess({ metric: "owner_reach_rate", value: 0, observations: 0 });
    expect(a.verdict).toContain("No owner-reached rate recorded yet");
  });

  it("treats near-enough as meeting the bar", () => {
    const a = assess({
      metric: "owner_reach_rate",
      value: 0.295,
      observations: 200,
      target: target({ target: 0.3 }),
    });
    expect(a.vsTarget).toBe("on_par");
  });

  it("does not divide by zero on a zero target", () => {
    const a = assess({
      metric: "appointment_rate",
      value: 0.05,
      observations: 100,
      target: target({ metric: "appointment_rate", target: 0 }),
    });
    expect(Number.isFinite(a.value)).toBe(true);
    expect(a.verdict.length).toBeGreaterThan(0);
  });

  it("every metric has a plain-language meaning for whoever sets the target", () => {
    for (const m of METRICS) {
      expect(METRIC_MAP[m.key].meaning.length, m.key).toBeGreaterThan(20);
    }
  });
});

/**
 * "No target set" was honest and useless. Next to a caller's numbers it left
 * only the team average — the exact comparison that makes someone working a
 * weak batch look strong.
 */
describe("the bar in force, when you have not set one", () => {
  it("falls back to the borrowed figure and admits it", () => {
    const eff = effectiveTarget("connect_rate", []);
    expect(eff?.value).toBe(0.25);
    expect(eff?.borrowed).toBe(true);
    expect(eff?.source).toBe(SUGGESTED_SOURCE);
    expect(eff?.low).toBe(0.15);
    expect(eff?.high).toBe(0.35);
  });

  it("prefers a target you actually set", () => {
    const eff = effectiveTarget("connect_rate", [
      { metric: "connect_rate", target: 0.4, source: "our best month", minimumSample: 30 },
    ]);
    expect(eff?.value).toBe(0.4);
    expect(eff?.borrowed).toBe(false);
    expect(eff?.source).toBe("our best month");
  });

  it("still calls a stored borrowed figure borrowed", () => {
    // Pressing "use the starting figures" writes rows; they are not yours.
    const eff = effectiveTarget("connect_rate", [
      { metric: "connect_rate", target: 0.25, source: SUGGESTED_SOURCE, minimumSample: 30 },
    ]);
    expect(eff?.borrowed).toBe(true);
  });
});

describe("a bar for a rate measured per stage, not per dial", () => {
  it("divides the two published per-dial figures", () => {
    // 12% of dials reach an owner, 25% connect → 48% of answered calls.
    const bar = impliedStageBar("owner_reach_rate", "connect_rate", []);
    expect(bar?.value).toBeCloseTo(0.48, 2);
    expect(bar?.borrowed).toBe(true);
    expect(bar?.source).toContain("implied by");
  });

  it("uses your own numbers where you set them", () => {
    const bar = impliedStageBar("owner_reach_rate", "connect_rate", [
      { metric: "owner_reach_rate", target: 0.2, source: "ours", minimumSample: 30 },
      { metric: "connect_rate", target: 0.5, source: "ours", minimumSample: 30 },
    ]);
    expect(bar?.value).toBeCloseTo(0.4, 5);
    expect(bar?.borrowed).toBe(false);
  });

  it("never implies a rate above 100%", () => {
    const bar = impliedStageBar("connect_rate", "appointment_rate", []);
    expect(bar!.value).toBeLessThanOrEqual(1);
  });

  it("refuses to divide by a zero denominator", () => {
    const bar = impliedStageBar("owner_reach_rate", "connect_rate", [
      { metric: "connect_rate", target: 0, source: "ours", minimumSample: 30 },
    ]);
    expect(bar).toBeNull();
  });
});
