// Who may be emailed.
//
// The test that matters most is the first one. Everything else here is
// housekeeping; that one is a compliance rule.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  canEmail,
  canRepush,
  chooseEmail,
  emailUnavailableReason,
  explainNonePushable,
  looksLikeEmail,
  summarizeEmailAvailability,
  EMAIL_ELIGIBILITY_COLUMNS,
  isGenericAddress,
  orderForPush,
  onlyNamedPeople,
  pushRank,
  knowsAName,
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
    ).toEqual({ email: "sam@firm.com", source: "direct_email", audience: "decision_maker" });
  });

  it("falls back to whatever owner intel found", () => {
    expect(chooseEmail({ owner_email: "info@firm.com" })).toEqual({
      email: "info@firm.com",
      source: "owner_email",
      // Generic: the audience is read off the address, and owner intel finding
      // it does not make info@ a person.
      audience: "generic",
    });
  });

  it("lower-cases, because a webhook matches on the address", () => {
    expect(chooseEmail({ direct_email: "Sam@Firm.com" })?.email).toBe("sam@firm.com");
  });

  it("skips a malformed direct address rather than using it", () => {
    expect(chooseEmail({ direct_email: "not-an-email", owner_email: "info@firm.com" })).toEqual({
      email: "info@firm.com",
      source: "owner_email",
      audience: "generic",
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

/* -------------------------------------------------------------------------- */
/* who the address actually reaches                                           */
/* -------------------------------------------------------------------------- */

/*
 * The waterfall used to order on SOURCE alone: direct_email, then owner_email,
 * then website_email, regardless of what the address was. So a provider's
 * info@ outranked the owner's own published address, which is backwards for a
 * programme whose whole purpose is reaching somebody who can say yes.
 *
 * Audience now leads and source only breaks ties, so a generic address is last
 * whichever column it arrived in.
 */
describe("A GENERIC ADDRESS IS ALWAYS THE LAST RESORT", () => {
  it("prefers a verified decision-maker above everything", () => {
    const c = chooseEmail({
      direct_email: "maria@acehvac.com",
      owner_email: "sam@acehvac.com",
      website_email: "sam@acehvac.com",
      website_email_kind: "personal",
    });
    expect(c).toEqual({
      email: "maria@acehvac.com",
      source: "direct_email",
      audience: "decision_maker",
    });
  });

  it("takes the owner's published personal address over a generic one", () => {
    const c = chooseEmail({
      owner_email: "info@acehvac.com",
      website_email: "sam@acehvac.com",
      website_email_kind: "personal",
    });
    expect(c?.email).toBe("sam@acehvac.com");
    expect(c?.audience).toBe("personal");
  });

  it("a provider that returns info@ is NOT treated as a decision-maker", () => {
    const c = chooseEmail({
      direct_email: "info@acehvac.com",
      website_email: "sam@acehvac.com",
      website_email_kind: "personal",
    });
    // The audience is read off the address, not off the column it arrived in.
    expect(c?.email).toBe("sam@acehvac.com");
    expect(c?.audience).toBe("personal");
  });

  it("still uses a generic address when it is the only one — never nothing", () => {
    const c = chooseEmail({ website_email: "info@acehvac.com", website_email_kind: "role" });
    expect(c?.email).toBe("info@acehvac.com");
    expect(c?.audience).toBe("generic");
  });

  it("falls back to reading the local part when the crawl recorded no kind", () => {
    expect(chooseEmail({ website_email: "info@acehvac.com" })?.audience).toBe("generic");
    expect(chooseEmail({ website_email: "sam@acehvac.com" })?.audience).toBe("personal");
  });

  it("counts the split before anything is sent", () => {
    const a = summarizeEmailAvailability([
      { direct_email: "maria@a.com" },
      { website_email: "sam@b.com", website_email_kind: "personal" },
      { website_email: "info@c.com", website_email_kind: "role" },
      { website_email: "office@d.com", website_email_kind: "role" },
      { website_email: "info@e.com", website_email_kind: "role", do_not_call: true },
    ]);
    expect(a.available).toBe(4);
    expect(a.audience).toEqual({ decision_maker: 1, personal: 1, generic: 2 });
  });

  it("does not count suppressed leads in the split", () => {
    const a = summarizeEmailAvailability([
      { website_email: "sam@a.com", website_email_kind: "personal", do_not_call: true },
    ]);
    expect(a.audience.personal).toBe(0);
  });
});

/*
 * The generic-address list is deliberately duplicated: emailEligibility.ts is
 * loaded by the push, the admin count and the explainer, and must not drag in
 * the crawler. Duplication is fine; SILENT DIVERGENCE is not — a word in one
 * list and not the other means the crawl calls an address generic and the
 * waterfall calls it personal, and it gets ranked as an owner's inbox.
 */
describe("the two generic-address lists cannot drift apart", () => {
  it("classifies every role local part the crawler knows about", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/lib/extractEmails.ts", import.meta.url), "utf8");
    const block = /const ROLE_LOCAL_PARTS = new Set\(\[([\s\S]*?)\]\)/.exec(src);
    expect(block, "could not find ROLE_LOCAL_PARTS").toBeTruthy();
    const words = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(words.length).toBeGreaterThan(20);

    const missed = words.filter((w) => !isGenericAddress(`${w}@example.org`));
    expect(missed, `not treated as generic by the waterfall: ${missed.join(", ")}`).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* which leads go first                                                       */
/* -------------------------------------------------------------------------- */

/*
 * A campaign filled up with repair@, sales@, contact@, office@ and service@
 * while named people sat unpushed behind them, and Instantly's CONTACT column
 * was empty for nearly every row.
 *
 * chooseEmail picked the best address WITHIN a lead. Nothing decided which
 * LEADS to send — the push sliced an unordered list.
 */
describe("NAMED PEOPLE ARE PUSHED BEFORE GENERAL INBOXES", () => {
  const dm = { id: "dm", direct_email: "maria@a.com", decision_maker_name: "Maria Rivera" };
  const namedPersonal = { id: "np", website_email: "sam@b.com", website_email_kind: "personal", owner_name: "Sam Patel" };
  const unnamedPersonal = { id: "up", website_email: "jo@c.com", website_email_kind: "personal" };
  const namedGeneric = { id: "ng", website_email: "info@d.com", website_email_kind: "role", owner_name: "Dana Cole" };
  const unnamedGeneric = { id: "ug", website_email: "office@e.com", website_email_kind: "role" };

  it("orders decision-maker, then named person, then general inbox", () => {
    const order = orderForPush([unnamedGeneric, namedGeneric, unnamedPersonal, namedPersonal, dm]);
    expect(order.map((l) => l.id)).toEqual(["dm", "np", "up", "ng", "ug"]);
  });

  it("prefers a lead whose person we can name, within the same audience", () => {
    expect(pushRank(namedPersonal)).toBeLessThan(pushRank(unnamedPersonal));
    expect(pushRank(namedGeneric)).toBeLessThan(pushRank(unnamedGeneric));
  });

  it("a named person at a general inbox still loses to an unnamed personal one", () => {
    // Audience dominates: reaching the right human beats knowing their name.
    expect(pushRank(unnamedPersonal)).toBeLessThan(pushRank(namedGeneric));
  });

  it("ORDERING NEVER DROPS ANYBODY", () => {
    const all = [unnamedGeneric, namedGeneric, unnamedPersonal, namedPersonal, dm];
    expect(orderForPush(all)).toHaveLength(all.length);
    // Including leads with no address at all — they sort last, not away.
    expect(orderForPush([...all, { id: "none" }])).toHaveLength(6);
  });

  it("the optional filter keeps only named audiences", () => {
    const kept = onlyNamedPeople([dm, namedPersonal, namedGeneric, unnamedGeneric]);
    expect(kept.map((l) => l.id)).toEqual(["dm", "np"]);
  });

  it("knowsAName accepts either name field", () => {
    expect(knowsAName({ owner_name: "Sam" })).toBe(true);
    expect(knowsAName({ decision_maker_name: "Sam" })).toBe(true);
    expect(knowsAName({ owner_name: "   " })).toBe(false);
    expect(knowsAName({})).toBe(false);
  });
});

/*
 * The pure ordering can be perfect and still unused. Reverting the push to
 * `wanted.slice(0, cap)` passes every test above — which is exactly the state
 * the code was in when the campaign filled with general inboxes.
 */
describe("THE PUSH ACTUALLY USES THE ORDERING", () => {
  const src = readFileSync(new URL("../src/lib/emailPush.ts", import.meta.url), "utf8");

  it("orders the batch before slicing it", () => {
    expect(src).toMatch(/orderForPush\([\s\S]{0,40}\)\.slice\(0, cap\)/);
  });

  it("does not slice an unordered list", () => {
    expect(src).not.toMatch(/const batch = (eligible|wanted)\.slice\(0, cap\)/);
  });

  it("honours the named-people-only switch", () => {
    expect(src).toMatch(/settings\.named_people_only/);
    expect(src).toMatch(/onlyNamedPeople\(/);
  });
});
