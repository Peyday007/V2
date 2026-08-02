// The report that says whether the enrichment is worth its bill.
//
// The figure that matters is owner conversations per 100 calls to enriched
// records. The tests below are mostly about the ways that figure can be made
// to lie: an empty denominator reading as zero rather than "no data", failed
// lookups falling out of a cost average, an optimistic button inflating the
// owner count, and a verdict declared off a dozen calls.

import { describe, it, expect } from "vitest";
import {
  buildFunnel,
  buildCost,
  buildCallOutcomes,
  buildSplit,
  buildAccuracy,
  buildByGrade,
  buildByNumberType,
  buildByProvider,
  buildEnrichmentReport,
  reachedOwner,
  reachedLivePerson,
  per100,
  pct,
  costPer,
  MIN_CALLS_FOR_A_VERDICT,
  MIN_LOOKUPS_TO_JUDGE_PROVIDER,
  type LeadFact,
  type CallFactForReport,
  type AttemptFact,
  type FeedbackFact,
} from "../src/lib/enrichmentReport";

const lead = (o: Partial<LeadFact> & { id: string }): LeadFact => ({ ...o });
const call = (o: Partial<CallFactForReport> & { outcome: string }): CallFactForReport => ({ ...o });

describe("rates with nothing in the denominator", () => {
  it("REPORTS NULL, NOT ZERO — no data and a zero rate are different answers", () => {
    expect(per100(0, 0)).toBeNull();
    expect(pct(0, 0)).toBeNull();
    expect(costPer(500, 0)).toBeNull();
  });

  it("computes the ordinary case", () => {
    expect(per100(6, 111)).toBeCloseTo(5.405);
    expect(pct(3, 4)).toBe(0.75);
    expect(costPer(500, 5)).toBe(100);
  });
});

describe("who was actually reached", () => {
  it("trusts the recorded decision-maker flag", () => {
    expect(reachedOwner(call({ outcome: "dm_conversation", reached_dm: true }))).toBe(true);
  });

  it("falls back to the role for older rows", () => {
    expect(reachedOwner(call({ outcome: "callback", spoke_with_role: "owner" }))).toBe(true);
  });

  it("AN OUTCOME BUTTON ALONE IS NOT AN OWNER CONVERSATION", () => {
    // dm_conversation is a chip a caller can press optimistically. Counting it
    // would inflate the one number this whole feature is judged on.
    expect(reachedOwner(call({ outcome: "dm_conversation" }))).toBe(false);
    expect(reachedOwner(call({ outcome: "dm_conversation", reached_dm: false }))).toBe(false);
  });

  it("knows a live answer from a dead line", () => {
    expect(reachedLivePerson(call({ outcome: "gatekeeper" }))).toBe(true);
    expect(reachedLivePerson(call({ outcome: "no_answer" }))).toBe(false);
    expect(reachedLivePerson(call({ outcome: "voicemail" }))).toBe(false);
    expect(reachedLivePerson(call({ outcome: "bad_number" }))).toBe(false);
  });
});

describe("the funnel", () => {
  const leads: LeadFact[] = [
    lead({
      id: "a",
      decision_maker_name: "Maria Rivera",
      direct_phone: "+13134820199",
      direct_phone_class: "verified_owner_mobile",
      enrichment_grade: "A",
    }),
    lead({
      id: "b",
      decision_maker_name: "Tom Ash",
      direct_phone: "+13134820177",
      direct_phone_class: "probable_owner_direct",
      enrichment_grade: "B",
    }),
    lead({
      id: "c",
      decision_maker_name: "Dana Fletcher",
      direct_phone: "+13134820100",
      direct_phone_class: "main_business_line",
      enrichment_grade: "C",
    }),
    lead({ id: "d", enrichment_grade: "D" }),
  ];

  it("counts each stage", () => {
    const f = buildFunnel(leads);
    expect(f.businessesCollected).toBe(4);
    expect(f.ownersIdentified).toBe(3);
    expect(f.directNumbersFound).toBe(2);
    expect(f.verifiedDirectNumbers).toBe(1);
    expect(f.callReady).toBe(2);
    expect(f.byGrade).toEqual({ A: 1, B: 1, C: 1, D: 1 });
  });

  it("A MAIN BUSINESS LINE IS NOT A DIRECT NUMBER, even stored in direct_phone", () => {
    const f = buildFunnel([leads[2]]);
    expect(f.directNumbersFound).toBe(0);
  });

  it("expresses each step against the step before it", () => {
    const f = buildFunnel(leads);
    expect(f.ownerDiscoveryRate).toBe(0.75);
    expect(f.directNumberDiscoveryRate).toBeCloseTo(2 / 3);
    expect(f.endToEndRate).toBe(0.5);
  });

  it("says nothing rather than zero on an empty set", () => {
    const f = buildFunnel([]);
    expect(f.businessesCollected).toBe(0);
    expect(f.ownerDiscoveryRate).toBeNull();
    expect(f.directNumberDiscoveryRate).toBeNull();
  });
});

