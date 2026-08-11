// The three things that let the email programme run itself: what a sequence is
// allowed to be, how the cadence is translated for Instantly, and how many
// leads to push without being asked.
//
// All three are pure, and all three are places where being wrong is quiet — a
// sequence that sends on the wrong days, or a top-up that double-fills a
// campaign, produces no error at all. Hence the tests.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  validatePlan,
  normalisePlan,
  describeCadence,
  containsMoneyOrTerms,
  unknownVariables,
  variablesUsed,
  looksLikePlan,
  MAX_STEPS,
  MIN_STEPS,
  MAX_DELAY_DAYS,
  type SequencePlan,
  type SequenceStep,
} from "../src/lib/sequencePlan";
import {
  toInstantlySequence,
  readCampaignSteps,
  hasVisibleText,
  formatBody,
  countBlocks,
} from "../src/lib/instantly/mapping";
import { planRefill, dailyCounterFor, todayString } from "../src/lib/refillPlan";
import { composeVariables } from "../src/lib/emailCompose";

const step = (over: Partial<SequenceStep> = {}): SequenceStep => ({
  step: 1,
  delayDays: 0,
  subject: "Missed calls at {{business_name}}",
  body: "{{greeting}}\n\nWhat happens to a call you cannot get to?\n\n{{gap_list}}",
  rationale: "Opens on the one question that matters.",
  ...over,
});

const plan = (steps: SequenceStep[]): SequencePlan => ({
  name: "Missed calls",
  brief: "short and direct",
  steps,
});

const good = plan([
  step(),
  step({
    step: 2,
    delayDays: 3,
    subject: "One more thing",
    body: "Most people will not leave a message.\n\nHere is what we found for {{business_name}}: {{workshop_link}}",
  }),
  step({ step: 3, delayDays: 5, subject: "Last one", body: "Happy to leave it there if it is not for you." }),
]);

/* -------------------------------------------------------------------------- */
/* what a sequence may be                                                     */
/* -------------------------------------------------------------------------- */

describe("a valid sequence passes", () => {
  it("no complaints about a sensible three-email run", () => {
    expect(validatePlan(good)).toEqual([]);
  });
});

describe("AT LEAST ONE EMAIL MUST CARRY THE LINK", () => {
  it("a sequence that never links to the prospect's page is refused", () => {
    // Every pushed lead now gets a packet — their gaps, their
    // recommendations, the same page a caller would have texted them — and
    // {{workshop_link}} is how the sequence reaches it. A sequence that never
    // references it sends the prospect nothing to look at, and the whole
    // diagnostic pipeline behind it produces a variable that goes nowhere.
    const noLink = plan([step(), step({ step: 2, delayDays: 3 })]);
    const problems = validatePlan(noLink);
    expect(problems.some((p) => /workshop_link/.test(p.problem))).toBe(true);
  });

  it("one is enough — it does not have to be in every email", () => {
    expect(validatePlan(good)).toEqual([]);
    expect(good.steps.filter((s) => s.body.includes("{{workshop_link}}")).length).toBe(1);
  });

  it("counts it in the subject too", () => {
    const inSubject = plan([
      step({ subject: "Your plan: {{workshop_link}}" }),
      step({ step: 2, delayDays: 3 }),
    ]);
    expect(validatePlan(inSubject).some((p) => /workshop_link/.test(p.problem))).toBe(false);
  });
});

