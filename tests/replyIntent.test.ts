// Reading a reply.
//
// The whole file is built to be wrong in one direction only, so most of these
// tests are about what must NOT happen: an opt-out read as anything else, an
// out-of-office read as interest, a model overturning a refusal.

import { describe, it, expect } from "vitest";
import {
  readReply,
  stripQuoted,
  shouldDraftReply,
  suppressesFurtherEmail,
  requiresHuman,
  mergeModelReading,
  isReplyIntent,
  type Reading,
} from "../src/lib/replyIntent";

describe("opt-outs are caught first and caught loosely", () => {
  const optOuts = [
    "unsubscribe",
    "Please unsubscribe me.",
    "take me off your list",
    "Remove me from this list please",
    "opt out",
    "Stop emailing me.",
    "Do not email me again",
    "I no longer wish to receive these",
    "please delete my information",
  ];

  for (const text of optOuts) {
    it(`"${text}" is an opt-out`, () => {
      expect(readReply(text).intent).toBe("unsubscribe");
    });
  }

  it("is caught even when the rest of the message sounds interested", () => {
    // The dangerous case: a polite refusal that a keyword-counting reader
    // would score as enthusiasm.
    const r = readReply(
      "Thanks, this sounds interesting and I'd love to hear more another time, but please take me off your list for now."
    );
    expect(r.intent).toBe("unsubscribe");
  });

  it("suppresses further email and is never answered", () => {
    expect(suppressesFurtherEmail("unsubscribe")).toBe(true);
    expect(shouldDraftReply("unsubscribe")).toBe(false);
  });
});

describe("auto-replies are not people", () => {
  it("an out-of-office is not interest, however friendly", () => {
    const r = readReply(
      "Thank you for your email. I am currently out of the office and will return on the 14th. I will respond to your message then."
    );
    expect(r.intent).toBe("out_of_office");
  });

  it("nothing is drafted for one, and nobody is woken up", () => {
    expect(shouldDraftReply("out_of_office")).toBe(false);
    expect(requiresHuman("out_of_office")).toBe(false);
  });

  it("a bounce body is not answered either", () => {
    expect(readReply("Delivery has failed to these recipients: sam@firm.com").intent).toBe(
      "auto_reply"
    );
  });
});

describe("refusals beat politeness", () => {
  for (const text of [
    "Not interested, thanks",
    "No thanks",
    "We're all set, we already have someone",
    "already have one",
    "This isn't a fit for us",
  ]) {
    it(`"${text}" is a refusal`, () => {
      expect(readReply(text).intent).toBe("not_interested");
    });
  }

  it("a refusal stops the sequence and gets no reply", () => {
    expect(suppressesFurtherEmail("not_interested")).toBe(true);
    expect(shouldDraftReply("not_interested")).toBe(false);
  });
});

describe("interest, and what is not interest", () => {
  it("an explicit next step is interest", () => {
    for (const text of [
      "How much is it?",
      "Send me more info",
      "Yes I'm interested, give me a call",
      "Tell me more",
      "sounds good, let's talk",
    ]) {
      expect(readReply(text).intent, text).toBe("interested");
    }
  });

  it("a bare question is a question, not interest", () => {
    expect(readReply("Who is this?").intent).toBe("question");
  });

  it("something with no signal is left explicitly unclear", () => {
    const r = readReply("ok");
    expect(r.intent).toBe("unclear");
    expect(r.confidence).toBeLessThan(0.5);
  });

  it("an empty reply is unclear with no confidence at all", () => {
    expect(readReply("").confidence).toBe(0);
    expect(readReply(null).intent).toBe("unclear");
  });
});

describe("wrong person and referrals", () => {
  it("a plain wrong-person reply is that and nothing more", () => {
    expect(readReply("Wrong person — I don't handle this.").intent).toBe("wrong_person");
  });

  it("naming somebody else is a referral", () => {
    expect(
      readReply("I'm not the right person for this, you want to speak to Dave in the office.")
        .intent
    ).toBe("referral");
  });

  it("both get a draft, because both have a useful next move", () => {
    expect(shouldDraftReply("wrong_person")).toBe(true);
    expect(shouldDraftReply("referral")).toBe(true);
  });
});

describe("quoted history is not the reply", () => {
  it("stops at a quoted block", () => {
    const body = [
      "No thanks.",
      "",
      "> Hi Sam, I wanted to ask one quick question. Interested in a call?",
      "> Send me more info and let's talk",
    ].join("\n");
    expect(stripQuoted(body)).toBe("No thanks.");
  });

  it("stops at an 'On ... wrote:' line", () => {
    const body = "Not for us.\n\nOn Tue, 3 Jun 2025 at 14:02, Sam <sam@firm.com> wrote:\nHow much is it? Interested?";
    expect(stripQuoted(body)).toBe("Not for us.");
  });

  it("THE ORIGINAL EMAIL UNDERNEATH DOES NOT MAKE IT INTERESTED", () => {
    // Our own copy contains every interest phrase in the list. Reading the
    // quoted original as the reply would classify literally every response as
    // interested, which is the single worst way this file could fail.
    const body = "Not interested.\n\n> Worth a two-minute look? Happy to chat, give me a call, how much is it";
    expect(readReply(body).intent).toBe("not_interested");
  });
});

describe("the model may narrow a conclusion but never widen one", () => {
  const refusal: Reading = { intent: "not_interested", confidence: 0.85, reason: "rules" };
  const keen: Reading = { intent: "interested", confidence: 0.9, reason: "model" };

  it("cannot overturn a refusal the rules found", () => {
    expect(mergeModelReading(refusal, keen).intent).toBe("not_interested");
  });

  it("cannot overturn an opt-out either", () => {
    const optOut: Reading = { intent: "unsubscribe", confidence: 0.95, reason: "rules" };
    expect(mergeModelReading(optOut, keen).intent).toBe("unsubscribe");
  });

  it("cannot invent interest the rules did not see", () => {
    const unclear: Reading = { intent: "unclear", confidence: 0.2, reason: "rules" };
    expect(mergeModelReading(unclear, keen).intent).toBe("unclear");
  });

  it("CAN find an opt-out the rules missed", () => {
    const unclear: Reading = { intent: "unclear", confidence: 0.2, reason: "rules" };
    const spotted: Reading = { intent: "unsubscribe", confidence: 0.6, reason: "model" };
    const merged = mergeModelReading(unclear, spotted);
    expect(merged.intent).toBe("unsubscribe");
    expect(merged.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("cannot raise confidence far above what the rules supported", () => {
    const question: Reading = { intent: "question", confidence: 0.5, reason: "rules" };
    const sure: Reading = { intent: "question", confidence: 0.99, reason: "model" };
    expect(mergeModelReading(question, sure).confidence).toBeLessThanOrEqual(0.65);
  });

  it("no model reading changes nothing", () => {
    expect(mergeModelReading(refusal, null)).toEqual(refusal);
  });
});

describe("the intent vocabulary", () => {
  it("recognises its own values and nothing else", () => {
    expect(isReplyIntent("interested")).toBe(true);
    expect(isReplyIntent("keen")).toBe(false);
    expect(isReplyIntent(null)).toBe(false);
  });
});
