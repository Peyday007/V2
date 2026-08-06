// How much the inboxes can carry, and when one is ready to carry more.
//
// Two things here fail silently if they are wrong, which is why they are
// tested this hard: a capacity number that is too high quietly queues sends
// into tomorrow forever, and a limit raised too fast burns a domain weeks
// before anybody connects the two.

import { describe, it, expect } from "vitest";
import {
  computeCapacity,
  leadsPerDay,
  smartDailyCap,
  planLimitChange,
  planAllLimits,
  stepFor,
  daysToCeiling,
  DEFAULT_RAMP,
  DEFAULT_HEADROOM,
  MIN_HEALTHY_WARMUP,
  type SendingAccount,
} from "../src/lib/sendingCapacity";
import { normaliseAccounts, normaliseCampaigns } from "../src/lib/instantly/mapping";
import { readFileSync } from "node:fs";

const NOW = new Date("2026-08-04T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const account = (over: Partial<SendingAccount> = {}): SendingAccount => ({
  email: "a@ours.com",
  dailyLimit: 30,
  warmupScore: 95,
  warmupStatus: "active",
  active: true,
  createdAt: daysAgo(120),
  recentSends: 500,
  recentBounces: 2,
  lastRaisedAt: null,
  ...over,
});

/* -------------------------------------------------------------------------- */
/* capacity                                                                   */
/* -------------------------------------------------------------------------- */

describe("what the inboxes can send", () => {
  it("adds up the healthy ones", () => {
    const c = computeCapacity([
      account({ email: "a@x.com", dailyLimit: 30 }),
      account({ email: "b@x.com", dailyLimit: 90 }),
      account({ email: "c@x.com", dailyLimit: 90 }),
    ]);
    expect(c.dailySends).toBe(210);
    expect(c.accountsCounted).toBe(3);
  });

  it("LEAVES HEADROOM rather than planning to use every slot", () => {
    // The accounts also carry replies, retries and the odd manual send.
    // Planning against 100% means the first busy day silently spills over.
    const c = computeCapacity([account({ dailyLimit: 100 })]);
    expect(c.usableSends).toBe(85);
    expect(DEFAULT_HEADROOM).toBe(0.85);
  });

  it("leaves an unhealthy inbox OUT ENTIRELY, not counted at a discount", () => {
    // Capacity you cannot safely use is not capacity. Counting it at a
    // discount produces a plan that overruns the accounts that are fine.
    const c = computeCapacity([
      account({ email: "good@x.com", dailyLimit: 90 }),
      account({ email: "sick@x.com", dailyLimit: 90, warmupScore: MIN_HEALTHY_WARMUP - 1 }),
    ]);
    expect(c.dailySends).toBe(90);
    expect(c.accountsIgnored).toBe(1);
  });

  it("leaves an inactive inbox out", () => {
    const c = computeCapacity([account({ dailyLimit: 90, active: false })]);
    expect(c.dailySends).toBe(0);
    expect(c.reason).toMatch(/no healthy sending accounts/i);
  });

  it("counts an inbox whose health is simply unknown", () => {
    // A missing score is not a bad score. Dropping every account because a
    // field was renamed would read as "you have no inboxes".
    expect(computeCapacity([account({ warmupScore: null, dailyLimit: 50 })]).dailySends).toBe(50);
  });

  it("says what it did, in words", () => {
    expect(computeCapacity([account()]).reason).toMatch(/1 inbox can send 30\/day/);
  });
});

/* -------------------------------------------------------------------------- */
/* the other cap, the one that was being ignored                              */
/* -------------------------------------------------------------------------- */

/*
 * The real case that produced this: eighteen inboxes, most at 90, and the page
 * confidently reporting well over a thousand sends a day. Instantly was sending
 * sixty, because the CAMPAIGN was set to sixty, and each inbox showed "4 of 90".
 * Summing the inboxes and calling it capacity was simply wrong.
 */
