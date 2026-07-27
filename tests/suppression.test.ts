import { describe, it, expect } from "vitest";
import {
  buildSuppressionIndex,
  checkSuppressed,
  partitionEligible,
  phoneKeyFor,
  siblingsToSuppress,
} from "../src/lib/suppression";

/**
 * The bug these tests exist for: a do-not-call request was recorded against
 * ONE lead record, while the same business sitting in the database under a
 * second record stayed dialable. A DNC is about the number, not the row.
 */

const DNC_PHONE = "3135550100";

describe("phoneKeyFor", () => {
  it("prefers the normalized column", () => {
    expect(phoneKeyFor({ id: "a", normalized_phone: DNC_PHONE, phone: "(313) 555-0100" })).toBe(
      DNC_PHONE
    );
  });

  it("falls back to normalizing the raw phone, because not every path sets the column", () => {
    expect(phoneKeyFor({ id: "a", phone: "(313) 555-0100" })).toBe(DNC_PHONE);
  });

  it("strips a leading country code so the same number matches either way", () => {
    expect(phoneKeyFor({ id: "a", phone: "+1 313-555-0100" })).toBe(DNC_PHONE);
  });

  it("returns null for a number it cannot make sense of, rather than a partial match", () => {
    expect(phoneKeyFor({ id: "a", phone: "555-0100" })).toBeNull();
    expect(phoneKeyFor({ id: "a" })).toBeNull();
  });
});

describe("buildSuppressionIndex", () => {
  it("indexes both the lead id and the number", () => {
    const idx = buildSuppressionIndex([{ lead_id: "lead-1", normalized_phone: DNC_PHONE }]);
    expect(idx.leadIds.has("lead-1")).toBe(true);
    expect(idx.phones.has(DNC_PHONE)).toBe(true);
  });

  it("tolerates a manual entry with no lead attached", () => {
    const idx = buildSuppressionIndex([{ lead_id: null, normalized_phone: DNC_PHONE }]);
    expect(idx.phones.has(DNC_PHONE)).toBe(true);
    expect(idx.leadIds.size).toBe(0);
  });

  it("normalizes stored numbers, so a badly formatted row still blocks", () => {
    const idx = buildSuppressionIndex([{ normalized_phone: "1-313-555-0100" }]);
    expect(idx.phones.has(DNC_PHONE)).toBe(true);
  });

  it("an empty list blocks nothing", () => {
    const idx = buildSuppressionIndex([]);
    expect(checkSuppressed({ id: "x", phone: "313-555-0100" }, idx).suppressed).toBe(false);
  });
});

describe("checkSuppressed — this is the bug being fixed", () => {
  const index = buildSuppressionIndex([
    { lead_id: "lead-1", normalized_phone: DNC_PHONE },
  ]);

  it("blocks the lead the request was recorded against", () => {
    const r = checkSuppressed({ id: "lead-1", normalized_phone: DNC_PHONE }, index);
    expect(r.suppressed).toBe(true);
    expect(r.matchedOn).toBe("lead");
  });

  it("BLOCKS A DIFFERENT RECORD FOR THE SAME BUSINESS", () => {
    const duplicate = { id: "lead-2-a-duplicate-row", normalized_phone: DNC_PHONE };
    const r = checkSuppressed(duplicate, index);
    expect(r.suppressed).toBe(true);
    expect(r.matchedOn).toBe("phone");
    expect(r.reason).toContain("another record for the same business");
  });

  it("blocks a duplicate whose normalized column was never populated", () => {
    const r = checkSuppressed({ id: "lead-3", phone: "+1 (313) 555-0100" }, index);
    expect(r.suppressed).toBe(true);
  });

  it("honours the lead's own do_not_call flag even with an empty list", () => {
    const r = checkSuppressed(
      { id: "lead-9", phone: "2485550111", do_not_call: true },
      buildSuppressionIndex([])
    );
    expect(r.suppressed).toBe(true);
    expect(r.matchedOn).toBe("flag");
  });

  it("does not block an unrelated business", () => {
    const r = checkSuppressed({ id: "lead-4", normalized_phone: "2485550111" }, index);
    expect(r.suppressed).toBe(false);
    expect(r.reason).toBeNull();
  });

  it("does not block a lead with no phone number at all", () => {
    expect(checkSuppressed({ id: "lead-5" }, index).suppressed).toBe(false);
  });
});

describe("partitionEligible", () => {
  const index = buildSuppressionIndex([{ normalized_phone: DNC_PHONE }]);

  it("keeps callable leads and separates the blocked ones", () => {
    const { eligible, blocked } = partitionEligible(
      [
        { id: "ok-1", normalized_phone: "2485550111" },
        { id: "dnc-1", normalized_phone: DNC_PHONE },
        { id: "ok-2", normalized_phone: "2485550112" },
        { id: "dnc-2", phone: "313.555.0100" },
      ],
      index
    );
    expect(eligible.map((l) => l.id)).toEqual(["ok-1", "ok-2"]);
    expect(blocked.map((b) => b.lead.id)).toEqual(["dnc-1", "dnc-2"]);
  });

  it("preserves order, so packet position stays stable", () => {
    const leads = [
      { id: "a", normalized_phone: "2485550111" },
      { id: "b", normalized_phone: "2485550112" },
      { id: "c", normalized_phone: "2485550113" },
    ];
    expect(partitionEligible(leads, index).eligible.map((l) => l.id)).toEqual(["a", "b", "c"]);
  });

  it("explains why each blocked lead was blocked", () => {
    const { blocked } = partitionEligible([{ id: "x", normalized_phone: DNC_PHONE }], index);
    expect(blocked[0].check.reason).toBeTruthy();
  });

  it("loses nothing — every lead comes out one side or the other", () => {
    const leads = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      normalized_phone: i % 4 === 0 ? DNC_PHONE : `24855501${String(i).padStart(2, "0")}`,
    }));
    const { eligible, blocked } = partitionEligible(leads, index);
    expect(eligible.length + blocked.length).toBe(20);
  });
});

describe("siblingsToSuppress", () => {
  const leads = [
    { id: "origin", normalized_phone: DNC_PHONE },
    { id: "dup-1", normalized_phone: DNC_PHONE },
    { id: "dup-2", phone: "(313) 555-0100" },
    { id: "other", normalized_phone: "2485550111" },
  ];

  it("finds every other record sharing the number", () => {
    expect(siblingsToSuppress("origin", DNC_PHONE, leads).map((l) => l.id)).toEqual([
      "dup-1",
      "dup-2",
    ]);
  });

  it("never includes the lead the request came from", () => {
    expect(siblingsToSuppress("origin", DNC_PHONE, leads).some((l) => l.id === "origin")).toBe(
      false
    );
  });

  it("suppresses nothing when the number could not be determined", () => {
    expect(siblingsToSuppress("origin", null, leads)).toEqual([]);
  });
});
