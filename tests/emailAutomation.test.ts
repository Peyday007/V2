// Composing, drafting, the auto-send gate, and the webhook parsing.
//
// The two properties worth stating up front, because they are what these tests
// are protecting:
//
//   NOTHING IS INVENTED. A personalization line only ever states a fact that
//   is on the record. A thin record produces a short line or none.
//
//   NO DRAFT EVER NAMES A PRICE, and any reply about money goes to a person
//   whatever the settings say.

import { describe, it, expect } from "vitest";
import {
  composePersonalization,
  composeVariables,
  composePreview,
  splitName,
} from "../src/lib/emailCompose";
import { buildDraft, mayAutoSend, mentionsMoney } from "../src/lib/emailDraft";
import {
  normaliseEvent,
  mapEventType,
  suppressesEmail,
  needsHuman,
  idempotencyKeyFor,
} from "../src/lib/instantly/events";
// From ./mapping rather than ./client: client.ts imports server-only, which a
// test cannot load. That split is exactly why the pure parts live separately.
import { normaliseCampaigns, pushBody, explainStatus } from "../src/lib/instantly/mapping";

/* -------------------------------------------------------------------------- */
/* composing                                                                  */
/* -------------------------------------------------------------------------- */

describe("the personalization only says what the record supports", () => {
  it("quotes what the owner said on the phone, above everything else", () => {
    const line = composePersonalization({
      businessName: "Ace Plumbing",
      reviewCount: 400,
      answeringSetup: "my wife picks up when she can",
    });
    expect(line).toContain("my wife picks up when she can");
  });

  it("uses the review count when there is one", () => {
    const line = composePersonalization({ businessName: "Ace Plumbing", reviewCount: 132 });
    expect(line).toContain("132 reviews");
  });

  it("NEVER claims a review count that is not on the record", () => {
    const line = composePersonalization({ businessName: "Ace Plumbing", website: "a.com" });
    expect(line).toBe("");
    expect(line).not.toMatch(/\d/);
  });

  it("does not say '0 reviews' for a null count", () => {
    const line = composePersonalization({
      businessName: "Ace Plumbing",
      reviewCount: null,
      website: "a.com",
    });
    expect(line).not.toContain("0 reviews");
  });

  it("a missing website is a fact and may be stated", () => {
    expect(composePersonalization({ businessName: "Ace Plumbing" })).toContain("no website");
  });

  it("a present website produces no claim either way", () => {
    // Having a website says nothing about how calls are handled.
    const line = composePersonalization({ businessName: "Ace Plumbing", website: "ace.com" });
    expect(line).toBe("");
  });

  it("a long quote is trimmed rather than run into a paragraph", () => {
    const line = composePersonalization({
      businessName: "Ace",
      answeringSetup: "x".repeat(400),
    });
    expect(line.length).toBeLessThan(200);
  });
});

describe("merge variables", () => {
  it("are all strings, because a null renders as the word null", () => {
    const vars = composeVariables({ businessName: "Ace Plumbing" });
    for (const [k, v] of Object.entries(vars)) {
      expect(typeof v, k).toBe("string");
    }
  });

  it("absent facts are empty, not placeholders", () => {
    const vars = composeVariables({ businessName: "Ace Plumbing" });
    expect(vars.review_count).toBe("");
    expect(vars.owner_first_name).toBe("");
    expect(vars.rating).toBe("");
    expect(Object.values(vars).join(" ")).not.toMatch(/undefined|null|N\/A|TBD/i);
  });

  it("carry the business name and the branch flags", () => {
    const vars = composeVariables({
      businessName: "Ace Plumbing",
      ownerName: "Maria Rivera",
      reviewCount: 40,
      rating: 4.8,
      website: "ace.com",
      answeringSetup: "voicemail",
    });
    expect(vars.business_name).toBe("Ace Plumbing");
    expect(vars.owner_first_name).toBe("Maria");
    expect(vars.rating).toBe("4.8");
    expect(vars.has_website).toBe("yes");
    expect(vars.spoke_to_owner).toBe("yes");
  });
});

describe("splitting a name", () => {
  it("handles one word, two words and three", () => {
    expect(splitName("Maria")).toEqual({ firstName: "Maria", lastName: null });
    expect(splitName("Maria Rivera")).toEqual({ firstName: "Maria", lastName: "Rivera" });
    expect(splitName("Maria del Carmen Rivera").lastName).toBe("del Carmen Rivera");
    expect(splitName(null)).toEqual({ firstName: null, lastName: null });
    expect(splitName("   ")).toEqual({ firstName: null, lastName: null });
  });
});