describe("cost", () => {
  const attempts: AttemptFact[] = [
    { provider: "pdl", attempted: true, accepted: true, cost_cents: 20 },
    { provider: "pdl", attempted: true, accepted: false, cost_cents: 20 },
    { provider: "apollo", attempted: true, accepted: false, cost_cents: 60 },
    { provider: "apollo", attempted: false, cost_cents: 0, skipped_reason: "not configured" },
  ];

  it("KEEPS THE FAILURES IN THE NUMERATOR — a cost per number that ignores misses is not a cost", () => {
    const c = buildCost(attempts, {
      directNumbersFound: 1,
      verifiedDirectNumbers: 1,
      callReady: 1,
    });
    expect(c.totalCents).toBe(100);
    expect(c.costPerNumberCents).toBe(100);
  });

  it("counts lookups and hits separately from spend", () => {
    const c = buildCost(attempts, {
      directNumbersFound: 1,
      verifiedDirectNumbers: 0,
      callReady: 0,
    });
    expect(c.lookups).toBe(3);
    expect(c.hits).toBe(1);
    // Never Infinity when nothing succeeded.
    expect(c.costPerVerifiedNumberCents).toBeNull();
    expect(c.costPerCallReadyLeadCents).toBeNull();
  });
});

describe("the headline figure", () => {
  it("reproduces the batch that prompted this work", () => {
    // 111 live answers, six owners, out of 400 dials.
    const calls: CallFactForReport[] = [
      ...Array.from({ length: 6 }, () => call({ outcome: "dm_conversation", reached_dm: true })),
      ...Array.from({ length: 105 }, () => call({ outcome: "gatekeeper" })),
      ...Array.from({ length: 289 }, () => call({ outcome: "no_answer" })),
    ];
    const r = buildCallOutcomes(calls);
    expect(r.calls).toBe(400);
    expect(r.livePersonReached).toBe(111);
    expect(r.ownerConversations).toBe(6);
    expect(r.ownerConversationsPer100).toBeCloseTo(1.5);
    expect(r.ownerShareOfLiveAnswers).toBeCloseTo(0.054, 2);
  });

  it("counts meetings", () => {
    const r = buildCallOutcomes([
      call({ outcome: "appointment_set", reached_dm: true }),
      call({ outcome: "not_interested", reached_dm: true }),
    ]);
    expect(r.meetings).toBe(1);
    expect(r.meetingsPer100).toBe(50);
  });

  it("no calls means no figure", () => {
    const r = buildCallOutcomes([]);
    expect(r.ownerConversationsPer100).toBeNull();
    expect(r.ownerShareOfLiveAnswers).toBeNull();
  });
});