describe("THE CAMPAIGN'S OWN DAILY LIMIT IS USUALLY THE ONE THAT DECIDES", () => {
  const eighteen = Array.from({ length: 18 }, (_, i) =>
    account({ email: `a${i}@x.com`, dailyLimit: 90 })
  );

  it("takes the campaign limit when it is lower than the inboxes", () => {
    const c = computeCapacity(eighteen, DEFAULT_HEADROOM, 60);
    expect(c.dailySends).toBe(60);
    expect(c.cappedByCampaign).toBe(true);
    expect(c.campaignDailyLimit).toBe(60);
  });

  it("explains the '4 of 90' that started this, in the operator's own terms", () => {
    const c = computeCapacity(eighteen, DEFAULT_HEADROOM, 60);
    expect(c.reason).toMatch(/campaign is limited to 60 emails a day/i);
    // 60 spread over 18 inboxes is 3 each, which is what the screenshots showed.
    expect(c.reason).toMatch(/about 3 each/);
    expect(c.reason).toMatch(/Options/);
  });

  it("keeps the inbox total when the campaign limit is higher", () => {
    const c = computeCapacity([account({ dailyLimit: 30 })], DEFAULT_HEADROOM, 500);
    expect(c.dailySends).toBe(30);
    expect(c.cappedByCampaign).toBe(false);
    expect(c.reason).toMatch(/limit of 500 a day is not the constraint/);
  });

  it("A LIMIT THAT COULD NOT BE READ IS NOT A LIMIT OF ZERO", () => {
    // The failure mode that would be worst: a failed request reading as a cap
    // of nothing, which stops the programme dead and looks like a bad setting.
    for (const unknown of [null, 0, Number.NaN, -5]) {
      const c = computeCapacity([account({ dailyLimit: 30 })], DEFAULT_HEADROOM, unknown);
      expect(c.dailySends).toBe(30);
      expect(c.cappedByCampaign).toBe(false);
      expect(c.campaignDailyLimit).toBeNull();
    }
  });

  it("says the limit was not read, rather than implying it was checked", () => {
    const c = computeCapacity([account({ dailyLimit: 30 })], DEFAULT_HEADROOM, null);
    expect(c.reason).toMatch(/has not been read/);
  });

  it("CARRIES THROUGH TO THE LEADS-PER-DAY CAP, which is what pushes", () => {
    // The whole point. Without this the top-up sizes itself against 1620 sends
    // a day and pushes leads into a campaign that can mail sixty of them, so
    // the backlog grows forever and nothing in the app says why.
    const uncapped = smartDailyCap(eighteen, 4);
    const capped = smartDailyCap(eighteen, 4, DEFAULT_HEADROOM, 60);
    expect(uncapped.leadsPerDay).toBe(344);
    expect(capped.leadsPerDay).toBe(12);
  });
});

/* -------------------------------------------------------------------------- */
/* the arithmetic people get wrong                                            */
/* -------------------------------------------------------------------------- */

describe("turning sends into leads", () => {
  it("DIVIDES BY THE NUMBER OF STEPS", () => {
    // Pushing a lead is not sending an email. A lead in a 4-step sequence
    // sends four emails, so at steady state: daily sends = leads × steps.
    expect(leadsPerDay(900, 4)).toBe(225);
    expect(leadsPerDay(900, 1)).toBe(900);
  });

  it("ten inboxes at 90 with a 4-step sequence is 191 leads a day", () => {
    const accounts = Array.from({ length: 10 }, (_, i) =>
      account({ email: `a${i}@x.com`, dailyLimit: 90 })
    );
    const cap = smartDailyCap(accounts, 4);
    expect(cap.capacity.dailySends).toBe(900);
    expect(cap.capacity.usableSends).toBe(765);
    expect(cap.leadsPerDay).toBe(191);
  });

  it("which is why a hand-typed 100 wastes most of them", () => {
    const accounts = Array.from({ length: 10 }, (_, i) =>
      account({ email: `a${i}@x.com`, dailyLimit: 90 })
    );
    expect(smartDailyCap(accounts, 4).leadsPerDay).toBeGreaterThan(100);
  });

  it("rounds down, never up", () => {
    expect(leadsPerDay(10, 3)).toBe(3);
  });

  it("no inboxes means no leads, and says so", () => {
    const cap = smartDailyCap([], 3);
    expect(cap.leadsPerDay).toBe(0);
    expect(cap.reason).toMatch(/no healthy sending accounts/i);
  });

  it("never divides by zero", () => {
    expect(leadsPerDay(100, 0)).toBe(100);
  });
});

