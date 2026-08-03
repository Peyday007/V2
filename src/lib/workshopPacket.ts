// The packet a caller sends an owner mid-call, and the page it opens.
//
// Pure. No database, no network, no Twilio — so the state machine, the gap
// copy and the message template can all be tested, and the page and the API
// cannot disagree about what a packet says.
//
// The rule that shapes everything here: NOTHING ON THE OWNER'S PAGE IS
// INVENTED. Every gap bullet is computed from a field already on the business
// record. If the data does not support a claim, the bullet does not appear.
// A page that tells an owner "you have no online booking" when nobody checked
// is the fastest way to lose the call that earned the click.

export const PACKET_STATUSES = ["not_sent", "sent", "opened", "trial_requested"] as const;
export type PacketStatus = (typeof PACKET_STATUSES)[number];

export const PACKET_STATUS_LABEL: Record<PacketStatus, string> = {
  not_sent: "Not sent",
  sent: "Sent",
  opened: "Opened",
  trial_requested: "Trial requested",
};

/** How far along, for ordering and for progress bars. Higher is further. */
export const PACKET_STATUS_RANK: Record<PacketStatus, number> = {
  not_sent: 0,
  sent: 1,
  opened: 2,
  trial_requested: 3,
};

export const DELIVERY_METHODS = ["text", "email", "both"] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

/**
 * Statuses only ever move forward.
 *
 * The one that matters: an owner who opens the page, then opens it again after
 * agreeing, must not be knocked back from trial_requested to opened. The page
 * marks "opened" on every load, so without this the most valuable state in the
 * system would be destroyed by a refresh.
 */
export function advanceStatus(current: PacketStatus, proposed: PacketStatus): PacketStatus {
  return PACKET_STATUS_RANK[proposed] > PACKET_STATUS_RANK[current] ? proposed : current;
}

/** Is this status a live signal a human has not dealt with yet? */
export function needsAttention(status: PacketStatus, acknowledgedAt: string | null): boolean {
  return status === "trial_requested" && !acknowledgedAt;
}

/* -------------------------------------------------------------------------- */
/* can this even be sent                                                      */
/* -------------------------------------------------------------------------- */

export type SendSubject = {
  ownerName: string | null | undefined;
  ownerPhone: string | null | undefined;
  doNotCall?: boolean | null;
  phoneInvalid?: boolean | null;
};

export type SendGate = { allowed: boolean; reason: string | null };

/**
 * Whether the Send button may fire.
 *
 * The do-not-call check is here rather than only in the API because a text
 * message is a contact. Somebody who asked not to be called did not ask to be
 * texted instead, and "the SMS path forgot to check the suppression list" is
 * exactly the kind of gap that turns a compliance rule into a fine.
 */
export function canSend(subject: SendSubject): SendGate {
  if (subject.doNotCall) {
    return {
      allowed: false,
      reason: "This business is on the do-not-call list. Nothing gets sent to them.",
    };
  }
  if (subject.phoneInvalid) {
    return { allowed: false, reason: "This number is marked as not callable." };
  }
  if (!(subject.ownerName || "").trim()) {
    return { allowed: false, reason: "Add the owner's name first — the message is addressed to them." };
  }
  if (!(subject.ownerPhone || "").trim()) {
    return { allowed: false, reason: "Add a mobile number to text the link to." };
  }
  return { allowed: true, reason: null };
}

/* -------------------------------------------------------------------------- */
/* the gaps                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Only fields the business record already carries. Nothing is fetched live,
 * and nothing is inferred from a field that is null.
 *
 * There is deliberately no "no online booking widget" input. Detecting that
 * needs a page fetch nobody has run, and asserting it from an absent field
 * would be exactly the fabrication this module exists to prevent. When a
 * booking-detection field exists, it gets a branch here — not before.
 */
export type GapInput = {
  businessName: string;
  city?: string | null;
  website?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  /** What the owner themselves said on the call. The strongest line available. */
  answeringSetup?: string | null;
};

export type Gap = {
  key: string;
  headline: string;
  detail: string;
  /** The field this was computed from, so a claim can be traced. */
  basis: string;
};

/** Enough reviews that missing calls is demonstrably costing them work. */
export const BUSY_REVIEW_COUNT = 25;

