// What may be said to a business owner about their own business.
//
// The old workshop classified every finding by what we would sell: receptionist,
// website, SEO, reviews. The top-level type was the product, so every packet was
// structurally a list of things to sell, reordered — and an owner reading four in
// a row can tell.
//
// These tests hold the replacement to two properties. Findings are ranked by how
// specific and consequential they are, not by how sellable. And nothing is ever
// claimed that public data cannot support.

import { describe, it, expect } from "vitest";
import {
  rankScore,
  rankOpportunities,
  validateOpportunity,
  forbiddenClaims,
  stripInternal,
  stripAllInternal,
  JOURNEY_STAGES,
  CONFIDENCE_LABEL,
  type Opportunity,
  type RankInputs,
} from "../src/lib/opportunityModel";
import {
  buildOpportunityMap,
  AREA_PROMPT,
  MAX_MAPPED,
  PROVENANCE_HEADINGS,
  type BottleneckAnswer,
} from "../src/lib/bottleneckAudit";

const opp = (over: Partial<Opportunity> = {}): Opportunity => ({
  id: "o1",
  stage: "contact",
  category: "uncaptured_demand",
  title: "Enquiries arriving when nobody can answer",
  summary: "Your listing shows calls are the main way people reach you.",
  evidence: "google_listing.primary_action, reviews mentioning voicemail",
  sourceType: "google_listing",
  observedAt: "2026-08-15T00:00:00Z",
  knownFacts: ["Your listing lists a phone number as the only way to get in touch."],
  inferences: ["Some of that demand may arrive when the team is on a job."],
  needsConfirmation: ["How often calls go unanswered in a normal week"],
  wouldVerifyNext: ["Ask for a week of call records"],
  confidence: "medium",
  demonstrable: true,
  solutionDirections: ["Capture enquiries when nobody can pick up"],
  priority: "supporting",
  internalNote: "Open on the voicemail line — it lands every time.",
  ...over,
});

const rank = (over: Partial<RankInputs> = {}): RankInputs => ({
  confidence: "medium",
  importance: 0.6,
  specificity: 0.5,
  distinctiveness: 0.5,
  demonstrable: false,
  solvability: 0.7,
  customBuild: false,
  ...over,
});

/* -------------------------------------------------------------------------- */

describe("THE JOURNEY, NOT THE PRODUCT CATALOGUE", () => {
  it("classifies by where the business leaks, in customer order", () => {
    expect(JOURNEY_STAGES[0]).toBe("demand");
    expect(JOURNEY_STAGES).toContain("retention");
    expect(JOURNEY_STAGES).toContain("visibility");
    expect(JOURNEY_STAGES).toHaveLength(11);
  });

  it("no stage is named after something we sell", () => {
    for (const s of JOURNEY_STAGES) {
      expect(s).not.toMatch(/receptionist|website|seo|review_automation/i);
    }
  });
});

describe("A SPECIFIC CONSTRAINT OUTRANKS A GENERIC PRODUCT PITCH", () => {
  it("the generic recommendation loses, even at high confidence", () => {
    // "You should have a website" — certain, important, and true of thousands
    // of businesses. Exactly the finding the old packet led with every time.
    const generic = rankScore(
      rank({ confidence: "high", importance: 0.8, specificity: 0.1, distinctiveness: 0.1 })
    );
    // "Estimates you already priced are not being chased" — specific, from
    // their own record, and something they have not been told before.
    const specific = rankScore(
      rank({
        confidence: "medium",
        importance: 0.9,
        specificity: 0.9,
        distinctiveness: 0.8,
        demonstrable: true,
        customBuild: true,
      })
    );
    expect(specific).toBeGreaterThan(generic);
  });

  it("specificity and distinctiveness both carry real weight", () => {
    const base = rank();
    expect(rankScore({ ...base, specificity: 1 })).toBeGreaterThan(rankScore(base));
    expect(rankScore({ ...base, distinctiveness: 1 })).toBeGreaterThan(rankScore(base));
  });

  it("being demonstrable without access is worth something", () => {
    expect(rankScore(rank({ demonstrable: true }))).toBeGreaterThan(
      rankScore(rank({ demonstrable: false }))
    );
  });

  it("nonsense inputs cannot produce a nonsense score", () => {
    const s = rankScore(rank({ importance: NaN, specificity: 99, distinctiveness: -5 }));
    expect(Number.isFinite(s)).toBe(true);
  });
});

