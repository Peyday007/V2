// Drafting the reply, and deciding whether it may ever go out on its own.
//
// A draft is a suggestion. The default, and the shipped default, is that a
// person reads every one before it reaches a prospect. `auto_reply_enabled`
// exists because an administrator may decide otherwise, and this file is where
// that decision is bounded: even switched on, it only ever covers the two
// intents where a wrong answer is recoverable, and never covers anything
// touching money.
//
// The standing rule this file is written around: PRICES, DISCOUNTS AND LEGAL
// LANGUAGE ARE NEVER PRODUCED AUTOMATICALLY. So no draft in here contains a
// number with a currency symbol, and a reply that asks about cost is forced to
// a human no matter what the settings say. The draft answers the question with
// a conversation, which is what a salesperson would do anyway.
//
// Pure. No database, no model call, no network.

import type { ReplyIntent } from "./replyIntent";
import { shouldDraftReply } from "./replyIntent";

export type DraftContext = {
  businessName: string;
  /** Best known first name for the person who replied. */
  ownerFirstName?: string | null;
  /** Whoever is signing — the VA's name, or the company's. */
  senderName: string;
  companyName?: string | null;
  /** The public workshop page, when one exists for this business. */
  workshopLink?: string | null;
  /** What the prospect actually wrote, already stripped of quoted history. */
  replyBody?: string | null;
};

export type Draft = {
  subject: string;
  body: string;
  /** Why this shape of reply, for the person approving it. */
  rationale: string;
};

/* -------------------------------------------------------------------------- */
/* money                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Does this reply turn on price?
 *
 * Kept separate from intent classification because it cuts across it: "how
 * much is it" is an interested reply AND a pricing question, and the pricing
 * part is the one that decides a human must handle it.
 */
const PRICE_TALK = [
  /\bhow much\b/i,
  /\bcost(?:s|ing)?\b/i,
  /\bpric(?:e|es|ing)\b/i,
  /\bquote\b/i,
  /\bbudget\b/i,
  /\bper month\b/i,
  /\bmonthly fee\b/i,
  /\bdiscount\b/i,
  /\bcontract\b/i,
  /\bfree trial\b/i,
  /[$£€]\s?\d/,
];

export function mentionsMoney(text: string | null | undefined): boolean {
  const t = text || "";
  return PRICE_TALK.some((p) => p.test(t));
}

/* -------------------------------------------------------------------------- */
/* the drafts                                                                 */
/* -------------------------------------------------------------------------- */

function greeting(ctx: DraftContext): string {
  const first = (ctx.ownerFirstName || "").trim().split(/\s+/)[0] || "";
  return first ? `Hi ${first},` : "Hi,";
}

function signOff(ctx: DraftContext): string {
  const company = (ctx.companyName || "").trim();
  // Same rule as the SMS: an unset company name drops the line rather than
  // printing a placeholder into a prospect's inbox.
  return company ? `${ctx.senderName}\n${company}` : ctx.senderName;
}

/**
 * Build the draft for a reading.
 *
 * Returns null when nothing should be drafted — an opt-out, a refusal, an
 * out-of-office. That is not a failure; it is the correct outcome, and the
 * caller must handle it rather than falling back to a generic reply.
 */