describe("NO GENERATED COPY EVER CONTAINS A PRICE", () => {
  const money = [
    "It is $199 a month.",
    "20% off if you sign up this week",
    "Get a free trial today",
    "300 dollars, all in",
    "No contract, cancel anytime",
    "money-back guarantee",
    "and it is only 99 to start",
  ];

  for (const text of money) {
    it(`rejects "${text}"`, () => {
      expect(containsMoneyOrTerms(text)).not.toBeNull();
      const problems = validatePlan(plan([step(), step({ step: 2, delayDays: 2, body: text })]));
      expect(problems.some((p) => /never written automatically/i.test(p.problem))).toBe(true);
    });
  }

  it("is checked in the subject as well as the body", () => {
    const problems = validatePlan(
      plan([step({ subject: "Save 50% on your calls" }), step({ step: 2, delayDays: 2 })])
    );
    expect(problems.some((p) => /never written automatically/i.test(p.problem))).toBe(true);
  });

  it("does not fire on ordinary sales copy", () => {
    expect(containsMoneyOrTerms("Worth a two-minute look?")).toBeNull();
    expect(containsMoneyOrTerms("Every call gets answered and you get the details by text.")).toBeNull();
  });

  it("normalisePlan does NOT quietly strip it", () => {
    // Deleting the pricing sentence would leave a paragraph with a hole in it.
    // The writer is told to try again instead.
    const withMoney = plan([step(), step({ step: 2, delayDays: 2, body: "It is $99 a month." })]);
    expect(normalisePlan(withMoney).steps[1].body).toContain("$99");
    expect(validatePlan(normalisePlan(withMoney)).length).toBeGreaterThan(0);
  });
});

describe("the bounds on the writer's judgement", () => {
  it("one email is not a sequence", () => {
    const problems = validatePlan(plan([step()]));
    expect(problems.some((p) => new RegExp(`at least ${MIN_STEPS}`).test(p.problem))).toBe(true);
  });

  it("too many is spam", () => {
    const many = Array.from({ length: MAX_STEPS + 2 }, (_, i) =>
      step({ step: i + 1, delayDays: i === 0 ? 0 : 2 })
    );
    const problems = validatePlan(plan(many));
    expect(problems.some((p) => /too many/i.test(p.problem))).toBe(true);
  });

  it("the first email must go out immediately", () => {
    const problems = validatePlan(plan([step({ delayDays: 3 }), step({ step: 2, delayDays: 2 })]));
    expect(problems.some((p) => /must be 0/.test(p.problem))).toBe(true);
  });

  it("two emails the same day is a bug", () => {
    const problems = validatePlan(plan([step(), step({ step: 2, delayDays: 0 })]));
    expect(problems.some((p) => /at least 1 day/i.test(p.problem))).toBe(true);
  });

  it("a gap long enough to be forgotten is refused", () => {
    const problems = validatePlan(plan([step(), step({ step: 2, delayDays: MAX_DELAY_DAYS + 10 })]));
    expect(problems.some((p) => /forgotten/i.test(p.problem))).toBe(true);
  });

  it("the whole run cannot drag past a month and a half", () => {
    const long = [
      step(),
      step({ step: 2, delayDays: 14 }),
      step({ step: 3, delayDays: 14 }),
      step({ step: 4, delayDays: 14 }),
      step({ step: 5, delayDays: 14 }),
    ];
    expect(validatePlan(plan(long)).some((p) => /one conversation/i.test(p.problem))).toBe(true);
  });

  it('a subject starting "Re:" is a lie about a conversation that never happened', () => {
    const problems = validatePlan(plan([step({ subject: "Re: our chat" }), step({ step: 2, delayDays: 2 })]));
    expect(problems.some((p) => /never happened/i.test(p.problem))).toBe(true);
  });

  it("a subject too long to read on a phone is refused", () => {
    const problems = validatePlan(
      plan([step({ subject: "x".repeat(120) }), step({ step: 2, delayDays: 2 })])
    );
    expect(problems.some((p) => /cut off on a phone/i.test(p.problem))).toBe(true);
  });

  it("reports EVERY problem, not the first", () => {
    // The fix is one regeneration with all the complaints fed back. One at a
    // time would mean six round trips to fix six things.
    const bad = plan([step({ subject: "", delayDays: 5 }), step({ step: 2, delayDays: 0, body: "" })]);
    expect(validatePlan(bad).length).toBeGreaterThanOrEqual(4);
  });
});