describe("RANKING PICKS A LEAD AND SPREADS THE REST", () => {
  const candidates = [
    { ...opp({ id: "a", stage: "contact", title: "A" }), rank: rank({ specificity: 0.9 }) },
    { ...opp({ id: "b", stage: "contact", title: "B" }), rank: rank({ specificity: 0.85 }) },
    { ...opp({ id: "c", stage: "retention", title: "C" }), rank: rank({ specificity: 0.6 }) },
    { ...opp({ id: "d", stage: "review", title: "D" }), rank: rank({ specificity: 0.2 }) },
  ];

  it("the strongest leads and is marked primary", () => {
    const out = rankOpportunities(candidates, 3);
    expect(out[0].id).toBe("a");
    expect(out[0].priority).toBe("primary");
    expect(out.slice(1).every((o) => o.priority === "supporting")).toBe(true);
  });

  it("SPREADS ACROSS STAGES rather than three views of one problem", () => {
    // b is stronger than c but shares a stage with a. Three variations on
    // "people cannot reach you" reads as one problem padded out.
    const out = rankOpportunities(candidates, 3);
    expect(out.map((o) => o.id)).toEqual(["a", "c", "d"]);
  });

  it("a finding that cannot be stood behind is dropped, not shown", () => {
    const out = rankOpportunities(
      [
        { ...opp({ id: "ok" }), rank: rank() },
        { ...opp({ id: "no-evidence", evidence: "" }), rank: rank({ specificity: 1 }) },
      ],
      3
    );
    expect(out.map((o) => o.id)).toEqual(["ok"]);
  });

  it("returns at least one even when asked for none", () => {
    expect(rankOpportunities(candidates, 0)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */

describe("NOTHING IS CLAIMED THAT PUBLIC DATA CANNOT SUPPORT", () => {
  const banned = [
    "You are losing $4,200 a month to missed calls",
    "This is costing you £1,500 a year",
    "Your conversion rate is 12%",
    "You miss 14 calls a week",
    "You are missing 30 enquiries every month",
    "Roughly 40% of your leads never get a reply",
    "Your margin is 22% on this work",
  ];

  for (const text of banned) {
    it(`refuses: "${text}"`, () => {
      expect(forbiddenClaims({ summary: text }).length).toBeGreaterThan(0);
      expect(validateOpportunity(opp({ summary: text })).length).toBeGreaterThan(0);
    });
  }

  it("checks EVERY owner-facing field, not just the summary", () => {
    for (const field of [
      "title",
      "evidence",
      "potentialEffect",
      "customBuildPotential",
    ] as const) {
      expect(forbiddenClaims({ [field]: "costing you $900 a month" }).length).toBeGreaterThan(0);
    }
    expect(forbiddenClaims({ inferences: ["you miss 12 calls a week"] }).length).toBeGreaterThan(0);
    expect(forbiddenClaims({ knownFacts: ["Your revenue is $40,000"] }).length).toBeGreaterThan(0);
  });

  it("THE CONDITIONAL REGISTER IS ALLOWED, because it is honest", () => {
    for (const ok of [
      "This may create an opportunity leak.",
      "This is likely adding friction for buyers.",
      "This could reduce the demand you actually capture.",
      "We would need your own numbers to say what this is worth.",
    ]) {
      expect(forbiddenClaims({ summary: ok })).toEqual([]);
    }
  });

  it("an ordinary evidenced finding passes cleanly", () => {
    expect(validateOpportunity(opp())).toEqual([]);
  });

  it("evidence is mandatory — an opinion is not an observation", () => {
    const problems = validateOpportunity(opp({ evidence: "  " }));
    expect(problems.join(" ")).toMatch(/opinion, not an observation/i);
  });

  it("known and inferred must be separated", () => {
    const problems = validateOpportunity(opp({ knownFacts: [], inferences: [] }));
    expect(problems.join(" ")).toMatch(/known from what is inferred/i);
  });

  it("confidence never becomes certainty", () => {
    for (const label of Object.values(CONFIDENCE_LABEL)) {
      expect(label).not.toMatch(/\bcertain\b|\bguaranteed\b|\bproven\b/i);
    }
    expect(CONFIDENCE_LABEL.high).toMatch(/based on what is public/i);
  });
});

describe("INTERNAL NOTES CANNOT REACH THE PUBLIC PAYLOAD", () => {
  it("stripped at the boundary, not merely hidden in a component", () => {
    const pub = stripInternal(opp());
    expect("internalNote" in pub).toBe(false);
    expect(JSON.stringify(pub)).not.toMatch(/land every time/);
  });

  it("and for a whole list", () => {
    const list = stripAllInternal([opp({ id: "a" }), opp({ id: "b" })]);
    expect(JSON.stringify(list)).not.toContain("internalNote");
    expect(list).toHaveLength(2);
  });

  it("everything the owner needs still survives the strip", () => {
    const pub = stripInternal(opp());
    for (const k of ["title", "summary", "evidence", "knownFacts", "inferences", "confidence"]) {
      expect(pub, k).toHaveProperty(k);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("THE OPPORTUNITY MAP IS A MAP, NOT AN AUDIT", () => {
  const answers: BottleneckAnswer[] = [
    { area: "estimates_not_followed", frequency: "daily", affects: "revenue" },
    { area: "missed_calls", frequency: "weekly", affects: "revenue" },
    { area: "repeat_questions", frequency: "occasionally", affects: "time" },
  ];

  it("ranks what they reported and bands it", () => {
    const map = buildOpportunityMap(answers);
    expect(map[0].area).toBe("estimates_not_followed");
    expect(map[0].band).toBe("fix_first");
    expect(["fix_first", "quick_win", "investigate_next"]).toContain(map[1].band);
  });

  it("NEVER CLAIMS HIGH CONFIDENCE from a questionnaire", () => {
    for (const m of buildOpportunityMap(answers)) {
      expect(m.confidence).not.toBe("high");
    }
  });

  it("shows only the strongest few, not a catalogue of everything ticked", () => {
    const everything = Object.keys(AREA_PROMPT).map((area) => ({
      area: area as BottleneckAnswer["area"],
      frequency: "daily" as const,
    }));
    expect(buildOpportunityMap(everything).length).toBeLessThanOrEqual(MAX_MAPPED);
  });

  it("says where value MAY leak, never how much", () => {
    for (const m of buildOpportunityMap(answers)) {
      expect(m.whereValueLeaks).not.toMatch(/[£$€]\s*\d/);
      expect(forbiddenClaims({ summary: m.whereValueLeaks })).toEqual([]);
    }
  });

  it("every entry says what still needs checking", () => {
    for (const m of buildOpportunityMap(answers)) {
      expect(m.toVerify.length).toBeGreaterThan(0);
      expect(m.possibleCauses.length).toBeGreaterThan(0);
      expect(typeof m.needsPermission).toBe("boolean");
      expect(m.timeToSignal.length).toBeGreaterThan(0);
    }
  });

  it("echoes back what they actually said, unaltered", () => {
    const map = buildOpportunityMap([
      { area: "missed_calls", detail: "  worst on Fridays  ", frequency: "daily", affects: "revenue" },
    ]);
    expect(map[0].reported.detail).toBe("worst on Fridays");
    expect(map[0].reported.frequency).toBe("daily");
  });

  it("an unknown area is ignored rather than crashing the map", () => {
    const map = buildOpportunityMap([
      { area: "not_a_real_area" as BottleneckAnswer["area"] },
      { area: "missed_calls", frequency: "daily" },
    ]);
    expect(map).toHaveLength(1);
    expect(map[0].area).toBe("missed_calls");
  });

  it("no answers produces an empty map, not an invented one", () => {
    expect(buildOpportunityMap([])).toEqual([]);
  });

  it("THE FOUR PROVENANCES STAY APART", () => {
    // Merging them is how a questionnaire answer becomes, three screens later,
    // something we appear to have discovered.
    expect(PROVENANCE_HEADINGS.observed).toMatch(/outside/i);
    expect(PROVENANCE_HEADINGS.reported).toMatch(/you told us/i);
    expect(PROVENANCE_HEADINGS.inferred).toMatch(/reading/i);
    expect(PROVENANCE_HEADINGS.unverified).toMatch(/checking/i);
    expect(new Set(Object.values(PROVENANCE_HEADINGS)).size).toBe(4);
  });
});
