import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  planReenrichment,
  whatIsMissing,
  skipReasonFor,
  gainScore,
  reenrichKey,
  MAX_BATCH,
  DEFAULT_BATCH,
} from "../src/lib/reenrichPlan";

/*
 * 728 leads were enriched successfully on 27 July. The code that reads an email
 * address off a website landed on 4 August, along with the deeper diagnostic.
 * So a thousand leads are callable and empty — and none of them will ever fill
 * in on their own, because nothing queues work for a lead that already
 * finished.
 */

const bare = (over = {}) => ({ id: "l1", business_name: "Ace", ...over });

describe("what a re-run would actually add", () => {
  it("says a lead with nothing is missing all three", () => {
    expect(whatIsMissing(bare())).toEqual(["email", "diagnostic", "decision_maker"]);
  });

  it("counts any address as an address", () => {
    expect(whatIsMissing(bare({ website_email: "a@b.com" }))).not.toContain("email");
    expect(whatIsMissing(bare({ direct_email: "a@b.com" }))).not.toContain("email");
    expect(whatIsMissing(bare({ owner_email: "a@b.com" }))).not.toContain("email");
  });

  it("treats an EMPTY findings array as no diagnosis", () => {
    // What a lead looks like when the column exists and nothing wrote to it.
    expect(whatIsMissing(bare({ diagnostic_findings: [] }))).toContain("diagnostic");
    expect(whatIsMissing(bare({ diagnostic_findings: [{ key: "x" }] }))).not.toContain("diagnostic");
  });

  it("either name counts as somebody to ask for", () => {
    expect(whatIsMissing(bare({ owner_name: "Sam" }))).not.toContain("decision_maker");
    expect(whatIsMissing(bare({ decision_maker_name: "Sam" }))).not.toContain("decision_maker");
  });
});

describe("WHO IS LEFT ALONE", () => {
  it("NEVER re-crawls somebody on the do-not-call list", () => {
    // They asked us to stop. Quietly continuing to gather data about them is
    // not honouring that just because no message is sent at the end of it.
    expect(skipReasonFor(bare({ do_not_call: true }))).toBe("On the do-not-call list");
  });

  it("skips binned leads", () => {
    expect(skipReasonFor(bare({ archived_at: "2026-01-01" }))).toBe("Binned");
  });

  it("skips a lead that already has everything", () => {
    expect(
      skipReasonFor(
        bare({ website_email: "a@b.com", diagnostic_findings: [{}], owner_name: "Sam" })
      )
    ).toBe("Already has everything");
  });

  it("suppression outranks completeness, so a DNC lead is never reported as done", () => {
    const lead = bare({
      do_not_call: true,
      website_email: "a@b.com",
      diagnostic_findings: [{}],
      owner_name: "Sam",
    });
    expect(skipReasonFor(lead)).toBe("On the do-not-call list");
  });
});

describe("the leads that gain most go first", () => {
  it("ranks a lead with a website above one without", () => {
    expect(gainScore(bare({ website: "https://a.com" }))).toBeGreaterThan(gainScore(bare()));
  });

  it("takes the highest-gain leads when the batch is capped", () => {
    const leads = [
      ...Array.from({ length: 5 }, (_, i) => bare({ id: `no-site-${i}` })),
      ...Array.from({ length: 5 }, (_, i) => bare({ id: `site-${i}`, website: "https://a.com" })),
    ];
    const plan = planReenrichment(leads, 5);
    expect(plan.queue).toHaveLength(5);
    expect(plan.queue.every((q) => q.id.startsWith("site-"))).toBe(true);
    expect(plan.waiting).toBe(5);
  });

  it("accounts for every lead it did not queue", () => {
    const plan = planReenrichment(
      [
        bare({ id: "a", website: "https://a.com" }),
        bare({ id: "b", do_not_call: true }),
        bare({ id: "c", archived_at: "2026-01-01" }),
        bare({ id: "d", website_email: "x@y.com", diagnostic_findings: [{}], owner_name: "S" }),
      ],
      100
    );
    expect(plan.queue).toHaveLength(1);
    const total = plan.queue.length + plan.skipped.reduce((n, s) => n + s.count, 0);
    expect(total).toBe(4);
  });

  it("says so plainly when there is nothing to do", () => {
    const plan = planReenrichment(
      [bare({ website_email: "x@y.com", diagnostic_findings: [{}], owner_name: "S" })],
      100
    );
    expect(plan.queue).toHaveLength(0);
    expect(plan.summary).toMatch(/Nothing to re-enrich/);
  });

  it("clamps the batch so a mistake costs a batch, not the list", () => {
    const leads = Array.from({ length: 2000 }, (_, i) => bare({ id: `l${i}` }));
    expect(planReenrichment(leads, 99999).queue.length).toBe(MAX_BATCH);
    expect(planReenrichment(leads, 0).queue.length).toBe(DEFAULT_BATCH);
  });
});

describe("pressing the button twice does not queue the work twice", () => {
  it("keys one job per lead per day", () => {
    const morning = new Date("2026-08-05T09:00:00Z");
    const evening = new Date("2026-08-05T21:00:00Z");
    const tomorrow = new Date("2026-08-06T09:00:00Z");
    expect(reenrichKey("l1", morning)).toBe(reenrichKey("l1", evening));
    expect(reenrichKey("l1", morning)).not.toBe(reenrichKey("l1", tomorrow));
    expect(reenrichKey("l1", morning)).not.toBe(reenrichKey("l2", morning));
  });
});

/*
 * enrichLeadForOwner runs shouldReEnrich() first and REFUSES a lead that was
 * already enriched — correctly, so nothing pays twice for a record that has not
 * changed. But the record has not changed here; the application has. Without
 * admin_requested the backfill queues hundreds of jobs that every one of them
 * declines, and the page reports success while nothing happens.
 *
 * This is the single line the whole feature depends on, so it gets a test that
 * reads the route rather than trusting it.
 */
describe("THE BACKFILL MUST ASK FOR A FORCED RE-RUN", () => {
  const route = readFileSync(
    join(__dirname, "..", "src", "app", "api", "enrichment", "backfill", "route.ts"),
    "utf8"
  );

  it("sets admin_requested on every queued job", () => {
    expect(route).toMatch(/admin_requested:\s*true/);
  });

  it("queues the handler that actually collects addresses", () => {
    expect(route).toMatch(/type:\s*"enrich_owner_contact"/);
  });

  it("uses the per-day idempotency key rather than a bare lead id", () => {
    expect(route).toMatch(/idempotencyKey:\s*reenrichKey\(/);
  });

  it("runs behind live lead generation", () => {
    expect(route).toMatch(/priority:\s*200/);
  });
});