describe("merge fields", () => {
  it("finds the ones used", () => {
    expect(variablesUsed("Hi {{owner_first_name}} at {{business_name}}").sort()).toEqual([
      "business_name",
      "owner_first_name",
    ]);
  });

  it("A FIELD WE DO NOT SEND WOULD APPEAR LITERALLY, so it is an error", () => {
    expect(unknownVariables("Hi {{first_name}}")).toEqual(["first_name"]);
    const problems = validatePlan(
      plan([step({ body: "Hi {{owner_last_name}}" }), step({ step: 2, delayDays: 2 })])
    );
    expect(problems.some((p) => /appear literally/i.test(p.problem))).toBe(true);
  });

  it("accepts every field the push actually sends", () => {
    const body = "{{business_name}} {{owner_first_name}} {{review_count}} {{workshop_link}} {{gap_headline}}";
    expect(unknownVariables(body)).toEqual([]);
  });
});

describe("normalising", () => {
  it("renumbers, clamps and forces the first delay to zero", () => {
    const messy = plan([
      step({ step: 7, delayDays: 9 }),
      step({ step: 9, delayDays: 99 }),
      step({ step: 11, delayDays: 0 }),
    ]);
    const out = normalisePlan(messy);
    expect(out.steps.map((x) => x.step)).toEqual([1, 2, 3]);
    expect(out.steps[0].delayDays).toBe(0);
    expect(out.steps[1].delayDays).toBe(MAX_DELAY_DAYS);
    expect(out.steps[2].delayDays).toBe(1);
  });

  it("drops anything past the ceiling", () => {
    const many = Array.from({ length: 12 }, (_, i) => step({ step: i + 1, delayDays: 2 }));
    expect(normalisePlan(plan(many)).steps.length).toBe(MAX_STEPS);
  });

  it("rejects a shape that is not a plan at all", () => {
    expect(looksLikePlan(null)).toBe(false);
    expect(looksLikePlan({ name: "x" })).toBe(false);
    expect(looksLikePlan({ name: "x", steps: [{ subject: 1, body: "y" }] })).toBe(false);
    expect(looksLikePlan(good)).toBe(true);
  });
});

describe("describing the cadence", () => {
  it("says which days it lands on", () => {
    expect(describeCadence(good.steps)).toBe("3 emails over 8 days — sent on day 0, then 3, then 8.");
  });
});

/* -------------------------------------------------------------------------- */
/* the off-by-one                                                             */
/* -------------------------------------------------------------------------- */