describe("the preview", () => {
  it("greets by first name only", () => {
    const { body } = composePreview({ businessName: "Ace", ownerName: "Maria Rivera" });
    expect(body).toContain("Hi Maria,");
    expect(body).not.toContain("Maria Rivera");
  });

  it("still reads as a sentence with nothing on the record", () => {
    const { body } = composePreview({ businessName: "Ace", website: "a.com" });
    expect(body).toContain("Hi,");
    expect(body).not.toMatch(/\s—\s\./);
  });

  it("includes the workshop link when there is one", () => {
    const { body } = composePreview({
      businessName: "Ace",
      website: "a.com",
      workshopLink: "https://x.test/workshop/abc",
    });
    expect(body).toContain("https://x.test/workshop/abc");
  });
});

/* -------------------------------------------------------------------------- */
/* drafting                                                                   */
/* -------------------------------------------------------------------------- */

const ctx = { businessName: "Ace Plumbing", ownerFirstName: "Maria", senderName: "the team" };

describe("drafts", () => {
  it("nothing is drafted for an opt-out or a refusal", () => {
    expect(buildDraft("unsubscribe", ctx)).toBeNull();
    expect(buildDraft("not_interested", ctx)).toBeNull();
    expect(buildDraft("out_of_office", ctx)).toBeNull();
  });

  it("NO DRAFT EVER CONTAINS A PRICE", () => {
    for (const intent of ["interested", "question", "referral", "wrong_person"] as const) {
      const d = buildDraft(intent, { ...ctx, replyBody: "How much does it cost per month?" });
      expect(d, intent).not.toBeNull();
      expect(d!.body, intent).not.toMatch(/[$£€]\s?\d/);
      expect(d!.body, intent).not.toMatch(/\b\d+\s*(?:dollars|per month|a month)\b/i);
    }
  });

  it("a pricing question is answered with a call, not a number", () => {
    const d = buildDraft("question", { ...ctx, replyBody: "How much is it?" })!;
    expect(d.body).toMatch(/ring you|call/i);
    expect(d.rationale).toMatch(/never produced automatically|no figure/i);
  });

  it("drops the company line rather than printing a placeholder", () => {
    const d = buildDraft("interested", { ...ctx, companyName: null })!;
    expect(d.body).not.toMatch(/undefined|null/);
  });

  it("a wrong-person draft asks who instead of re-pitching", () => {
    const d = buildDraft("wrong_person", ctx)!;
    expect(d.body).toMatch(/right one|who would be/i);
    expect(d.body).not.toMatch(/AI receptionist/i);
  });
});

