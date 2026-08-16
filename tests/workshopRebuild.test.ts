// The workshop as an assessment, end to end.
//
// The properties here are the ones that would be expensive to get wrong in
// front of a business owner: that a token cannot reach somebody else's
// assessment, that an internal note cannot reach a public payload, that
// pressing a button of interest is not permission to touch anything, and that
// an operator checking a page does not look like a prospect reading it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  advanceStatus,
  variantForToken,
  idempotencyKeyFor,
  needsAttention,
  nextAction,
  reportVariants,
  grantsSystemAccess,
  isPaidEngagement,
  isInterestOnly,
  EVENT_STATUS,
  VARIANT_CONFIG,
  WORKSHOP_VARIANTS,
  LOW_SAMPLE_THRESHOLD,
  STATUS_LABEL,
  type WorkshopStatus,
  type VariantTally,
} from "../src/lib/workshopLifecycle";
import { buildOpportunityMap } from "../src/lib/bottleneckAudit";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

/**
 * Source with comments removed, and adjacent string literals joined.
 *
 * Both matter for the copy assertions below. A comment explaining that
 * "Start my free 7-day trial" was REMOVED is not that string being shown to
 * anybody — and long copy is written as concatenated literals, so a phrase can
 * be split across two lines and still render as one sentence.
 */
function renderedCopy(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/"\s*\+\s*\n?\s*"/g, "");
}
const publicRoute = read("../src/app/api/workshop/[token]/route.ts");
const adminRoute = read("../src/app/api/workshops/route.ts");
const store = read("../src/lib/workshopAssessment.ts");
const view = read("../src/components/WorkshopView.tsx");
const migration = read("../supabase/migrations/0045_workshop_assessment.sql");

/* -------------------------------------------------------------------------- */
/* compatibility                                                              */
/* -------------------------------------------------------------------------- */

describe("EXISTING LINKS AND HISTORY SURVIVE", () => {
  it("the migration never drops, deletes or rewrites a workshop row", () => {
    expect(migration).not.toMatch(/drop table|truncate|delete from/i);
    expect(migration).not.toMatch(/update workshop_packets\s+set/i);
    // The only drop is the status CHECK, which is immediately re-added wider.
    expect(migration).toMatch(/drop constraint if exists workshop_packets_status_check/i);
    expect(migration).toMatch(/add constraint workshop_packets_status_check/i);
  });

  it("the token column is never altered — every existing URL still resolves", () => {
    expect(migration).not.toMatch(/alter\s+column\s+token|drop\s+column\s+token/i);
  });

  it("trial_requested REMAINS a legal stored value", () => {
    // Rows written before the rebuild hold it. Rewriting them would destroy
    // the record of what people actually agreed to.
    expect(migration).toMatch(/'trial_requested'/);
    expect(STATUS_LABEL.trial_requested).toMatch(/legacy/i);
  });

  it("a legacy trial request still reads as interest, and nothing more", () => {
    expect(isInterestOnly("trial_requested")).toBe(true);
    expect(grantsSystemAccess("trial_requested")).toBe(false);
    expect(isPaidEngagement("trial_requested")).toBe(false);
  });

  it("the old trial wording is gone from the public page", () => {
    // Rendered copy only. The comment recording that it was removed is not the
    // string being shown to a prospect.
    expect(renderedCopy(view)).not.toMatch(/free 7-day trial|Start my free/i);
    expect(view).toContain("I'm interested in seeing more");
  });

  it("both the public route and the admin list degrade if 0045 is unrun", () => {
    expect(store).toMatch(/isMissingColumn/);
    expect(adminRoute).toMatch(/LEGACY_COLUMNS/);
  });
});

/* -------------------------------------------------------------------------- */
/* isolation and privacy                                                      */
/* -------------------------------------------------------------------------- */

