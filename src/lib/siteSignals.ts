// What a business's own website tells you about how it gets work.
//
// Every diagnostic on the owner's page has to trace to something real, and
// until now the only real things on the record were "has a website: yes/no",
// a star rating and a review count. That is why every packet said the same
// thing about missed calls: it was the only claim the data could support.
//
// This reads the pages the enrichment crawler already fetches and writes down
// what is actually there. It is deliberately conservative in one direction:
//
//   ABSENCE OF EVIDENCE IS NOT EVIDENCE OF ABSENCE.
//
// A booking widget loaded by JavaScript will not appear in the HTML we fetched,
// so "no booking widget found" is recorded as `null` — unknown — not as
// `false`. Only things we can positively see become true, and only things we
// can positively rule out become false. The diagnostic then refuses to make a
// claim from a null. That distinction is the whole reason this file has three
// states instead of two.
//
// Pure string work, tested against real markup.

/** true = found it. false = looked and it is definitely not there. null = cannot tell. */
export type Tri = boolean | null;

export type SiteSignals = {
  /** Served over https. Checked on the URL, so this is always knowable. */
  https: Tri;
  /** A viewport meta tag — the minimum for a site to work on a phone. */
  mobileViewport: Tri;
  /** A form that takes an enquiry. */
  contactForm: Tri;
  /** A recognised online-booking or scheduling widget. */
  onlineBooking: Tri;
  /** A clickable tel: link, so a phone visitor can call in one tap. */
  clickToCall: Tri;
  /** LocalBusiness structured data, which is what search engines read. */
  localBusinessSchema: Tri;
  /** Any hours published on the site at all. */
  publishedHours: Tri;
  /** A claim of 24/7 or emergency cover. */
  claimsEmergency: Tri;
  /** Any link to reviews or a testimonials section. */
  showsReviews: Tri;
  /** A title tag long enough to be deliberate. */
  hasPageTitle: Tri;
  /** A meta description. */
  hasMetaDescription: Tri;
  /** The most recent copyright year found, if any. */
  copyrightYear: number | null;
  /** Bytes of HTML on the landing page — a crude weight signal. */
  landingBytes: number | null;
  /** Which known booking or field-service tools were spotted. */
  tools: string[];
};

export const UNKNOWN_SIGNALS: SiteSignals = {
  https: null,
  mobileViewport: null,
  contactForm: null,
  onlineBooking: null,
  clickToCall: null,
  localBusinessSchema: null,
  publishedHours: null,
  claimsEmergency: null,
  showsReviews: null,
  hasPageTitle: null,
  hasMetaDescription: null,
  copyrightYear: null,
  landingBytes: null,
  tools: [],
};

/**
 * Booking and field-service tools that leave a fingerprint in the markup.
 *
 * Spotting one of these is a positive: it means the business already books
 * online, which changes what is worth selling them. Not spotting one proves
 * nothing, hence the tri-state.
 */
const BOOKING_TOOLS: { name: string; patterns: RegExp[] }[] = [
  { name: "Housecall Pro", patterns: [/housecallpro\.com/i, /hcp-booking/i] },
  { name: "Jobber", patterns: [/getjobber\.com/i, /jobber\.com\/booking/i] },
  { name: "ServiceTitan", patterns: [/servicetitan\.com/i, /st-scheduler/i] },
  { name: "Calendly", patterns: [/calendly\.com/i] },
  { name: "Acuity", patterns: [/acuityscheduling\.com/i, /squarespacescheduling\.com/i] },
  { name: "Podium", patterns: [/podium\.com/i] },
  { name: "Thryv", patterns: [/thryv\.com/i] },
  { name: "Setmore", patterns: [/setmore\.com/i] },
  { name: "Square Appointments", patterns: [/squareup\.com\/appointments/i] },
];

const BOOKING_WORDS = [
  /\bbook (?:online|now|an appointment|a service)\b/i,
  /\bschedule (?:online|now|an appointment|service)\b/i,
  /\brequest (?:an? )?(?:appointment|estimate|quote)\b/i,
  /\bbooking form\b/i,
];

/** Text between tags, so word checks are not fooled by attributes and scripts. */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * Read one page.
 *
 * `isLanding` marks the page the site's root redirected to: a few of these
 * signals only mean anything on the landing page (its weight, its title) while
 * others count wherever they appear (a booking widget on the contact page is
 * still a booking widget).
 */
