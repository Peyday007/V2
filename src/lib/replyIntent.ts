// Reading a reply.
//
// A reply is the most valuable event in this system and the most dangerous
// thing to be wrong about, so this file is built to be wrong in one direction
// only. Every rule below either sends LESS email or asks a human. Nothing here
// can decide, on its own, to send more.
//
// Three specific ways an automatic reader gets a cold-email programme into
// trouble, and what is done about each:
//
//   1. Missing an opt-out. "take me off your list" read as a question, and the
//      sequence carries on. That is the one that ends in a complaint, so the
//      opt-out patterns are checked FIRST, before anything else can claim the
//      message, and a single match is enough.
//
//   2. Reading an out-of-office as interest. "Thanks for your email, I am away
//      until the 14th and will respond on my return" contains "thanks", "will
//      respond" and a promise of contact. Auto-replies are therefore detected
//      before any interest signal is looked for.
//
//   3. Reading politeness as agreement. "No thanks, we're all set" is a
//      refusal. It is checked before interest, because "thanks" appears in
//      both and the refusal is the costlier one to miss.
//
// Pure. No network, no model call. The optional model reading is merged in by
// `mergeModelReading`, which is deliberately built so the model can narrow a
// conclusion but never widen one.

export const REPLY_INTENTS = [
  "unsubscribe",
  "not_interested",
  "interested",
  "question",
  "wrong_person",
  "referral",
  "out_of_office",
  "auto_reply",
  "unclear",
] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];

export const INTENT_LABEL: Record<ReplyIntent, string> = {
  unsubscribe: "Asked to be removed",
  not_interested: "Not interested",
  interested: "Interested",
  question: "Asked a question",
  wrong_person: "Wrong person",
  referral: "Pointed us at someone else",
  out_of_office: "Out of office",
  auto_reply: "Automatic reply",
  unclear: "Unclear",
};

export type Reading = {
  intent: ReplyIntent;
  /** 0–1. What the rules below actually support, not a guess dressed up. */
  confidence: number;
  /** The phrase that decided it, so a human can check the reasoning. */
  reason: string;
};

/* -------------------------------------------------------------------------- */
/* the patterns                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Opt-out. Checked first and matched loosely on purpose.
 *
 * A false positive costs one lead who might have been interested. A false
 * negative costs a complaint, a spam report, and eventually the sending
 * domain. Those are not close, so the bar is low.
 */
const OPT_OUT = [
  /\bunsubscribe\b/i,
  /\bopt[\s-]?out\b/i,
  /\bremove me\b/i,
  /\btake me off\b/i,
  /\bremove (?:us|my|our) (?:from|email|address|name)\b/i,
  /\bstop (?:emailing|contacting|messaging)\b/i,
  /\bdo not (?:email|contact)\b/i,
  /\bdon'?t (?:email|contact) (?:me|us)\b/i,
  /\bno longer wish to receive\b/i,
  /\bdelete (?:my|our) (?:info|information|details|data)\b/i,
];

/**
 * Automatic mail. Checked before any human intent, because an auto-reply
 * frequently contains words that look like a real answer.
 */
const AUTO_REPLY = [
  /\bout of (?:the )?office\b/i,
  /\bautomatic reply\b/i,
  /\bauto[\s-]?reply\b/i,
  /\bon (?:annual |parental )?leave\b/i,
  /\bon vacation\b/i,
  /\bon holiday\b/i,
  /\baway from (?:my|the) (?:desk|office)\b/i,
  /\bwill (?:be )?(?:back|return(?:ing)?) on\b/i,
  /\bcurrently unavailable\b/i,
  /\bthis (?:is|was) an automated\b/i,
  /\bdo not reply to this\b/i,
];

/** Undeliverable. Rare on this path — Instantly reports most bounces as a
 *  bounce event rather than a reply — but a mailer-daemon body still arrives
 *  as a reply sometimes, and drafting an answer to a mail server is absurd. */
const BOUNCE = [
  /\bmail(?:er)?[\s-]?daemon\b/i,
  /\bundeliverable\b/i,
  /\bdelivery (?:has )?failed\b/i,
  /\baddress not found\b/i,
  /\brecipient .{0,20}(?:rejected|not found)\b/i,
];