export function buildDraft(intent: ReplyIntent, ctx: DraftContext): Draft | null {
  if (!shouldDraftReply(intent)) return null;

  const hi = greeting(ctx);
  const sig = signOff(ctx);
  const link = (ctx.workshopLink || "").trim();
  const asksMoney = mentionsMoney(ctx.replyBody);

  const subject = `Re: ${ctx.businessName}`;

  if (intent === "wrong_person") {
    return {
      subject,
      body: [
        hi,
        "",
        "Apologies — I had you down as the person who handles how calls come into the business. Who would be the right one to ask?",
        "",
        "Happy to go straight to them and leave you out of it.",
        "",
        sig,
      ].join("\n"),
      rationale:
        "They said they are the wrong person. The only useful move is to ask who the right one is, briefly, and offer to stop emailing them.",
    };
  }

  if (intent === "referral") {
    return {
      subject,
      body: [
        hi,
        "",
        "That is helpful, thank you — I will reach out to them.",
        "",
        "If it is easier to pass my details along instead, that works too.",
        "",
        sig,
      ].join("\n"),
      rationale:
        "They pointed at somebody else. Acknowledge, do not re-pitch, and give them the lower-effort option.",
    };
  }

  if (intent === "question") {
    const lines = [hi, ""];
    if (asksMoney) {
      // Deliberately answers with a conversation and no number. See the note
      // at the top of this file.
      lines.push(
        "Good question — it depends on how many calls you take, so I would rather not guess at a number in an email."
      );
      lines.push("");
      lines.push("Is there a couple of minutes this week when I could ring you and give you a straight answer?");
    } else {
      lines.push("Happy to answer that.");
      lines.push("");
      lines.push(
        "The short version: it answers every call you cannot get to, asks the caller what the job is and where, and texts you the details straight away."
      );
      if (link) {
        lines.push("");
        lines.push(`Here is what we put together for ${ctx.businessName}: ${link}`);
      }
      lines.push("");
      lines.push("Anything else you want to know before we look at it properly?");
    }
    lines.push("", sig);
    return {
      subject,
      body: lines.join("\n"),
      rationale: asksMoney
        ? "They asked about cost. The draft quotes no figure at all and moves to a call — pricing is never produced automatically."
        : "They asked a question. Answer it plainly, point at the page already built for them, and invite the next question.",
    };
  }

  // interested
  const lines = [hi, ""];
  lines.push("Glad it landed.");
  if (link) {
    lines.push("");
    lines.push(`Here is what we found for ${ctx.businessName}: ${link}`);
  }
  lines.push("");
  lines.push(
    "The quickest way through this is a short call — five minutes, and you will know whether it is worth doing. What does the rest of your week look like?"
  );
  if (asksMoney) {
    lines.push("");
    lines.push("Happy to go through the numbers on the call as well.");
  }
  lines.push("", sig);

  return {
    subject,
    body: lines.join("\n"),
    rationale: asksMoney
      ? "Interested and asking about money. The draft names no figure and puts the numbers on the call, where a person is in the loop."
      : "Interested. Short, no re-pitch, and one clear ask — a call.",
  };
}

/* -------------------------------------------------------------------------- */
/* the auto-send gate                                                         */
/* -------------------------------------------------------------------------- */

export type AutoSendSettings = {
  autoReplyEnabled: boolean;
  /** Below this the reading is not acted on at all. */
  confidenceFloor: number;
};

export type AutoSendDecision = { allowed: boolean; reason: string };

/**
 * May this draft go out without a person reading it?
 *
 * Every condition is a veto, and the list is deliberately long:
 *
 *   - an administrator has to have switched it on, and it ships off;
 *   - the reading has to clear the confidence floor;
 *   - only "interested" and "question" qualify. A referral or a wrong-person
 *     reply involves a third party and gets a human;
 *   - anything mentioning money gets a human regardless of everything above.
 *
 * The last one is not redundant with the drafting rule. The draft already
 * avoids quoting a figure — this makes sure a person still sees a reply that
 * was ABOUT money, because that is a conversation worth having deliberately.
 */
export function mayAutoSend(
  intent: ReplyIntent,
  confidence: number,
  replyBody: string | null | undefined,
  settings: AutoSendSettings
): AutoSendDecision {
  if (!settings.autoReplyEnabled) {
    return {
      allowed: false,
      reason: "Automatic replies are switched off. Every draft waits for a person.",
    };
  }
  if (!(intent === "interested" || intent === "question")) {
    return {
      allowed: false,
      reason: `A "${intent}" reply is never answered automatically.`,
    };
  }
  if (!(confidence >= settings.confidenceFloor)) {
    return {
      allowed: false,
      reason: `The reading scored ${confidence.toFixed(2)}, below the ${settings.confidenceFloor.toFixed(
        2
      )} floor.`,
    };
  }
  if (mentionsMoney(replyBody)) {
    return {
      allowed: false,
      reason: "The reply is about price. Anything touching money goes to a person.",
    };
  }
  return { allowed: true, reason: "Cleared every automatic-reply condition." };
}