export function readPage(html: string, url: string, isLanding: boolean): Partial<SiteSignals> {
  const text = visibleText(html);
  const out: Partial<SiteSignals> = {};

  // Always knowable from the URL itself.
  out.https = /^https:/i.test(url);

  // Present or definitively absent — these are plain markup, so a negative is
  // a real negative rather than an unknown.
  out.mobileViewport = /<meta[^>]+name=["']?viewport["']?/i.test(html);
  out.clickToCall = /href\s*=\s*["']tel:/i.test(html);
  out.localBusinessSchema =
    /"@type"\s*:\s*"(?:LocalBusiness|Plumber|HVACBusiness|Electrician|RoofingContractor|HomeAndConstructionBusiness|ProfessionalService)"/i.test(
      html
    );

  const title = /<title[^>]*>([^<]{3,})<\/title>/i.exec(html);
  out.hasPageTitle = !!title;
  out.hasMetaDescription = /<meta[^>]+name=["']?description["']?[^>]*content=["'][^"']{20,}/i.test(html);

  /*
   * A form that takes an enquiry.
   *
   * A <form> that is only a search box is not an enquiry form, and treating it
   * as one would tell an owner they have a contact form when they do not.
   */
  const forms = html.match(/<form[\s\S]{0,4000}?<\/form>/gi) || [];
  const enquiryForm = forms.some(
    (f) =>
      /type\s*=\s*["']?(?:email|tel)["']?/i.test(f) ||
      /<textarea/i.test(f) ||
      /name\s*=\s*["'](?:message|comments|enquiry|inquiry|details)/i.test(f)
  );
  // A page with no <form> at all is a definite no. A page with forms that are
  // all search boxes is also a no. Either way we looked.
  out.contactForm = enquiryForm;

  const tools = BOOKING_TOOLS.filter((t) => t.patterns.some((p) => p.test(html))).map((t) => t.name);
  out.tools = tools;
  // A named tool is proof. Booking words are proof. Neither is NOT proof of
  // absence — a widget injected by JavaScript never reaches us — so a
  // negative here stays unknown.
  out.onlineBooking = tools.length > 0 || BOOKING_WORDS.some((p) => p.test(text)) ? true : null;

  out.publishedHours =
    /\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\s*[-–—:]\s*(?:\d|closed)/i.test(text) ||
    /\b(?:open|hours)\b[^.]{0,40}\b\d{1,2}\s*(?:am|pm)\b/i.test(text)
      ? true
      : null;

  out.claimsEmergency =
    /\b24[\s/-]?7\b|\b24 hours?\b|\bemergency (?:service|call|repair)\b|\bsame[- ]day\b/i.test(text)
      ? true
      : null;

  out.showsReviews =
    /\b(?:testimonial|review)s?\b/i.test(text) || /google\.com\/(?:maps|search)[^"']*review/i.test(html)
      ? true
      : null;

  const years = [...text.matchAll(/©\s*(?:\d{4}\s*[-–—]\s*)?(\d{4})|copyright\s+(?:\d{4}\s*[-–—]\s*)?(\d{4})/gi)]
    .map((m) => Number(m[1] || m[2]))
    .filter((y) => y >= 2000 && y <= 2100);
  out.copyrightYear = years.length ? Math.max(...years) : null;

  if (isLanding) out.landingBytes = html.length;

  return out;
}

/**
 * Merge what several pages said into one picture.
 *
 * `true` wins over `null` wins over `false` for the "found it somewhere"
 * signals — a booking widget on the contact page counts even if the home page
 * had none. The always-knowable ones (https, viewport) take the landing page's
 * answer, since that is the page that matters.
 */
export function mergeSignals(pages: Partial<SiteSignals>[]): SiteSignals {
  const out: SiteSignals = { ...UNKNOWN_SIGNALS, tools: [] };
  const anyTrue = (key: keyof SiteSignals) => {
    let sawFalse = false;
    for (const p of pages) {
      const v = p[key];
      if (v === true) return true;
      if (v === false) sawFalse = true;
    }
    return sawFalse ? false : null;
  };

  for (const key of [
    "https",
    "mobileViewport",
    "contactForm",
    "onlineBooking",
    "clickToCall",
    "localBusinessSchema",
    "publishedHours",
    "claimsEmergency",
    "showsReviews",
    "hasPageTitle",
    "hasMetaDescription",
  ] as const) {
    out[key] = anyTrue(key);
  }

  const years = pages.map((p) => p.copyrightYear).filter((y): y is number => typeof y === "number");
  out.copyrightYear = years.length ? Math.max(...years) : null;

  const bytes = pages.map((p) => p.landingBytes).filter((b): b is number => typeof b === "number");
  out.landingBytes = bytes.length ? bytes[0] : null;

  out.tools = [...new Set(pages.flatMap((p) => p.tools || []))];
  return out;
}

/** Read a whole crawl. */
export function readSite(pages: { url: string; html: string }[]): SiteSignals {
  if (pages.length === 0) return { ...UNKNOWN_SIGNALS };
  return mergeSignals(pages.map((p, i) => readPage(p.html, p.url, i === 0)));
}

/** How much of the picture we actually have, 0-1. Used to gate claims. */
export function signalCoverage(s: SiteSignals): number {
  const keys = [
    "https",
    "mobileViewport",
    "contactForm",
    "clickToCall",
    "localBusinessSchema",
    "hasPageTitle",
    "hasMetaDescription",
  ] as const;
  const known = keys.filter((k) => s[k] !== null).length;
  return known / keys.length;
}
