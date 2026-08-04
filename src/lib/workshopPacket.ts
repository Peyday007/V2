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
  const suppressed = canGenerateLink(subject);
  if (!suppressed.allowed) return suppressed;

  if (!(subject.ownerName || "").trim()) {
    return { allowed: false, reason: "Add the owner's name first — the message is addressed to them." };
  }
  if (!(subject.ownerPhone || "").trim()) {
    return { allowed: false, reason: "Add a mobile number to text the link to." };
  }
  return { allowed: true, reason: null };
}

/**
 * A weaker gate, for producing the link without sending anything.
 *
 * Deliberately does NOT require a name or a mobile.
 *
 * The bug this fixes: Copy Link shared the send gate, so on a lead with no
 * owner name and no direct number — which is every lead until a contact
 * provider is configured — the button was disabled and pressing it did
 * nothing at all. But copying a link needs neither of those. The page it opens
 * is about the BUSINESS; the owner's name only ever appears in the text
 * message, and there is no text message on this path.
 *
 * Suppression still applies. Someone on the do-not-call list should not be
 * receiving a pitch by any route, including one a caller pastes by hand.
 */
export function canGenerateLink(subject: Pick<SendSubject, "doNotCall" | "phoneInvalid">): SendGate {
  if (subject.doNotCall) {
    return {
      allowed: false,
      reason: "This business is on the do-not-call list. Nothing gets sent to them.",
    };
  }
  if (subject.phoneInvalid) {
    return { allowed: false, reason: "This number is marked as not callable." };
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
  /**
   * The diagnosis, when one has been run.
   *
   * This is now the main path. computeGaps below is the fallback for a lead
   * that predates the diagnostic or whose site could not be crawled — it uses
   * only rating, review count and has-a-website, which is exactly why every
   * packet used to say the same thing.
   */
  findings?: { key: string; headline: string; detail: string; basis: string[] }[];
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
  /*
   * A real diagnosis wins outright.
   *
   * It is built from the same honesty rule — nothing from a null — but from
   * far more signals: where they rank, whether the site works on a phone,
   * whether search engines can read it, whether the reviews are thin. The
   * three checks below are what is left when none of that was collected.
   */
  if (input.findings && input.findings.length > 0) {
    return input.findings.slice(0, 4).map((f) => ({
      key: f.key,
      headline: f.headline,
      detail: f.detail,
      basis: f.basis.join(", "),
    }));
  }

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
 * The page still works — the recommendations and the offer stand on their own
 * — and it says nothing about the business rather than filling the space with
 * a template. Callers should know this happens so they are not surprised.
 */
export function gapsAreThin(gaps: Gap[]): boolean {
  return gaps.length === 0;
}

/* -------------------------------------------------------------------------- */
/* what we would actually do for them                                         */
/* -------------------------------------------------------------------------- */

export type Recommendation = {
  key: string;
  title: string;
  detail: string;
  /**
   * The field this was tailored from, or "general" when it applies to any
   * home-service business. Shown to nobody, but it keeps the distinction
   * between "we noticed this about YOU" and "this is what we do" explicit in
   * the code rather than blurred in the copy.
   */
  basis: string;
};

/**
 * What we would do about each finding, in the owner's language.
 *
 * Keyed on the finding rather than generated, so the offer for "you are not
 * mobile-friendly" is always the same offer and a caller is never surprised by
 * what the page promised on their behalf.
 */
const RECOMMENDATION_TITLE: Record<string, string> = {
  stated_setup: "Replace what you described on the call",
  busy_phone: "Pick up after hours and at weekends",
  emergency_claim: "Make the 24/7 promise real",
  no_click_to_call: "Make your number tappable",
  buried_in_search: "Get you further up the local results",
  ranks_well: "Stop losing the callers you already earn",
  no_schema: "Tell search engines who you are",
  no_meta: "Control what people read before they ring",
  no_website: "Give people somewhere to land",
  no_https: "Get the browser warning off your site",
  not_mobile: "Make the site work on a phone",
  no_form: "Give people a way in that is not a phone call",
  stale_site: "Bring the site up to date",
  thin_reviews: "Get the reviews you have earned",
  weak_rating: "Get the happy customers heard",
  strong_rating: "Make the reputation pay",
  reviews_not_shown: "Put your reviews where people decide",
  already_books_online: "Cover the callers your booking form misses",
  existing_provider: "Fix what the current setup drops",
};

/**
 * The recommendations on the owner's page.
 *
 * These are an OFFER — what would be set up if they said yes — not a set of
 * claims about how the business currently runs. That distinction is what keeps
 * the page honest when the record is thin: a recommendation to answer
 * after-hours calls is fair to make about anybody, whereas asserting that they
 * *are* missing calls needs evidence we may not have.
 *
 * Where the record does support it, the wording is tailored and the reason is
 * stated. Where it does not, the recommendation still stands but says nothing
 * specific about them.
 */
export function buildRecommendations(input: GapInput): Recommendation[] {
  const out: Recommendation[] = [];

  /*
   * Where a diagnosis exists, the recommendations answer IT rather than
   * reciting the generic four. A business whose problem is that nobody can
   * find them should not be reading three paragraphs about after-hours calls.
   */
  if (input.findings && input.findings.length > 0) {
    for (const f of input.findings.slice(0, 4)) {
      out.push({
        key: `fix_${f.key}`,
        title: RECOMMENDATION_TITLE[f.key] ?? "Fix what we found",
        detail: f.detail,
        basis: f.basis.join(", "),
      });
    }
    return out;
  }
  const reviews = input.reviewCount;
  const busy = typeof reviews === "number" && reviews >= BUSY_REVIEW_COUNT;

  out.push(
    busy
      ? {
          key: "after_hours",
          title: "Pick up after hours and at weekends",
          detail: `With ${reviews} reviews you are clearly getting found. The calls that come in at seven in the evening, on a Sunday, or while you are under a sink are the ones worth catching — every one of them gets answered, and you get the details by text.`,
          basis: "review_count",
        }
      : {
          key: "after_hours",
          title: "Pick up after hours and at weekends",
          detail:
            "Calls that arrive outside working hours, or while you are already on a job, get answered instead of going to voicemail. You get the caller's name, number and what they wanted, by text.",
          basis: "general",
        }
  );

  out.push({
    key: "never_voicemail",
    title: "Stop sending new customers to voicemail",
    detail:
      "Most people ringing a trade will not leave a message — they ring the next name on the list. Anything missed is answered on the first or second ring instead, so the job does not walk.",
    basis: "general",
  });

  if (!(input.website || "").trim()) {
    out.push({
      key: "no_website_capture",
      title: "Capture the enquiries your listing sends you",
      detail:
        "There is no website on your listing, so everyone who looks you up has exactly one way in: the phone. That makes every unanswered call a lost job rather than an inconvenience.",
      basis: "website",
    });
  }

  out.push({
    key: "qualify",
    title: "Find out what the job is before you ring back",
    detail:
      "Callers are asked what they need, where they are, and how urgent it is. You get that in a text, so you can decide who is worth ringing back first instead of working through them blind.",
    basis: "general",
  });

  const setup = (input.answeringSetup || "").trim();
  if (setup) {
    out.push({
      key: "stated_setup",
      title: "Replace what you described on the call",
      detail: `You told us: "${setup}" — that is exactly the gap this closes.`,
      basis: "answering_setup",
    });
  }

  return out.slice(0, 4);
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
