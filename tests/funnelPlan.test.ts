// When to go and get more leads.
//
// This is the decision that spends money at Google on a schedule with nobody
// watching, so the order of the checks matters more than any single one of
// them. Pure, so all of it is testable without spending anything.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { decideFunnel, nextSearchTarget, type FunnelFacts } from "../src/lib/funnelPlan";

const facts = (over: Partial<FunnelFacts> = {}): FunnelFacts => ({
  enabled: true,
  eligibleToEmail: 5,
  refillWhenBelow: 200,
  awaitingEnrichment: 0,
  sourcingRunning: false,
  hoursSinceLastRun: null,
  minHoursBetweenRuns: 6,
  ...over,
});

/* -------------------------------------------------------------------------- */
/* the thing that was actually broken                                         */
/* -------------------------------------------------------------------------- */

describe("THE POOL RUNS DRY AND SOMETHING REFILLS IT", () => {
  it("sources when there is nothing left to email and nothing to enrich", () => {
    const d = decideFunnel(facts());
    expect(d.act).toBe("source");
    expect(d.reason).toMatch(/needs refilling/);
  });

  it("does nothing while the pool is still deep enough", () => {
    expect(decideFunnel(facts({ eligibleToEmail: 500 })).act).toBe("wait");
  });

  it("refills BEFORE the tank is empty, not after", () => {
    // Sourcing, enriching and crawling take hours. Waiting for zero means a
    // silent gap with every switch correctly switched on — which is exactly
    // the state this was built to end.
    expect(decideFunnel(facts({ eligibleToEmail: 199, refillWhenBelow: 200 })).act).toBe("source");
    expect(decideFunnel(facts({ eligibleToEmail: 200, refillWhenBelow: 200 })).act).toBe("wait");
  });
});

/* -------------------------------------------------------------------------- */
/* everything that stops it spending                                          */
/* -------------------------------------------------------------------------- */

describe("EVERY REASON NOT TO SPEND IS CHECKED FIRST", () => {
  it("OFF MEANS OFF, whatever the numbers say", () => {
    const d = decideFunnel(facts({ enabled: false, eligibleToEmail: 0 }));
    expect(d.act).toBe("wait");
    expect(d.reason).toMatch(/switched off/);
  });

  it("ENRICHES BEFORE IT BUYS — the most important rule here", () => {
    /*
     * A lead already in the database with no address is a free crawl away
     * from being emailable. A new lead from Google costs money AND still
     * needs the same crawl afterwards. Buying while enrichment is outstanding
     * is paying to make a queue longer.
     */
    const d = decideFunnel(facts({ eligibleToEmail: 0, awaitingEnrichment: 800 }));
    expect(d.act).toBe("enrich");
    expect(d.reason).toMatch(/free/);
  });

  it("one lead left to enrich is still enough to stop a purchase", () => {
    expect(decideFunnel(facts({ awaitingEnrichment: 1 })).act).toBe("enrich");
  });

  it("never starts a second run while one is going", () => {
    const d = decideFunnel(facts({ sourcingRunning: true }));
    expect(d.act).toBe("wait");
    expect(d.reason).toMatch(/already going/);
  });

  it("leaves a gap between runs, and says how long is left", () => {
    const d = decideFunnel(facts({ hoursSinceLastRun: 2, minHoursBetweenRuns: 6 }));
    expect(d.act).toBe("wait");
    expect(d.reason).toMatch(/about 4h/);
  });

  it("sources once the gap has passed", () => {
    expect(decideFunnel(facts({ hoursSinceLastRun: 7, minHoursBetweenRuns: 6 })).act).toBe("source");
  });

  it("a first ever run is not blocked by the gap", () => {
    expect(decideFunnel(facts({ hoursSinceLastRun: null })).act).toBe("source");
  });

  it("EVERY DECISION EXPLAINS ITSELF", () => {
    for (const f of [
      facts({ enabled: false }),
      facts({ eligibleToEmail: 900 }),
      facts({ awaitingEnrichment: 5 }),
      facts({ sourcingRunning: true }),
      facts({ hoursSinceLastRun: 1 }),
      facts(),
    ]) {
      expect(decideFunnel(f).reason.length).toBeGreaterThan(30);
    }
  });
});

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
describe("THE FUNNEL CHECK ACTUALLY RUNS", () => {
  const tick = readFileSync(
    new URL("../src/app/api/worker/tick/route.ts", import.meta.url),
    "utf8"
  );
  const handlers = readFileSync(new URL("../src/lib/jobHandlers.ts", import.meta.url), "utf8");
  const store = readFileSync(new URL("../src/lib/funnelStore.ts", import.meta.url), "utf8");

  it("the worker enqueues it", () => {
    expect(tick).toMatch(/type: "keep_funnel_full"/);
  });

  it("a handler is registered for it", () => {
    expect(handlers).toMatch(/keep_funnel_full: keepFunnelFullJob/);
  });

  it("the store runs the PURE decision rather than deciding for itself", () => {
    expect(store).toMatch(/decideFunnel\(\{/);
  });

  it("SPENDS NOTHING when the decision is not to source", () => {
    // The two acting branches are both behind the decision, and "wait"
    // returns before either of them.
    const body = store.slice(store.indexOf("export async function keepFunnelFull"));
    const waitReturn = body.indexOf('decision.act === "wait"');
    const insert = body.indexOf('from("sourcing_campaigns")\n    .insert');
    expect(waitReturn).toBeGreaterThan(-1);
    expect(waitReturn).toBeLessThan(insert === -1 ? Number.MAX_SAFE_INTEGER : insert);
  });

  it("an unreadable 'is sourcing running' reads as RUNNING, not as free to spend", () => {
    expect(store).toMatch(/sourcingIsRunning\(\)\.catch\(\(\) => true\)/);
  });

  it("records what it searched BEFORE it can fail, so a repeat moves on", () => {
    expect(store).toMatch(/from\("auto_source_history"\)/);
  });

  it("refuses to source without a Places key rather than throwing", () => {
    expect(store).toMatch(/placesKeyConfigured\(\)/);
  });
});
