// Keeping the inboxes busy.
//
// THE FAILURE THESE PROTECT AGAINST, stated once so the tests below read as
// what they are rather than as arithmetic exercises:
//
// Ten inboxes could carry 850–1,000 emails a day. Twenty-two went out, with 29
// qualified contacts sitting unpushed. Every switch was on, the worker ticked
// every minute, and every panel on the page was telling the truth. Three
// separate faults produced it and not one of them raised an error.
//
// Each describe below is one of those faults, or one of the properties that
// stops it coming back.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  sequenceSpanDays,
  sequenceIsFinished,
  computeDemand,
  planSupply,
  measuredYield,
  sourcingVolumeFor,
  pushBatchSize,
  SEQUENCE_COMPLETION_GRACE_DAYS,
  ASSUMED_YIELD,
  YIELD_SAMPLE_FLOOR,
  MIN_YIELD,
  MAX_YIELD,
  DEFAULT_RESERVE_DAYS,
  URGENT_COVER_DAYS,
  sourcingCeilingFor,
  ABSOLUTE_MAX_LEADS_PER_RUN,
  firstTouchCapacity,
  followUpsDueToday,
  cumulativeStepOffsets,
  type Demand,
  type SupplyFacts,
} from "../src/lib/supplyPlan";
import {
  skipReasonFor,
  stillEnrichable,
  countStillEnrichable,
  MAX_ENRICH_ATTEMPTS,
} from "../src/lib/reenrichPlan";
import { passesRecipientPolicy } from "../src/lib/emailEligibility";

/* -------------------------------------------------------------------------- */
/* the sequence, and how many leads it takes to keep it fed                    */
/* -------------------------------------------------------------------------- */

const fourStep = [
  { step: 1, delayDays: 0 },
  { step: 2, delayDays: 3 },
  { step: 3, delayDays: 4 },
  { step: 4, delayDays: 5 },
];

describe("how long a lead occupies the campaign", () => {
  it("adds up the waits, ignoring step one", () => {
    expect(sequenceSpanDays(fourStep)).toBe(12);
  });

  it("a single email spans no days", () => {
    expect(sequenceSpanDays([{ step: 1, delayDays: 0 }])).toBe(0);
  });

  it("survives a malformed step rather than producing NaN", () => {
    const span = sequenceSpanDays([
      { step: 1, delayDays: 0 },
      { step: 2, delayDays: NaN as unknown as number },
      { step: 3, delayDays: 4 },
    ]);
    expect(span).toBe(4);
  });
});

/*
 * FAULT 1 — THE ONE THAT STOPPED THE CAMPAIGN.
 *
 * There is no "finished the sequence" status and there cannot be one:
 * Instantly raises no event when a lead reaches the end without replying,
 * which is what happens to most of them. So a lead pushed in July, sent all
 * four emails and never heard from again kept the status `sent` forever, and
 * the count of "how full is the campaign" included it forever.
 */
describe("A FINISHED SEQUENCE STOPS HOLDING A SLOT", () => {
  const now = new Date("2026-08-13T00:00:00Z");
  const daysAgo = (n: number) =>
    new Date(now.getTime() - n * 86_400_000).toISOString();

  it("a lead pushed today is still in sequence", () => {
    expect(sequenceIsFinished(daysAgo(0), 12, now)).toBe(false);
  });

  it("a lead mid-sequence is still in sequence", () => {
    expect(sequenceIsFinished(daysAgo(8), 12, now)).toBe(false);
  });

  it("the grace period keeps it counted while Instantly may still be sending", () => {
    // 12-day sequence + 7 days of slack for weekends and holds.
    expect(sequenceIsFinished(daysAgo(12 + SEQUENCE_COMPLETION_GRACE_DAYS - 1), 12, now)).toBe(
      false
    );
  });

  it("PAST THAT IT IS FINISHED, and the slot is free", () => {
    expect(sequenceIsFinished(daysAgo(12 + SEQUENCE_COMPLETION_GRACE_DAYS + 1), 12, now)).toBe(
      true
    );
    // The July cohort that filled the campaign forever.
    expect(sequenceIsFinished(daysAgo(60), 12, now)).toBe(true);
  });

  it("an unknown or unparseable push date is never called finished", () => {
    // Under-filling is recoverable; pushing into an occupied slot is not.
    expect(sequenceIsFinished(null, 12, now)).toBe(false);
    expect(sequenceIsFinished("not a date", 12, now)).toBe(false);
  });

  it("the production count passes the span, or the bug is back", () => {
    const src = readFileSync(new URL("../src/lib/emailPush.ts", import.meta.url), "utf8");
    // The signature must take a span AND actually filter on it.
    expect(src).toMatch(/activeThreadCount\(\s*\n?\s*campaignId: string,\s*\n?\s*spanDays/);
    expect(src).toMatch(/SEQUENCE_COMPLETION_GRACE_DAYS/);
    expect(src).toMatch(/gte\("created_at", cutoff\)/);

    const handlers = readFileSync(
      new URL("../src/lib/jobHandlers.ts", import.meta.url),
      "utf8"
    );
    // The refill must pass it. Calling it bare restores the all-time count.
    expect(handlers).toMatch(/activeThreadCount\([^)]*shape\.spanDays\)/);
  });
});

/* -------------------------------------------------------------------------- */
/* the target, derived rather than typed in                                    */
/* -------------------------------------------------------------------------- */

