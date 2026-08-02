// The owner-enrichment pipeline.
//
// These tests exist because of a measured failure: in one batch, 111 calls
// reached a live person and six reached an owner. Everything below defends one
// of the rules that failure produced —
//
//   never hand back the main business line as a direct owner number,
//   never assert a person on one weak signal,
//   never let a lead with no direct number into the direct-call queue,
//   never spend past a cap, and check that BEFORE the provider is called.
//
// Nothing here touches a network. Providers are passed in, so provider failure
// and budget exhaustion are exercised without a bill.

import { describe, it, expect } from "vitest";

import {
  toE164,
  formatUs,
  structurallyValid,
  lineTypeFromNumber,
  classifyNumber,
  dedupeKeys,
  isDirectOwnerLine,
  PHONE_CLASS_RANK,
  VERIFIED_CONFIDENCE,
} from "../src/lib/phoneIntel";

import {
  roleFromTitle,
  looksLikePersonName,
  splitName,
  assessMatch,
  selectDecisionMaker,
  MIN_DM_CONFIDENCE,
  type Candidate,
  type MatchContext,
} from "../src/lib/decisionMaker";

import {
  gradeLead,
  isCallReady,
  callReadyOnly,
  orderForAssignment,
  compareForAssignment,
  orderLeadsForAssignment,
  ASSIGNMENT_COLUMNS,
  CALL_READY_GRADES,
  type AssignmentCandidate,
} from "../src/lib/enrichmentGrade";

import {
  maySpend,
  shouldReEnrich,
  runWaterfall,
  DEFAULT_LIMITS,
  type BudgetLimits,
  type Spend,
} from "../src/lib/directNumber";

import {
  STOP_AT_CONFIDENCE,
  type ContactProvider,
  type LookupResult,
  type LookupSubject,
} from "../src/lib/contactProviders/types";

import {
  effectOf,
  correctedConfidence,
  scoreProviders,
  CONFIRMING,
  CONTRADICTING,
  CONTACT_OUTCOMES,
  MIN_CALLS_TO_RANK_PROVIDER,
} from "../src/lib/contactFeedback";

import { nextState, isCallReadyState, isRetryable } from "../src/lib/enrichmentState";

import { normalise as normalisePdl } from "../src/lib/contactProviders/peopleDataLabs";

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const MAIN_LINE = "+13134820100";
const OWNER_MOBILE = "+13134820199";
const OTHER_DIRECT = "+13134820177";

const SUBJECT: LookupSubject = {
  leadId: "lead-1",
  fullName: "Maria Rivera",
  firstName: "Maria",
  lastName: "Rivera",
  title: "Owner",
  businessName: "Rivera Plumbing",
  domain: "riveraplumbing.com",
  city: "Detroit",
  state: "MI",
  address: "18 Vernor Hwy, Detroit, MI",
  email: null,
  profileUrl: null,
  mainBusinessPhone: MAIN_LINE,
};

const CTX: MatchContext = {
  businessName: "Rivera Plumbing",
  domain: "riveraplumbing.com",
  city: "Detroit",
  state: "MI",
};

function provider(over: Partial<ContactProvider> & { key: string }): ContactProvider {
  return {
    label: over.key,
    order: 10,
    billsOnlyOnHit: true,
    costPerHitCents: 20,
    isAvailable: () => true,
    unavailableReason: () => null,
    lookup: async (): Promise<LookupResult> => ({
      provider: over.key,
      phones: [],
      retrievedAt: new Date().toISOString(),
      costCents: 0,
    }),
    ...over,
  };
}

/** A provider that hands back one phone and records that it was asked. */
function hitProvider(
  key: string,
  phone: string,
  opts: {
    confidence?: number;
    lineType?: "mobile" | "landline" | "voip" | "toll_free" | "unknown";
    providerVerified?: boolean;
    costCents?: number;
    calls?: string[];
  } = {}
): ContactProvider {
  return provider({
    key,
    costPerHitCents: opts.costCents ?? 20,
    lookup: async () => {
      opts.calls?.push(key);
      return {
        provider: key,
        phones: [
          {
            phone,
            lineType: opts.lineType ?? "mobile",
            confidence: opts.confidence ?? 0.9,
            providerVerified: opts.providerVerified ?? true,
            sourceRef: `${key}-ref`,
          },
        ],
        retrievedAt: new Date().toISOString(),
        costCents: opts.costCents ?? 20,
      };
    },
  });
}

function freshSpend(): Spend {
  return { monthToDateCents: 0, thisRunCents: 0 };
}

/* -------------------------------------------------------------------------- */
/* numbers                                                                     */
/* -------------------------------------------------------------------------- */

describe("normalising a telephone number", () => {
  it("takes the shapes a scraped page actually produces", () => {
    expect(toE164("(313) 482-0199")).toBe(OWNER_MOBILE);
    expect(toE164("313.482.0199")).toBe(OWNER_MOBILE);
    expect(toE164("1-313-482-0199")).toBe(OWNER_MOBILE);
    expect(toE164("+1 313 482 0199")).toBe(OWNER_MOBILE);
  });

  it("refuses what cannot be a North American number", () => {
    expect(toE164("482-0199")).toBeNull();
    expect(toE164("+44 20 7946 0958")).toBeNull();
    expect(toE164(null)).toBeNull();
    expect(toE164("")).toBeNull();
  });

  it("formats for a caller reading it off the screen", () => {
    expect(formatUs("13134820199")).toBe("(313) 482-0199");
    expect(formatUs("nonsense")).toBeNull();
  });
});

describe("structural validity", () => {
  it("accepts a real number", () => {
    expect(structurallyValid(OWNER_MOBILE).valid).toBe(true);
  });

  it("rejects the junk scraping produces", () => {
    expect(structurallyValid("+11134820199").valid).toBe(false); // area code starts with 1
    expect(structurallyValid("+13130820199").valid).toBe(false); // exchange starts with 0
    expect(structurallyValid("+13135550199").valid).toBe(false); // 555 placeholder
    expect(structurallyValid("+13333333333").valid).toBe(false); // same digit ten times
    expect(structurallyValid("+11234567890").valid).toBe(false); // filler
  });

  it("says why, in words an admin can act on", () => {
    expect(structurallyValid("+13135550199").reason).toMatch(/555/);
  });
});