/* -------------------------------------------------------------------------- */
/* moving a limit                                                             */
/* -------------------------------------------------------------------------- */

describe("the ramp", () => {
  it("NEVER TRIPLES AN INBOX IN ONE MOVE", () => {
    // The thing that actually burns a domain. Providers score the rate of
    // change, and 30 to 90 overnight looks like a compromised account.
    const d = planLimitChange(account({ dailyLimit: 30 }), DEFAULT_RAMP, NOW);
    expect("change" in d).toBe(true);
    if ("change" in d) {
      expect(d.change.to).toBe(45);
      expect(d.change.to).toBeLessThan(90);
    }
  });

  it("caps the step at +20 however big the account", () => {
    expect(stepFor(30)).toBe(15);
    expect(stepFor(60)).toBe(20);
    expect(stepFor(200)).toBe(20);
  });

  it("never steps by less than 5", () => {
    expect(stepFor(1)).toBe(5);
  });

  it("reaches the ceiling in four steps from 30, and never overshoots", () => {
    let limit = 30;
    const seen = [limit];
    for (let i = 0; i < 10 && limit < 90; i++) {
      const d = planLimitChange(account({ dailyLimit: limit }), DEFAULT_RAMP, NOW);
      if (!("change" in d)) break;
      limit = d.change.to;
      seen.push(limit);
    }
    expect(seen).toEqual([30, 45, 65, 85, 90]);
    expect(limit).toBe(90);
  });

  it("stops dead at the ceiling", () => {
    const d = planLimitChange(account({ dailyLimit: 90 }), DEFAULT_RAMP, NOW);
    expect("hold" in d).toBe(true);
    if ("hold" in d) expect(d.hold.reason).toMatch(/ceiling/i);
  });

  it("respects a ceiling the operator raised", () => {
    const d = planLimitChange(account({ dailyLimit: 90 }), { ...DEFAULT_RAMP, ceiling: 120 }, NOW);
    expect("change" in d).toBe(true);
  });
});

describe("what is never raised", () => {
  it("an inbox younger than the warmup period", () => {
    const d = planLimitChange(account({ createdAt: daysAgo(10) }), DEFAULT_RAMP, NOW);
    expect("hold" in d).toBe(true);
    if ("hold" in d) expect(d.hold.reason).toMatch(/10 days old/);
  });

  it("an inbox whose health score says it is struggling", () => {
    const d = planLimitChange(account({ warmupScore: 60 }), DEFAULT_RAMP, NOW);
    expect("hold" in d).toBe(true);
    if ("hold" in d) expect(d.hold.reason).toMatch(/makes it worse/);
  });

  it("an inbox raised inside the cooldown", () => {
    const d = planLimitChange(account({ lastRaisedAt: daysAgo(1) }), DEFAULT_RAMP, NOW);
    expect("hold" in d).toBe(true);
    if ("hold" in d) expect(d.hold.reason).toMatch(/time to settle/);
  });

  it("but one raised longer ago than the cooldown is fine", () => {
    expect("change" in planLimitChange(account({ lastRaisedAt: daysAgo(3) }), DEFAULT_RAMP, NOW)).toBe(
      true
    );
  });

  it("an inactive inbox", () => {
    expect("hold" in planLimitChange(account({ active: false }), DEFAULT_RAMP, NOW)).toBe(true);
  });
});

