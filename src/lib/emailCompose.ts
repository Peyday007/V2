// What goes into the email, and where every word of it came from.
//
// The division of labour with Instantly, restated because it decides the whole
// shape of this file:
//
//   INSTANTLY HOLDS THE SEQUENCE. The email template, the follow-up steps, the
//   sending schedule and the unsubscribe footer live there, edited by a person
//   in their editor. This application does not own the copy and must not try
//   to.
//
//   THIS APPLICATION HOLDS THE FACTS. It knows the owner's name, the review
//   count, whether there is a website, and what the business told a caller on
//   the phone. That is what makes a cold email land, and Instantly has no way
//   to know any of it.
//
// So the output here is MERGE VARIABLES, not a finished email. The sequence
// references {{personalization}} and the custom variables by name.
//
// The honesty rule from the workshop page applies unchanged and is the reason
// computeGaps is reused rather than reimplemented: NOTHING IS INVENTED. Every
// sentence traces to a field that is populated. Where the record is thin the
// personalization is short — or empty, which the sequence must handle — rather
// than padded out with a claim nobody checked.

import { computeGaps, buildRecommendations, type Gap } from "./workshopPacket";

export type ComposeInput = {
  businessName: string;
  city?: string | null;
  state?: string | null;
  website?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  /** What the owner said on the call, if a caller ever reached them. */
  answeringSetup?: string | null;
  /** Best known name for the decision-maker. */
  ownerName?: string | null;
  industry?: string | null;
  /**
   * The public workshop page for this business, when one has already been
   * created. Passing it links the email to exactly what a caller would text,
   * so a prospect who gets both sees one consistent thing.
   */
  workshopLink?: string | null;
  /**
   * The strongest thing the diagnostic found. When present this IS the
   * personalization — it is a specific, checkable fact about them, which is
   * strictly better than the review-count line it replaces.
   */
  diagnosticHook?: string | null;
  /** Everything the diagnosis found, for the merge variables. */
  findings?: { key: string; headline: string; detail: string; basis: string[] }[];
};

