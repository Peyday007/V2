import { describe, it, expect } from "vitest";
import { planSearches, textQueryFor } from "../src/lib/searchPlan";
import { qualifyBusiness, looksLikeFranchise } from "../src/lib/qualify";
import { backoffSeconds } from "../src/lib/jobs.pure";
import {
  MACHINE_STATUSES,
  MACHINE_STATUS_LABELS,
  isMachineStatus,
  needsEnrichmentQueue,
  isPacketEligible,
} from "../src/lib/machineStatus";

describe("search planning", () => {
  it("builds the keyword x location grid", () => {
    const plan = planSearches({
      search_terms: ["roofer", "roofing contractor"],
      industry: "Roofing",
      city: "Detroit",
      state: "MI",
      zips: null,
    });
    expect(plan).toHaveLength(2);
    expect(plan[0]).toEqual({ search_term: "roofer", location: "Detroit, MI" });
  });

  it("prefers ZIPs over city for finer coverage", () => {
    const plan = planSearches({
      search_terms: ["roofer"],
      industry: null,
      city: "Detroit",
      state: "MI",
      zips: ["48201", "48226"],
    });
    expect(plan).toHaveLength(2);
    expect(plan.map((p) => p.location)).toEqual(["48201 MI", "48226 MI"]);
  });

  it("falls back to the industry when no search terms are given", () => {
    const plan = planSearches({
      search_terms: [],
      industry: "Plumbing",
      city: "Warren",
      state: "MI",
      zips: null,
    });
    expect(plan).toEqual([{ search_term: "Plumbing", location: "Warren, MI" }]);
  });

  it("deduplicates identical combinations", () => {
    const plan = planSearches({
      search_terms: ["roofer", "Roofer", "roofer"],
      industry: null,
      city: "Troy",
      state: "MI",
      zips: null,
    });
    expect(plan).toHaveLength(1);
  });

  it("returns nothing when there is no location", () => {
    expect(
      planSearches({
        search_terms: ["roofer"],
        industry: null,
        city: null,
        state: null,
        zips: null,
      })
    ).toEqual([]);
  });

  it("formats the Places text query", () => {
    expect(
      textQueryFor({ search_term: "roof repair", location: "Southfield, MI" })
    ).toBe("roof repair in Southfield, MI");
  });
});

const OPEN_RULES = {
  min_rating: null,
  min_review_count: null,
  max_review_count: null,
  require_website: false,
  exclude_franchises: false,
};

const BASE = {
  business_name: "Turner Roofing",
  phone: "(313) 555-0100",
  normalized_phone: "3135550100",
  website: "https://turnerroofing.com",
  rating: 4.7,
  review_count: 120,
  business_status: "OPERATIONAL",
};

