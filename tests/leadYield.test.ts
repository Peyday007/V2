import { describe, it, expect } from "vitest";
import {
  decideSearching,
  rawBusinessesNeeded,
  callableProgressPercent,
  DEFAULT_YIELD,
  MIN_SAMPLE_FOR_OBSERVED,
  MIN_APPLIED_YIELD,
} from "../src/lib/leadYield";

/**
 * The complaint these tests exist for: asking the engine for 100 leads
 * produced about 40 callable ones, because it stopped counting at "saved"
 * rather than "callable" and the operator had to learn to order double.
 */

function state(over: Partial<Parameters<typeof decideSearching>[0]> = {}) {
  return { target: 100, callable: 0, discarded: 0, inFlight: 0, ...over };
}

describe("the bug: stopping at businesses saved instead of leads callable", () => {
  it("keeps searching when 100 were saved but only 40 came out callable", () => {
    const d = decideSearching(state({ callable: 40, discarded: 60, inFlight: 0 }));
    expect(d.keepSearching).toBe(true);
    expect(d.stillNeeded).toBe(60);
  });

  it("stops once the CALLABLE target is genuinely met", () => {
    const d = decideSearching(state({ callable: 100, discarded: 140 }));
    expect(d.keepSearching).toBe(false);
    expect(d.reason).toContain("target reached");
  });

  it("overshooting the target still stops", () => {
    expect(decideSearching(state({ callable: 175, discarded: 30 })).keepSearching).toBe(
      false
    );
  });
});

describe("projection stops it over-searching while enrichment lags", () => {
  it("does not keep searching just because nothing has finished processing yet", () => {
    // 250 saved, none processed. At the default 50% assumption that projects
    // to 125 callable, which covers a target of 100.
    const d = decideSearching(state({ callable: 0, discarded: 0, inFlight: 250 }));
    expect(d.keepSearching).toBe(false);
    expect(d.appliedYield).toBe(DEFAULT_YIELD);
  });

  it("keeps searching when the in-flight pile is too small to cover the target", () => {
    const d = decideSearching(state({ callable: 0, discarded: 0, inFlight: 100 }));
    expect(d.keepSearching).toBe(true);
    expect(d.projectedCallable).toBe(50);
  });

  it("counts in-flight leads toward the projection", () => {
    const d = decideSearching(state({ callable: 60, discarded: 60, inFlight: 100 }));
    // 60 callable + 100 * observed 50% = 110, covering the target of 100.
    expect(d.keepSearching).toBe(false);
  });
});

describe("it learns the real yield instead of trusting the assumption", () => {
  it("ignores the observed rate until there is enough of a sample", () => {
    const d = decideSearching(state({ callable: 1, discarded: 4, inFlight: 200 }));
    expect(d.observedYield).toBeCloseTo(0.2, 5);
    expect(d.appliedYield).toBe(DEFAULT_YIELD); // 5 processed is noise
  });

  it("uses the observed rate once the sample is big enough", () => {
    const d = decideSearching(
      state({ callable: 20, discarded: 80, inFlight: 100 }) // 100 processed, 20%
    );
    expect(d.observedYield).toBeCloseTo(0.2, 5);
    expect(d.appliedYield).toBeCloseTo(0.2, 5);
    // 20 + 100*0.2 = 40, well short of 100, so it keeps going.
    expect(d.keepSearching).toBe(true);
    expect(d.stillNeeded).toBe(60);
  });

  it("a poor yield makes it search MORE, not give up", () => {
    const poor = decideSearching(state({ callable: 20, discarded: 80, inFlight: 50 }));
    const good = decideSearching(state({ callable: 20, discarded: 5, inFlight: 50 }));
    expect(poor.stillNeeded).toBeGreaterThan(good.stillNeeded);
  });

  it("never projects below the floor, so a bad patch cannot cause runaway searching", () => {
    const d = decideSearching(state({ callable: 0, discarded: 200, inFlight: 100 }));
    expect(d.observedYield).toBe(0);
    expect(d.appliedYield).toBe(MIN_APPLIED_YIELD);
  });

  it("switches to observed exactly at the sample threshold", () => {
    const below = decideSearching(
      state({ callable: 6, discarded: MIN_SAMPLE_FOR_OBSERVED - 7, inFlight: 10 })
    );
    const at = decideSearching(
      state({ callable: 6, discarded: MIN_SAMPLE_FOR_OBSERVED - 6, inFlight: 10 })
    );
    expect(below.appliedYield).toBe(DEFAULT_YIELD);
    expect(at.appliedYield).not.toBe(DEFAULT_YIELD);
  });
});

describe("edges", () => {
  it("a fresh campaign with nothing found searches", () => {
    expect(decideSearching(state()).keepSearching).toBe(true);
  });

  it("a zero target never searches", () => {
    expect(decideSearching(state({ target: 0 })).keepSearching).toBe(false);
  });

  it("always explains itself", () => {
    for (const s of [
      state(),
      state({ callable: 100 }),
      state({ callable: 20, discarded: 80, inFlight: 40 }),
      state({ inFlight: 500 }),
    ]) {
      expect(decideSearching(s).reason.length).toBeGreaterThan(0);
    }
  });

  it("stillNeeded is never negative", () => {
    expect(decideSearching(state({ callable: 500 })).stillNeeded).toBe(0);
  });
});

describe("rawBusinessesNeeded", () => {
  it("asks for twice as many raw businesses at a 50% yield", () => {
    expect(rawBusinessesNeeded(50, 0.5)).toBe(100);
  });

  it("asks for more when the yield is worse", () => {
    expect(rawBusinessesNeeded(50, 0.25)).toBe(200);
  });

  it("is zero when nothing more is needed", () => {
    expect(rawBusinessesNeeded(0, 0.5)).toBe(0);
    expect(rawBusinessesNeeded(-5, 0.5)).toBe(0);
  });

  it("clamps an absurd yield so the number stays finite", () => {
    expect(Number.isFinite(rawBusinessesNeeded(50, 0))).toBe(true);
  });
});

describe("callableProgressPercent", () => {
  it("measures callable leads, so the bar cannot read 100% with an empty packet", () => {
    expect(callableProgressPercent(40, 100)).toBe(40);
  });

  it("caps at 100", () => {
    expect(callableProgressPercent(500, 100)).toBe(100);
  });

  it("handles a zero target", () => {
    expect(callableProgressPercent(0, 0)).toBe(100);
  });
});