describe("coming back down", () => {
  it("HALVES AN INBOX THAT IS BOUNCING, immediately", () => {
    const d = planLimitChange(
      account({ dailyLimit: 90, recentSends: 400, recentBounces: 30 }),
      DEFAULT_RAMP,
      NOW
    );
    expect("change" in d).toBe(true);
    if ("change" in d) {
      expect(d.change.direction).toBe("lower");
      expect(d.change.to).toBe(45);
      expect(d.change.reason).toMatch(/protect the domain/i);
    }
  });

  it("comes down even inside the cooldown — damage now beats a schedule", () => {
    const d = planLimitChange(
      account({ dailyLimit: 90, recentSends: 400, recentBounces: 30, lastRaisedAt: daysAgo(0) }),
      DEFAULT_RAMP,
      NOW
    );
    expect("change" in d && d.change.direction === "lower").toBe(true);
  });

  it("comes down even on a young or unhealthy inbox", () => {
    const d = planLimitChange(
      account({ dailyLimit: 90, createdAt: daysAgo(3), warmupScore: 20, recentSends: 100, recentBounces: 20 }),
      DEFAULT_RAMP,
      NOW
    );
    expect("change" in d && d.change.direction === "lower").toBe(true);
  });

  it("IGNORES A BOUNCE RATE FROM TOO FEW SENDS", () => {
    // One bounce in five is 20% and means nothing. Acting on it would sawtooth
    // every new inbox down to nothing.
    const d = planLimitChange(
      account({ dailyLimit: 90, recentSends: 5, recentBounces: 1 }),
      DEFAULT_RAMP,
      NOW
    );
    expect("change" in d && d.change.direction === "lower").toBe(false);
  });

  it("never drops below a floor", () => {
    const d = planLimitChange(
      account({ dailyLimit: 12, recentSends: 200, recentBounces: 40 }),
      DEFAULT_RAMP,
      NOW
    );
    if ("change" in d) expect(d.change.to).toBeGreaterThanOrEqual(10);
  });

  it("leaves an inbox alone when the bounce rate is normal", () => {
    const d = planLimitChange(
      account({ dailyLimit: 90, recentSends: 1000, recentBounces: 10 }),
      DEFAULT_RAMP,
      NOW
    );
    expect("hold" in d).toBe(true);
  });
});