describe("money detection", () => {
  it("catches the ways somebody asks about cost", () => {
    for (const t of [
      "how much",
      "what does it cost",
      "send pricing",
      "can I get a quote",
      "no budget this year",
      "is there a discount",
      "$500",
      "what's the contract like",
    ]) {
      expect(mentionsMoney(t), t).toBe(true);
    }
  });

  it("does not fire on an ordinary reply", () => {
    expect(mentionsMoney("Sounds good, when can you call?")).toBe(false);
    expect(mentionsMoney(null)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* the auto-send gate                                                         */
/* -------------------------------------------------------------------------- */

describe("nothing is sent automatically unless every condition is met", () => {
  const on = { autoReplyEnabled: true, confidenceFloor: 0.7 };
  const off = { autoReplyEnabled: false, confidenceFloor: 0.7 };

  it("OFF BY DEFAULT beats everything else", () => {
    expect(mayAutoSend("interested", 1, null, off).allowed).toBe(false);
  });

  it("only interested and question ever qualify", () => {
    for (const intent of [
      "unsubscribe",
      "not_interested",
      "referral",
      "wrong_person",
      "unclear",
      "out_of_office",
      "auto_reply",
    ] as const) {
      expect(mayAutoSend(intent, 1, null, on).allowed, intent).toBe(false);
    }
  });

  it("the confidence floor is enforced", () => {
    expect(mayAutoSend("interested", 0.69, null, on).allowed).toBe(false);
    expect(mayAutoSend("interested", 0.7, null, on).allowed).toBe(true);
  });

  it("ANYTHING ABOUT MONEY GOES TO A PERSON, even at full confidence", () => {
    const d = mayAutoSend("interested", 1, "How much is it?", on);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/price|money/i);
  });

  it("every refusal explains itself", () => {
    for (const d of [
      mayAutoSend("interested", 1, null, off),
      mayAutoSend("referral", 1, null, on),
      mayAutoSend("interested", 0.1, null, on),
      mayAutoSend("interested", 1, "pricing?", on),
    ]) {
      expect(d.reason.length).toBeGreaterThan(10);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* webhook parsing                                                            */
/* -------------------------------------------------------------------------- */

describe("normalising a webhook", () => {
  const reply = {
    event_type: "reply_received",
    timestamp: "2026-03-04T10:00:00Z",
    campaign_id: "camp-1",
    lead_email: "Sam@Firm.com",
    reply_subject: "Re: Ace Plumbing",
    reply_text: "Sounds good, call me",
    email_account: "outreach@ours.com",
    reply_to_uuid: "msg-9",
  };

  it("maps the documented names, and the alternatives", () => {
    expect(mapEventType("reply_received")).toBe("replied");
    expect(mapEventType("email_replied")).toBe("replied");
    expect(mapEventType("EMAIL_OPENED")).toBe("opened");
    expect(mapEventType("lead_unsubscribed")).toBe("unsubscribed");
  });

  it("NEVER DROPS AN EVENT IT DOES NOT RECOGNISE", () => {
    // A vendor adding an event type must show up as a run of "other" rows,
    // not as events that silently never arrived.
    expect(mapEventType("some_new_thing_2027")).toBe("other");
    const e = normaliseEvent({ event_type: "some_new_thing_2027", lead_email: "a@b.co" })!;
    expect(e.type).toBe("other");
    expect(e.rawType).toBe("some_new_thing_2027");
  });

  it("pulls out the parts that matter", () => {
    const e = normaliseEvent(reply)!;
    expect(e.type).toBe("replied");
    expect(e.email).toBe("sam@firm.com"); // lower-cased, because threads match on it
    expect(e.body).toBe("Sounds good, call me");
    expect(e.campaignId).toBe("camp-1");
    expect(e.replyToUuid).toBe("msg-9");
  });

  it("prefers the full reply over the snippet", () => {
    const e = normaliseEvent({ ...reply, reply_text_snippet: "Sounds g…" })!;
    expect(e.body).toBe("Sounds good, call me");
  });

  it("accepts unix timestamps as well as ISO", () => {
    const e = normaliseEvent({ ...reply, timestamp: "1772618400" })!;
    expect(e.occurredAt).toMatch(/^20\d\d-/);
  });

  it("a retried delivery produces the SAME key", () => {
    const a = normaliseEvent(reply)!;
    const b = normaliseEvent({ ...reply });
    expect(b!.idempotencyKey).toBe(a.idempotencyKey);
  });

  it("a genuinely new reply produces a different one", () => {
    const a = normaliseEvent(reply)!;
    const b = normaliseEvent({ ...reply, reply_to_uuid: "msg-10", timestamp: "2026-03-05T10:00:00Z", reply_text: "Actually, no" })!;
    expect(b.idempotencyKey).not.toBe(a.idempotencyKey);
  });

  it("uses Instantly's own id when it sends one", () => {
    expect(idempotencyKeyFor({ event_id: "abc" }, "replied", "a@b.co", "t", null)).toBe(
      "instantly:abc"
    );
  });

  it("returns null only when there is nothing usable at all", () => {
    expect(normaliseEvent(null)).toBeNull();
    expect(normaliseEvent({})).toBeNull();
    expect(normaliseEvent("nonsense")).toBeNull();
    expect(normaliseEvent({ lead_email: "a@b.co" })).not.toBeNull();
  });

  it("knows which events suppress and which need a person", () => {
    expect(suppressesEmail("unsubscribed")).toBe(true);
    expect(suppressesEmail("bounced")).toBe(true);
    expect(suppressesEmail("opened")).toBe(false);
    expect(needsHuman("replied")).toBe(true);
    expect(needsHuman("opened")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* the client's pure parts                                                    */
/* -------------------------------------------------------------------------- */

describe("the Instantly client, without a network", () => {
  it("reads a campaign list in any of the shapes it might arrive in", () => {
    const raw = [{ id: "1", name: "Trades Q1", status: "active", daily_limit: 60 }];
    const expected = [{ id: "1", name: "Trades Q1", status: "active", dailyLimit: 60 }];
    expect(normaliseCampaigns({ items: raw })).toEqual(expected);
    expect(normaliseCampaigns({ data: raw })).toEqual(expected);
    expect(normaliseCampaigns(raw)).toEqual(expected);
    expect(normaliseCampaigns(null)).toEqual([]);
  });

  it("skips a campaign with no id rather than pushing to undefined", () => {
    expect(normaliseCampaigns({ items: [{ name: "no id" }] })).toEqual([]);
  });

  it("refuses to duplicate a lead already in the campaign", () => {
    const body = pushBody("camp-1", {
      leadId: "l1",
      email: "a@b.co",
      firstName: "Sam",
      lastName: null,
      companyName: "Ace",
      website: null,
      phone: null,
      personalization: "",
      customVariables: {},
    });
    expect(body.skip_if_in_campaign).toBe(true);
    expect(body.campaign).toBe("camp-1");
    // An absent last name is omitted, not sent as null.
    expect(body.last_name).toBeUndefined();
  });

  it("explains a status rather than printing a number", () => {
    expect(explainStatus(401, "")).toMatch(/API key/i);
    expect(explainStatus(404, "")).toMatch(/campaign/i);
    expect(explainStatus(429, "")).toMatch(/rate-limit/i);
    expect(explainStatus(500, "")).toMatch(/Nothing was pushed/i);
  });
});