describe("enriched records against main-line records", () => {
  const enrichedLead = (id: string): LeadFact =>
    lead({ id, direct_phone: "+1313482019" + id, direct_phone_class: "verified_owner_mobile" });
  const plainLead = (id: string): LeadFact =>
    lead({ id, direct_phone: null, direct_phone_class: null });

  function calls(leadIds: string[], ownerEvery: number): CallFactForReport[] {
    return leadIds.map((lead_id, i) =>
      call({
        lead_id,
        outcome: i % ownerEvery === 0 ? "dm_conversation" : "gatekeeper",
        reached_dm: i % ownerEvery === 0,
      })
    );
  }

  it("REFUSES A VERDICT off too few calls", () => {
    const s = buildSplit(calls(["1"], 1), [enrichedLead("1")]);
    expect(s.verdict).toMatch(/too few to judge/);
    expect(s.enriched.calls).toBe(1);
  });

  it("reports the lift when both sides have enough behind them", () => {
    const enrichedIds = Array.from({ length: 100 }, () => "1");
    const plainIds = Array.from({ length: 100 }, () => "2");
    const s = buildSplit(
      [...calls(enrichedIds, 4), ...calls(plainIds, 20)],
      [enrichedLead("1"), plainLead("2")]
    );
    expect(s.enriched.calls).toBe(100);
    expect(s.mainLine.calls).toBe(100);
    expect(s.enriched.ownerConversationsPer100).toBe(25);
    expect(s.mainLine.ownerConversationsPer100).toBe(5);
    expect(s.liftPer100).toBe(20);
    expect(s.verdict).toMatch(/20.0 more owners/);
  });

  it("SAYS SO PLAINLY when the enrichment is doing worse", () => {
    const s = buildSplit(
      [
        ...calls(Array.from({ length: 100 }, () => "1"), 50),
        ...calls(Array.from({ length: 100 }, () => "2"), 4),
      ],
      [enrichedLead("1"), plainLead("2")]
    );
    expect(s.liftPer100).toBeLessThan(0);
    expect(s.verdict).toMatch(/FEWER owners/);
    expect(s.verdict).toMatch(/not paying for itself/);
  });

  it("a call with no lead attached counts as main-line, not as enriched", () => {
    const s = buildSplit([call({ outcome: "gatekeeper" })], [enrichedLead("1")]);
    expect(s.enriched.calls).toBe(0);
    expect(s.mainLine.calls).toBe(1);
  });

  it("the bar is a stated constant, not a number buried in a branch", () => {
    expect(MIN_CALLS_FOR_A_VERDICT).toBeGreaterThanOrEqual(30);
  });
});

describe("accuracy, from the callers", () => {
  const fb = (outcome: string, provider = "pdl"): FeedbackFact => ({ outcome, provider });

  it("scores only the calls that settled something", () => {
    const a = buildAccuracy([
      fb("correct_owner_reached"),
      fb("appointment_booked"),
      fb("wrong_person"),
      fb("wrong_number"),
      // Neutral: proves nothing either way, stays out of the denominator.
      fb("gatekeeper_reached"),
    ]);
    expect(a.judged).toBe(4);
    expect(a.confirmed).toBe(2);
    expect(a.accuracy).toBe(0.5);
  });

  it("separates a wrong person from a wrong number", () => {
    const a = buildAccuracy([
      fb("wrong_person"),
      fb("owner_no_longer_there"),
      fb("wrong_number"),
      fb("disconnected"),
    ]);
    expect(a.wrongPerson).toBe(2);
    expect(a.wrongNumber).toBe(2);
    expect(a.wrongPersonRate).toBe(0.5);
    expect(a.wrongNumberRate).toBe(0.5);
  });

  it("nothing judged means no accuracy claim", () => {
    const a = buildAccuracy([fb("gatekeeper_reached")]);
    expect(a.judged).toBe(0);
    expect(a.accuracy).toBeNull();
  });
});