describe("every account at once", () => {
  it("splits into changes and holds, and explains all of them", () => {
    const { changes, holds } = planAllLimits(
      [
        account({ email: "ready@x.com", dailyLimit: 30 }),
        account({ email: "capped@x.com", dailyLimit: 90 }),
        account({ email: "young@x.com", createdAt: daysAgo(2) }),
        account({ email: "bouncing@x.com", dailyLimit: 80, recentSends: 300, recentBounces: 30 }),
      ],
      DEFAULT_RAMP,
      NOW
    );
    expect(changes.map((c) => c.email).sort()).toEqual(["bouncing@x.com", "ready@x.com"]);
    expect(holds.length).toBe(2);
    for (const c of [...changes, ...holds]) expect(c.reason.length).toBeGreaterThan(10);
  });

  it("estimates how long the slowest inbox takes to reach the ceiling", () => {
    // 30 → 90 is four steps, two days apart.
    expect(daysToCeiling([account({ dailyLimit: 30 })], DEFAULT_RAMP)).toBe(8);
    expect(daysToCeiling([account({ dailyLimit: 90 })], DEFAULT_RAMP)).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* reading the account list                                                   */
/* -------------------------------------------------------------------------- */

describe("parsing what Instantly sends back", () => {
  it("reads the documented shape", () => {
    const out = normaliseAccounts({
      items: [
        {
          email: "Sam@Ours.com",
          daily_limit: 30,
          stat_warmup_score: 96,
          warmup_status: "active",
          status: 1,
          timestamp_created: "2026-01-01T00:00:00Z",
        },
      ],
    });
    expect(out[0]).toEqual({
      email: "sam@ours.com",
      dailyLimit: 30,
      warmupScore: 96,
      warmupStatus: "active",
      active: true,
      createdAt: "2026-01-01T00:00:00Z",
    });
  });

  it("accepts a bare array and a data envelope too", () => {
    const one = [{ email: "a@x.com", daily_limit: 10 }];
    expect(normaliseAccounts(one).length).toBe(1);
    expect(normaliseAccounts({ data: one }).length).toBe(1);
    expect(normaliseAccounts(null).length).toBe(0);
  });

  it("A LIMIT IT CANNOT READ IS ZERO, NOT A GUESS", () => {
    // Zero drops the inbox out of the capacity total, which is the safe
    // direction. A guessed 50 would have the planner sending against an inbox
    // it knows nothing about.
    expect(normaliseAccounts([{ email: "a@x.com" }])[0].dailyLimit).toBe(0);
    expect(computeCapacity(normaliseAccounts([{ email: "a@x.com" }]).map((a) => ({
      ...a,
      recentSends: 0,
      recentBounces: 0,
    }))).dailySends).toBe(0);
  });

  it("reads a paused account as inactive, in either spelling", () => {
    expect(normaliseAccounts([{ email: "a@x.com", status: 2 }])[0].active).toBe(false);
    expect(normaliseAccounts([{ email: "a@x.com", status: "paused" }])[0].active).toBe(false);
    expect(normaliseAccounts([{ email: "a@x.com", status: "active" }])[0].active).toBe(true);
  });

  it("treats a missing status as active rather than silently ignoring every inbox", () => {
    expect(normaliseAccounts([{ email: "a@x.com", daily_limit: 30 }])[0].active).toBe(true);
  });

  it("skips a row with no address at all", () => {
    expect(normaliseAccounts([{ daily_limit: 30 }])).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* the campaign limit is read, not just accounted for                         */
/* -------------------------------------------------------------------------- */

describe("reading a campaign's daily limit", () => {
  it("picks it up under any of the names it goes by", () => {
    expect(normaliseCampaigns([{ id: "c1", daily_limit: 60 }])[0].dailyLimit).toBe(60);
    expect(normaliseCampaigns([{ id: "c1", dailyLimit: 60 }])[0].dailyLimit).toBe(60);
    expect(normaliseCampaigns([{ id: "c1", campaign_daily_limit: "60" }])[0].dailyLimit).toBe(60);
  });

  it("IS NULL WHEN ABSENT, never a guessed default", () => {
    // A guess here would silently change how many leads a day get pushed.
    expect(normaliseCampaigns([{ id: "c1", name: "X" }])[0].dailyLimit).toBeNull();
  });
});

/*
 * "Do not report built when logic exists but is not wired into the real
 * workflow." A capacity function that ACCEPTS a campaign limit is worth nothing
 * if the two places that compute capacity never pass one — and that is exactly
 * the shape of bug this codebase has shipped before. These read the production
 * files.
 */
describe("THE CAMPAIGN LIMIT REACHES THE PLACES THAT DECIDE", () => {
  const sync = readFileSync(new URL("../src/lib/capacitySync.ts", import.meta.url), "utf8");
  const route = readFileSync(
    new URL("../src/app/api/instantly/capacity/route.ts", import.meta.url),
    "utf8"
  );

  it("the worker's sync reads it and passes it to BOTH calculations", () => {
    expect(sync).toMatch(/campaignDailyLimit\(settings\.campaign_id\)/);
    expect(sync).toMatch(/smartDailyCap\(accounts, steps, headroom, campaignLimit\)/);
    expect(sync).toMatch(/computeCapacity\(accounts, headroom, campaignLimit\)/);
  });

  it("the page's own numbers come from the same limit", () => {
    // Otherwise the page and the worker disagree, which is the drift that
    // produced "47 ready to call" next to "none are available".
    expect(route).toMatch(/campaignDailyLimit\(settings\.campaign_id\)/);
    expect(route).toMatch(/computeCapacity\(accounts, headroom, campaignLimit\)/);
    expect(route).toMatch(/smartDailyCap\(accounts, steps, headroom, campaignLimit\)/);
  });

  it("a failed read never takes the page down with it", () => {
    expect(route).toMatch(/\.catch\(\(\) => null\)/);
  });
});
