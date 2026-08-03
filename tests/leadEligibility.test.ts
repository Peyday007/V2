import { describe, it, expect } from "vitest";
import {
  isAvailableToCall,
  unavailableReason,
  summarizeAvailability,
  explainNoneAvailable,
  applyAvailableFilter,
  AVAILABLE_EQ_FILTERS,
  AVAILABLE_IS_FILTERS,
  AVAILABLE_IN_FILTERS,
  type LeadRow,
} from "../src/lib/leadEligibility";
import { summarizeCounts } from "../src/lib/pipelineState";

const AVAILABLE: LeadRow = {
  status: "new",
  machine_status: "ready_for_calling",
  do_not_call: false,
  phone_invalid: false,
  archived_at: null,
  // A call-ready grade is now part of being available at all.
  enrichment_grade: "A",
  direct_phone: "+13135550142",
};

/**
 * The bug: the dashboard counted any lead whose machine_status was
 * ready_for_calling, while the packet queries also demanded status='new', not
 * suppressed and not a bad number. So the page said "47 ready to call" and the
 * Add button said "none are available".
 */
describe("one rule, used everywhere", () => {
  it("a clean, unassigned, processed lead is available", () => {
    expect(isAvailableToCall(AVAILABLE)).toBe(true);
    expect(unavailableReason(AVAILABLE)).toBeNull();
  });

  it("THE BUG: ready_for_calling is not enough on its own", () => {
    const alreadyOut: LeadRow = { ...AVAILABLE, status: "in_packet" };
    const alreadyCalled: LeadRow = { ...AVAILABLE, status: "called" };
    const suppressed: LeadRow = { ...AVAILABLE, do_not_call: true };
    const unreachable: LeadRow = { ...AVAILABLE, phone_invalid: true };

    for (const row of [alreadyOut, alreadyCalled, suppressed, unreachable]) {
      expect(row.machine_status).toBe("ready_for_calling");
      expect(isAvailableToCall(row)).toBe(false);
    }
  });

  it("explains each blocker in words an operator can act on", () => {
    expect(unavailableReason({ ...AVAILABLE, archived_at: "2026-07-01" })).toBe("Binned");
    expect(unavailableReason({ ...AVAILABLE, do_not_call: true })).toBe(
      "On the do-not-call list"
    );
    expect(unavailableReason({ ...AVAILABLE, phone_invalid: true })).toBe(
      "Phone number is not callable"
    );
    expect(unavailableReason({ ...AVAILABLE, machine_status: "assigned_to_packet" })).toBe(
      "Already with a caller"
    );
    expect(unavailableReason({ ...AVAILABLE, machine_status: "contacted" })).toBe(
      "Already called"
    );
    expect(unavailableReason({ ...AVAILABLE, machine_status: "enrichment_queued" })).toBe(
      "Still being researched"
    );
    expect(unavailableReason({ ...AVAILABLE, machine_status: "enrichment_failed" })).toBe(
      "Discarded — not worth calling"
    );
  });

  it("the most decisive reason wins", () => {
    // Suppressed AND already with a caller reads as suppressed.
    const row: LeadRow = {
      ...AVAILABLE,
      do_not_call: true,
      machine_status: "assigned_to_packet",
    };
    expect(unavailableReason(row)).toBe("On the do-not-call list");
  });

  it("a lead with no machine status at all is not handed out", () => {
    expect(isAvailableToCall({ status: "new" })).toBe(false);
  });
});

describe("summarizeAvailability", () => {
  it("counts what is free and groups the rest by reason", () => {
    const rows: LeadRow[] = [
      AVAILABLE,
      AVAILABLE,
      { ...AVAILABLE, machine_status: "assigned_to_packet" },
      { ...AVAILABLE, machine_status: "assigned_to_packet" },
      { ...AVAILABLE, machine_status: "assigned_to_packet" },
      { ...AVAILABLE, do_not_call: true },
    ];
    const a = summarizeAvailability(rows);
    expect(a.available).toBe(2);
    expect(a.total).toBe(6);
    expect(a.reasons[0]).toEqual({ reason: "Already with a caller", count: 3 });
  });

  it("loses nothing — available plus blocked equals the total", () => {
    const rows: LeadRow[] = Array.from({ length: 25 }, (_, i) =>
      i % 3 === 0 ? AVAILABLE : { ...AVAILABLE, machine_status: "contacted" }
    );
    const a = summarizeAvailability(rows);
    const blocked = a.reasons.reduce((n, r) => n + r.count, 0);
    expect(a.available + blocked).toBe(25);
  });

  it("handles an empty database", () => {
    expect(summarizeAvailability([])).toEqual({ available: 0, total: 0, reasons: [] });
  });
});