describe("line type from digits alone", () => {
  it("knows toll-free from the area code, because that part is certain", () => {
    expect(lineTypeFromNumber("+18004820199")).toBe("toll_free");
    expect(lineTypeFromNumber("+18884820199")).toBe("toll_free");
  });

  it("REFUSES to guess mobile vs landline — portability made that undecidable", () => {
    expect(lineTypeFromNumber(OWNER_MOBILE)).toBe("unknown");
  });
});

/* -------------------------------------------------------------------------- */
/* classification — the check the whole pipeline exists for                     */
/* -------------------------------------------------------------------------- */

describe("classifying a discovered number", () => {
  const base = {
    mainBusinessPhone: MAIN_LINE,
    lineType: "mobile" as const,
    confidence: 0.9,
    providerVerified: true,
    identityMatched: true,
  };

  it("THE FAILURE THIS EXISTS TO PREVENT: the main business line is never a direct owner number", () => {
    const c = classifyNumber({ ...base, candidate: MAIN_LINE });
    expect(c.phoneClass).toBe("main_business_line");
    expect(c.usable).toBe(false);
    expect(isDirectOwnerLine(c.phoneClass)).toBe(false);
  });

  it("recognises the main line however it was formatted", () => {
    const c = classifyNumber({ ...base, candidate: "(313) 482-0100" });
    expect(c.phoneClass).toBe("main_business_line");
  });

  it("rejects toll-free outright — it reaches a switchboard by definition", () => {
    const c = classifyNumber({ ...base, candidate: "+18004820199", lineType: "unknown" });
    expect(c.phoneClass).toBe("main_business_line");
    expect(c.usable).toBe(false);
  });

  it("asserts nothing when nothing ties the number to the person", () => {
    const c = classifyNumber({ ...base, candidate: OWNER_MOBILE, identityMatched: false });
    expect(c.phoneClass).toBe("unknown");
    expect(c.usable).toBe(false);
  });

  it("asserts nothing when two sources disagree", () => {
    const c = classifyNumber({ ...base, candidate: OWNER_MOBILE, conflicting: true });
    expect(c.phoneClass).toBe("unknown");
    expect(c.usable).toBe(false);
  });

  it("verified means the provider asserted it AND was confident", () => {
    expect(classifyNumber({ ...base, candidate: OWNER_MOBILE }).phoneClass).toBe(
      "verified_owner_mobile"
    );
    // Same assertion, below the bar.
    expect(
      classifyNumber({ ...base, candidate: OWNER_MOBILE, confidence: VERIFIED_CONFIDENCE - 0.01 })
        .phoneClass
    ).toBe("probable_owner_mobile");
    // Confident, but the provider never asserted ownership.
    expect(
      classifyNumber({ ...base, candidate: OWNER_MOBILE, providerVerified: false }).phoneClass
    ).toBe("probable_owner_mobile");
  });

  it("an unknown line type is a direct line, not a mobile", () => {
    const c = classifyNumber({ ...base, candidate: OWNER_MOBILE, lineType: "unknown" });
    expect(c.phoneClass).toBe("verified_owner_direct");
    expect(c.usable).toBe(true);
  });

  it("ranks a verified mobile above everything else", () => {
    expect(PHONE_CLASS_RANK.verified_owner_mobile).toBeLessThan(
      PHONE_CLASS_RANK.probable_owner_mobile
    );
    expect(PHONE_CLASS_RANK.probable_owner_direct).toBeLessThan(
      PHONE_CLASS_RANK.main_business_line
    );
  });
});

/* -------------------------------------------------------------------------- */
/* deduplication                                                               */
/* -------------------------------------------------------------------------- */