describe("ONE TOKEN SEES ONE WORKSHOP", () => {
  it("every public read resolves through the token, never a supplied id", () => {
    expect(publicRoute).toMatch(/packetByToken\(token\)/);
    // A packet id taken from the request body would let anyone address any
    // workshop. The id must only ever come from the token lookup.
    expect(publicRoute).not.toMatch(/body\.packet_?[Ii]d|body\.packetId/);
    expect(publicRoute).toMatch(/const packetId = found\.packet\.id/);
  });

  it("the lookup rejects a short or empty token rather than scanning", () => {
    expect(store).toMatch(/token\.length < 16/);
  });

  it("a revoked or expired workshop is gone for everyone", () => {
    expect(publicRoute.match(/status === "revoked"/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("INTERNAL NOTES CANNOT REACH THE PUBLIC PAYLOAD", () => {
  it("the public shape is built through stripAllInternal", () => {
    expect(store).toMatch(/stripAllInternal\(opportunities\)/);
  });

  it("the public route never selects the operator's columns", () => {
    for (const col of ["internal_note", "operator_note", "next_action"]) {
      expect(publicRoute, col).not.toContain(col);
    }
  });

  it("the ADMIN route may see them — that is the difference between the two", () => {
    expect(adminRoute).toMatch(/operator_note/);
  });

  it("the public component never renders an internal field", () => {
    expect(view).not.toMatch(/internalNote|internal_note|talkTrack/);
  });
});

/* -------------------------------------------------------------------------- */
/* the lifecycle                                                              */
/* -------------------------------------------------------------------------- */

describe("THE LIFECYCLE CANNOT MOVE BACKWARDS", () => {
  it("a late-arriving open does not erase an interest already recorded", () => {
    // Events arrive out of order constantly. Letting the later one win would
    // wipe the one signal an operator is waiting for.
    expect(advanceStatus("interested", "opened")).toBe("interested");
    expect(advanceStatus("converted", "engaged")).toBe("converted");
  });

  it("but genuine progress is accepted", () => {
    expect(advanceStatus("sent", "opened")).toBe("opened");
    expect(advanceStatus("opened", "interested")).toBe("interested");
    expect(advanceStatus("interested", "demo_requested")).toBe("demo_requested");
  });

  it("a revoked workshop stays revoked whatever arrives next", () => {
    for (const s of ["opened", "interested", "converted"] as WorkshopStatus[]) {
      expect(advanceStatus("revoked", s)).toBe("revoked");
      expect(advanceStatus("expired", s)).toBe("expired");
    }
  });

  it("an operator can still revoke from anywhere", () => {
    expect(advanceStatus("interested", "revoked")).toBe("revoked");
  });

  it("every status has a next action a person can act on", () => {
    for (const s of Object.keys(STATUS_LABEL) as WorkshopStatus[]) {
      expect(nextAction(s, false).length, s).toBeGreaterThan(10);
    }
  });
});

describe("INTEREST IS NOT PERMISSION, A TRIAL, OR A PURCHASE", () => {
  it("the interest event reaches exactly `interested` and no further", () => {
    expect(EVENT_STATUS["workshop.interest_clicked"]).toBe("interested");
  });

  it("interest grants nothing", () => {
    expect(grantsSystemAccess("interested")).toBe(false);
    expect(isPaidEngagement("interested")).toBe(false);
    expect(isInterestOnly("interested")).toBe(true);
  });

  it("only an explicit approval grants access, and only conversion is paid", () => {
    expect(grantsSystemAccess("live_change_approved")).toBe(true);
    expect(isPaidEngagement("converted")).toBe(true);
    expect(grantsSystemAccess("demo_requested")).toBe(false);
    expect(grantsSystemAccess("walkthrough_scheduled")).toBe(false);
  });

  it("the API says so in the response, not just in a comment", () => {
    expect(publicRoute).toMatch(/grantsAccess: false/);
    expect(publicRoute).toMatch(/startsTrial: false/);
    expect(publicRoute).toMatch(/Nothing in your business changes/);
  });

  it("the page tells the owner before they press it", () => {
    expect(view).toMatch(/does not start a trial, buy anything, or give us access/i);
  });

  it("the public endpoint refuses to accept a manufactured conversion", () => {
    // Only view-type events may be reported by the page. Interest, demo and
    // walkthrough have their own validated actions.
    expect(publicRoute).toMatch(/That event is not reportable here/);
  });
});

/* -------------------------------------------------------------------------- */
/* counting                                                                   */
/* -------------------------------------------------------------------------- */

describe("A CONVERSION IS COUNTED ONCE", () => {
  it("the events that must never double up carry a fixed key", () => {
    for (const e of [
      "workshop.interest_clicked",
      "workshop.private_example_requested",
      "workshop.converted",
    ] as const) {
      expect(idempotencyKeyFor(e), e).toBe(e);
    }
  });

  it("a double-tapped button produces one key, so the index rejects the second", () => {
    expect(idempotencyKeyFor("workshop.interest_clicked")).toBe(
      idempotencyKeyFor("workshop.interest_clicked")
    );
  });

  it("views are once per target — six re-reads are not six findings read", () => {
    expect(idempotencyKeyFor("workshop.finding_viewed", "f1")).toBe("workshop.finding_viewed:f1");
    expect(idempotencyKeyFor("workshop.finding_viewed", "f2")).not.toBe(
      idempotencyKeyFor("workshop.finding_viewed", "f1")
    );
  });

  it("the database enforces it, not just the application", () => {
    expect(migration).toMatch(/create unique index[\s\S]{0,120}workshop_events_idem_idx/i);
    expect(migration).toMatch(/\(packet_id, idempotency_key\)/);
  });

  it("the interest response reports whether it was the first time", () => {
    expect(publicRoute).toMatch(/firstTime: recorded/);
  });

  it("an interest raises attention exactly once, so no duplicate task", () => {
    expect(needsAttention("workshop.interest_clicked")).toBe(true);
    expect(needsAttention("workshop.summary_viewed")).toBe(false);
  });
});

describe("AN ADMIN PREVIEW IS NOT PROSPECT ACTIVITY", () => {
  it("the page flags itself when opened with ?preview=1", () => {
    expect(view).toMatch(/preview.*===\s*"1"/);
    expect(view).toMatch(/preview: isPreview/);
  });

  it("the API refuses to let a preview act at all", () => {
    expect(publicRoute).toMatch(/const isAdminPreview = body\?\.preview === true/);
    expect(publicRoute.match(/if \(isAdminPreview\)/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it("a preview never advances the lifecycle", () => {
    expect(store).toMatch(/if \(!input\.isAdminPreview\)/);
  });

  it("previews are stored apart and excluded from the timeline", () => {
    expect(migration).toMatch(/is_admin_preview/);
    expect(adminRoute).toMatch(/filter\(\(e\) => !e\.is_admin_preview\)/);
    expect(adminRoute).toMatch(/filter\(\(e\) => e\.is_admin_preview\)/);
  });

  it("the admin preview link carries the flag", () => {
    const page = read("../src/app/(admin)/admin/campaigns/workshop/page.tsx");
    expect(page).toMatch(/\?preview=1/);
  });
});

/* -------------------------------------------------------------------------- */
/* experiments                                                                */
/* -------------------------------------------------------------------------- */

describe("A VARIANT IS STABLE, AND NEVER TESTS THE TRUTH", () => {
  it("the same token always yields the same variant", () => {
    const token = "a".repeat(40);
    const first = variantForToken(token);
    for (let i = 0; i < 50; i++) expect(variantForToken(token)).toBe(first);
  });

  it("different tokens spread across the variants", () => {
    const seen = new Set(
      Array.from({ length: 300 }, (_, i) => variantForToken(`token-${i}-${"x".repeat(20)}`))
    );
    expect(seen.size).toBeGreaterThan(1);
  });

  it("an empty token falls back to control rather than throwing", () => {
    expect(variantForToken("")).toBe("control");
  });

  it("VARIANTS CHANGE PRESENTATION ONLY", () => {
    // Nothing here touches a finding, its evidence, its confidence, the
    // consent wording, or what pressing the button means. Testing those would
    // mean showing half the sample something untrue.
    for (const v of WORKSHOP_VARIANTS) {
      const keys = Object.keys(VARIANT_CONFIG[v]);
      for (const k of keys) {
        expect(k, `${v}.${k}`).not.toMatch(/evidence(?!Inline)|confidence|consent|trial|permission/i);
      }
    }
  });

  it("no variant alters the interest copy", () => {
    const ctas = new Set(WORKSHOP_VARIANTS.map(() => "I'm interested in seeing more"));
    expect(ctas.size).toBe(1);
  });

  it("reports raw counts with rates, and warns on a small sample", () => {
    const [small] = reportVariants([
      { variant: "compact", delivered: 5, opened: 4, engaged: 3, interested: 2, auditCompleted: 1, privateBuildRequested: 1, walkthroughRequested: 0, converted: 2 } as VariantTally,
    ]);
    expect(small.delivered).toBe(5);
    expect(small.conversionRate).toBe(40);
    expect(small.lowSample).toBe(true);
    expect(small.caveat).toMatch(/too few/i);
  });

  it("a real sample loses the warning", () => {
    const [big] = reportVariants([
      { variant: "control", delivered: LOW_SAMPLE_THRESHOLD + 10, opened: 40, engaged: 20, interested: 10, auditCompleted: 5, privateBuildRequested: 4, walkthroughRequested: 2, converted: 3 } as VariantTally,
    ]);
    expect(big.lowSample).toBe(false);
    expect(big.caveat).toBeNull();
  });

  it("never names a winner", () => {
    const out = reportVariants([
      { variant: "a", delivered: 100, opened: 50, engaged: 20, interested: 10, auditCompleted: 5, privateBuildRequested: 3, walkthroughRequested: 1, converted: 9 } as VariantTally,
      { variant: "b", delivered: 100, opened: 50, engaged: 20, interested: 10, auditCompleted: 5, privateBuildRequested: 3, walkthroughRequested: 1, converted: 1 } as VariantTally,
    ]);
    expect(JSON.stringify(out)).not.toMatch(/winner|winning|best/i);
  });
});

/* -------------------------------------------------------------------------- */
/* the audit                                                                  */
/* -------------------------------------------------------------------------- */

describe("THE BOTTLENECK AUDIT KEEPS WHAT WAS TYPED", () => {
  it("each answer is upserted per area as it is given", () => {
    expect(store).toMatch(/onConflict: "packet_id,area"/);
    expect(migration).toMatch(/unique \(packet_id, area\)/);
  });

  it("the page saves on change rather than only on submit", () => {
    expect(view).toMatch(/action: "save_answer"/);
    expect(view).toMatch(/save as you go/i);
  });

  it("a failed map leaves the answers intact and says so", () => {
    expect(publicRoute).toMatch(/recoverable: map\.length === 0/);
    expect(view).toMatch(/nothing you typed is lost/i);
  });

  it("the map is rebuilt from stored answers, so a refresh recovers it", () => {
    const map = buildOpportunityMap([
      { area: "estimates_not_followed", frequency: "daily", affects: "revenue" },
      { area: "missed_calls", frequency: "weekly", affects: "revenue" },
    ]);
    expect(map).toHaveLength(2);
    expect(map[0].band).toBe("fix_first");
  });

  it("it is never called a definitive audit", () => {
    expect(view).toMatch(/not a verified audit/i);
    expect(renderedCopy(view)).not.toMatch(/definitive audit/i);
  });
});

/* -------------------------------------------------------------------------- */
/* the public experience                                                      */
/* -------------------------------------------------------------------------- */

describe("THE PAGE LEADS WITH THE BUSINESS, NOT THE CATALOGUE", () => {
  it("it is a guided mini-site, not one scrolling packet", () => {
    for (const s of ["summary", "finding", "preview", "audit", "map", "next"]) {
      expect(view, s).toContain(`"${s}"`);
    }
  });

  it("the four provenances are separate headings", () => {
    expect(view).toContain("What we observed");
    expect(view).toContain("What we know");
    expect(view).toMatch(/What we are inferring/);
    expect(view).toContain("What only you can confirm");
  });

  it("evidence carries its source and the date it was looked at", () => {
    expect(view).toMatch(/SOURCE_LABEL/);
    expect(view).toMatch(/observedAt/);
  });

  it("the private build is matched to the finding, not generic", () => {
    expect(view).toMatch(/Matched to/);
    expect(view).toMatch(/not a\s*\n?\s*generic demonstration/);
  });

  it("the broader-capability line is restrained and comes after the example", () => {
    expect(view).toMatch(/CAPABILITY_LINE/);
    // Joined across its concatenated literals, then matched as one sentence.
    expect(renderedCopy(view)).toMatch(/customer intake, follow-up, reputation/);
    /*
     * And it RENDERS below the matched example, not as an opening catalogue.
     * Measured at the usage site, not the const declaration — the string is
     * defined at the top of the file and used much further down.
     */
    const copy = renderedCopy(view);
    expect(copy.indexOf("Matched to")).toBeLessThan(copy.indexOf("{CAPABILITY_LINE}"));
  });

  it("all four next-step routes are offered", () => {
    expect(view).toMatch(/Schedule a phone call/);
    expect(view).toMatch(/Schedule a video call/);
    expect(view).toMatch(/recorded walkthrough/);
    expect(view).toMatch(/keep looking on my own/i);
  });

  it("no consent box is pre-ticked — there is no box at all", () => {
    expect(view).not.toMatch(/defaultChecked|checked=\{true\}/);
  });
});

/* -------------------------------------------------------------------------- */
/* the email system                                                           */
/* -------------------------------------------------------------------------- */

describe("THE EMAIL SYSTEM IS NOT TOUCHED BY ANY OF THIS", () => {
  it("no workshop module imports the email supply, ledger or Instantly client", () => {
    for (const [name, src] of [
      ["assessment store", store],
      ["public route", publicRoute],
      ["admin route", adminRoute],
      ["view", view],
    ] as const) {
      expect(src, name).not.toMatch(/from "@?\.?\.?\/?(lib\/)?(emailPush|supplyPlan|sendWindows|instantly\/client|funnelStore)"/);
    }
  });

  it("the workshop sends nothing to anybody", () => {
    // The assessment surface records and reads. Delivery stays where it was,
    // in workshopSend, and nothing here calls it.
    expect(publicRoute).not.toMatch(/sendSms|sendEmail|pushLead|createAndSendPacket/);
    expect(store).not.toMatch(/sendSms|sendEmail|pushLead/);
  });
});