describe("what the campaign will consume", () => {
  const demand = computeDemand({
    usableSends: 850,
    sequenceSteps: 4,
    spanDays: 12,
    reserveDays: 3,
  });

  it("intake is capacity divided by the emails each lead receives", () => {
    expect(demand.intakePerDay).toBe(212);
  });

  it("THE CAMPAIGN TARGET IS INTAKE TIMES THE SPAN, not a flat number", () => {
    // The number that was hard-coded at 200 while the true figure was 2,756.
    // Being short by an order of magnitude on this one value is what made the
    // top-up believe a stalled campaign was full.
    expect(demand.targetInCampaign).toBe(212 * 13);
    expect(demand.targetInCampaign).toBeGreaterThan(2000);
  });

  it("the reserve is intake times the days of cover wanted", () => {
    expect(demand.reserveTarget).toBe(212 * 3);
  });

  it("planned sends come back to the capacity it started from", () => {
    expect(demand.plannedSendsPerDay).toBeLessThanOrEqual(850);
    expect(demand.plannedSendsPerDay).toBeGreaterThan(800);
  });

  it("a one-step sequence needs one day of leads, not zero", () => {
    const d = computeDemand({
      usableSends: 100,
      sequenceSteps: 1,
      spanDays: 0,
      reserveDays: 3,
    });
    expect(d.intakePerDay).toBe(100);
    expect(d.targetInCampaign).toBe(100);
  });

  it("no capacity plans no intake rather than dividing by zero", () => {
    const d = computeDemand({ usableSends: 0, sequenceSteps: 4, spanDays: 12, reserveDays: 3 });
    expect(d.intakePerDay).toBe(0);
    expect(d.targetInCampaign).toBe(0);
    expect(d.reason).toMatch(/no usable sending capacity/i);
  });

  it("a nonsense reserve is clamped rather than becoming a nonsense spend", () => {
    expect(
      computeDemand({ usableSends: 400, sequenceSteps: 4, spanDays: 8, reserveDays: 900 })
        .reserveTarget
    ).toBeLessThanOrEqual(100 * 14);
    expect(
      computeDemand({ usableSends: 400, sequenceSteps: 4, spanDays: 8, reserveDays: -5 })
        .reserveTarget
    ).toBe(100);
  });
});

/* -------------------------------------------------------------------------- */
/* the supply decision                                                        */
/* -------------------------------------------------------------------------- */

const demand212: Demand = computeDemand({
  usableSends: 850,
  sequenceSteps: 4,
  spanDays: 12,
  reserveDays: 3,
});

const facts = (over: Partial<SupplyFacts> = {}): SupplyFacts => ({
  sourcingEnabled: true,
  demand: demand212,
  qualifiedReady: 29,
  enrichableNow: 0,
  enrichmentPerDay: 200,
  qualificationYield: 0.1,
  yieldIsMeasured: true,
  sourcingRunning: false,
  hoursSinceLastRun: null,
  minHoursBetweenRuns: 6,
  maxLeadsPerRun: 300,
  ...over,
});

/* 1. Low qualified reserve triggers enrichment and/or sourcing. */
describe("A LOW RESERVE MAKES SOMETHING HAPPEN", () => {
  it("29 contacts against 636 needed goes and sources", () => {
    // The exact state the system was in, doing nothing.
    const d = planSupply(facts());
    expect(d.act).toBe("source");
    expect(d.sourceCount).toBeGreaterThan(0);
    expect(d.shortfall).toBe(636 - 29);
  });

  it("enriches instead when the backlog can cover it in time", () => {
    const d = planSupply(
      facts({
        qualifiedReady: 600,
        enrichableNow: 2000, // 10% of 2000 = 200, more than the 36 short
        enrichmentPerDay: 2000,
      })
    );
    expect(d.act).toBe("enrich");
    expect(d.sourceCount).toBe(0);
  });

  it("SOURCES ANYWAY when the backlog cannot arrive in time", () => {
    /*
     * THE DEADLOCK. The old rule was "any lead awaiting enrichment blocks
     * sourcing", full stop — so 935 leads that would never yield a named
     * contact held the gate shut permanently and nothing was ever bought.
     */
    const d = planSupply(
      facts({
        qualifiedReady: 29,
        enrichableNow: 935,
        enrichmentPerDay: 200, // ~5 days to work, against 0.1 days of cover
      })
    );
    expect(d.act).toBe("source");
  });
});

/* 2. Generic / unnamed addresses do not falsely satisfy the reserve. */
describe("GENERIC AND UNNAMED CONTACTS ARE NOT SUPPLY", () => {
  it("the reserve is measured in contacts that pass the recipient rule", () => {
    const generic = { website_email: "info@acme.com", decision_maker_name: "Maria Diaz" };
    const nameless = { direct_email: "someone@acme.com" };
    const good = { direct_email: "maria@acme.com", decision_maker_name: "Maria Diaz" };
    expect(passesRecipientPolicy(generic)).toBe(false);
    expect(passesRecipientPolicy(nameless)).toBe(false);
    expect(passesRecipientPolicy(good)).toBe(true);
  });

  it("a thousand general inboxes still leaves the reserve short", () => {
    // qualifiedReady is fed by countEligible, which filters through
    // onlyNamedPeopleWeCanGreet. This asserts the decision behaves correctly
    // given that: the rejected ones simply never reach this number.
    const d = planSupply(facts({ qualifiedReady: 29 }));
    expect(d.act).toBe("source");
    expect(d.needsHuman).toBe(false); // routine — the system is replacing them
  });

  it("the count the worker reads is the policy-filtered one", () => {
    const store = readFileSync(new URL("../src/lib/funnelStore.ts", import.meta.url), "utf8");
    expect(store).toMatch(/qualifiedReady:\s*supply\.qualifiedReady/);
    expect(store).toMatch(/countEligible\(\)/);
  });
});

