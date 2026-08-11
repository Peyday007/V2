// Is the whole chain running, and where did it stop?
//
// Every stage already reported on itself honestly and it was not enough: the
// top-up said "no leads eligible", the campaign said "323 of 323 contacted",
// enrichment said "nothing queued" — all true, and the real answer (nothing
// had sourced a lead in weeks) was on none of them.

import { describe, it, expect } from "vitest";
import { funnelHealth, type FunnelFacts } from "../src/lib/funnelHealth";

const facts = (over: Partial<FunnelFacts> = {}): FunnelFacts => ({
  totalLeads: 1500,
  awaitingEnrichment: 0,
  eligibleToEmail: 300,
  inCampaign: 323,
  sentLast24h: 100,
  autoSourceEnabled: true,
  autoReenrichEnabled: true,
  autoPushEnabled: true,
  programmeEnabled: true,
  sourcingRunning: false,
  ...over,
});

describe("THE HEADLINE NAMES THE FIRST BREAK AND NOTHING ELSE", () => {
  it("says it is flowing when it is", () => {
    const h = funnelHealth(facts());
    expect(h.flowing).toBe(true);
    expect(h.headline).toMatch(/moving all the way through/);
  });

  it("REPORTS THE EARLIEST BREAK, not the loudest", () => {
    /*
     * The exact state this was built for: sending is stopped AND the campaign
     * is empty AND the pool is dry — but the thing to act on is the supply,
     * because fixing anything downstream of an empty top does nothing.
     */
    const h = funnelHealth(
      facts({ awaitingEnrichment: 0, eligibleToEmail: 0, inCampaign: 0, sentLast24h: 0 })
    );
    expect(h.headline).toMatch(/new leads coming in/i);
    expect(h.headline).not.toMatch(/emails going out/i);
  });

  it("moves on to enrichment once supply is fine", () => {
    const h = funnelHealth(
      facts({ awaitingEnrichment: 800, autoReenrichEnabled: false, eligibleToEmail: 0 })
    );
    expect(h.headline).toMatch(/finding addresses/i);
  });

  it("reports the push stage when supply and enrichment are both fine", () => {
    const h = funnelHealth(facts({ autoPushEnabled: false }));
    expect(h.headline).toMatch(/leads into the campaign/i);
  });
});

describe("A BUSY STAGE IS NOT A BROKEN ONE", () => {
  it("enrichment with a queue and the switch on is working, not stuck", () => {
    const h = funnelHealth(facts({ awaitingEnrichment: 800, autoReenrichEnabled: true }));
    const stage = h.stages.find((s) => s.key === "enrichment")!;
    expect(stage.state).toBe("working");
    expect(stage.fix).toBeNull();
  });

  it("a sourcing run in progress is working, not stuck", () => {
    const h = funnelHealth(
      facts({ sourcingRunning: true, awaitingEnrichment: 0, eligibleToEmail: 0 })
    );
    expect(h.stages.find((s) => s.key === "supply")!.state).toBe("working");
  });

  it("leads waiting to be pushed is working", () => {
    expect(funnelHealth(facts({ eligibleToEmail: 50 })).stages.find((s) => s.key === "push")!.state).toBe(
      "working"
    );
  });

  it("nothing left to push is FINE, not a problem", () => {
    // This is the state that read as broken for weeks. An empty waiting list
    // with a full campaign is a healthy pipeline that has caught up.
    const stage = funnelHealth(facts({ eligibleToEmail: 0 })).stages.find((s) => s.key === "push")!;
    expect(stage.state).toBe("ok");
  });
});

describe("EVERY STUCK STAGE SAYS WHAT TO DO ABOUT IT", () => {
  it("names the switch when supply has run out and sourcing is off", () => {
    const h = funnelHealth(
      facts({
        awaitingEnrichment: 0,
        eligibleToEmail: 0,
        autoSourceEnabled: false,
        sentLast24h: 0,
        inCampaign: 0,
      })
    );
    const supply = h.stages.find((s) => s.key === "supply")!;
    expect(supply.state).toBe("stuck");
    expect(supply.fix).toMatch(/find more leads/i);
  });

  it("says to wait rather than to act when sourcing is already on", () => {
    const h = funnelHealth(
      facts({ awaitingEnrichment: 0, eligibleToEmail: 0, autoSourceEnabled: true })
    );
    expect(h.stages.find((s) => s.key === "supply")!.fix).toMatch(/within the hour/);
  });

  it("EVERY stuck stage carries a fix, always", () => {
    for (const f of [
      facts({ awaitingEnrichment: 0, eligibleToEmail: 0, autoSourceEnabled: false }),
      facts({ awaitingEnrichment: 40, autoReenrichEnabled: false }),
      facts({ programmeEnabled: false }),
      facts({ autoPushEnabled: false }),
      facts({ sentLast24h: 0 }),
      facts({ sentLast24h: 0, inCampaign: 0 }),
    ]) {
      for (const stage of funnelHealth(f).stages) {
        if (stage.state === "stuck") expect(stage.fix, stage.label).toBeTruthy();
      }
    }
  });

  it("says enrichment is free, because that is why it was left off", () => {
    const h = funnelHealth(facts({ awaitingEnrichment: 800, autoReenrichEnabled: false }));
    expect(h.stages.find((s) => s.key === "enrichment")!.fix).toMatch(/costs nothing/i);
  });
});

describe("it never claims to be sending when it is not", () => {
  it("no send in 24 hours is never 'flowing', whatever else looks fine", () => {
    const h = funnelHealth(facts({ sentLast24h: 0 }));
    expect(h.flowing).toBe(false);
  });

  it("distinguishes an empty campaign from a campaign that is not sending", () => {
    expect(
      funnelHealth(facts({ sentLast24h: 0, inCampaign: 0 })).stages.find((s) => s.key === "sending")!
        .detail
    ).toMatch(/campaign is empty/);
    expect(
      funnelHealth(facts({ sentLast24h: 0, inCampaign: 323 })).stages.find((s) => s.key === "sending")!
        .detail
    ).toMatch(/323 leads are in the campaign/);
  });
});