describe("quick qualification", () => {
  it("passes a clean business", () => {
    expect(qualifyBusiness(BASE, OPEN_RULES)).toEqual({ passed: true });
  });

  it("rejects a business with no usable phone", () => {
    const r = qualifyBusiness({ ...BASE, normalized_phone: null }, OPEN_RULES);
    expect(r.passed).toBe(false);
    if (!r.passed) expect(r.reason).toContain("phone");
  });

  it("rejects permanently closed businesses", () => {
    const r = qualifyBusiness(
      { ...BASE, business_status: "CLOSED_PERMANENTLY" },
      OPEN_RULES
    );
    expect(r.passed).toBe(false);
    if (!r.passed) expect(r.reason).toContain("not operational");
  });

  it("enforces the website requirement only when enabled", () => {
    const noSite = { ...BASE, website: null };
    expect(qualifyBusiness(noSite, OPEN_RULES).passed).toBe(true);
    expect(
      qualifyBusiness(noSite, { ...OPEN_RULES, require_website: true }).passed
    ).toBe(false);
  });

  it("enforces rating and review thresholds", () => {
    expect(
      qualifyBusiness({ ...BASE, rating: 3.2 }, { ...OPEN_RULES, min_rating: 4 }).passed
    ).toBe(false);
    expect(
      qualifyBusiness({ ...BASE, review_count: 5 }, { ...OPEN_RULES, min_review_count: 20 })
        .passed
    ).toBe(false);
    expect(
      qualifyBusiness(
        { ...BASE, review_count: 9000 },
        { ...OPEN_RULES, max_review_count: 500 }
      ).passed
    ).toBe(false);
  });

  it("treats a missing rating as a failure when a minimum is set", () => {
    const r = qualifyBusiness({ ...BASE, rating: null }, { ...OPEN_RULES, min_rating: 4 });
    expect(r.passed).toBe(false);
  });

  it("respects the do-not-call suppression list", () => {
    const r = qualifyBusiness({ ...BASE, do_not_call: true }, OPEN_RULES);
    expect(r.passed).toBe(false);
    if (!r.passed) expect(r.reason).toContain("do-not-call");
  });

  it("detects franchises without false-positives on local firms", () => {
    expect(looksLikeFranchise("LeafFilter Gutter Protection")).toBe(true);
    expect(looksLikeFranchise("Roto-Rooter Plumbing")).toBe(true);
    expect(looksLikeFranchise("Turner Roofing")).toBe(false);
    expect(looksLikeFranchise("Owens Family Roofing")).toBe(false);
  });

  it("only excludes franchises when the campaign asks", () => {
    const chain = { ...BASE, business_name: "LeafFilter Gutter Protection" };
    expect(qualifyBusiness(chain, OPEN_RULES).passed).toBe(true);
    expect(
      qualifyBusiness(chain, { ...OPEN_RULES, exclude_franchises: true }).passed
    ).toBe(false);
  });

  it("gives a reason on every failure", () => {
    const r = qualifyBusiness({ ...BASE, business_name: "" }, OPEN_RULES);
    expect(r.passed).toBe(false);
    if (!r.passed) expect(r.reason.length).toBeGreaterThan(0);
  });
});

describe("job retry backoff", () => {
  it("grows exponentially", () => {
    expect(backoffSeconds(1)).toBe(30);
    expect(backoffSeconds(2)).toBe(60);
    expect(backoffSeconds(3)).toBe(120);
    expect(backoffSeconds(4)).toBe(240);
  });

  it("caps at 15 minutes so a stuck job never backs off forever", () => {
    expect(backoffSeconds(20)).toBe(900);
  });

  it("handles a zero/negative attempt count", () => {
    expect(backoffSeconds(0)).toBe(30);
  });
});

describe("machine statuses", () => {
  it("has a label for every status", () => {
    for (const s of MACHINE_STATUSES) expect(MACHINE_STATUS_LABELS[s]).toBeTruthy();
  });

  it("only ready_for_calling is packet eligible", () => {
    expect(isPacketEligible("ready_for_calling")).toBe(true);
    for (const s of MACHINE_STATUSES) {
      if (s !== "ready_for_calling") expect(isPacketEligible(s)).toBe(false);
    }
  });

  it("queues enrichment only for leads that have not had it", () => {
    expect(needsEnrichmentQueue("discovered")).toBe(true);
    expect(needsEnrichmentQueue("normalized")).toBe(true);
  });

  it("PREVENTS duplicate enrichment for leads already queued or done", () => {
    for (const s of [
      "enrichment_queued",
      "enriching",
      "decision_maker_found",
      "role_only_found",
      "enrichment_failed",
      "ready_for_calling",
      "assigned_to_packet",
      "contacted",
      "archived",
    ]) {
      expect(needsEnrichmentQueue(s)).toBe(false);
    }
  });

  it("rejects unknown statuses", () => {
    expect(isMachineStatus("banana")).toBe(false);
    expect(needsEnrichmentQueue("banana")).toBe(false);
  });
});

import { requestBudgetFor } from "../src/lib/budget";

describe("API request budget derived from lead target", () => {
  it("scales with the target so the user never sets it", () => {
    expect(requestBudgetFor(100)).toBe(17);
    expect(requestBudgetFor(300)).toBe(50);
    expect(requestBudgetFor(500)).toBe(84);
  });

  it("has a floor so tiny campaigns still run", () => {
    expect(requestBudgetFor(1)).toBe(5);
    expect(requestBudgetFor(0)).toBe(5);
  });

  it("has a hard ceiling so a typo cannot authorize runaway spend", () => {
    expect(requestBudgetFor(1_000_000)).toBe(400);
  });

  it("handles garbage input", () => {
    expect(requestBudgetFor(NaN)).toBe(5);
  });
});
