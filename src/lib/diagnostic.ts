// What is actually wrong with this business's setup, and what we could sell
// them to fix it.
//
// The problem this replaces: every packet said the same thing. "You are
// missing calls." True of everyone, provable about no one, and it gave a
// caller exactly one thing to talk about — so a business ranking twentieth in
// the map pack with no website heard the same opening as one ranking second
// with a booking widget.
//
// The rule that shapes everything below is unchanged from the workshop page,
// and now matters far more because there are far more claims available:
//
//   NOTHING IS INVENTED, AND A NULL IS NEVER A CLAIM.
//
// siteSignals.ts returns three states on purpose — true, false, and "could not
// tell". A booking widget injected by JavaScript never reaches our crawler, so
// "no booking widget found" is null, and a finding is NEVER built from a null.
// Telling an owner they have no online booking when we simply could not see it
// is the fastest way to lose the meeting the packet earned.
//
// Each finding carries:
//   - what we observed, and the field it came from
//   - what that costs them, in their language
//   - what we would do about it, which is the sellable part
//   - a weight, so a caller leads with the strongest one
//
// Pure. No database, no network.

import type { SiteSignals } from "./siteSignals";

export type ServiceLine =
  | "ai_receptionist"
  | "local_seo"
  | "website_build"
  | "reputation"
  | "booking"
  | "mobile_fix";

export const SERVICE_LABEL: Record<ServiceLine, string> = {
  ai_receptionist: "AI receptionist",
  local_seo: "Local search",
  website_build: "Website",
  reputation: "Reviews",
  booking: "Online booking",
  mobile_fix: "Mobile site",
};

export type Finding = {
  key: string;
  /** Which thing we would sell to fix it. */
  service: ServiceLine;
  /** 0-1. How strongly the evidence supports leading with this. */
  weight: number;
  /** What an owner sees. Their language, not ours. */
  headline: string;
  detail: string;
  /** The field(s) this came from, so any claim can be traced. */
  basis: string[];
  /** One line a caller can say out loud. Never shown to the owner. */
  talkTrack: string;
};

/* -------------------------------------------------------------------------- */
/* what we know                                                               */
/* -------------------------------------------------------------------------- */

export type DiagnosticInput = {
  businessName: string;
  city?: string | null;
  state?: string | null;
  industry?: string | null;
  website?: string | null;
  rating?: number | null;
  reviewCount?: number | null;

  /**
   * Where they came in the map results for their own trade in their own city.
   * 1 is top. Null means the run did not record it — common for imported
   * leads — and produces no ranking claim at all.
   */
  mapRank?: number | null;
  /** How many results that search returned, so a rank has a denominator. */
  mapResultCount?: number | null;

  /** What the crawl saw. Absent for a lead with no website crawled. */
  site?: SiteSignals | null;

  /** What the owner themselves said on a call. Beats everything. */
  answeringSetup?: string | null;
  existingProvider?: string | null;

  /** For the "site looks abandoned" check. */
  currentYear?: number;
};

/* -------------------------------------------------------------------------- */
/* thresholds, named so they can be argued with                               */
/* -------------------------------------------------------------------------- */

/** Enough reviews that the phone demonstrably rings. */
export const BUSY_REVIEWS = 25;
/** Roughly the bottom of the first "page" of local results. */
export const FIRST_PAGE_RANK = 10;
/** Below this a rating is actively costing them calls. */
export const WEAK_RATING = 4.0;
/** A rating this good is an asset worth pointing at. */
export const STRONG_RATING = 4.6;
/** Fewer than this and they are invisible next to anyone who asks. */
export const THIN_REVIEWS = 15;
/** Copyright this far behind means nobody has touched the site. */
export const STALE_YEARS = 3;

/* -------------------------------------------------------------------------- */
/* the checks                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every honest finding, strongest first.
 *
 * Deliberately generates MORE than will be shown. Selection happens in
 * `topFindings`, which spreads across service lines — four variations on
 * "your website is bad" is one sellable point wearing four hats, and the
 * brief was for two to four genuinely different ones.
 */