/* 3. Sourcing volume adapts to measured yield. */
describe("SOURCING VOLUME FOLLOWS THE MEASURED YIELD", () => {
  it("a 10% yield buys roughly ten times the gap, plus margin", () => {
    expect(sourcingVolumeFor(100, 0.1)).toBe(1250);
  });

  it("a 50% yield buys roughly twice", () => {
    expect(sourcingVolumeFor(100, 0.5)).toBe(250);
  });

  it("a worse yield buys more, a better yield buys less", () => {
    expect(sourcingVolumeFor(100, 0.05)).toBeGreaterThan(sourcingVolumeFor(100, 0.2));
  });

  it("nothing wanted buys nothing", () => {
    expect(sourcingVolumeFor(0, 0.1)).toBe(0);
    expect(sourcingVolumeFor(-5, 0.1)).toBe(0);
  });

  it("a zero or missing yield never demands an infinite purchase", () => {
    /*
     * Zero reaching here means "nobody has measured", not "nothing ever
     * qualifies" — measuredYield clamps a genuine zero to MIN_YIELD long
     * before this. So it falls back to the assumed rate, which buys LESS than
     * treating it as the worst possible yield would. Under-buying is the
     * recoverable direction.
     */
    expect(Number.isFinite(sourcingVolumeFor(100, 0))).toBe(true);
    expect(sourcingVolumeFor(100, 0)).toBe(sourcingVolumeFor(100, ASSUMED_YIELD));
    expect(sourcingVolumeFor(100, 0)).toBeLessThan(sourcingVolumeFor(100, MIN_YIELD));
    // And a measured zero really is treated as the floor.
    expect(measuredYield({ resolved: 500, qualified: 0 }).yield).toBe(MIN_YIELD);
  });

  it("MEASURED, not assumed, once there is a sample to believe", () => {
    const guess = measuredYield({ resolved: 10, qualified: 9 });
    expect(guess.measured).toBe(false);
    expect(guess.yield).toBe(ASSUMED_YIELD);

    const real = measuredYield({ resolved: YIELD_SAMPLE_FLOOR * 2, qualified: 20 });
    expect(real.measured).toBe(true);
    expect(real.yield).toBeCloseTo(0.2, 5);
  });

  it("a freak measurement cannot become a freak spend", () => {
    expect(measuredYield({ resolved: 1000, qualified: 0 }).yield).toBe(MIN_YIELD);
    expect(measuredYield({ resolved: 1000, qualified: 1000 }).yield).toBe(MAX_YIELD);
  });

  it("the decision actually scales the run by it", () => {
    const poor = planSupply(facts({ qualificationYield: 0.05, maxLeadsPerRun: 100000 }));
    const good = planSupply(facts({ qualificationYield: 0.5, maxLeadsPerRun: 100000 }));
    expect(poor.sourceCount).toBeGreaterThan(good.sourceCount);
  });
});

/* 4. Adequate reserve stops unnecessary purchasing. */
describe("A FULL RESERVE BUYS NOTHING", () => {
  it("holds once the reserve is met", () => {
    const d = planSupply(facts({ qualifiedReady: demand212.reserveTarget }));
    expect(d.act).toBe("hold");
    expect(d.sourceCount).toBe(0);
    expect(d.shortfall).toBe(0);
    expect(d.needsHuman).toBe(false);
  });

  it("holds when well over, rather than topping up for the sake of it", () => {
    const d = planSupply(facts({ qualifiedReady: demand212.reserveTarget * 5 }));
    expect(d.act).toBe("hold");
    expect(d.sourceCount).toBe(0);
  });

  it("one contact below the target does act", () => {
    const d = planSupply(facts({ qualifiedReady: demand212.reserveTarget - 1 }));
    expect(d.act).toBe("source");
  });
});

/* 5. Concurrent workers cannot duplicate purchases or pushes. */
describe("CONCURRENT WORKERS CANNOT DOUBLE-SPEND", () => {
  it("a run already going stops a second being started", () => {
    const d = planSupply(facts({ sourcingRunning: true }));
    expect(d.act).toBe("hold");
    expect(d.sourceCount).toBe(0);
  });

  it("an unreadable running-state is treated as running", () => {
    const store = readFileSync(new URL("../src/lib/funnelStore.ts", import.meta.url), "utf8");
    expect(store).toMatch(/sourcingIsRunning\(\)\.catch\(\(\) => true\)/);
  });

  it("the spacing rule stops a burst of runs within the cooldown", () => {
    /*
     * With cover in hand. The spacing yields when there is under a day of
     * contacts left — see "THE SPACING YIELDS WHEN THE CAMPAIGN IS ABOUT TO
     * RUN DRY" below — because the next sending window would otherwise open
     * before the next run does. Short of a day's contacts the six hours
     * still apply, and this is the case that proves it.
     */
    const d = planSupply(
      facts({ qualifiedReady: 400, hoursSinceLastRun: 1, minHoursBetweenRuns: 6 })
    );
    expect(d.act).toBe("hold");
    expect(d.reason).toMatch(/6h apart|spaced/i);
  });

  it("the refill is enqueued under a per-minute idempotency key", () => {
    const tick = readFileSync(
      new URL("../src/app/api/worker/tick/route.ts", import.meta.url),
      "utf8"
    );
    expect(tick).toMatch(/refill_email_campaign:\$\{new Date\(\)\.toISOString\(\)\.slice\(0, 16\)\}/);
    // And the sourcing check is hourly, not per tick.
    expect(tick).toMatch(/keep_funnel_full:\$\{new Date\(\)\.toISOString\(\)\.slice\(0, 13\)\}/);
  });

  it("the attempt counter increments inside the row lock, not read-then-write", () => {
    // Two workers enriching at the same moment must not both write "1".
    const sql = readFileSync(
      new URL("../supabase/migrations/0044_demand_driven_supply.sql", import.meta.url),
      "utf8"
    );
    expect(sql).toMatch(/create or replace function increment_enrich_attempts/i);
    expect(sql).toMatch(/enrich_attempts = coalesce\(enrich_attempts, 0\) \+ 1/i);
  });
});