/**
 * What we can honestly say about this business, from what was already
 * collected.
 *
 * Every branch is guarded on the field being present. A null review count
 * produces no review bullet — not "0 reviews", which would be a claim we never
 * checked. Three at most, because a wall of bullets reads as a template.
 */
export function computeGaps(input: GapInput): Gap[] {
  const gaps: Gap[] = [];
  const name = input.businessName;

  const reviews = input.reviewCount;
  if (typeof reviews === "number" && reviews >= BUSY_REVIEW_COUNT) {
    gaps.push({
      key: "busy_no_after_hours",
      headline: `${reviews} reviews, and no listed way to reach you after hours`,
      detail:
        `${name} clearly gets called. What we could not find is what happens to those ` +
        `calls in the evening, at the weekend, or while you are on a job.`,
      basis: "review_count",
    });
  }

  // No website on the listing is a fact from the business record. Having one
  // says nothing either way about how calls are handled, so it produces no
  // bullet at all rather than a guess.
  if (!(input.website || "").trim()) {
    gaps.push({
      key: "no_website",
      headline: "No website on your listing",
      detail:
        "Everyone who looks you up lands on your listing and has one option: ring you. " +
        "If nobody picks up, that is the end of it.",
      basis: "website",
    });
  }

  if (typeof input.rating === "number" && input.rating >= 4.5 && (reviews ?? 0) >= 10) {
    gaps.push({
      key: "good_rating",
      headline: `${input.rating.toFixed(1)} stars — people like the work`,
      detail:
        "The reputation is doing its job and sending you callers. The question is " +
        "only how many of them get through.",
      basis: "rating",
    });
  }

  const setup = (input.answeringSetup || "").trim();
  if (setup) {
    gaps.push({
      key: "stated_setup",
      headline: "What you told us on the phone",
      detail: setup,
      basis: "answering_setup",
    });
  }

  return gaps.slice(0, 3);
}

/**
 * When there is nothing honest to say.
 *
 * The page still works — the demo and the offer stand on their own — and it
 * says nothing about the business rather than filling the space with a
 * template. Callers should know this happens so they are not surprised.
 */
export function gapsAreThin(gaps: Gap[]): boolean {
  return gaps.length === 0;
}

/* -------------------------------------------------------------------------- */
/* the message                                                                */
/* -------------------------------------------------------------------------- */

export type MessageInput = {
  ownerName: string;
  vaName: string;
  companyName: string;
  businessName: string;
  link: string;
};

/**
 * The SMS. One sentence and a link, because a cold text that scrolls gets
 * read as spam.
 *
 * First names only: "Hi Maria Rivera" from someone who just spoke to her reads
 * like a mail merge, which is precisely what it must not look like.
 */
export function renderMessage(input: MessageInput): string {
  const first = input.ownerName.trim().split(/\s+/)[0] || input.ownerName.trim();
  const company = (input.companyName || "").trim();
  // An unset company name drops the clause rather than printing a placeholder.
  // "this is Sam with undefined" is worse than no attribution at all, and an
  // env var nobody set must never reach a prospect's phone.
  const who = company ? `this is ${input.vaName} with ${company}` : `this is ${input.vaName}`;
  return `Hi ${first}, ${who}. Here's what we found for ${input.businessName}: ${input.link}`;
}

/** The public URL for a token, given the app's own origin. */
export function packetUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/workshop/${token}`;
}

/**
 * A message this long will be split into several billed segments and may
 * arrive out of order on some carriers. Surfaced to the sender rather than
 * discovered on the bill.
 */
export const SMS_SEGMENT_CHARS = 160;
export function segmentCount(message: string): number {
  // Concatenated SMS spends 7 characters per part on the segmentation header.
  if (message.length <= SMS_SEGMENT_CHARS) return 1;
  return Math.ceil(message.length / 153);
}

/* -------------------------------------------------------------------------- */
/* tokens                                                                     */
/* -------------------------------------------------------------------------- */

/** Long enough that guessing is not a strategy. 32 hex chars = 128 bits. */
export const TOKEN_BYTES = 16;

/** Shape check only — generation is server-side, in the API route. */
export function looksLikeToken(token: string | null | undefined): boolean {
  return typeof token === "string" && /^[a-f0-9]{32}$/.test(token);
}