export function diagnose(input: DiagnosticInput): Finding[] {
  const out: Finding[] = [];
  const name = input.businessName;
  const site = input.site ?? null;
  const reviews = input.reviewCount;
  const rating = input.rating;
  const year = input.currentYear ?? new Date().getFullYear();
  const where = (input.city || "").trim();

  /* ------------------------------ the phone ----------------------------- */

  // What the owner told us outranks everything we inferred.
  const said = (input.answeringSetup || "").trim();
  if (said) {
    out.push({
      key: "stated_setup",
      service: "ai_receptionist",
      weight: 0.98,
      headline: "What you told us about how calls get answered",
      detail: said,
      basis: ["answering_setup"],
      talkTrack: `They already told us: "${said.slice(0, 100)}". Lead with that, do not re-diagnose it.`,
    });
  }

  if (typeof reviews === "number" && reviews >= BUSY_REVIEWS && !said) {
    out.push({
      key: "busy_phone",
      service: "ai_receptionist",
      weight: 0.8,
      headline: `${reviews} reviews, and no listed way to reach you out of hours`,
      detail:
        `${name} clearly gets called. What we could not find is what happens to those calls ` +
        `in the evening, at the weekend, or while you are on a job.`,
      basis: ["review_count"],
      talkTrack: `${reviews} reviews means the phone rings. Ask what happens to the 7pm ones.`,
    });
  }

  // Positive evidence only: they SAY they cover emergencies, which raises the
  // stakes on an unanswered call rather than lowering them.
  if (site?.claimsEmergency === true) {
    out.push({
      key: "emergency_claim",
      service: "ai_receptionist",
      weight: 0.85,
      headline: "Your site promises emergency cover",
      detail:
        "Someone with a burst pipe at midnight reads that, rings, and decides about you in " +
        "fifteen seconds. That promise is only as good as the phone behind it.",
      basis: ["site.claimsEmergency"],
      talkTrack: "Their own site says 24/7. Ask who actually picks up at 2am — usually nobody.",
    });
  }

  if (site?.clickToCall === false && site?.mobileViewport !== null) {
    out.push({
      key: "no_click_to_call",
      service: "mobile_fix",
      weight: 0.55,
      headline: "Your number is not tappable on a phone",
      detail:
        "Most people find you on a mobile. If the number is text rather than a link, they have " +
        "to memorise it and dial it by hand — and a good share simply do not.",
      basis: ["site.clickToCall"],
      talkTrack: "No tel: link. Small fix, easy first yes, opens the conversation.",
    });
  }

  /* ---------------------------- being findable -------------------------- */

  const rank = input.mapRank;
  if (typeof rank === "number" && rank > FIRST_PAGE_RANK) {
    const page = Math.ceil(rank / FIRST_PAGE_RANK);
    out.push({
      key: "buried_in_search",
      service: "local_seo",
      weight: 0.9,
      headline: `You come up ${ordinal(rank)}${where ? ` for ${trade(input.industry)} in ${where}` : ""}`,
      detail:
        `That is page ${page}. Almost nobody scrolls that far — they ring one of the first ` +
        `three and stop looking. The businesses above you are not necessarily better; they ` +
        `have a more complete listing and more recent reviews.`,
      basis: ["map_rank"],
      talkTrack: `Ranked ${rank}. This is the strongest opener they have — it is a number about them, not a generality.`,
    });
  } else if (typeof rank === "number" && rank <= 3) {
    out.push({
      key: "ranks_well",
      service: "ai_receptionist",
      weight: 0.6,
      headline: `You come up ${ordinal(rank)}${where ? ` in ${where}` : ""} — the search is already working`,
      detail:
        "Being found is the expensive half and you have it. Which makes every call that goes " +
        "to voicemail more expensive, not less: you paid for that caller in reputation.",
      basis: ["map_rank"],
      talkTrack: `They rank ${rank}. Do NOT pitch SEO. Their leak is at the phone.`,
    });
  }

  if (site?.localBusinessSchema === false) {
    out.push({
      key: "no_schema",
      service: "local_seo",
      weight: 0.45,
      headline: "Search engines cannot read your details off your site",
      detail:
        "There is no structured business information on the page — the bit that tells Google " +
        "your hours, your area and your services in a form it trusts. It is invisible to a " +
        "visitor and it is one of the things that decides who comes up first.",
      basis: ["site.localBusinessSchema"],
      talkTrack: "No LocalBusiness schema. Concrete, cheap to fix, and pairs with the ranking point.",
    });
  }

  if (site?.hasMetaDescription === false || site?.hasPageTitle === false) {
    out.push({
      key: "no_meta",
      service: "local_seo",
      weight: 0.4,
      headline: "Your listing in search results writes itself",
      detail:
        "Without a title and description of your own, search engines pick a sentence off your " +
        "page at random. That snippet is the only thing most people read before deciding who " +
        "to ring.",
      basis: ["site.hasPageTitle", "site.hasMetaDescription"],
      talkTrack: "Missing title/description. Easy visual to show them on a screen share.",
    });
  }

  /* -------------------------------- the site ---------------------------- */

  if (!(input.website || "").trim()) {
    out.push({
      key: "no_website",
      service: "website_build",
      weight: 0.88,
      headline: "No website on your listing",
      detail:
        "Everyone who looks you up lands on your listing with exactly one option: ring you. " +
        "Anyone comparing three companies will usually drop the one they cannot read about.",
      basis: ["website"],
      talkTrack: "No site at all. Biggest single gap, and the easiest for them to feel.",
    });
  } else {
    if (site?.https === false) {
      out.push({
        key: "no_https",
        service: "website_build",
        weight: 0.7,
        headline: "Browsers are marking your site as not secure",
        detail:
          "Chrome shows a warning next to the address on sites without a certificate. Whatever " +
          "the site says after that, the visitor has already been told to be careful.",
        basis: ["site.https"],
        talkTrack: "No HTTPS. Show them the browser warning; it lands instantly.",
      });
    }

    if (site?.mobileViewport === false) {
      out.push({
        key: "not_mobile",
        service: "mobile_fix",
        weight: 0.82,
        headline: "Your site was not built for phones",
        detail:
          "Most people looking for a trade are on a mobile, and a desktop-only site arrives " +
          "zoomed out and unreadable. They pinch once, give up, and go back to the results.",
        basis: ["site.mobileViewport"],
        talkTrack: "No viewport tag — the site genuinely does not work on a phone. Ask them to open it on theirs.",
      });
    }

    if (site?.contactForm === false) {
      out.push({
        key: "no_form",
        service: "booking",
        weight: 0.6,
        headline: "There is no way to reach you except ringing",
        detail:
          "Plenty of people will not phone a stranger — they are at work, or it is late, or " +
          "they just would rather type. With no form, every one of those is somebody else's job.",
        basis: ["site.contactForm"],
        talkTrack: "No enquiry form anywhere on the site. Pairs well with the after-hours point.",
      });
    }

    const stale = site?.copyrightYear;
    if (typeof stale === "number" && year - stale >= STALE_YEARS) {
      out.push({
        key: "stale_site",
        service: "website_build",
        weight: 0.65,
        headline: `Your site still says ${stale}`,
        detail:
          "It is a small thing that people read as a big one: if the site has not been touched " +
          "in years, a visitor wonders whether the business is still going.",
        basis: ["site.copyrightYear"],
        talkTrack: `Copyright ${stale}. Gentle, concrete, hard to argue with.`,
      });
    }
  }

  /* ------------------------------- reputation --------------------------- */

  if (typeof reviews === "number" && reviews > 0 && reviews < THIN_REVIEWS) {
    out.push({
      key: "thin_reviews",
      service: "reputation",
      weight: 0.72,
      headline: `Only ${reviews} review${reviews === 1 ? "" : "s"} to go on`,
      detail:
        "Anyone choosing between you and the firm above you is reading reviews, and volume " +
        "reads as experience whether or not it is. Your customers are happy; almost none of " +
        "them are asked.",
      basis: ["review_count"],
      talkTrack: `${reviews} reviews. Ask how they currently ask for them — the answer is usually "we don't".`,
    });
  }

  if (typeof rating === "number" && rating < WEAK_RATING && (reviews ?? 0) >= 5) {
    out.push({
      key: "weak_rating",
      service: "reputation",
      weight: 0.75,
      headline: `${rating.toFixed(1)} stars is costing you calls`,
      detail:
        "People filter on rating before they read a word. The fix is rarely the work — it is " +
        "that the happy customers never get asked and the unhappy one always posts.",
      basis: ["rating", "review_count"],
      talkTrack: `${rating.toFixed(1)} stars. Handle carefully — do not open with it, they know.`,
    });
  }

  if (typeof rating === "number" && rating >= STRONG_RATING && (reviews ?? 0) >= 10) {
    out.push({
      key: "strong_rating",
      service: "ai_receptionist",
      weight: 0.5,
      headline: `${rating.toFixed(1)} stars — people like the work`,
      detail:
        "The reputation is doing its job and sending you callers. The only question is how " +
        "many of them get through.",
      basis: ["rating", "review_count"],
      talkTrack: "Open with the compliment; it is true and it earns the next two minutes.",
    });
  }

  if (site?.showsReviews === false && (reviews ?? 0) >= BUSY_REVIEWS) {
    out.push({
      key: "reviews_not_shown",
      service: "reputation",
      weight: 0.5,
      headline: `${reviews} reviews, and none of them on your own site`,
      detail:
        "The best thing you have is sitting on a listing somebody has to go and find. On the " +
        "page where people decide, it is not there.",
      basis: ["site.showsReviews", "review_count"],
      talkTrack: "They have the proof and are not using it. Easy, cheap, visible win.",
    });
  }

  /* -------------------------------- booking ----------------------------- */

  if (site?.onlineBooking === true) {
    // Not a gap. Recorded because it tells the caller what NOT to pitch.
    out.push({
      key: "already_books_online",
      service: "booking",
      weight: 0.3,
      headline: "You already take bookings online",
      detail:
        "Which means the gap is not the booking — it is what happens to the people who ring " +
        "instead, and to the ones who start a booking at eleven at night with a question.",
      basis: ["site.onlineBooking", ...(site.tools.length ? ["site.tools"] : [])],
      talkTrack:
        site.tools.length > 0
          ? `They use ${site.tools.join(", ")}. Do NOT pitch booking. Position as the layer in front of it.`
          : "They book online already. Do not pitch booking software.",
    });
  }

  if ((input.existingProvider || "").trim()) {
    out.push({
      key: "existing_provider",
      service: "ai_receptionist",
      weight: 0.35,
      headline: "You already have something in place",
      detail: `You mentioned ${input.existingProvider!.trim()}.`,
      basis: ["existing_provider"],
      talkTrack: `They have ${input.existingProvider}. Ask what it does badly rather than pitching a replacement.`,
    });
  }

  return out.sort((a, b) => b.weight - a.weight);
}