/** Split a stored full name into the parts Instantly merges separately. */
export function splitName(full: string | null | undefined): {
  firstName: string | null;
  lastName: string | null;
} {
  const clean = (full || "").trim().replace(/\s+/g, " ");
  if (!clean) return { firstName: null, lastName: null };
  const parts = clean.split(" ");
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/**
 * The one lead-specific sentence.
 *
 * One sentence, not three. A cold email that opens with a paragraph of
 * research reads as a mail-merge showing its working; a single specific line
 * reads as somebody who actually looked.
 *
 * The order below is by how strong the evidence is:
 *
 *   1. What the owner themselves said on a call. Unbeatable, and quoted
 *      rather than paraphrased so it cannot be distorted.
 *   2. A review count that shows the phone rings.
 *   3. No website on the listing, which makes the phone the only way in.
 *
 * Returns an empty string when the record supports none of these. That is a
 * real outcome and the sequence has to cope with it — a template that reads
 * badly with an empty {{personalization}} is a template that will eventually
 * go out saying nothing in the middle of a sentence.
 */
export function composePersonalization(input: ComposeInput): string {
  const setup = (input.answeringSetup || "").trim();

  /*
   * A diagnostic finding outranks everything except the owner's own words.
   *
   * "You come up 19th for plumbers in Dallas" is a specific, checkable fact
   * about them. "You have 132 reviews" is also true but says nothing they do
   * not know, and it was the best this could do before the diagnosis existed.
   */
  const hook = (input.diagnosticHook || "").trim();
  if (!setup && hook) return lowerFirst(hook);
  if (setup) {
    return `you mentioned "${trimQuote(setup)}" when we spoke`;
  }

  const reviews = input.reviewCount;
  if (typeof reviews === "number" && reviews >= 25) {
    const rated =
      typeof input.rating === "number" && input.rating >= 4.5
        ? ` at ${input.rating.toFixed(1)} stars`
        : "";
    return `I saw ${input.businessName} has ${reviews} reviews${rated}, so the phone clearly rings`;
  }

  if (!(input.website || "").trim()) {
    return `${input.businessName} has no website on its listing, so the phone is the only way anyone can reach you`;
  }

  return "";
}

/** Keep a quoted line short enough to sit inside a sentence. */
function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function trimQuote(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}

/**
 * Everything the sequence can merge, by name.
 *
 * Every value is a string, because Instantly merges text and a null arriving
 * in a template renders as the word "null" in a prospect's inbox. Absent facts
 * become empty strings and the template is responsible for the fallback — the
 * same rule as renderMessage dropping the company clause when COMPANY_NAME is
 * unset.
 */
export function composeVariables(input: ComposeInput): Record<string, string> {
  const { firstName } = splitName(input.ownerName);
  const gapInput = {
    businessName: input.businessName,
    city: input.city,
    website: input.website,
    rating: input.rating,
    reviewCount: input.reviewCount,
    answeringSetup: input.answeringSetup,
    findings: input.findings,
  };
  const gaps = computeGaps(gapInput);
  const recs = buildRecommendations(gapInput);

  return {
    owner_first_name: firstName || "",

    /*
     * THE OPENING LINE, RESOLVED HERE RATHER THAN IN THE TEMPLATE.
     *
     * A sequence that writes "Hey {{owner_first_name}}," renders as "Hey ,"
     * for every lead whose name we do not have — which is most of the ones
     * reached at a general inbox. That is the first thing the prospect reads
     * and it announces a mail merge before the first sentence.
     *
     * Instantly has no conditional syntax we can rely on, so the branch has to
     * happen on this side. "Hi," alone is not a failure state: it is how a
     * person writes to somebody whose name they do not know, which is exactly
     * the situation.
     */
    greeting: firstName ? `Hi ${firstName},` : "Hi,",

    business_name: input.businessName,
    city: (input.city || "").trim(),
    state: (input.state || "").trim(),
    review_count: typeof input.reviewCount === "number" ? String(input.reviewCount) : "",
    rating: typeof input.rating === "number" ? input.rating.toFixed(1) : "",
    // The headline of the strongest thing we can honestly say.
    gap_headline: gaps[0]?.headline ?? "",
    // The single recommendation most worth leading with.
    top_recommendation: recs[0]?.title ?? "",
    workshop_link: (input.workshopLink || "").trim(),

    /*
     * THE FINDINGS THEMSELVES, in the email.
     *
     * gap_headline is one line, and everything else we actually worked out
     * sat behind a link — so the only people who ever saw the real substance
     * were the ones curious enough to click. That is backwards: the findings
     * ARE the reason the email is worth reading, and they should be in it.
     *
     * Written as lines rather than a paragraph because that is how somebody
     * skims an email on a phone. Blank between them so they survive as
     * separate blocks — see formatBody, which turns those into paragraphs.
     *
     * Both are empty strings when nothing was found, never a placeholder.
     * A sentence about a business we know nothing about is exactly the
     * "AI receptionist heavy" filler this is meant to replace.
     */
    gap_detail: gaps[0]?.detail ?? "",
    gap_list: gaps
      .slice(0, 3)
      .map((g) => `• ${g.headline}${g.detail ? ` — ${g.detail}` : ""}`)
      .join("\n"),
    recommendation_list: recs
      .slice(0, 3)
      .map((r) => `• ${r.title}${r.detail ? ` — ${r.detail}` : ""}`)
      .join("\n"),
    /** How many things were found, so copy can say "three things" honestly. */
    gap_count: gaps.length > 0 ? String(Math.min(gaps.length, 3)) : "",
    // So a template can branch instead of printing an empty line.
    has_website: (input.website || "").trim() ? "yes" : "no",
    spoke_to_owner: (input.answeringSetup || "").trim() ? "yes" : "no",
  };
}

/**
 * What the merged email would look like, for a human to read before pushing.
 *
 * This is a PREVIEW, not the thing that gets sent — the real subject and body
 * come from the sequence in Instantly. It exists because pushing 50 leads on
 * the strength of variables nobody has seen rendered is how a batch goes out
 * with a stray quotation mark in the middle of it, and because the reply
 * drafter needs to know what the prospect was actually sent in order to answer
 * them sensibly.
 *
 * Labelled as a preview everywhere it is displayed.
 */
export function composePreview(input: ComposeInput): { subject: string; body: string } {
  const { firstName } = splitName(input.ownerName);
  const personal = composePersonalization(input);
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";

  const gapInput = {
    businessName: input.businessName,
    city: input.city,
    website: input.website,
    rating: input.rating,
    reviewCount: input.reviewCount,
    answeringSetup: input.answeringSetup,
    findings: input.findings,
  };
  const gaps = computeGaps(gapInput);

  /*
   * LED BY WHAT WAS FOUND, not by the product.
   *
   * This used to open with a question about missed calls and then pitch an
   * AI receptionist, whatever the diagnosis said — so a business whose actual
   * problem was that nobody could find them in search got an email about the
   * phone. Being obviously not about them is what makes cold email look
   * automated, and it wasted the diagnosis we had already done.
   */
  const subject = gaps[0] ? `${input.businessName} — ${gaps[0].headline}` : `${input.businessName}`;

  const lines: string[] = [greeting, ""];
  lines.push(
    personal
      ? `${capitalise(personal)} — so I had a look at how people find and reach you.`
      : "I had a look at how people find and reach you."
  );

  if (gaps.length > 0) {
    lines.push("");
    lines.push(gaps.length === 1 ? "One thing stood out:" : "A few things stood out:");
    for (const g of gaps.slice(0, 3)) {
      lines.push("");
      lines.push(`• ${g.headline}${g.detail ? ` — ${g.detail}` : ""}`);
    }
  }

  if ((input.workshopLink || "").trim()) {
    lines.push("");
    lines.push(
      `The rest of it, and what we would do about each one, is here: ${input.workshopLink!.trim()}`
    );
  }
  lines.push("");
  // A reply, not a booking link. See the writer's own rules.
  lines.push("Worth a look?");

  return { subject, body: lines.join("\n") };
}

function capitalise(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** The gaps, exposed so the admin page can show what a push is based on. */
export function gapsFor(input: ComposeInput): Gap[] {
  return computeGaps({
    businessName: input.businessName,
    city: input.city,
    website: input.website,
    rating: input.rating,
    reviewCount: input.reviewCount,
    answeringSetup: input.answeringSetup,
    findings: input.findings,
  });
}

/** The lead columns composing needs. */
export const EMAIL_COMPOSE_COLUMNS =
  "id, business_name, city, state, website, rating, review_count, answering_setup, owner_name, decision_maker_name, industry";