/* 6. General inboxes and nameless contacts can never be pushed. */
describe("THE RECIPIENT RULE SURVIVES ALL OF THIS", () => {
  const push = readFileSync(new URL("../src/lib/emailPush.ts", import.meta.url), "utf8");

  it("the push still filters unconditionally", () => {
    expect(push).toMatch(/onlyNamedPeopleWeCanGreet\(eligible\)/);
    expect(push).toMatch(/return onlyNamedPeopleWeCanGreet\(usable\)\.length/);
  });

  it("no setting introduced here can switch it off", () => {
    expect(push).not.toMatch(/settings\.named_people_only/);
    expect(push).not.toMatch(/settings\.require_named_person/);
    expect(push).not.toMatch(/auto_scale_supply[\s\S]*onlyNamed/);
  });

  it("scaling supply is a separate switch from who may be emailed", () => {
    const handlers = readFileSync(
      new URL("../src/lib/jobHandlers.ts", import.meta.url),
      "utf8"
    );
    // auto_scale_supply may only ever move the TARGET, never the filter.
    const scaleUse = handlers.match(/auto_scale_supply[^\n]*/g) || [];
    expect(scaleUse.length).toBeGreaterThan(0);
    for (const line of scaleUse) {
      expect(line).not.toMatch(/named|greet|recipient/i);
    }
  });
});

/* 7. Failed enrichment is retried, then replaced, without blocking forever. */
describe("ENRICHMENT GIVES UP AND THE FUNNEL MOVES ON", () => {
  const site = { id: "l1", website: "acme.com", business_name: "Acme" };

  it("a fresh lead is retried", () => {
    expect(skipReasonFor({ ...site, enrich_attempts: 0 })).toBeNull();
    expect(skipReasonFor({ ...site, enrich_attempts: MAX_ENRICH_ATTEMPTS - 1 })).toBeNull();
  });

  it("PAST THE CEILING IT IS LEFT ALONE", () => {
    expect(skipReasonFor({ ...site, enrich_attempts: MAX_ENRICH_ATTEMPTS })).toBe(
      "Enrichment has been tried enough"
    );
    expect(skipReasonFor({ ...site, enrich_attempts: 99 })).toBe(
      "Enrichment has been tried enough"
    );
  });

  it("a lead given up on is not counted as outstanding work", () => {
    // The whole deadlock in one assertion: this number reaching zero is what
    // lets sourcing run, and it could never reach zero before.
    const leads = [
      { ...site, enrich_attempts: 0 },
      { ...site, enrich_attempts: MAX_ENRICH_ATTEMPTS },
      { ...site, enrich_attempts: MAX_ENRICH_ATTEMPTS + 5 },
    ];
    expect(countStillEnrichable(leads)).toBe(1);
  });

  it("a lead with no website is never counted as workable", () => {
    // A free crawl cannot read an address off a site that does not exist.
    expect(stillEnrichable({ id: "l2", business_name: "Acme", enrich_attempts: 0 })).toBe(false);
  });

  it("a lead that already has everything is not work either", () => {
    expect(
      stillEnrichable({
        ...site,
        direct_email: "maria@acme.com",
        decision_maker_name: "Maria Diaz",
        diagnostic_findings: [{ x: 1 }],
      })
    ).toBe(false);
  });

  it("suppression still outranks all of it", () => {
    expect(skipReasonFor({ ...site, do_not_call: true })).toBe("On the do-not-call list");
    expect(skipReasonFor({ ...site, archived_at: "2026-01-01" })).toBe("Binned");
  });

  it("an unrun 0044 reads as never tried, which is the old safe behaviour", () => {
    expect(skipReasonFor({ ...site })).toBeNull();
  });

  it("the attempt is counted before the crawl, not after a clean finish", () => {
    // Counting only successes lets a site that always times out retry forever.
    const handlers = readFileSync(
      new URL("../src/lib/jobHandlers.ts", import.meta.url),
      "utf8"
    );
    const enrich = handlers.slice(handlers.indexOf("const enrichLead: Handler"));
    const bump = enrich.indexOf("increment_enrich_attempts");
    expect(bump).toBeGreaterThan(-1);
    expect(bump).toBeLessThan(enrich.indexOf("enrichLeadForOwner"));
  });
});