describe("breakdowns", () => {
  const leads: LeadFact[] = [
    lead({ id: "a", enrichment_grade: "A", direct_phone_class: "verified_owner_mobile" }),
    lead({ id: "b", enrichment_grade: "B", direct_phone_class: "probable_owner_direct" }),
    lead({ id: "c", enrichment_grade: "C", direct_phone_class: "main_business_line" }),
  ];
  const calls: CallFactForReport[] = [
    call({ lead_id: "a", outcome: "appointment_set", reached_dm: true }),
    call({ lead_id: "a", outcome: "gatekeeper" }),
    call({ lead_id: "b", outcome: "dm_conversation", reached_dm: true }),
    call({ lead_id: "c", outcome: "gatekeeper" }),
    call({ lead_id: "c", outcome: "no_answer" }),
  ];

  it("by grade", () => {
    const rows = buildByGrade(leads, calls);
    const a = rows.find((r) => r.grade === "A")!;
    expect(a.calls).toBe(2);
    expect(a.ownerConversations).toBe(1);
    expect(a.ownerConversationsPer100).toBe(50);
    expect(a.meetingsPer100).toBe(50);

    const c = rows.find((r) => r.grade === "C")!;
    expect(c.ownerConversations).toBe(0);
    expect(c.ownerConversationsPer100).toBe(0);

    // Every grade is present even with nothing in it, so a missing row is
    // never mistaken for a grade that does not exist.
    expect(rows.map((r) => r.grade)).toEqual(["A", "B", "C", "D"]);
  });

  it("by number type, hiding classes nothing landed in", () => {
    const rows = buildByNumberType(leads, calls);
    expect(rows.map((r) => r.phoneClass)).toEqual([
      "verified_owner_mobile",
      "probable_owner_direct",
      "main_business_line",
    ]);
    expect(rows[0].ownerConversationsPer100).toBe(50);
  });

  it("by provider", () => {
    const attempts: AttemptFact[] = [
      ...Array.from({ length: 30 }, () => ({
        provider: "pdl",
        attempted: true,
        accepted: true,
        cost_cents: 20,
      })),
      { provider: "apollo", attempted: true, accepted: false, cost_cents: 60, error: "HTTP 500" },
    ];
    const feedback: FeedbackFact[] = [
      { outcome: "correct_owner_reached", provider: "pdl" },
      { outcome: "correct_owner_reached", provider: "pdl" },
      { outcome: "wrong_number", provider: "pdl" },
    ];
    const rows = buildByProvider(attempts, feedback);
    const pdl = rows.find((r) => r.provider === "pdl")!;
    expect(pdl.lookups).toBe(30);
    expect(pdl.hits).toBe(30);
    expect(pdl.hitRate).toBe(1);
    expect(pdl.costCents).toBe(600);
    expect(pdl.costPerHitCents).toBe(20);
    expect(pdl.ownerConversations).toBe(2);
    expect(pdl.contradicted).toBe(1);
    expect(pdl.costPerOwnerConversationCents).toBe(300);
    expect(pdl.verdict).toMatch(/2 of 3 judged calls/);

    const apollo = rows.find((r) => r.provider === "apollo")!;
    expect(apollo.errors).toBe(1);
    expect(apollo.costPerHitCents).toBeNull();
  });

  it("WITHHOLDS A PROVIDER VERDICT below the minimum — reordering spend off four lookups is how a good provider gets dropped", () => {
    const rows = buildByProvider(
      [{ provider: "pdl", attempted: true, accepted: true, cost_cents: 20 }],
      [{ outcome: "wrong_number", provider: "pdl" }]
    );
    expect(rows[0].verdict).toMatch(/too few to judge/);
    expect(MIN_LOOKUPS_TO_JUDGE_PROVIDER).toBeGreaterThan(1);
  });
});

describe("the whole report", () => {
  it("builds from nothing without throwing, and says why it is empty", () => {
    const r = buildEnrichmentReport({ leads: [], calls: [], attempts: [], feedback: [] });
    expect(r.funnel.businessesCollected).toBe(0);
    expect(r.overall.calls).toBe(0);
    expect(r.headline).toMatch(/No calls recorded yet/);
    expect(r.byProvider).toEqual([]);
  });

  it("leads with the number the whole feature is judged on", () => {
    const r = buildEnrichmentReport({
      leads: [
        lead({
          id: "a",
          decision_maker_name: "Maria Rivera",
          direct_phone: "+13134820199",
          direct_phone_class: "verified_owner_mobile",
          enrichment_grade: "A",
        }),
      ],
      calls: [
        call({ lead_id: "a", outcome: "dm_conversation", reached_dm: true }),
        call({ lead_id: "a", outcome: "no_answer" }),
      ],
      attempts: [{ provider: "pdl", attempted: true, accepted: true, cost_cents: 20 }],
      feedback: [{ lead_id: "a", outcome: "correct_owner_reached", provider: "pdl" }],
    });
    expect(r.headline).toMatch(/50.0 owner conversations per 100 calls/);
    expect(r.cost.costPerNumberCents).toBe(20);
    expect(r.accuracy.accuracy).toBe(1);
  });
});
