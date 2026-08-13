// When to go and get more leads.
//
// This is the decision that spends money at Google on a schedule with nobody
// watching, so the order of the checks matters more than any single one of
// them. Pure, so all of it is testable without spending anything.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { nextSearchTarget } from "../src/lib/funnelPlan";


/*
 * The sourcing DECISION moved to supplyPlan.ts and is tested in
 * supplyPlan.test.ts — see "WHERE decideFunnel WENT" in funnelPlan.ts for why.
 * What remains here is choosing WHERE to search next, plus the guards that the
 * check is actually wired into the worker.
 */

/* -------------------------------------------------------------------------- */
/* what to search for next                                                    */
/* -------------------------------------------------------------------------- */

describe("moving through the grid rather than buying the same leads twice", () => {
  const trades = ["hvac", "plumbing"];
  const metros = ["Dallas, TX", "Atlanta, GA"];
  const NOW = new Date("2026-08-11T12:00:00Z");
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

  it("takes something never searched, first", () => {
    const t = nextSearchTarget(trades, metros, [], NOW);
    expect(t).toEqual({ trade: "hvac", metro: "Dallas, TX" });
  });

  it("moves on rather than repeating", () => {
    const t = nextSearchTarget(
      trades,
      metros,
      [{ trade: "hvac", metro: "Dallas, TX", at: daysAgo(1) }],
      NOW
    );
    expect(t).not.toEqual({ trade: "hvac", metro: "Dallas, TX" });
  });

  it("comes back to the OLDEST once everything has been tried", () => {
    const history = [
      { trade: "hvac", metro: "Dallas, TX", at: daysAgo(90) },
      { trade: "hvac", metro: "Atlanta, GA", at: daysAgo(50) },
      { trade: "plumbing", metro: "Dallas, TX", at: daysAgo(60) },
      { trade: "plumbing", metro: "Atlanta, GA", at: daysAgo(40) },
    ];
    expect(nextSearchTarget(trades, metros, history, NOW)).toEqual({
      trade: "hvac",
      metro: "Dallas, TX",
    });
  });

  it("REFUSES rather than re-buying when everything is inside the cooling period", () => {
    // Searching the same ground returns the same businesses, every one of
    // which is dropped as a duplicate — API requests bought to add nothing.
    // Null here is a real answer: widen the trades or the metros.
    const history = [
      { trade: "hvac", metro: "Dallas, TX", at: daysAgo(1) },
      { trade: "hvac", metro: "Atlanta, GA", at: daysAgo(2) },
      { trade: "plumbing", metro: "Dallas, TX", at: daysAgo(3) },
      { trade: "plumbing", metro: "Atlanta, GA", at: daysAgo(4) },
    ];
    expect(nextSearchTarget(trades, metros, history, NOW)).toBeNull();
  });

  it("survives an empty list rather than throwing", () => {
    expect(nextSearchTarget([], metros, [], NOW)).toBeNull();
    expect(nextSearchTarget(trades, [], [], NOW)).toBeNull();
  });

  it("ignores a history row with an unparseable date", () => {
    const t = nextSearchTarget(trades, metros, [{ trade: "hvac", metro: "Dallas, TX", at: "nope" }], NOW);
    expect(t).toEqual({ trade: "hvac", metro: "Dallas, TX" });
  });
});

/* -------------------------------------------------------------------------- */
/* wired into the real workflow                                               */
/* -------------------------------------------------------------------------- */

/*
 * "Do not report built when logic exists but is not wired into the real
 * workflow." A refill decision nothing runs is exactly the state that made
 * every downstream switch look broken for weeks.
 */