describe("translating the cadence for Instantly", () => {
  it("MOVES THE WAIT BACK ONE STEP", () => {
    // Ours: delayDays on a step is the wait BEFORE it.
    // Instantly: delay on a step is the wait AFTER it.
    // Getting this backwards sends on the wrong days, silently, forever.
    const out = toInstantlySequence(good.steps);
    expect(out.steps.map((x) => x.delay)).toEqual([3, 5, 0]);
  });

  it("the last step waits for nothing", () => {
    const out = toInstantlySequence(good.steps);
    expect(out.steps[out.steps.length - 1].delay).toBe(0);
  });

  it("the total elapsed time survives the translation", () => {
    const ourTotal = good.steps.slice(1).reduce((n, x) => n + x.delayDays, 0);
    const theirTotal = toInstantlySequence(good.steps)
      .steps.slice(0, -1)
      .reduce((n, x) => n + x.delay, 0);
    expect(theirTotal).toBe(ourTotal);
  });

  it("DEFAULTS TO REAL PARAGRAPHS, which is the only form that both stores and renders", () => {
    // Plain \n stores fine and renders as one block, because HTML collapses
    // newlines. Bare <br> rendered fine and stored BLANK on the live account.
    // <p> blocks are what the editor itself produces and satisfy both.
    const out = toInstantlySequence([step({ body: "Hi,\n\nOne question." })]);
    expect(out.steps[0].variants[0].body).toBe("<p>Hi,</p><p>One question.</p>");
  });

  it("keeps a single newline as a break INSIDE its paragraph", () => {
    // A sign-off and the line under it are one block, not two.
    expect(formatBody("Thanks,\nSam", "paragraphs")).toBe("<p>Thanks,<br>Sam</p>");
  });

  it("COUNTS BLOCKS, so fused paragraphs can be told from missing ones", () => {
    expect(countBlocks("<p>a</p><p>b</p><p>c</p>")).toBe(3);
    expect(countBlocks("a<br>b")).toBe(2);
    // The failure that shipped: content present, structure gone.
    expect(countBlocks("a b c")).toBe(1);
    expect(countBlocks("")).toBe(0);
  });

  it("keeps the line breaks in HTML form, so an email is not one paragraph", () => {
    const out = toInstantlySequence([step({ body: "Hi,\n\nOne question.\n\nWorth a look?" })], "html");
    expect(out.steps[0].variants[0].body).toContain("<br>");
    expect(out.steps[0].variants[0].body).not.toContain("\n");
  });

  it("escapes markup in HTML form so a stray angle bracket cannot break it", () => {
    const out = toInstantlySequence([step({ body: "a < b & c > d" })], "html");
    expect(out.steps[0].variants[0].body).toBe("a &lt; b &amp; c &gt; d");
  });

  it("NEVER MANGLES THE TEXT FORM — it is passed through untouched", () => {
    // Escaping plain text would put &lt; in somebody's inbox.
    expect(formatBody("a < b & c > d", "text")).toBe("a < b & c > d");
  });

  it("leaves merge fields alone in both forms", () => {
    for (const f of ["text", "html"] as const) {
      expect(formatBody("Hi {{owner_first_name}}", f)).toContain("{{owner_first_name}}");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* pushing without being asked                                                */
/* -------------------------------------------------------------------------- */

const base = {
  autoPushEnabled: true,
  programmeEnabled: true,
  campaignId: "camp-1",
  activeInCampaign: 50,
  targetActive: 200,
  dailyCap: 100,
  pushedToday: 0,
  eligible: 500,
  maxPerRun: 50,
};

describe("the automatic top-up", () => {
  it("does nothing at all unless somebody switched it on", () => {
    expect(planRefill({ ...base, autoPushEnabled: false }).count).toBe(0);
    expect(planRefill({ ...base, programmeEnabled: false }).count).toBe(0);
    expect(planRefill({ ...base, campaignId: null }).count).toBe(0);
  });

  it("A COUNT IT COULD NOT READ IS NOT ZERO", () => {
    // The one that would actually hurt. A failed count read as "empty" would
    // push a full batch into a campaign that is already full, every day, on
    // every failure, until somebody noticed the send volume.
    const d = planRefill({ ...base, activeInCampaign: null });
    expect(d.count).toBe(0);
    expect(d.reason).toMatch(/could not read/i);
  });

  it("pushes the gap up to the target", () => {
    const d = planRefill({ ...base, activeInCampaign: 180, maxPerRun: 500 });
    expect(d.count).toBe(20);
    expect(d.reason).toMatch(/topping the campaign up/);
  });

  it("pushes nothing when the campaign is already at target", () => {
    expect(planRefill({ ...base, activeInCampaign: 200 }).count).toBe(0);
    expect(planRefill({ ...base, activeInCampaign: 500 }).count).toBe(0);
  });

  it("respects the daily cap, and says which ceiling bit", () => {
    const d = planRefill({ ...base, pushedToday: 90, maxPerRun: 500 });
    expect(d.count).toBe(10);
    expect(d.reason).toMatch(/today's cap/);
  });

  it("stops entirely once the day is used up", () => {
    expect(planRefill({ ...base, pushedToday: 100 }).count).toBe(0);
    expect(planRefill({ ...base, pushedToday: 250 }).count).toBe(0);
  });

  it("never pushes more leads than exist", () => {
    expect(planRefill({ ...base, eligible: 7 }).count).toBe(7);
    expect(planRefill({ ...base, eligible: 0 }).count).toBe(0);
  });

  it("respects the per-run cap the manual button also uses", () => {
    expect(planRefill({ ...base, maxPerRun: 25 }).count).toBe(25);
  });

  it("EVERY CEILING IS A CEILING — the smallest always wins", () => {
    for (const over of [
      { activeInCampaign: 195 }, // room = 5
      { pushedToday: 97 }, //       daily = 3
      { eligible: 2 },
      { maxPerRun: 1 },
    ]) {
      const d = planRefill({ ...base, ...over });
      const smallest = Math.min(
        base.targetActive - (over.activeInCampaign ?? base.activeInCampaign),
        base.dailyCap - (over.pushedToday ?? base.pushedToday),
        over.eligible ?? base.eligible,
        over.maxPerRun ?? base.maxPerRun
      );
      expect(d.count, JSON.stringify(over)).toBe(smallest);
    }
  });

  it("always explains itself, even when the answer is nothing", () => {
    for (const over of [
      { autoPushEnabled: false },
      { activeInCampaign: null },
      { activeInCampaign: 900 },
      { pushedToday: 100 },
      { eligible: 0 },
      {},
    ]) {
      expect(planRefill({ ...base, ...over }).reason.length).toBeGreaterThan(10);
    }
  });
});

describe("the daily counter", () => {
  it("carries over within the same day", () => {
    expect(dailyCounterFor({ pushedToday: 40, pushedTodayDate: "2026-08-04" }, "2026-08-04")).toBe(40);
  });

  it("RESETS ON A CALENDAR DAY, not 24 hours later", () => {
    // A cap that resets 24 hours after the last push drifts later every day
    // and eventually sends in the middle of the night.
    expect(dailyCounterFor({ pushedToday: 100, pushedTodayDate: "2026-08-03" }, "2026-08-04")).toBe(0);
  });

  it("starts at zero when nothing has ever been pushed", () => {
    expect(dailyCounterFor({ pushedToday: 0, pushedTodayDate: null }, "2026-08-04")).toBe(0);
  });

  it("formats the way Postgres stores a date", () => {
    expect(todayString(new Date("2026-08-04T23:30:00Z"))).toBe("2026-08-04");
  });
});

/* -------------------------------------------------------------------------- */
/* the top-up can finally count                                               */
/* -------------------------------------------------------------------------- */

/*
 * The automatic top-up was on, the worker was alive, the campaign was Active
 * and 92 leads had addresses — and the campaign stayed empty.
 *
 * activeLeadCount() asked Instantly how many leads were in the campaign.
 * /leads/list returns a page of items and no total, so it found no `total`,
 * `total_count` or `count` key and returned null every minute. planRefill
 * treats null as DO NOT PUSH, which is right — pushing blind double-fills a
 * campaign — and meant the top-up declined sixty times an hour, silently.
 *
 * The count now comes from our own thread rows, which cannot be null and need
 * no API. Instantly's number is still used when it arrives, as a ceiling.
 */
describe("A COUNT WE OWN, RATHER THAN ONE WE HAVE TO ASK FOR", () => {
  /** The resolution used by the refill handler. */
  const resolve = (ours: number | null, theirs: number | null) =>
    ours === null ? theirs : theirs === null ? ours : Math.max(ours, theirs);

  it("uses our own count when Instantly says nothing — the case that was stuck", () => {
    expect(resolve(40, null)).toBe(40);
    // And that is a number, so planRefill will act on it.
    expect(
      planRefill({
        autoPushEnabled: true,
        programmeEnabled: true,
        campaignId: "c1",
        activeInCampaign: resolve(40, null),
        targetActive: 1000,
        dailyCap: 500,
        pushedToday: 0,
        eligible: 92,
        maxPerRun: 49,
      }).count
    ).toBeGreaterThan(0);
  });

  it("takes the LARGER when both are known, so a disagreement under-fills", () => {
    // Over-pushing is the one failure that burns a sending domain.
    expect(resolve(40, 118)).toBe(118);
    expect(resolve(118, 40)).toBe(118);
  });

  it("still refuses to push when NEITHER can be read", () => {
    expect(resolve(null, null)).toBeNull();
    const d = planRefill({
      autoPushEnabled: true,
      programmeEnabled: true,
      campaignId: "c1",
      activeInCampaign: resolve(null, null),
      targetActive: 1000,
      dailyCap: 500,
      pushedToday: 0,
      eligible: 92,
      maxPerRun: 49,
    });
    expect(d.count).toBe(0);
    expect(d.reason).toMatch(/Could not read how many leads are in the campaign/);
  });

  it("an empty campaign is zero, not unknown", () => {
    // The distinction the whole bug turned on: nothing in the campaign must
    // read as 0 and push, not as null and decline.
    expect(resolve(0, null)).toBe(0);
    expect(
      planRefill({
        autoPushEnabled: true,
        programmeEnabled: true,
        campaignId: "c1",
        activeInCampaign: 0,
        targetActive: 1000,
        dailyCap: 500,
        pushedToday: 0,
        eligible: 92,
        maxPerRun: 49,
      }).count
    ).toBe(49);
  });
});

describe("THE HANDLER USES THE COUNT IT OWNS", () => {
  const src = readFileSync(new URL("../src/lib/jobHandlers.ts", import.meta.url), "utf8");
  const refill = src.slice(
    src.indexOf("const refillEmailCampaign"),
    src.indexOf("const syncSendingAccountsJob")
  );

  it("asks our own thread count", () => {
    expect(refill).toMatch(/activeThreadCount\(/);
  });

  it("does not let Instantly's null decide on its own", () => {
    expect(refill).toMatch(/ours === null \? theirs : theirs === null \? ours : Math\.max\(ours, theirs\)/);
  });
});

/* -------------------------------------------------------------------------- */
/* a 200 is not proof the copy arrived                                        */
/* -------------------------------------------------------------------------- */

/*
 * The campaign that produced this: every subject present in the Instantly
 * editor, every BODY blank, and this app reporting "Published" — because
 * publishing checked that the PATCH was accepted and never that the words
 * landed. An accepted request and a correct one are different facts.
 */
describe("THE FINDINGS BELONG IN THE EMAIL, NOT BEHIND THE LINK", () => {
  /*
   * We diagnose the business, then the copy said "here is what we found:
   * <link>" — so everything of substance was visible only to whoever was
   * curious enough to click, which is the person who needed convincing
   * least. The findings are the reason the email is worth reading.
   */
  const firstEmail = (body: string) =>
    validatePlan(
      plan([
        step({ body }),
        step({ step: 2, delayDays: 3, body: "More soon. {{workshop_link}}" }),
      ])
    );

  it("REFUSES a first email that only offers a link", () => {
    const problems = firstEmail("Hi {{owner_first_name}},\n\nWe looked at {{business_name}}. See {{workshop_link}}");
    expect(problems.some((p) => /does not say what we found/.test(p.problem))).toBe(true);
  });

  it("accepts one that carries the list of findings", () => {
    expect(firstEmail("Hi,\n\n{{gap_list}}\n\nMore: {{workshop_link}}")).toEqual([]);
  });

  it("accepts the headline-and-detail form too", () => {
    expect(
      firstEmail("Hi,\n\n{{gap_headline}}\n\n{{gap_detail}}\n\nMore: {{workshop_link}}")
    ).toEqual([]);
  });

  it("names the FIRST email, which is the one everybody reads", () => {
    const problems = firstEmail("Nothing useful here. {{workshop_link}}");
    expect(problems.find((p) => /does not say what we found/.test(p.problem))?.step).toBe(1);
  });

  it("the writer is told to put them in, not to link to them", () => {
    const writer = readFileSync(new URL("../src/lib/sequenceWriter.ts", import.meta.url), "utf8");
    expect(writer).toMatch(/PUT THE FINDINGS IN THE EMAIL/);
    expect(writer).toMatch(/still be worth reading if the link were removed/);
  });
});

describe("READING BACK WHAT INSTANTLY ACTUALLY STORED", () => {
  const campaign = (steps: { subject?: string; body?: string }[]) => ({
    id: "c1",
    sequences: [{ steps: steps.map((v) => ({ type: "email", delay: 0, variants: [v] })) }],
  });

  it("reads the subject and body of every step", () => {
    const got = readCampaignSteps(
      campaign([
        { subject: "One", body: "First body" },
        { subject: "Two", body: "Second body" },
      ])
    );
    expect(got).toEqual([
      { subject: "One", body: "First body" },
      { subject: "Two", body: "Second body" },
    ]);
  });

  it("SEES THE EXACT FAILURE: subject present, body gone", () => {
    const got = readCampaignSteps(campaign([{ subject: "{{business_name}} — a few things", body: "" }]));
    expect(got).toEqual([{ subject: "{{business_name}} — a few things", body: "" }]);
    expect(hasVisibleText(got![0].body)).toBe(false);
  });

  it("only reads the first sequence, which is the only one Instantly uses", () => {
    const body = {
      sequences: [
        { steps: [{ variants: [{ subject: "real", body: "real" }] }] },
        { steps: [{ variants: [{ subject: "ignored", body: "ignored" }] }] },
      ],
    };
    expect(readCampaignSteps(body)).toHaveLength(1);
  });

  it("A CAMPAIGN IT CANNOT READ IS NULL, NEVER AN EMPTY LIST", () => {
    // Empty would read as "the campaign has no copy" and send somebody
    // republishing over emails that were perfectly fine.
    for (const junk of [null, undefined, {}, { sequences: [] }, { sequences: [{}] }, "nope"]) {
      expect(readCampaignSteps(junk)).toBeNull();
    }
  });

  it("a step with no variants reads as empty rather than throwing", () => {
    expect(readCampaignSteps({ sequences: [{ steps: [{ type: "email" }] }] })).toEqual([
      { subject: "", body: "" },
    ]);
  });
});

describe("tags are not content", () => {
  it("counts real words as visible", () => {
    expect(hasVisibleText("Hi there<br>How are you?")).toBe(true);
  });

  it("KNOWS A BODY OF PURE MARKUP IS A BLANK EMAIL", () => {
    // The shape a mangled round-trip leaves behind: structurally valid,
    // renders as nothing, and would pass any check that only asked whether
    // the string was empty.
    for (const blank of ["", "   ", "<br>", "<br><br><br>", "<div></div>", "<p>&nbsp;</p>"]) {
      expect(hasVisibleText(blank)).toBe(false);
    }
  });
});

/*
 * "Do not report built when logic exists but is not wired into the real
 * workflow." Reading back is worth nothing if publishing does not do it, so
 * this reads the production file.
 */
describe("PUBLISHING VERIFIES, RATHER THAN TRUSTING THE RESPONSE", () => {
  const client = readFileSync(
    new URL("../src/lib/instantly/client.ts", import.meta.url),
    "utf8"
  );
  const route = readFileSync(
    new URL("../src/app/api/instantly/sequence/route.ts", import.meta.url),
    "utf8"
  );

  it("publishSequence reads the campaign back after the PATCH", () => {
    const publish = client.slice(client.indexOf("export async function publishSequence"));
    expect(publish).toMatch(/readPublishedSteps\(campaignId\)/);
  });

  it("an empty body is reported as NOT published", () => {
    const publish = client.slice(client.indexOf("export async function publishSequence"));
    expect(publish).toMatch(/hasVisibleText\(s\.body\)/);
    // Success requires no blank bodies, no fused ones, and every step stored.
    expect(publish).toMatch(/blank === 0 && fused === 0 && stored\.length >= steps\.length/);
  });

  it("CHECKS STRUCTURE TOO — content present with the breaks gone is a failure", () => {
    // "Is it empty" passed a sequence whose paragraphs had all fused into one
    // block. That shipped. Emptiness is not the only way to lose the copy.
    const publish = client.slice(client.indexOf("export async function publishSequence"));
    expect(publish).toMatch(/countBlocks\(s\.body\) < wanted/);
  });

  it("tries paragraphs first, then the two formats already known to fail one way", () => {
    const publish = client.slice(client.indexOf("export async function publishSequence"));
    expect(publish).toMatch(/\["paragraphs", "html", "text"\] as const/);
    expect(publish).toMatch(/toInstantlySequence\(steps, format\)/);
  });

  it("verifies BETWEEN the two attempts rather than firing both blindly", () => {
    // What separates a waterfall from a shotgun: the second format is only
    // sent because the first one was checked and found wanting.
    const publish = client.slice(client.indexOf("export async function publishSequence"));
    const readBack = publish.indexOf("readPublishedSteps(campaignId)");
    const secondTry = publish.indexOf("last = { blank");
    expect(readBack).toBeGreaterThan(-1);
    expect(readBack).toBeLessThan(secondTry);
  });

  it("a failed read-back does NOT become a failed publish", () => {
    // The PATCH succeeded. Calling that a failure sends somebody chasing copy
    // that is fine.
    const publish = client.slice(client.indexOf("export async function publishSequence"));
    expect(publish).toMatch(/stored === null\) return \{ ok: true \}/);
  });

  it("the page is told what the campaign really contains", () => {
    expect(route).toMatch(/inInstantly/);
    expect(route).toMatch(/blankBodies/);
  });
});

/* -------------------------------------------------------------------------- */
/* "Hey ," is what most prospects were reading                                */
/* -------------------------------------------------------------------------- */

/*
 * Most leads are reached at a general inbox, and a general inbox rarely comes
 * with a person's name. A template that writes its own greeting around
 * {{owner_first_name}} therefore renders as "Hey ," — the first thing the
 * prospect reads, announcing a mail merge before the first sentence.
 */
describe("THE GREETING MUST SURVIVE NOT KNOWING WHO THEY ARE", () => {
  it("resolves to a name when there is one", () => {
    const v = composeVariables({ businessName: "Rivera Plumbing", ownerName: "Maria Rivera" } as never);
    expect(v.greeting).toBe("Hi Maria,");
  });

  it("resolves to a COMPLETE greeting when there is not", () => {
    const v = composeVariables({ businessName: "Rivera Plumbing", ownerName: null } as never);
    expect(v.greeting).toBe("Hi,");
    // The bug this replaces, stated so it cannot come back silently.
    expect(`Hey ${v.owner_first_name},`).toBe("Hey ,");
  });

  it("REFUSES a template that builds its own greeting from the name", () => {
    const problems = validatePlan(
      plan([
        step({ body: "Hey {{owner_first_name}},\n\n{{gap_list}}" }),
        step({ step: 2, delayDays: 3, body: "More. {{workshop_link}}" }),
      ])
    );
    expect(problems.some((p) => /renders as/.test(p.problem))).toBe(true);
  });

  it("catches every way of writing it", () => {
    for (const opener of ["Hi", "Hey", "Hello", "Dear", "hi", "HEY"]) {
      const problems = validatePlan(
        plan([
          step({ body: `${opener} {{owner_first_name}},\n\n{{gap_list}}` }),
          step({ step: 2, delayDays: 3, body: "More. {{workshop_link}}" }),
        ])
      );
      expect(problems.some((p) => /\{\{greeting\}\}/.test(p.problem))).toBe(true);
    }
  });

  it("still allows the name MID-SENTENCE, where an empty one reads fine", () => {
    const problems = validatePlan(
      plan([
        step({ body: "{{greeting}}\n\n{{gap_list}}\n\nThanks {{owner_first_name}}" }),
        step({ step: 2, delayDays: 3, body: "More. {{workshop_link}}" }),
      ])
    );
    expect(problems).toEqual([]);
  });

  it("the writer is told to use it", () => {
    const writer = readFileSync(new URL("../src/lib/sequenceWriter.ts", import.meta.url), "utf8");
    expect(writer).toMatch(/THE GREETING IS \{\{greeting\}\}, ALWAYS/);
  });
});