/** A refusal. Checked before interest. */
const NOT_INTERESTED = [
  /\bnot interested\b/i,
  /\bno,? thank(?:s| you)\b/i,
  /\bno thanks\b/i,
  /\bwe(?:'re| are) (?:all set|good|fine|happy)\b/i,
  /\balready (?:have|use|got) (?:one|a|an|someone)\b/i,
  /\bnot (?:looking|for us|a fit|right for us)\b/i,
  /\b(?:isn'?t|is not|aren'?t|are not|won'?t be) (?:a fit|for us|right|something)\b/i,
  /\bpass\b(?!word)/i,
  /\bno need\b/i,
  /\bwe don'?t need\b/i,
];

/** Wrong recipient, and the useful version of it. */
const WRONG_PERSON = [
  /\bwrong (?:person|number|address|contact)\b/i,
  /\bi(?:'m| am) not the\b/i,
  /\bno longer (?:with|at|work)\b/i,
  /\bi don'?t (?:work|handle)\b/i,
  /\bnot my (?:department|area|remit)\b/i,
];

const REFERRAL = [
  /\b(?:speak|talk|reach out|check) (?:to|with)\b/i,
  /\bcopy(?:ing)? in\b/i,
  /\bforward(?:ed|ing)? (?:this|you)\b/i,
  /\bbest person (?:is|to)\b/i,
  /\byou want\b.{0,30}\bnot me\b/i,
];

/** Genuine interest. Every one of these is an explicit next step. */
const INTERESTED = [
  /\bsend (?:me |us |over )?(?:more|the|some) (?:info|information|details|pricing)\b/i,
  /\bhow much\b/i,
  /\bwhat(?:'s| is| does it) cost\b/i,
  /\bpric(?:e|ing)\b/i,
  /\binterested\b/i,
  /\btell me more\b/i,
  /\bset(?:up|\s?up)? a (?:call|time|meeting)\b/i,
  /\bhappy to (?:chat|talk|hear)\b/i,
  /\bgive me a call\b/i,
  /\bcall me\b/i,
  /\bwhen (?:can|could) (?:we|you)\b/i,
  /\blet'?s (?:talk|chat|do it)\b/i,
  /\bsounds (?:good|interesting)\b/i,
  /\bsign (?:me |us )?up\b/i,
];

/** A question that is not yet interest. */
const QUESTION = [/\?/];

/* -------------------------------------------------------------------------- */
/* the reader                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Only the prospect's own words.
 *
 * Quoted history is stripped, because our own email is sitting underneath
 * theirs and it contains every interest phrase in the list above. Reading the
 * quoted original as the reply would classify literally every response as
 * interested, which is the single most likely way this file could be wrong in
 * the dangerous direction.
 */
export function stripQuoted(body: string): string {
  const lines = (body || "").replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith(">")) break;
    // "On Tue, 3 Jun 2025 at 14:02, Sam <sam@…> wrote:"
    if (/^on .{4,80}wrote:$/i.test(t)) break;
    if (/^-{2,}\s*original message\s*-{2,}$/i.test(t)) break;
    if (/^from:\s.+@/i.test(t)) break;
    if (/^_{5,}$/.test(t)) break;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) return m[0];
  }
  return null;
}

/**
 * Classify one reply.
 *
 * The order of the blocks below IS the safety property. Do not reorder them
 * without reading the note at the top of this file.
 */
export function readReply(rawBody: string | null | undefined): Reading {
  const body = stripQuoted(rawBody || "");
  if (!body.trim()) {
    return { intent: "unclear", confidence: 0, reason: "The reply had no readable text." };
  }

  const optOut = firstMatch(body, OPT_OUT);
  if (optOut) {
    return { intent: "unsubscribe", confidence: 0.95, reason: `Contains "${optOut}".` };
  }

  const bounce = firstMatch(body, BOUNCE);
  if (bounce) {
    return { intent: "auto_reply", confidence: 0.9, reason: `Looks undeliverable — "${bounce}".` };
  }

  const auto = firstMatch(body, AUTO_REPLY);
  if (auto) {
    return { intent: "out_of_office", confidence: 0.85, reason: `Contains "${auto}".` };
  }

  const refused = firstMatch(body, NOT_INTERESTED);
  if (refused) {
    return { intent: "not_interested", confidence: 0.85, reason: `Contains "${refused}".` };
  }

  const wrong = firstMatch(body, WRONG_PERSON);
  if (wrong) {
    // Someone naming a colleague is worth far more than a plain "wrong person",
    // so the referral is only claimed when both signals are there.
    const onward = firstMatch(body, REFERRAL);
    return onward
      ? { intent: "referral", confidence: 0.7, reason: `"${wrong}" and "${onward}".` }
      : { intent: "wrong_person", confidence: 0.8, reason: `Contains "${wrong}".` };
  }

  const keen = firstMatch(body, INTERESTED);
  if (keen) {
    return { intent: "interested", confidence: 0.75, reason: `Contains "${keen}".` };
  }

  if (firstMatch(body, QUESTION)) {
    return { intent: "question", confidence: 0.5, reason: "The reply asks something." };
  }

  // A short human reply with no recognisable signal is common and is left
  // explicitly unclear rather than pushed into the nearest bucket.
  return {
    intent: "unclear",
    confidence: 0.2,
    reason: "No phrase in the reply matched a known intent.",
  };
}

/* -------------------------------------------------------------------------- */
/* what follows from a reading                                                */
/* -------------------------------------------------------------------------- */

/** Intents that must stop all further email to this address, at once. */
export function suppressesFurtherEmail(intent: ReplyIntent): boolean {
  return intent === "unsubscribe" || intent === "not_interested";
}

/**
 * Whether to draft a reply at all.
 *
 * Nothing is drafted for an opt-out or a refusal. There is no clever answer to
 * "take me off your list" and attempting one is exactly the behaviour that
 * turns an unsubscribe into a complaint. Auto-replies get nothing either,
 * because nobody read the first email yet.
 */
export function shouldDraftReply(intent: ReplyIntent): boolean {
  return (
    intent === "interested" ||
    intent === "question" ||
    intent === "referral" ||
    intent === "wrong_person"
  );
}

/**
 * Whether a person must look at this before anything goes out.
 *
 * True for everything except the two that need no answer. Note what this does
 * NOT say: it does not say a high-confidence "interested" can go out on its
 * own. That decision belongs to `auto_reply_enabled`, which ships false, and
 * to the confidence floor — this function only reports whether the reading is
 * the kind of thing a human should see.
 */
export function requiresHuman(intent: ReplyIntent): boolean {
  return intent !== "out_of_office" && intent !== "auto_reply";
}

/* -------------------------------------------------------------------------- */
/* the optional model reading                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Merge a model's reading with the rules', in the safe direction only.
 *
 * The model is allowed to:
 *   - find an opt-out or a refusal the rules missed;
 *   - downgrade an "interested" it does not believe.
 *
 * The model is NOT allowed to:
 *   - overturn an opt-out or a refusal the rules found, at any confidence;
 *   - promote anything to "interested".
 *
 * That asymmetry is the point. A language model reading a hostile reply as
 * enthusiasm is a plausible failure; a language model reading enthusiasm as
 * "remove me" costs one lead. Only the second one is allowed to happen.
 */
export function mergeModelReading(rules: Reading, model: Reading | null): Reading {
  if (!model) return rules;

  // The rules found a stop signal. Nothing overturns that.
  if (suppressesFurtherEmail(rules.intent)) return rules;

  // The model found one the rules missed. Take it.
  if (suppressesFurtherEmail(model.intent)) {
    return {
      intent: model.intent,
      confidence: Math.max(model.confidence, 0.7),
      reason: `${model.reason} (read by the model; the phrase rules did not catch it)`,
    };
  }

  // The model may not invent interest.
  if (model.intent === "interested" && rules.intent !== "interested") return rules;

  // Otherwise it may refine, but never above what the rules already supported.
  return {
    intent: model.intent,
    confidence: Math.min(model.confidence, rules.confidence + 0.15),
    reason: `${model.reason} (model reading, rules said ${rules.intent})`,
  };
}

export function isReplyIntent(v: unknown): v is ReplyIntent {
  return typeof v === "string" && (REPLY_INTENTS as readonly string[]).includes(v);
}