describe("explainNoneAvailable never just says 'none'", () => {
  it("says where the leads went", () => {
    const a = summarizeAvailability([
      { ...AVAILABLE, machine_status: "assigned_to_packet" },
      { ...AVAILABLE, machine_status: "assigned_to_packet" },
      { ...AVAILABLE, machine_status: "contacted" },
    ]);
    const text = explainNoneAvailable(a);
    expect(text).toContain("2 already with a caller");
    expect(text).toContain("1 already called");
    expect(text).toContain("Generate more");
  });

  it("says so plainly when the database is empty", () => {
    expect(explainNoneAvailable(summarizeAvailability([]))).toContain("no leads in the system");
  });
});

describe("the SQL filter matches the predicate", () => {
  it("applies every filter the predicate checks", () => {
    const applied: string[] = [];
    const fake = {
      eq(col: string) {
        applied.push(`eq:${col}`);
        return fake;
      },
      is(col: string) {
        applied.push(`is:${col}`);
        return fake;
      },
      in(col: string) {
        applied.push(`in:${col}`);
        return fake;
      },
    };
    applyAvailableFilter(fake);
    expect(applied).toEqual([
      "eq:status",
      "eq:machine_status",
      "eq:do_not_call",
      "eq:phone_invalid",
      "is:archived_at",
      // No in:enrichment_grade. The grade decides ORDER, not eligibility —
      // requiring an A or a B meant requiring a paid provider's direct number,
      // which excluded every lead in the system.
    ]);
  });

  it("filters on exactly the columns the predicate reads", () => {
    const columns = [
      ...AVAILABLE_EQ_FILTERS.map(([c]) => c),
      ...AVAILABLE_IS_FILTERS.map(([c]) => c),
      ...AVAILABLE_IN_FILTERS.map(([c]) => c),
    ].sort();
    expect(columns).toEqual(
      ["archived_at", "do_not_call", "machine_status", "phone_invalid", "status"].sort()
    );
  });

  it("returns the builder so the query can carry on being chained", () => {
    const fake = { eq: () => fake, is: () => fake, in: () => fake, marker: 42 };
    expect(applyAvailableFilter(fake).marker).toBe(42);
  });
});

describe("the dashboard count now agrees with the packet query", () => {
  it("uses the real availability rather than the machine status alone", () => {
    // Five leads at ready_for_calling, but only two are actually free.
    const rows: LeadRow[] = [
      AVAILABLE,
      AVAILABLE,
      { ...AVAILABLE, status: "in_packet" },
      { ...AVAILABLE, do_not_call: true },
      { ...AVAILABLE, phone_invalid: true },
    ];
    const byStatus = { ready_for_calling: 5 };
    const naive = summarizeCounts(byStatus);
    const honest = summarizeCounts(byStatus, {
      readyToCall: summarizeAvailability(rows).available,
    });
    expect(naive.readyToCall).toBe(5); // what the page used to claim
    expect(honest.readyToCall).toBe(2); // what the Add button can actually do
  });
});

/**
 * The outage this file now guards against.
 *
 * The grade gate required an A or a B. A lead only reaches A or B when a paid
 * contact provider returns a direct number for a named owner. With no provider
 * configured every lead grades C at best — so the rule excluded the entire
 * database and the callers had nothing to dial.
 */
describe("a lead with no enrichment is still a lead", () => {
  const base: LeadRow = {
    status: "new",
    machine_status: "ready_for_calling",
    do_not_call: false,
    phone_invalid: false,
    archived_at: null,
  };

  it("AN UNGRADED LEAD IS CALLABLE — this is the normal state without a provider", () => {
    expect(isAvailableToCall({ ...base, enrichment_grade: null })).toBe(true);
    expect(isAvailableToCall({ ...base })).toBe(true);
  });

  it("a C is callable — you ring the main line and ask for them by name", () => {
    expect(isAvailableToCall({ ...base, enrichment_grade: "C" })).toBe(true);
  });

  it("a D is callable — not knowing the owner's name is where this all started", () => {
    expect(isAvailableToCall({ ...base, enrichment_grade: "D" })).toBe(true);
  });

  it("an A is callable too, obviously", () => {
    expect(isAvailableToCall({ ...base, enrichment_grade: "A" })).toBe(true);
  });

  it("the real gates still hold", () => {
    expect(isAvailableToCall({ ...base, do_not_call: true })).toBe(false);
    expect(isAvailableToCall({ ...base, phone_invalid: true })).toBe(false);
    expect(isAvailableToCall({ ...base, archived_at: "2026-01-01" })).toBe(false);
    expect(isAvailableToCall({ ...base, machine_status: "enriching" })).toBe(false);
    expect(isAvailableToCall({ ...base, status: "in_packet" })).toBe(false);
  });

  it("a whole batch of ungraded leads reports as available, not as a wall of reasons", () => {
    const rows = Array.from({ length: 50 }, () => ({ ...base }));
    const summary = summarizeAvailability(rows);
    expect(summary.available).toBe(50);
    expect(summary.reasons).toEqual([]);
  });
});
