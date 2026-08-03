// Where the default lead run searches.
//
// This exists because of a chain nobody noticed until a caller's screen showed
// it: the default metro list opened with Detroit and also carried Chicago and
// Tampa. All three are all-party consent states, so under the "skip two-party
// states" recording policy those calls can never be recorded — no transcript,
// no AI reading, nothing in the review queue. A quarter of the default mix,
// including the biggest metro on the list, was unreviewable by construction.
//
// The rule below is the whole point: a lead the team cannot record is still a
// lead worth calling, but it should be chosen deliberately, not arrive by
// default.

import { describe, it, expect } from "vitest";
import {
  CANDIDATE_METROS,
  RECORDABLE_METROS,
  ALL_PARTY_METROS,
  DEFAULT_METROS,
  DEFAULT_ALL_PARTY_METROS,
  formatMetro,
  QUICK_MIX_TRADES,
} from "../src/lib/metros";
import { ALL_PARTY_CONSENT_STATES, isAllPartyState } from "../src/lib/consent";

describe("the default lead run only searches recordable states", () => {
  it("EVERY DEFAULT METRO IS IN A ONE-PARTY STATE", () => {
    // The check that would have caught this. Derived from the app's own list,
    // so adding a state to consent.ts automatically drops any metro in it.
    for (const m of RECORDABLE_METROS) {
      expect(isAllPartyState(m.state), formatMetro(m)).toBe(false);
    }
    expect(DEFAULT_METROS.length).toBe(RECORDABLE_METROS.length);
  });

  it("none of the metros that caused this are in the default any more", () => {
    for (const gone of ["Detroit, MI", "Chicago, IL", "Tampa, FL"]) {
      expect(DEFAULT_METROS).not.toContain(gone);
    }
  });

  it("but they are still addressable on purpose", () => {
    // Deleting them would have been the wrong fix: they are good leads, they
    // just cannot be recorded.
    expect(DEFAULT_ALL_PARTY_METROS).toContain("Detroit, MI");
    expect(DEFAULT_ALL_PARTY_METROS).toContain("Chicago, IL");
    expect(DEFAULT_ALL_PARTY_METROS).toContain("Tampa, FL");
  });

  it("the two lists are a clean partition of the candidates", () => {
    expect(RECORDABLE_METROS.length + ALL_PARTY_METROS.length).toBe(
      CANDIDATE_METROS.length
    );
    const overlap = RECORDABLE_METROS.filter((r) =>
      ALL_PARTY_METROS.some((a) => a.city === r.city && a.state === r.state)
    );
    expect(overlap).toEqual([]);
  });

  it("every all-party metro really is in an all-party state", () => {
    for (const m of ALL_PARTY_METROS) {
      expect(ALL_PARTY_CONSENT_STATES as readonly string[], formatMetro(m)).toContain(
        m.state
      );
    }
  });
});

describe("the default mix is still a usable spread", () => {
  it("has enough metros to be worth calling a mix", () => {
    expect(DEFAULT_METROS.length).toBeGreaterThanOrEqual(10);
  });

  it("is not concentrated in one state", () => {
    // Filling the list with Texas would technically satisfy the rule above and
    // ruin the point of a mix.
    const byState = new Map<string, number>();
    for (const m of RECORDABLE_METROS) {
      byState.set(m.state, (byState.get(m.state) || 0) + 1);
    }
    expect(byState.size).toBeGreaterThanOrEqual(8);
    const biggest = Math.max(...byState.values());
    expect(biggest).toBeLessThanOrEqual(Math.ceil(RECORDABLE_METROS.length / 3));
  });

  it("formats the way the search planner expects", () => {
    for (const m of DEFAULT_METROS) {
      expect(m).toMatch(/^[A-Za-z .'-]+, [A-Z]{2}$/);
    }
  });

  it("no duplicates", () => {
    expect(new Set(DEFAULT_METROS).size).toBe(DEFAULT_METROS.length);
  });

  it("the trade mix is untouched — this change was about geography only", () => {
    expect(QUICK_MIX_TRADES).toContain("hvac");
    expect(QUICK_MIX_TRADES).toContain("plumbing");
    expect(QUICK_MIX_TRADES.length).toBeGreaterThanOrEqual(10);
  });
});