describe("deduplication keys", () => {
  it("uses several signals, because any one alone produces false merges", () => {
    const keys = dedupeKeys({
      placeId: "ChIJ123",
      domain: "RiveraPlumbing.com",
      phone: "(313) 482-0100",
      address: "18 Vernor Hwy",
      businessName: "Rivera Plumbing",
    });
    expect(keys).toContain("place:ChIJ123");
    expect(keys).toContain(`phone:${MAIN_LINE}`);
    expect(keys).toContain("domain:riveraplumbing.com");
    expect(keys).toContain("site:riveraplumbing@18vernorhwy");
  });

  it("two records for the same business overlap on at least one key", () => {
    const a = dedupeKeys({ placeId: "ChIJ123", phone: "313-482-0100" });
    const b = dedupeKeys({ placeId: null, phone: "(313) 482-0100", domain: "riveraplumbing.com" });
    expect(a.some((k) => b.includes(k))).toBe(true);
  });

  it("two franchisees on one domain do NOT collapse on the site key", () => {
    const a = dedupeKeys({ address: "18 Vernor Hwy", businessName: "Rivera Plumbing Detroit" });
    const b = dedupeKeys({ address: "902 Woodward Ave", businessName: "Rivera Plumbing Detroit" });
    expect(a.some((k) => b.includes(k))).toBe(false);
  });

  it("emits nothing rather than a useless key when there is nothing to key on", () => {
    expect(dedupeKeys({ phone: "not a number" })).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* who the decision-maker is                                                   */
/* -------------------------------------------------------------------------- */

describe("reading a title", () => {
  it("matches the longest phrase first", () => {
    expect(roleFromTitle("Co-Owner")).toBe("co_owner");
    expect(roleFromTitle("co owner")).toBe("co_owner");
    expect(roleFromTitle("General Manager")).toBe("general_manager");
    expect(roleFromTitle("Office Manager")).toBe("office_manager");
    expect(roleFromTitle("Managing Partner")).toBe("managing_partner");
  });

  it("maps the plain ones", () => {
    expect(roleFromTitle("Owner")).toBe("owner");
    expect(roleFromTitle("Founder & CEO")).toBe("founder");
    expect(roleFromTitle("President")).toBe("president");
    expect(roleFromTitle("CEO")).toBe("president");
  });

  it("returns unknown rather than guessing", () => {
    expect(roleFromTitle("Technician")).toBe("unknown");
    expect(roleFromTitle(null)).toBe("unknown");
    expect(roleFromTitle("")).toBe("unknown");
  });
});

describe("does this even look like a person", () => {
  it("accepts ordinary names", () => {
    expect(looksLikePersonName("Maria Rivera")).toBe(true);
    expect(looksLikePersonName("J. P. O'Neill")).toBe(true);
  });

  it("rejects businesses dressed up as people", () => {
    expect(looksLikePersonName("Rivera Plumbing LLC")).toBe(false);
    expect(looksLikePersonName("Customer Support")).toBe(false);
    expect(looksLikePersonName("Sales Team")).toBe(false);
  });

  it("rejects fragments and junk", () => {
    expect(looksLikePersonName("Maria")).toBe(false);
    expect(looksLikePersonName("maria rivera")).toBe(false);
    expect(looksLikePersonName("Unit 4B")).toBe(false);
    expect(looksLikePersonName(null)).toBe(false);
  });

  it("splits a name for the provider lookup", () => {
    expect(splitName("Maria Rivera")).toEqual({ first: "Maria", last: "Rivera" });
    expect(splitName("Maria Elena Rivera")).toEqual({ first: "Maria", last: "Rivera" });
  });
});

describe("tying a person to THIS business", () => {
  const strong: Candidate = {
    name: "Maria Rivera",
    title: "Owner",
    sourceUrl: "https://riveraplumbing.com/about",
    supportingText: "Maria Rivera, Owner, Rivera Plumbing of Detroit, MI",
    method: "site_about",
    confidence: 0.9,
  };

  it("counts every independent signal", () => {
    const m = assessMatch(strong, CTX);
    expect(m.ambiguous).toBe(false);
    expect(m.signals.length).toBeGreaterThanOrEqual(4);
    expect(m.strength).toBe(1);
  });

  it("ONE signal is a coincidence, not a match", () => {
    const thin: Candidate = {
      name: "John Smith",
      title: null,
      sourceUrl: "https://directory.example.com/listing/8821",
      supportingText: "John Smith, plumber",
      method: "directory",
      confidence: 0.7,
    };
    const m = assessMatch(thin, CTX);
    expect(m.signals.length).toBeLessThan(2);
    expect(m.ambiguous).toBe(true);
  });

  it("a name that is not a person is refused outright", () => {
    const m = assessMatch({ ...strong, name: "Rivera Plumbing LLC" }, CTX);
    expect(m.ambiguous).toBe(true);
    expect(m.strength).toBe(0);
    expect(m.missing.join(" ")).toMatch(/does not look like a person/);
  });

  it("says what is missing, so a human can go and find it", () => {
    const m = assessMatch({ ...strong, sourceUrl: "https://elsewhere.example/x" }, CTX);
    expect(m.missing.join(" ")).toMatch(/own website/);
  });
});

describe("selecting the decision-maker, or refusing to", () => {
  const owner: Candidate = {
    name: "Maria Rivera",
    title: "Owner",
    sourceUrl: "https://riveraplumbing.com/about",
    supportingText: "Maria Rivera, Owner, Rivera Plumbing of Detroit, MI",
    method: "site_about",
    confidence: 0.9,
  };

  it("chooses a well-evidenced owner", () => {
    const s = selectDecisionMaker([owner], CTX);
    expect(s.chosen).toBe(true);
    if (!s.chosen) return;
    expect(s.name).toBe("Maria Rivera");
    expect(s.firstName).toBe("Maria");
    expect(s.lastName).toBe("Rivera");
    expect(s.role).toBe("owner");
    expect(s.confidence).toBeGreaterThanOrEqual(MIN_DM_CONFIDENCE);
    expect(s.sourceUrl).toBe("https://riveraplumbing.com/about");
  });

  it("REFUSES rather than asserting somebody who does not work there", () => {
    const s = selectDecisionMaker(
      [
        {
          name: "John Smith",
          title: null,
          sourceUrl: "https://directory.example.com/8821",
          supportingText: "John Smith, plumber",
          method: "directory",
          confidence: 0.9,
        },
      ],
      CTX
    );
    expect(s.chosen).toBe(false);
    if (s.chosen) return;
    expect(s.considered).toBe(1);
    expect(s.reason).toMatch(/two independent signals/);
  });

  it("refuses when two names are claimed and neither is strongly evidenced", () => {
    const contestedA: Candidate = { ...owner, name: "Maria Rivera", confidence: 0.6 };
    const contestedB: Candidate = {
      ...owner,
      name: "Tomas Rivera",
      supportingText: "Tomas Rivera, Owner, Rivera Plumbing, Detroit MI",
      confidence: 0.6,
    };
    const s = selectDecisionMaker([contestedA, contestedB], CTX);
    expect(s.chosen).toBe(false);
  });

  it("prefers the owner over an office manager even when the manager scores higher", () => {
    const manager: Candidate = {
      ...owner,
      name: "Dana Fletcher",
      title: "Office Manager",
      supportingText: "Dana Fletcher, Office Manager, Rivera Plumbing, Detroit, MI",
      confidence: 0.95,
    };
    const s = selectDecisionMaker([{ ...owner, confidence: 0.85 }, manager], CTX);
    expect(s.chosen).toBe(true);
    if (!s.chosen) return;
    expect(s.role).toBe("owner");
    expect(s.name).toBe("Maria Rivera");
  });

  it("refuses when there is nothing to consider", () => {
    const s = selectDecisionMaker([], CTX);
    expect(s.chosen).toBe(false);
    if (s.chosen) return;
    expect(s.considered).toBe(0);
  });

  it("weak evidence drags a confident source below the floor", () => {
    // Two signals — enough not to be ambiguous — but a low-confidence source.
    const weakSource: Candidate = {
      name: "Alex Moreno",
      title: "Owner",
      sourceUrl: "https://elsewhere.example/x",
      supportingText: "Alex Moreno, Owner, Rivera Plumbing",
      method: "search_snippet",
      confidence: 0.55,
    };
    const s = selectDecisionMaker([weakSource], CTX);
    expect(s.chosen).toBe(false);
    if (s.chosen) return;
    expect(s.reason).toMatch(/below the/);
  });
});

/* -------------------------------------------------------------------------- */
/* grading                                                                     */
/* -------------------------------------------------------------------------- */

describe("grading a lead", () => {
  it("A — verified person, verified number", () => {
    const g = gradeLead({
      decisionMakerName: "Maria Rivera",
      decisionMakerConfidence: 0.9,
      phoneClass: "verified_owner_mobile",
      directPhone: OWNER_MOBILE,
    });
    expect(g.grade).toBe("A");
    expect(g.callReady).toBe(true);
  });

  it("B — identified person, probable number", () => {
    const g = gradeLead({
      decisionMakerName: "Maria Rivera",
      decisionMakerConfidence: 0.7,
      phoneClass: "probable_owner_mobile",
      directPhone: OWNER_MOBILE,
    });
    expect(g.grade).toBe("B");
    expect(g.callReady).toBe(true);
  });

  it("B — verified number but the person is only identified", () => {
    const g = gradeLead({
      decisionMakerName: "Maria Rivera",
      decisionMakerConfidence: 0.6,
      phoneClass: "verified_owner_direct",
      directPhone: OWNER_MOBILE,
    });
    expect(g.grade).toBe("B");
  });

  it("C — the owner is known but only the switchboard is", () => {
    const g = gradeLead({
      decisionMakerName: "Maria Rivera",
      decisionMakerConfidence: 0.9,
      phoneClass: "main_business_line",
      directPhone: MAIN_LINE,
    });
    expect(g.grade).toBe("C");
    expect(g.callReady).toBe(false);
    expect(g.reason).toMatch(/no direct number/);
  });

  it("C — a direct phone stored against an unknown classification is not a direct number", () => {
    const g = gradeLead({
      decisionMakerName: "Maria Rivera",
      decisionMakerConfidence: 0.9,
      phoneClass: "unknown",
      directPhone: OTHER_DIRECT,
    });
    expect(g.grade).toBe("C");
  });

  it("D — nobody identified", () => {
    const g = gradeLead({
      decisionMakerName: null,
      decisionMakerConfidence: null,
      phoneClass: "verified_owner_mobile",
      directPhone: OWNER_MOBILE,
    });
    expect(g.grade).toBe("D");
    expect(g.callReady).toBe(false);
  });

  it("D — a name proposed below the floor is not an identification", () => {
    const g = gradeLead({
      decisionMakerName: "Maria Rivera",
      decisionMakerConfidence: MIN_DM_CONFIDENCE - 0.01,
      phoneClass: "verified_owner_mobile",
      directPhone: OWNER_MOBILE,
    });
    expect(g.grade).toBe("D");
    expect(g.reason).toMatch(/below the/);
  });

  it("only A and B are call-ready", () => {
    expect(CALL_READY_GRADES).toEqual(["A", "B"]);
    expect(isCallReady("A")).toBe(true);
    expect(isCallReady("B")).toBe(true);
    expect(isCallReady("C")).toBe(false);
    expect(isCallReady("D")).toBe(false);
    expect(isCallReady(null)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* assignment order                                                            */
/* -------------------------------------------------------------------------- */

describe("the order callers work in", () => {
  const row = (o: Partial<AssignmentCandidate> & { leadId: string }): AssignmentCandidate => ({
    grade: "B",
    phoneClass: "probable_owner_mobile",
    decisionMakerConfidence: 0.7,
    validatedAt: null,
    ...o,
  });

  it("grade first", () => {
    const ordered = orderForAssignment([
      row({ leadId: "c", grade: "C", phoneClass: "verified_owner_mobile" }),
      row({ leadId: "a", grade: "A", phoneClass: "probable_owner_direct" }),
      row({ leadId: "b", grade: "B" }),
    ]);
    expect(ordered.map((r) => r.leadId)).toEqual(["a", "b", "c"]);
  });

  it("then number quality", () => {
    const ordered = orderForAssignment([
      row({ leadId: "direct", grade: "A", phoneClass: "verified_owner_direct" }),
      row({ leadId: "mobile", grade: "A", phoneClass: "verified_owner_mobile" }),
    ]);
    expect(ordered.map((r) => r.leadId)).toEqual(["mobile", "direct"]);
  });

  it("then how sure we are of the person", () => {
    const ordered = orderForAssignment([
      row({ leadId: "unsure", decisionMakerConfidence: 0.6 }),
      row({ leadId: "sure", decisionMakerConfidence: 0.95 }),
    ]);
    expect(ordered.map((r) => r.leadId)).toEqual(["sure", "unsure"]);
  });

  it("then freshness, newest validation first", () => {
    const ordered = orderForAssignment([
      row({ leadId: "stale", validatedAt: "2026-01-01T00:00:00Z" }),
      row({ leadId: "fresh", validatedAt: "2026-07-01T00:00:00Z" }),
    ]);
    expect(ordered.map((r) => r.leadId)).toEqual(["fresh", "stale"]);
  });

  it("C and D never enter the direct queue", () => {
    const kept = callReadyOnly([
      row({ leadId: "d", grade: "D" }),
      row({ leadId: "a", grade: "A", phoneClass: "verified_owner_mobile" }),
      row({ leadId: "c", grade: "C" }),
      row({ leadId: "b", grade: "B" }),
    ]);
    expect(kept.map((r) => r.leadId)).toEqual(["a", "b"]);
  });

  it("does not mutate the caller's array", () => {
    const rows = [row({ leadId: "b", grade: "B" }), row({ leadId: "a", grade: "A" })];
    orderForAssignment(rows);
    expect(rows.map((r) => r.leadId)).toEqual(["b", "a"]);
  });

  it("is a stable comparator — equal rows compare equal", () => {
    const same = row({ leadId: "x" });
    expect(compareForAssignment(same, { ...same, leadId: "y" })).toBe(0);
  });
});

describe("ordering the rows a packet query actually returns", () => {
  it("puts the best-evidenced owner with the best number first", () => {
    const ordered = orderLeadsForAssignment([
      {
        id: "probable",
        enrichment_grade: "B",
        direct_phone_class: "probable_owner_direct",
        decision_maker_confidence: 0.6,
        direct_phone_validated_at: null,
      },
      {
        id: "best",
        enrichment_grade: "A",
        direct_phone_class: "verified_owner_mobile",
        decision_maker_confidence: 0.9,
        direct_phone_validated_at: "2026-07-30T00:00:00Z",
      },
    ]);
    expect(ordered.map((r) => r.id)).toEqual(["best", "probable"]);
  });

  it("SORTS UNGRADED ROWS LAST RATHER THAN DROPPING THEM — availability decides who gets in, not the sort", () => {
    const ordered = orderLeadsForAssignment([
      { id: "ungraded" },
      { id: "graded", enrichment_grade: "B", direct_phone_class: "probable_owner_mobile" },
    ]);
    expect(ordered.map((r) => r.id)).toEqual(["graded", "ungraded"]);
    expect(ordered).toHaveLength(2);
  });

  it("tolerates a grade the code does not recognise", () => {
    const ordered = orderLeadsForAssignment([
      { id: "junk", enrichment_grade: "Z" },
      { id: "real", enrichment_grade: "A", direct_phone_class: "verified_owner_mobile" },
    ]);
    expect(ordered.map((r) => r.id)).toEqual(["real", "junk"]);
  });

  it("the column list a query must select is the one the sort reads", () => {
    for (const col of [
      "enrichment_grade",
      "direct_phone_class",
      "decision_maker_confidence",
      "direct_phone_validated_at",
    ]) {
      expect(ASSIGNMENT_COLUMNS).toContain(col);
    }
  });

  it("does not mutate the rows handed to it", () => {
    const rows = [{ id: "b", enrichment_grade: "B" }, { id: "a", enrichment_grade: "A" }];
    orderLeadsForAssignment(rows);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
  });
});

/* -------------------------------------------------------------------------- */
/* budget                                                                      */
/* -------------------------------------------------------------------------- */

describe("what may be spent", () => {
  const p = { costPerHitCents: 20, label: "Test provider" };

  it("allows a call inside every cap", () => {
    expect(maySpend(p, 0, freshSpend(), DEFAULT_LIMITS).allowed).toBe(true);
  });

  it("stops at the per-lead cap", () => {
    const limits: BudgetLimits = { ...DEFAULT_LIMITS, maxCostPerLeadCents: 20 };
    const v = maySpend(p, 20, freshSpend(), limits);
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/per-lead cap/);
  });

  it("stops at the per-run cap", () => {
    const limits: BudgetLimits = { ...DEFAULT_LIMITS, perRunBudgetCents: 100 };
    const v = maySpend(p, 0, { monthToDateCents: 0, thisRunCents: 90 }, limits);
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/run/);
  });

  it("stops at the monthly cap", () => {
    const v = maySpend(p, 0, { monthToDateCents: DEFAULT_LIMITS.monthlyBudgetCents, thisRunCents: 0 }, DEFAULT_LIMITS);
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/monthly/);
  });

  it("the cap is a ceiling, not a threshold — landing exactly on it is allowed", () => {
    const limits: BudgetLimits = { ...DEFAULT_LIMITS, maxCostPerLeadCents: 40 };
    expect(maySpend(p, 20, freshSpend(), limits).allowed).toBe(true);
  });
});

describe("when a lead is worth enriching again", () => {
  const base = {
    attempts: 1,
    callerReportedWrong: false,
    businessChangedAt: null,
    adminRequested: false,
    newProviderSince: null,
    limits: DEFAULT_LIMITS,
    now: new Date("2026-08-01T00:00:00Z"),
  };

  it("always, if it has never been enriched", () => {
    const r = shouldReEnrich({ ...base, enrichedAt: null, attempts: 0 });
    expect(r.yes).toBe(true);
    expect(r.reason).toBe("never_enriched");
  });

  it("never, for fresh data with nothing changed", () => {
    const r = shouldReEnrich({ ...base, enrichedAt: "2026-07-20T00:00:00Z" });
    expect(r.yes).toBe(false);
    expect(r.detail).toMatch(/nothing has changed/);
  });

  it("once the data has expired", () => {
    const r = shouldReEnrich({ ...base, enrichedAt: "2026-01-01T00:00:00Z" });
    expect(r.yes).toBe(true);
    expect(r.reason).toBe("expired");
  });

  it("when a caller says the contact was wrong — the strongest signal there is", () => {
    const r = shouldReEnrich({
      ...base,
      enrichedAt: "2026-07-20T00:00:00Z",
      callerReportedWrong: true,
    });
    expect(r.yes).toBe(true);
    expect(r.reason).toBe("caller_reported_wrong");
  });

  it("when the business record itself changed", () => {
    const r = shouldReEnrich({
      ...base,
      enrichedAt: "2026-07-01T00:00:00Z",
      businessChangedAt: "2026-07-15T00:00:00Z",
    });
    expect(r.yes).toBe(true);
    expect(r.reason).toBe("business_changed");
  });

  it("when a provider was added after the last attempt", () => {
    const r = shouldReEnrich({
      ...base,
      enrichedAt: "2026-07-01T00:00:00Z",
      newProviderSince: "2026-07-10T00:00:00Z",
    });
    expect(r.yes).toBe(true);
    expect(r.reason).toBe("new_provider_available");
  });

  it("STOPS at the retry limit — paying repeatedly for the same nothing is the easiest money to waste", () => {
    const r = shouldReEnrich({
      ...base,
      enrichedAt: "2026-01-01T00:00:00Z",
      attempts: DEFAULT_LIMITS.maxRetries + 1,
      callerReportedWrong: true,
    });
    expect(r.yes).toBe(false);
    expect(r.detail).toMatch(/retry limit/);
  });

  it("an admin can override the retry limit deliberately", () => {
    const r = shouldReEnrich({
      ...base,
      enrichedAt: "2026-01-01T00:00:00Z",
      attempts: 9,
      adminRequested: true,
    });
    expect(r.yes).toBe(true);
    expect(r.reason).toBe("admin_requested");
  });
});

/* -------------------------------------------------------------------------- */
/* the waterfall                                                               */
/* -------------------------------------------------------------------------- */

describe("the direct-number waterfall", () => {
  it("returns the first sufficiently confident direct number", async () => {
    const out = await runWaterfall({
      subject: SUBJECT,
      providers: [hitProvider("first", OWNER_MOBILE)],
      spend: freshSpend(),
      limits: DEFAULT_LIMITS,
    });
    expect(out.phone).toBe(OWNER_MOBILE);
    expect(out.phoneClass).toBe("verified_owner_mobile");
    expect(out.provider).toBe("first");
    expect(out.sourceRef).toBe("first-ref");
    expect(out.validatedAt).not.toBeNull();
    expect(out.totalCostCents).toBe(20);
  });

  it("STOPS PAYING once it has a confident answer", async () => {
    const calls: string[] = [];
    const out = await runWaterfall({
      subject: SUBJECT,
      providers: [
        hitProvider("cheap", OWNER_MOBILE, { confidence: STOP_AT_CONFIDENCE, calls }),
        hitProvider("expensive", OTHER_DIRECT, { costCents: 200, calls }),
      ],
      spend: freshSpend(),
      limits: DEFAULT_LIMITS,
    });
    expect(calls).toEqual(["cheap"]);
    expect(out.totalCostCents).toBe(20);
    expect(out.phone).toBe(OWNER_MOBILE);
  });

  it("keeps going when the first provider finds nothing", async () => {
    const calls: string[] = [];
    const out = await runWaterfall({
      subject: SUBJECT,
      providers: [
        provider({
          key: "empty",
          lookup: async () => {
            calls.push("empty");
            return { provider: "empty", phones: [], retrievedAt: "", costCents: 0 };
          },
        }),
        hitProvider("second", OWNER_MOBILE, { calls }),
      ],
      spend: freshSpend(),
      limits: DEFAULT_LIMITS,
    });
    expect(calls).toEqual(["empty", "second"]);
    expect(out.provider).toBe("second");
  });

  it("A PROVIDER THROWING DOES NOT END THE RUN", async () => {
    const calls: string[] = [];
    const out = await runWaterfall({
      subject: SUBJECT,
      providers: [
        provider({
          key: "broken",
          lookup: async () => {
            calls.push("broken");
            throw new Error("503 upstream");
          },
        }),
        hitProvider("working", OWNER_MOBILE, { calls }),
      ],
      spend: freshSpend(),
      limits: DEFAULT_LIMITS,
    });
    expect(calls).toEqual(["broken", "working"]);
    expect(out.phone).toBe(OWNER_MOBILE);
    const broken = out.attempts.find((a) => a.provider === "broken")!;
    expect(broken.error).toMatch(/503 upstream/);
    // A throw is not a bill.
    expect(broken.costCents).toBe(0);
  });

  it("a provider that reports an error still records what it cost", async () => {
    const out = await runWaterfall({
      subject: SUBJECT,
      providers: [
        provider({
          key: "erroring",
          lookup: async () => ({
            provider: "erroring",
            phones: [],
            retrievedAt: "",
            costCents: 0,
            error: "HTTP 429: rate limited",
          }),
        }),
      ],
      spend: freshSpend(),
      limits: DEFAULT_LIMITS,
    });
    expect(out.phone).toBeNull();
    expect(out.attempts[0].error).toMatch(/429/);
  });

  it("skips an unconfigured provider and says why, without erroring", async () => {
    const out = await runWaterfall({
      subject: SUBJECT,
      providers: [
        provider({
          key: "unconfigured",
          isAvailable: () => false,
          unavailableReason: () => "PDL_API_KEY is not set in the environment.",
          lookup: async () => {
            throw new Error("must never be called");
          },
        }),
      ],
      spend: freshSpend(),
      limits: DEFAULT_LIMITS,
    });
    expect(out.phone).toBeNull();
    expect(out.attempts[0].tried).toBe(false);
    expect(out.attempts[0].skippedReason).toMatch(/PDL_API_KEY/);
    expect(out.reason).toMatch(/No contact provider was available/);
    expect(out.stoppedByBudget).toBe(false);
  });

  it("CHECKS THE BUDGET BEFORE CALLING — the provider is never asked", async () => {
    const calls: string[] = [];
    const out = await runWaterfall({
      subject: SUBJECT,
      providers: [hitProvider("costly", OWNER_MOBILE, { costCents: 200, calls })],
      spend: freshSpend(),
      limits: { ...DEFAULT_LIMITS, maxCostPerLeadCents: 50 },
    });
    expect(calls).toEqual([]);
    expect(out.stoppedByBudget).toBe(true);
    expect(out.totalCostCents).toBe(0);
    expect(out.reason).toMatch(/budget/i);
  });

  it("stops the whole waterfall once the run budget is gone", async () => {
    const calls: string[] = [];
    const out = await runWaterfall({
      subject: SUBJECT,
      providers: [
        hitProvider("one", OTHER_DIRECT, { confidence: 0.5, providerVerified: false, calls }),
        hitProvider("two", OWNER_MOBILE, { calls }),
      ],
      spend: { monthToDateCents: 0, thisRunCents: 0 },
      limits: { ...DEFAULT_LIMITS, perRunBudgetCents: 20 },
    });
    expect(calls).toEqual(["one"]);
    expect(out.stoppedByBudget).toBe(true);
  });

  it("respects the provider-attempt limit even when everything is affordable", async () => {
    const calls: string[] = [];
    await runWaterfall({
      subject: SUBJECT,
      providers: [
        hitProvider("a", OTHER_DIRECT, { confidence: 0.5, providerVerified: false, calls }),
        hitProvider("b", OTHER_DIRECT, { confidence: 0.5, providerVerified: false, calls }),
        hitProvider("c", OWNER_MOBILE, { calls }),
      ],
      spend: freshSpend(),
      limits: { ...DEFAULT_LIMITS, maxProviderAttempts: 2, maxCostPerLeadCents: 1000 },
    });
    expect(calls).toEqual(["a", "b"]);
  });

  it("the running spend is carried back out, so the caller can persist it", async () => {
    const spend = freshSpend();
    await runWaterfall({
      subject: SUBJECT,
      providers: [hitProvider("first", OWNER_MOBILE)],
      spend,
      limits: DEFAULT_LIMITS,
    });
    expect(spend.thisRunCents).toBe(20);
    expect(spend.monthToDateCents).toBe(20);
  });

  it("NEVER RETURNS THE MAIN BUSINESS LINE, even when a provider insists", async () => {
    const out = await runWaterfall({
      subject: SUBJECT,
      providers: [hitProvider("liar", MAIN_LINE)],
      spend: freshSpend(),
      limits: DEFAULT_LIMITS,
    });
    expect(out.phone).toBeNull();
    expect(out.reason).toMatch(/No provider returned a usable direct number/);
  });

  it("discards a number below the confidence floor rather than storing it", async () => {
    const out = await runWaterfall({
      subject: SUBJECT,
      providers: [hitProvider("weak", OWNER_MOBILE, { confidence: 0.2 })],
      spend: freshSpend(),
      limits: DEFAULT_LIMITS,
    });
    expect(out.phone).toBeNull();
  });

  it("refuses a number that contradicts what another source gave", async () => {
    const out = await runWaterfall({
      subject: SUBJECT,
      providers: [hitProvider("disagreeing", OTHER_DIRECT)],
      spend: freshSpend(),
      limits: DEFAULT_LIMITS,
      knownNumbers: [OWNER_MOBILE],
    });
    expect(out.phone).toBeNull();
  });

  it("prefers the better class when one provider returns several numbers", async () => {
    const out = await runWaterfall({
      subject: SUBJECT,
      providers: [
        provider({
          key: "multi",
          lookup: async () => ({
            provider: "multi",
            phones: [
              {
                phone: OTHER_DIRECT,
                lineType: "landline",
                confidence: 0.6,
                providerVerified: false,
                sourceRef: null,
              },
              {
                phone: OWNER_MOBILE,
                lineType: "mobile",
                confidence: 0.9,
                providerVerified: true,
                sourceRef: "x",
              },
            ],
            retrievedAt: "",
            costCents: 20,
          }),
        }),
      ],
      spend: freshSpend(),
      limits: DEFAULT_LIMITS,
    });
    expect(out.phone).toBe(OWNER_MOBILE);
    expect(out.phoneClass).toBe("verified_owner_mobile");
  });

  it("carries an email and profile back even when no number was found", async () => {
    const out = await runWaterfall({
      subject: SUBJECT,
      providers: [
        provider({
          key: "email_only",
          lookup: async () => ({
            provider: "email_only",
            phones: [],
            email: "maria@riveraplumbing.com",
            profileUrl: "https://linkedin.example/in/maria",
            retrievedAt: "",
            costCents: 0,
          }),
        }),
      ],
      spend: freshSpend(),
      limits: DEFAULT_LIMITS,
    });
    expect(out.phone).toBeNull();
    expect(out.email).toBe("maria@riveraplumbing.com");
    expect(out.profileUrl).toBe("https://linkedin.example/in/maria");
  });
});

/* -------------------------------------------------------------------------- */
/* the mapping of a real provider's response                                    */
/* -------------------------------------------------------------------------- */

describe("People Data Labs response mapping", () => {
  const subject = { mainBusinessPhone: MAIN_LINE };

  it("maps an explicit mobile as the strongest thing it returns", () => {
    const { phones } = normalisePdl(
      { likelihood: 9, data: { id: "pdl-1", mobile_phone: "313-482-0199" } },
      subject
    );
    expect(phones).toHaveLength(1);
    expect(phones[0].phone).toBe(OWNER_MOBILE);
    expect(phones[0].lineType).toBe("mobile");
    expect(phones[0].providerVerified).toBe(true);
    expect(phones[0].sourceRef).toBe("pdl-1");
    expect(phones[0].confidence).toBeCloseTo(0.9);
  });

  it("DROPS the main business number rather than selling it back as a personal line", () => {
    const { phones } = normalisePdl(
      { likelihood: 9, data: { mobile_phone: MAIN_LINE, phone_numbers: ["313-482-0100"] } },
      subject
    );
    expect(phones).toEqual([]);
  });

  it("deduplicates the same number arriving twice", () => {
    const { phones } = normalisePdl(
      {
        likelihood: 8,
        data: { mobile_phone: "3134820199", phone_numbers: ["(313) 482-0199"] },
      },
      subject
    );
    expect(phones).toHaveLength(1);
  });

  it("does not claim verification for numbers from the general list", () => {
    const { phones } = normalisePdl(
      { likelihood: 7, data: { phone_numbers: [{ number: OTHER_DIRECT, type: "landline" }] } },
      subject
    );
    expect(phones[0].providerVerified).toBe(false);
    expect(phones[0].lineType).toBe("landline");
  });

  it("returns empty rather than guessing when there is no data", () => {
    expect(normalisePdl({}, subject)).toEqual({ phones: [], email: null, profileUrl: null });
    expect(normalisePdl(null, subject).phones).toEqual([]);
  });

  it("picks up an email and profile when they are there", () => {
    const r = normalisePdl(
      {
        likelihood: 8,
        data: { work_email: "maria@riveraplumbing.com", linkedin_url: "https://li.example/maria" },
      },
      subject
    );
    expect(r.email).toBe("maria@riveraplumbing.com");
    expect(r.profileUrl).toBe("https://li.example/maria");
  });
});

/* -------------------------------------------------------------------------- */
/* what the caller found out                                                   */
/* -------------------------------------------------------------------------- */

describe("feeding the call outcome back into the data", () => {
  it("every outcome has a defined effect", () => {
    for (const o of CONTACT_OUTCOMES) {
      expect(effectOf(o)).toBeTruthy();
    }
  });

  it("confirmation raises confidence a little", () => {
    const r = correctedConfidence(0.7, "correct_owner_reached");
    expect(r.confidence).toBeGreaterThan(0.7);
    expect(r.stillAsserted).toBe(true);
  });

  it("A REFUSAL FROM THE RIGHT PERSON STILL CONFIRMS THE DATA", () => {
    expect(CONFIRMING).toContain("owner_declined");
    expect(effectOf("owner_declined").providerCredit).toBe(1);
    expect(effectOf("owner_declined").suppressPhone).toBe(false);
  });

  it("contradiction drops it a lot — and stops the claim being made", () => {
    const r = correctedConfidence(0.9, "wrong_person");
    expect(r.confidence).toBeLessThan(MIN_DM_CONFIDENCE);
    expect(r.stillAsserted).toBe(false);
    expect(effectOf("wrong_person").suppressDecisionMaker).toBe(true);
    expect(effectOf("wrong_person").suppressPhone).toBe(true);
    expect(effectOf("wrong_person").requeue).toBe(true);
  });

  it("a dead number condemns the number, not the person", () => {
    const e = effectOf("wrong_number");
    expect(e.suppressPhone).toBe(true);
    expect(e.suppressDecisionMaker).toBe(false);
  });

  it("an owner who has left the business invalidates everything", () => {
    const e = effectOf("owner_no_longer_there");
    expect(e.suppressPhone).toBe(true);
    expect(e.suppressDecisionMaker).toBe(true);
    expect(correctedConfidence(0.9, "owner_no_longer_there").confidence).toBeLessThan(0.2);
  });

  it("the switchboard sold back as a direct line is reclassified and re-enriched", () => {
    const e = effectOf("main_line_not_direct");
    expect(e.reclassifyAs).toBe("main_business_line");
    expect(e.requeue).toBe(true);
    expect(e.providerCredit).toBe(-1);
  });

  it("a gatekeeper proves nothing either way", () => {
    const e = effectOf("gatekeeper_reached");
    expect(e.confidenceMultiplier).toBe(1);
    expect(e.providerCredit).toBe(0);
    expect(e.suppressPhone).toBe(false);
  });

  it("confidence never runs away or goes negative", () => {
    expect(correctedConfidence(0.98, "appointment_booked").confidence).toBeLessThanOrEqual(0.98);
    expect(correctedConfidence(0, "wrong_person").confidence).toBe(0);
    expect(correctedConfidence(null, "correct_owner_reached").confidence).toBeGreaterThan(0.5);
  });

  it("every contradicting outcome requeues the lead", () => {
    for (const o of CONTRADICTING) {
      expect(effectOf(o).requeue).toBe(true);
    }
  });
});

describe("ranking providers on what the callers found", () => {
  it("WITHHOLDS a verdict below the minimum — dropping a good provider on a bad run is the failure mode", () => {
    const [s] = scoreProviders([
      { provider: "pdl", confirmed: 3, contradicted: 1, neutral: 5 },
    ]);
    expect(s.accuracy).toBeNull();
    expect(s.judged).toBe(4);
    expect(s.verdict).toMatch(/too few to rank/);
  });

  it("scores once there are enough judged calls", () => {
    const [s] = scoreProviders([
      { provider: "pdl", confirmed: 30, contradicted: 10, neutral: 100 },
    ]);
    expect(s.judged).toBe(40);
    expect(s.accuracy).toBeCloseTo(0.75);
    expect(s.verdict).toMatch(/75%/);
  });

  it("neutral calls do not count either way", () => {
    const [s] = scoreProviders([
      { provider: "pdl", confirmed: 10, contradicted: 10, neutral: 999 },
    ]);
    expect(s.judged).toBe(20);
    expect(s.judged).toBe(MIN_CALLS_TO_RANK_PROVIDER);
    expect(s.accuracy).toBeCloseTo(0.5);
  });

  it("puts the most accurate first, and the unranked last", () => {
    const scored = scoreProviders([
      { provider: "unranked", confirmed: 2, contradicted: 0, neutral: 0 },
      { provider: "weak", confirmed: 10, contradicted: 30, neutral: 0 },
      { provider: "strong", confirmed: 35, contradicted: 5, neutral: 0 },
    ]);
    expect(scored.map((s) => s.provider)).toEqual(["strong", "weak", "unranked"]);
  });
});

/* -------------------------------------------------------------------------- */
/* where a lead got to                                                         */
/* -------------------------------------------------------------------------- */

describe("the enrichment state a lead ends in", () => {
  const clean = {
    ownerIdentified: true,
    ambiguous: false,
    conflicting: false,
    directNumberFound: true,
    numberValidated: true,
    providerAvailable: true,
    budgetStopped: false,
  };

  it("the whole way through", () => {
    expect(nextState(clean)).toBe("call_ready");
    expect(isCallReadyState("call_ready")).toBe(true);
  });

  it("names the reason it stopped instead of silently passing", () => {
    expect(nextState({ ...clean, ownerIdentified: false })).toBe("no_owner_found");
    expect(nextState({ ...clean, directNumberFound: false })).toBe("no_direct_number");
    expect(nextState({ ...clean, numberValidated: false })).toBe("validation_failed");
    expect(nextState({ ...clean, ambiguous: true })).toBe("ambiguous_match");
    expect(nextState({ ...clean, conflicting: true })).toBe("conflicting_information");
  });

  it("REPORTS FIXABLE CONFIGURATION AHEAD OF 'no number' — otherwise somebody hunts a lead problem that does not exist", () => {
    expect(nextState({ ...clean, directNumberFound: false, budgetStopped: true })).toBe(
      "budget_exceeded"
    );
    expect(nextState({ ...clean, directNumberFound: false, providerAvailable: false })).toBe(
      "provider_unavailable"
    );
  });

  it("a lead with no owner is not call-ready however good the number is", () => {
    const s = nextState({ ...clean, ownerIdentified: false });
    expect(isCallReadyState(s)).toBe(false);
  });

  it("every stopped state stays retryable — a failure that disappears is one nobody fixes", () => {
    expect(isRetryable("no_direct_number")).toBe(true);
    expect(isRetryable("budget_exceeded")).toBe(true);
    expect(isRetryable("call_ready")).toBe(false);
    expect(isRetryable(null)).toBe(false);
  });
});
