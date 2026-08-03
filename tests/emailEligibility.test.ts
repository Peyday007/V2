// Who may be emailed.
//
// The test that matters most is the first one. Everything else here is
// housekeeping; that one is a compliance rule.

import { describe, it, expect } from "vitest";
import {
  canEmail,
  canRepush,
  chooseEmail,
  emailUnavailableReason,
  explainNonePushable,
  looksLikeEmail,
  summarizeEmailAvailability,
  EMAIL_ELIGIBILITY_COLUMNS,
} from "../src/lib/emailEligibility";
import { isAvailableToCall } from "../src/lib/leadEligibility";

const base = { direct_email: "owner@example.com" };

describe("suppression", () => {
  it("A DO-NOT-CALL LEAD IS NEVER EMAILED", () => {
    // Somebody who asked not to be called did not ask to be emailed instead.
    // If this test ever goes red, the fix is in the code, not in the test.
    expect(canEmail({ ...base, do_not_call: true })).toBe(false);
    expect(emailUnavailableReason({ ...base, do_not_call: true })).toBe(
      "On the do-not-call list"
    );
  });

  it("an unsubscribe is absolute", () => {
    expect(canEmail({ ...base, email_unsubscribed_at: "2026-01-02T00:00:00Z" })).toBe(false);
  });

  it("a bounce stops further email", () => {
    expect(canEmail({ ...base, email_bounced_at: "2026-01-02T00:00:00Z" })).toBe(false);
  });

  it("an archived lead is not emailed", () => {
    expect(canEmail({ ...base, archived_at: "2026-01-02T00:00:00Z" })).toBe(false);
  });

  it("THE SUPPRESSION RUNS ONE WAY: an email unsubscribe leaves them callable", () => {
    // Asked in both directions against the real calling predicate, because the
    // asymmetry is the design and a well-meaning "make it symmetrical" change
    // would quietly take working leads out of the callers' packets.
    const lead = {
      status: "new",
      machine_status: "ready_for_calling",
      do_not_call: false,
      phone_invalid: false,
      email_unsubscribed_at: "2026-01-02T00:00:00Z",
    };
    expect(canEmail(lead)).toBe(false);
    expect(isAvailableToCall(lead)).toBe(true);
  });

  it("suppression outranks a missing address in the wording", () => {
    // A suppressed lead must not read as "no email address on record", or
    // somebody goes looking for the address of a business that asked to be
    // left alone.
    expect(emailUnavailableReason({ do_not_call: true })).toBe("On the do-not-call list");
  });
});

describe("choosing the address", () => {
  it("prefers the enriched direct address", () => {
    expect(
      chooseEmail({ direct_email: "sam@firm.com", owner_email: "info@firm.com" })
    ).toEqual({ email: "sam@firm.com", source: "direct_email" });
  });

  it("falls back to whatever owner intel found", () => {
    expect(chooseEmail({ owner_email: "info@firm.com" })).toEqual({
      email: "info@firm.com",
      source: "owner_email",
    });
  });

  it("lower-cases, because a webhook matches on the address", () => {
    expect(chooseEmail({ direct_email: "Sam@Firm.com" })?.email).toBe("sam@firm.com");
  });

  it("skips a malformed direct address rather than using it", () => {
    expect(chooseEmail({ direct_email: "not-an-email", owner_email: "info@firm.com" })).toEqual({
      email: "info@firm.com",
      source: "owner_email",
    });
  });

  it("no address at all is a reason, not a crash", () => {
    expect(emailUnavailableReason({})).toBe("No email address on record");
  });
});

describe("the shape check is loose on purpose", () => {
  it("accepts ordinary addresses", () => {
    for (const ok of [
      "a@b.co",
      "sam.jones@big-firm.co.uk",
      "sam+leads@firm.com",
      "o'brien@firm.com",
    ]) {
      expect(looksLikeEmail(ok), ok).toBe(true);
    }
  });

  it("rejects what is obviously not one", () => {
    for (const bad of ["", "  ", "sam", "sam@", "@firm.com", "sam@firm", "sam jones@firm.com"]) {
      expect(looksLikeEmail(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("re-pushing", () => {
  it("a lead already in a campaign is not pushed again", () => {
    for (const s of ["pushed", "sent", "opened", "replied", "bounced", "unsubscribed"]) {
      expect(canRepush(s), s).toBe(false);
    }
  });

  it("but a push that never reached Instantly may be retried", () => {
    expect(canRepush("failed")).toBe(true);
  });
});

describe("saying where the leads went", () => {
  it("counts and orders the reasons", () => {
    const a = summarizeEmailAvailability([
      { direct_email: "a@b.co" },
      { direct_email: "c@d.co" },
      { do_not_call: true },
      {},
      {},
      {},
    ]);
    expect(a.available).toBe(2);
    expect(a.total).toBe(6);
    expect(a.reasons[0]).toEqual({ reason: "No email address on record", count: 3 });
  });

  it("never says just 'none available'", () => {
    const a = summarizeEmailAvailability([{ do_not_call: true }, {}]);
    expect(explainNonePushable(a)).toMatch(/do-not-call|no email address/i);
  });

  it("an empty system says so plainly", () => {
    expect(explainNonePushable(summarizeEmailAvailability([]))).toMatch(/no leads in the system/i);
  });
});

describe("the column list", () => {
  it("names every field the predicate reads", () => {
    for (const col of [
      "direct_email",
      "owner_email",
      "do_not_call",
      "archived_at",
      "email_unsubscribed_at",
      "email_bounced_at",
    ]) {
      expect(EMAIL_ELIGIBILITY_COLUMNS, col).toContain(col);
    }
  });
});
