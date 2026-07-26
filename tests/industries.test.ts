import { describe, it, expect } from "vitest";
import {
  INDUSTRIES,
  INDUSTRY_MAP,
  findIndustry,
  roleBasedAsk,
  searchTermsFor,
} from "../src/lib/industries";

describe("home-service industry presets", () => {
  it("covers more than just roofing", () => {
    expect(INDUSTRIES.length).toBeGreaterThan(15);
    const keys = INDUSTRIES.map((i) => i.key);
    for (const trade of ["roofing", "hvac", "plumbing", "electrical", "restoration"]) {
      expect(keys).toContain(trade);
    }
  });

  it("every vertical has search terms, an ask, and a fit rationale", () => {
    for (const ind of INDUSTRIES) {
      expect(ind.searchTerms.length).toBeGreaterThan(0);
      expect(ind.askFor).toBeTruthy();
      expect(ind.whyFit).toBeTruthy();
    }
  });

  it("has no duplicate keys", () => {
    const keys = INDUSTRIES.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("builds a deduplicated search-term list from several trades", () => {
    const terms = searchTermsFor(["roofing", "hvac"]);
    expect(terms).toContain("roofer");
    expect(terms).toContain("hvac contractor");
    expect(new Set(terms).size).toBe(terms.length);
  });

  it("ignores unknown preset keys", () => {
    expect(searchTermsFor(["not_a_trade"])).toEqual([]);
  });

  it("looks up a vertical by key or label", () => {
    expect(findIndustry("hvac")?.key).toBe("hvac");
    expect(findIndustry("HVAC")?.key).toBe("hvac");
    expect(findIndustry("Pest Control")?.key).toBe("pest_control");
    expect(findIndustry("Water / Fire Restoration")?.key).toBe("restoration");
  });

  it("returns null for unknown industries rather than guessing", () => {
    expect(findIndustry("underwater basket weaving")).toBeNull();
    expect(findIndustry(null)).toBeNull();
    expect(findIndustry("")).toBeNull();
  });
});

describe("role-based ask (Success Level C)", () => {
  it("uses the trade-specific role", () => {
    expect(roleBasedAsk("plumbing")).toContain("dispatcher");
    expect(roleBasedAsk("restoration")).toContain("operations manager");
    expect(roleBasedAsk("hvac")).toContain("service manager");
  });

  it("falls back to the owner for unknown industries", () => {
    expect(roleBasedAsk("something else")).toContain("the owner");
    expect(roleBasedAsk(null)).toContain("the owner");
  });

  it("always asks for a callback name and time", () => {
    for (const ind of INDUSTRIES) {
      const ask = roleBasedAsk(ind.key);
      expect(ask.toLowerCase()).toContain("name");
      expect(ask.toLowerCase()).toContain("call back");
    }
  });

  it("every preset key resolves through the map", () => {
    for (const ind of INDUSTRIES) {
      expect(INDUSTRY_MAP[ind.key]).toBeDefined();
    }
  });
});