/* -------------------------------------------------------------------------- */
/* choosing what to lead with                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The findings actually worth showing, spread across different things to sell.
 *
 * The brief was at least two to four DIFFERENT sellable points, and the naive
 * "take the top four by weight" does not deliver that: a site with no HTTPS,
 * no viewport, no form and a 2019 copyright would produce four findings that
 * are all "your website is bad". One point wearing four hats.
 *
 * So this takes the strongest finding from each service line first, then fills
 * any remaining slots by weight. A business with genuinely one problem still
 * gets one honest finding rather than three padded ones.
 */
export function topFindings(findings: Finding[], limit = 4): Finding[] {
  const byService = new Map<ServiceLine, Finding>();
  for (const f of findings) {
    const held = byService.get(f.service);
    if (!held || f.weight > held.weight) byService.set(f.service, f);
  }

  const spread = [...byService.values()].sort((a, b) => b.weight - a.weight);
  const chosen = spread.slice(0, limit);

  if (chosen.length < limit) {
    for (const f of findings) {
      if (chosen.length >= limit) break;
      if (!chosen.includes(f)) chosen.push(f);
    }
  }
  return chosen.sort((a, b) => b.weight - a.weight);
}

/** How many genuinely different things we could sell this business. */
export function sellableAngles(findings: Finding[]): ServiceLine[] {
  return [...new Set(findings.map((f) => f.service))];
}

/**
 * Is the diagnostic thin enough that a caller should know before dialling?
 *
 * Two distinct angles was the brief's floor. Below it the page still works —
 * the offer stands on its own — but nobody should be surprised on the call.
 */
export function diagnosticIsThin(findings: Finding[]): boolean {
  return sellableAngles(findings).length < 2;
}

/* -------------------------------------------------------------------------- */
/* wording helpers                                                            */
/* -------------------------------------------------------------------------- */

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/** An industry key as a person would say it. */
export function trade(industry: string | null | undefined): string {
  const key = (industry || "").trim().toLowerCase();
  const named: Record<string, string> = {
    hvac: "HVAC",
    plumbing: "plumbers",
    roofing: "roofers",
    electrical: "electricians",
    garage_door: "garage door repair",
    pest_control: "pest control",
    appliance_repair: "appliance repair",
    tree_service: "tree services",
    locksmith: "locksmiths",
    restoration: "restoration",
    cleaning: "cleaners",
    septic: "septic services",
  };
  return named[key] || key.replace(/_/g, " ") || "your trade";
}