/* 8. Automatic pushing works without the manual button. */
describe("PUSHING IS AUTOMATIC", () => {
  it("sizes a batch from the target, the day's intake and what is ready", () => {
    const b = pushBatchSize({
      activeInCampaign: 400,
      targetInCampaign: 2756,
      qualifiedReady: 500,
      firstTouchAllowed: 212,
      pushedToday: 0,
      maxPerRun: 50,
    });
    expect(b.count).toBe(50);
  });

  it("THE OLD STALL IS GONE: a full-looking campaign of finished leads still pushes", () => {
    // 323 all-time threads against the old target of 200 returned zero forever.
    // With finished sequences excluded the same campaign has room.
    const b = pushBatchSize({
      activeInCampaign: 323,
      targetInCampaign: 2756,
      qualifiedReady: 29,
      firstTouchAllowed: 212,
      pushedToday: 0,
      maxPerRun: 50,
    });
    expect(b.count).toBe(29);
  });

  it("still refuses to push blind", () => {
    const b = pushBatchSize({
      activeInCampaign: null,
      targetInCampaign: 2756,
      qualifiedReady: 500,
      firstTouchAllowed: 212,
      pushedToday: 0,
      maxPerRun: 50,
    });
    expect(b.count).toBe(0);
    expect(b.reason).toMatch(/double-fill/i);
  });

  it("stops when the day's capacity is committed", () => {
    /*
     * firstTouchAllowed is already net of today's sends and the follow-ups
     * still due — see firstTouchCapacity — so a spent day arrives here as
     * zero rather than as a separate counter to subtract. Deducting
     * pushedToday here as well would charge every push twice.
     */
    const b = pushBatchSize({
      activeInCampaign: 100,
      targetInCampaign: 2756,
      qualifiedReady: 500,
      firstTouchAllowed: 0,
      pushedToday: 212,
      maxPerRun: 50,
    });
    expect(b.count).toBe(0);
    expect(b.reason).toMatch(/fully committed|queue into tomorrow/i);
  });

  it("the worker enqueues the push itself, no button involved", () => {
    const tick = readFileSync(
      new URL("../src/app/api/worker/tick/route.ts", import.meta.url),
      "utf8"
    );
    expect(tick).toMatch(/type: "refill_email_campaign"/);
    const page = readFileSync(
      new URL("../src/app/(admin)/admin/email/page.tsx", import.meta.url),
      "utf8"
    );
    // The manual control is still there, but demoted out of the normal view.
    expect(page).toMatch(/Push by hand/);
    expect(page).toMatch(/Not needed for normal running/);
  });

  it("the refill computes its target instead of reading a stored 200", () => {
    const handlers = readFileSync(
      new URL("../src/lib/jobHandlers.ts", import.meta.url),
      "utf8"
    );
    expect(handlers).toMatch(/computeDemand\(/);
    expect(handlers).toMatch(/targetActive = scale \? demand\.targetInCampaign/);
    /*
     * The daily cap deliberately NO LONGER comes from demand.intakePerDay.
     * That was the forecast being used as a ceiling, and it threw away every
     * send the follow-up load did not claim. See "THE FORECAST STILL COUNTS
     * EVERY SEQUENCE STEP" for the assertions that replaced this one.
     */
    expect(handlers).toMatch(/dailyCap = todayCapacity \? todayCapacity\.firstTouchAllowed/);
  });
});

/* 9. Capacity utilisation uses actual sent data. */
describe("UTILISATION IS MEASURED, CAPACITY IS ESTIMATED", () => {
  const route = readFileSync(
    new URL("../src/app/api/funnel/route.ts", import.meta.url),
    "utf8"
  );

  it("the numerator is the reconciled send count, not a projection", () => {
    expect(route).toMatch(/utilisation = capacity > 0 \? Math\.min\(1, sent \/ capacity\)/);
    // `sent` is the webhook count reconciled with Instantly's own ledger.
    expect(route).toMatch(/Math\.max\(sent, ledger\.sent\)/);
    expect(route).toMatch(/sentLast24h: sent/);
  });

  it("capacity is labelled an estimate, because it is one", () => {
    expect(route).toMatch(/capacityIsEstimate: true/);
    const page = readFileSync(
      new URL("../src/app/(admin)/admin/email/page.tsx", import.meta.url),
      "utf8"
    );
    expect(page).toMatch(/estimated to carry/);
  });

  it("no capacity means no utilisation figure rather than a fake 0%", () => {
    expect(route).toMatch(/capacity > 0 \? Math\.min\(1, sent \/ capacity\) : null/);
  });
});

/* 10. Routine rejections do not raise a false red warning. */
describe("ROUTINE FILTERING IS NOT AN ALARM", () => {
  it("being short of the reserve is not a human problem while it can self-correct", () => {
    const d = planSupply(facts({ qualifiedReady: 0 }));
    expect(d.act).toBe("source");
    expect(d.needsHuman).toBe(false);
  });

  it("nor is a backlog of unusable leads", () => {
    const d = planSupply(facts({ enrichableNow: 935, qualifiedReady: 10 }));
    expect(d.needsHuman).toBe(false);
  });

  it("nor is a run already in progress", () => {
    expect(planSupply(facts({ sourcingRunning: true })).needsHuman).toBe(false);
  });

  it("the page reserves its banner for the same set", () => {
    const page = readFileSync(
      new URL("../src/app/(admin)/admin/email/page.tsx", import.meta.url),
      "utf8"
    );
    const start = page.indexOf("const supplyBlocker");
    const block = page.slice(start, start + 1600);
    // Nothing about generic inboxes or missing names may raise the banner.
    expect(block).not.toMatch(/generic|info@|unnamed|no name/i);
    expect(block).toMatch(/null/);
  });
});

/* 11. A real provider, schedule, credit or worker failure warns clearly. */
describe("A REAL BLOCKER IS NAMED EXACTLY", () => {
  it("no capacity is a human problem, and says what to check", () => {
    const d = planSupply(
      facts({
        demand: computeDemand({
          usableSends: 0,
          sequenceSteps: 4,
          spanDays: 12,
          reserveDays: 3,
        }),
      })
    );
    expect(d.needsHuman).toBe(true);
    expect(d.reason).toMatch(/sending accounts|daily limit/i);
  });

  it("short with sourcing switched off is a human problem", () => {
    const d = planSupply(facts({ sourcingEnabled: false, qualifiedReady: 5 }));
    expect(d.needsHuman).toBe(true);
    expect(d.reason).toMatch(/switched off/i);
  });

  it("covered with sourcing off is NOT a problem", () => {
    const d = planSupply(
      facts({ sourcingEnabled: false, qualifiedReady: demand212.reserveTarget })
    );
    expect(d.needsHuman).toBe(false);
  });

  it("a missing Places key names the variable rather than giving advice", () => {
    const store = readFileSync(new URL("../src/lib/funnelStore.ts", import.meta.url), "utf8");
    expect(store).toMatch(/GOOGLE_PLACES_API_KEY is not set/);
  });

  it("an exhausted search grid says what to widen", () => {
    const store = readFileSync(new URL("../src/lib/funnelStore.ts", import.meta.url), "utf8");
    expect(store).toMatch(/Add more trades or metros/);
  });

  it("the page names the exact env var and where to set it", () => {
    const page = readFileSync(
      new URL("../src/app/(admin)/admin/email/page.tsx", import.meta.url),
      "utf8"
    );
    expect(page).toMatch(/INSTANTLY_API_KEY in Vercel/);
  });
});

/* 12. Existing sent-email history is never rewritten. */
describe("EMAIL HISTORY IS NEVER REWRITTEN", () => {
  it("0044 does not touch email_threads at all", () => {
    const sql = readFileSync(
      new URL("../supabase/migrations/0044_demand_driven_supply.sql", import.meta.url),
      "utf8"
    );
    expect(sql).not.toMatch(/(update|delete\s+from|alter\s+table|truncate)\s+email_threads/i);
    expect(sql).not.toMatch(/(update|delete\s+from|truncate)\s+email_events/i);
  });

  it("0043 did not either, and still does not", () => {
    const sql = readFileSync(
      new URL("../supabase/migrations/0043_dm_only_email_policy.sql", import.meta.url),
      "utf8"
    );
    expect(sql).not.toMatch(/(update|delete\s+from|alter\s+table)\s+email_threads/i);
  });

  it("FINISHED IS COMPUTED AT READ TIME, never written into the row", () => {
    // The whole point: a completed sequence stops being counted without its
    // status, its timestamps or its history being altered.
    const push = readFileSync(new URL("../src/lib/emailPush.ts", import.meta.url), "utf8");
    const fn = push.slice(
      push.indexOf("export async function activeThreadCount"),
      push.indexOf("export async function completedThreadCount")
    );
    expect(fn).toMatch(/select\(/);
    expect(fn).not.toMatch(/\.update\(|\.delete\(|\.upsert\(/);
  });

  it("the reserve default is the documented one", () => {
    expect(DEFAULT_RESERVE_DAYS).toBe(3);
  });
});

/*
 * FEEDING THE DEMAND THE SYSTEM ALREADY CALCULATED CORRECTLY.
 *
 * computeDemand asked for 212 leads a day. Sourcing could deliver 120 at a 10%
 * yield — four runs a day at six-hour spacing, 300 leads each — so the supply
 * system was structurally incapable of meeting its own target and would have
 * sat permanently short however well every other part worked. Two ceilings did
 * it: the size of a run, and the gap between runs.
 */
describe("SOURCING CAN ACTUALLY REACH THE DAILY INTAKE", () => {
  it("a run is sized against what a day consumes, not a stored 300", () => {
    // 212 a day at the assumed 10% needs 2,120 businesses to be worth starting.
    expect(sourcingCeilingFor(300, 212)).toBe(2120);
  });

  it("the operator's larger figure still wins", () => {
    expect(sourcingCeilingFor(5000, 212)).toBe(3000); // but never past the hard cap
    expect(sourcingCeilingFor(2500, 100)).toBe(2500);
  });

  it("a hard ceiling survives any arithmetic", () => {
    expect(sourcingCeilingFor(300, 999_999)).toBe(ABSOLUTE_MAX_LEADS_PER_RUN);
    expect(sourcingCeilingFor(300, -5)).toBe(300);
  });

  it("the old ceiling could not have fed the demand, and the new one can", () => {
    const runsPerDay = 4;
    const yieldRate = 0.1;
    expect(300 * runsPerDay * yieldRate).toBeLessThan(212); // the bug
    expect(sourcingCeilingFor(300, 212) * yieldRate).toBeGreaterThanOrEqual(212);
  });
});

describe("THE SPACING YIELDS WHEN THE CAMPAIGN IS ABOUT TO RUN DRY", () => {
  const nearlyDry = facts({
    qualifiedReady: 20, // 0.09 days of cover at 212/day
    hoursSinceLastRun: 1,
    minHoursBetweenRuns: 6,
  });

  it("under a day of cover sources now rather than waiting for the window", () => {
    const d = planSupply(nearlyDry);
    expect(d.act).toBe("source");
    expect(d.daysOfCover).toBeLessThan(URGENT_COVER_DAYS);
  });

  it("with cover in hand the spacing still applies", () => {
    const d = planSupply(
      facts({ qualifiedReady: 400, hoursSinceLastRun: 1, minHoursBetweenRuns: 6 })
    );
    expect(d.act).toBe("hold");
    expect(d.reason).toMatch(/spaced|apart/i);
  });

  it("THE CONCURRENCY LOCK IS NEVER RELAXED, however urgent", () => {
    /*
     * The distinction the whole change rests on. Two runs closer together than
     * usual buy the same leads SOONER. Two runs at the same time buy them
     * TWICE. Only the second is a real risk, and urgency must never touch it.
     */
    const d = planSupply({ ...nearlyDry, sourcingRunning: true });
    expect(d.act).toBe("hold");
    expect(d.sourceCount).toBe(0);
    expect(d.reason).toMatch(/already going|twice/i);
  });

  it("urgency never overrides the switch, the capacity check or the reserve", () => {
    // Off stays off.
    expect(planSupply({ ...nearlyDry, sourcingEnabled: false }).act).toBe("hold");
    // No capacity stays no capacity.
    expect(
      planSupply({
        ...nearlyDry,
        demand: computeDemand({
          usableSends: 0,
          sequenceSteps: 4,
          spanDays: 12,
          reserveDays: 3,
        }),
      }).act
    ).toBe("hold");
    // And a covered reserve is still not urgent.
    expect(planSupply(facts({ qualifiedReady: demand212.reserveTarget })).act).toBe("hold");
  });
});

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CORRECTION: capacity ÷ steps IS A FORECAST, NOT A DISPATCH CAP.
 *
 * It was used as a hard daily ceiling on pushing. With 850 sends and a
 * four-step sequence that allowed 212 new leads a day on the reasoning that
 * the other 638 are follow-ups — reasoning that only holds once the pipeline
 * is full. On a real day with 250 follow-ups due, 600 first touches could have
 * gone out and 212 were allowed. Roughly 400 sends of paid, warmed capacity
 * thrown away daily by arithmetic that was never about today.
 * ─────────────────────────────────────────────────────────────────────────────
 */
describe("TODAY'S FIRST-TOUCH CAPACITY IS WHAT IS ACTUALLY LEFT", () => {
  const day = (followUpsDue: number, alreadySentToday = 0) =>
    firstTouchCapacity({ usableToday: 850, followUpsDue, alreadySentToday });

  /* 1-4: the four cases stated in the brief. */
  it("850 capacity, 250 follow-ups -> 600 first touches", () => {
    expect(day(250).firstTouchAllowed).toBe(600);
  });

  it("850 capacity, 450 follow-ups -> 400 first touches", () => {
    expect(day(450).firstTouchAllowed).toBe(400);
  });

  it("850 capacity, 650 follow-ups -> 200 first touches", () => {
    expect(day(650).firstTouchAllowed).toBe(200);
  });

  it("850 capacity, NO follow-ups -> 850 first touches, not 212", () => {
    // The whole point. The old model allowed 212 on this day and discarded 638.
    expect(day(0).firstTouchAllowed).toBe(850);
    expect(day(0).firstTouchAllowed).not.toBe(212);
  });

  /* 5: already-sent reduces what is left. */
  it("emails already sent today come off the top", () => {
    // 300 sent, of which 300 were follow-ups (none pushed today), against a
    // 250-follow-up day: the day's follow-up load is already covered.
    const c = firstTouchCapacity({
      usableToday: 850,
      followUpsDue: 250,
      alreadySentToday: 300,
      firstTouchesSentToday: 0,
    });
    expect(c.firstTouchAllowed).toBe(550);
  });

  it("DOES NOT DOUBLE-COUNT follow-ups already sent this morning", () => {
    /*
     * The subtle one. By 2pm with 250 follow-ups due and 200 of them out,
     * naively subtracting both the day's follow-up load AND everything sent
     * deducts 450 from 850 and needlessly starves the afternoon. Only the 50
     * still to come should be reserved.
     */
    const c = firstTouchCapacity({
      usableToday: 850,
      followUpsDue: 250,
      alreadySentToday: 200,
      firstTouchesSentToday: 0,
    });
    expect(c.firstTouchAllowed).toBe(600); // 850 - 200 sent - 50 still due
    expect(c.firstTouchAllowed).not.toBe(400); // the double-counted answer
  });

  it("separates first touches already pushed today from follow-ups", () => {
    // 300 sent today of which 100 were our pushes, so 200 were follow-ups.
    // 250 due means 50 left to reserve.
    const c = firstTouchCapacity({
      usableToday: 850,
      followUpsDue: 250,
      alreadySentToday: 300,
      firstTouchesSentToday: 100,
    });
    expect(c.firstTouchAllowed).toBe(500); // 850 - 300 - 50
  });

  /* 6: never exceeds the real limit. */
  it("NEVER EXCEEDS THE DAY'S REAL CAPACITY, whatever the inputs", () => {
    for (const [cap, fu, sent] of [
      [850, 0, 0],
      [850, 900, 0],
      [850, 250, 900],
      [0, 0, 0],
      [100, 50, 60],
    ] as [number, number, number][]) {
      const c = firstTouchCapacity({
        usableToday: cap,
        followUpsDue: fu,
        alreadySentToday: sent,
      });
      expect(c.firstTouchAllowed).toBeGreaterThanOrEqual(0);
      expect(c.firstTouchAllowed + sent).toBeLessThanOrEqual(Math.max(cap, sent));
    }
  });

  it("a day already fully spent allows nothing more", () => {
    expect(
      firstTouchCapacity({ usableToday: 850, followUpsDue: 0, alreadySentToday: 850 })
        .firstTouchAllowed
    ).toBe(0);
    expect(
      firstTouchCapacity({ usableToday: 850, followUpsDue: 850, alreadySentToday: 0 })
        .firstTouchAllowed
    ).toBe(0);
  });

  it("reports expected unused capacity and names its cause", () => {
    const c = firstTouchCapacity({
      usableToday: 850,
      followUpsDue: 250,
      alreadySentToday: 0,
      qualifiedReady: 100,
    });
    expect(c.firstTouchAllowed).toBe(600);
    expect(c.expectedUnused).toBe(500);
    expect(c.unusedCause).toMatch(/only 100 qualified/i);
  });

  it("no unused capacity reported when contacts cover the day", () => {
    const c = firstTouchCapacity({
      usableToday: 850,
      followUpsDue: 250,
      alreadySentToday: 0,
      qualifiedReady: 900,
    });
    expect(c.expectedUnused).toBe(0);
    expect(c.unusedCause).toBeNull();
  });
});

describe("HOW MANY FOLLOW-UPS ARE REALLY DUE TODAY", () => {
  const offsets = cumulativeStepOffsets(fourStep); // [0, 3, 7, 12]
  const now = new Date("2026-08-14T12:00:00Z");
  const pushedDaysAgo = (n: number) =>
    new Date(Date.UTC(2026, 7, 14 - n, 9, 0, 0)).toISOString();

  it("works out which day each step lands on", () => {
    expect(offsets).toEqual([0, 3, 7, 12]);
  });

  it("counts only leads whose step falls today", () => {
    const threads = [
      { pushedAt: pushedDaysAgo(3), status: "sent" }, // step 2 due
      { pushedAt: pushedDaysAgo(7), status: "sent" }, // step 3 due
      { pushedAt: pushedDaysAgo(12), status: "opened" }, // step 4 due
      { pushedAt: pushedDaysAgo(5), status: "sent" }, // nothing due
      { pushedAt: pushedDaysAgo(1), status: "sent" }, // nothing due
    ];
    expect(followUpsDueToday(threads, offsets, now).due).toBe(3);
  });

  it("DOES NOT ASSUME EVERY ACTIVE LEAD HAS ONE DUE TODAY", () => {
    // The lazy approximation this replaces. 100 leads mid-sequence produce a
    // handful of follow-ups on any given day, not 100.
    const threads = Array.from({ length: 100 }, (_, i) => ({
      pushedAt: pushedDaysAgo((i % 11) + 1),
      status: "sent",
    }));
    const due = followUpsDueToday(threads, offsets, now).due;
    expect(due).toBeGreaterThan(0);
    expect(due).toBeLessThan(30);
  });

  it("a lead pushed today counts as a first touch, never a follow-up", () => {
    expect(
      followUpsDueToday([{ pushedAt: pushedDaysAgo(0), status: "pushed" }], offsets, now).due
    ).toBe(0);
  });

  it("an ended thread sends nothing further", () => {
    for (const status of ["replied", "bounced", "unsubscribed", "failed"]) {
      expect(
        followUpsDueToday([{ pushedAt: pushedDaysAgo(3), status }], offsets, now).due
      ).toBe(0);
    }
  });

  it("EXPOSES ITS CONFIDENCE AND ITS LIMITATION, rather than pretending", () => {
    const e = followUpsDueToday(
      [{ pushedAt: pushedDaysAgo(3), status: "sent" }],
      offsets,
      now
    );
    expect(e.confidence).toBe("measured");
    expect(e.caveat).toMatch(/schedule|drift|later/i);
  });

  it("a sequence with no follow-up steps claims nothing", () => {
    const e = followUpsDueToday(
      [{ pushedAt: pushedDaysAgo(3), status: "sent" }],
      [0],
      now
    );
    expect(e.due).toBe(0);
    expect(e.caveat).toMatch(/no follow-up steps/i);
  });

  it("NEVER SILENTLY FALLS BACK TO capacity ÷ 4", () => {
    // An unreadable sequence claims no follow-ups, so the day's whole capacity
    // goes to first touches — the opposite of the old guess, and the honest
    // answer given Instantly exposes no "scheduled today" endpoint.
    const e = followUpsDueToday([], [], now);
    expect(e.due).toBe(0);
    expect(e.confidence).toBe("unknown");

    const src = readFileSync(new URL("../src/lib/supplyPlan.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("export function followUpsDueToday"));
    expect(fn.slice(0, 2000)).not.toMatch(/\/\s*4|\/\s*steps|intakePerDay/);
  });
});

/* 7: long-term forecasting still accounts for every step. */
describe("THE FORECAST STILL COUNTS EVERY SEQUENCE STEP", () => {
  it("reserve planning still divides by the steps", () => {
    const d = computeDemand({
      usableSends: 850,
      sequenceSteps: 4,
      spanDays: 12,
      reserveDays: 3,
    });
    expect(d.intakePerDay).toBe(212);
    expect(d.reserveTarget).toBe(636);
    expect(d.targetInCampaign).toBe(2756);
  });

  it("but that number is labelled a forecast, not a cap", () => {
    const src = readFileSync(new URL("../src/lib/supplyPlan.ts", import.meta.url), "utf8");
    expect(src).toMatch(/STEADY-STATE PLANNING ONLY\. NOT A DAILY DISPATCH CAP/);
  });

  it("THE PUSH NO LONGER READS IT AS A CEILING", () => {
    const handlers = readFileSync(
      new URL("../src/lib/jobHandlers.ts", import.meta.url),
      "utf8"
    );
    // The cap must come from firstTouchCapacity, not from the forecast.
    expect(handlers).toMatch(/firstTouchCapacity\(/);
    expect(handlers).toMatch(/dailyCap = todayCapacity \? todayCapacity\.firstTouchAllowed/);
    expect(handlers).not.toMatch(/dailyCap = scale \? demand\.intakePerDay/);
  });

  it("and the page says so in as many words", () => {
    const page = readFileSync(
      new URL("../src/app/(admin)/admin/email/page.tsx", import.meta.url),
      "utf8"
    );
    expect(page).toMatch(/long-term planning estimate only/i);
    expect(page).toMatch(/It is not a daily limit/);
    expect(page).toMatch(/First touches left/);
    expect(page).toMatch(/Follow-ups due today/);
  });
});

/* 8: the protections that must survive all of this. */
describe("THE PROTECTIONS SURVIVE THE CORRECTION", () => {
  const push = readFileSync(new URL("../src/lib/emailPush.ts", import.meta.url), "utf8");
  const handlers = readFileSync(
    new URL("../src/lib/jobHandlers.ts", import.meta.url),
    "utf8"
  );

  it("recipient rule still unconditional", () => {
    expect(push).toMatch(/onlyNamedPeopleWeCanGreet\(eligible\)/);
    expect(push).toMatch(/return onlyNamedPeopleWeCanGreet\(usable\)\.length/);
    expect(push).not.toMatch(/settings\.named_people_only/);
  });

  it("suppression still checked before anything is pushed", () => {
    expect(push).toMatch(/emailUnavailableReason/);
  });

  it("deduplication still excludes leads already in a campaign", () => {
    expect(push).toMatch(/canRepush\(t\.status/);
  });

  it("the per-tick idempotency key is unchanged", () => {
    const tick = readFileSync(
      new URL("../src/app/api/worker/tick/route.ts", import.meta.url),
      "utf8"
    );
    expect(tick).toMatch(/refill_email_campaign:\$\{new Date\(\)\.toISOString\(\)\.slice\(0, 16\)\}/);
  });

  it("today's send count is reconciled with Instantly rather than trusted blind", () => {
    // A missed webhook reading as zero would hand the whole day to first
    // touches that Instantly has already spent, and overrun the campaign limit.
    expect(handlers).toMatch(/sentToday = Math\.max\(sentToday, ledger\.sent\)/);
  });

  it("pushedToday is not deducted twice", () => {
    // firstTouchCapacity already subtracts today's sends.
    expect(handlers).toMatch(/pushedToday: todayCapacity \? 0 : pushedToday/);
  });
});
