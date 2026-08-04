// The diagnosis, the size estimate, and the script assignment.
//
// Three properties are load-bearing here and each has a mutation test behind
// it in the suite run:
//
//   1. A NULL IS NEVER A CLAIM. "Could not tell" must never become "they do
//      not have it".
//   2. THE SIZE ESTIMATE NEVER REACHES THE OWNER.
//   3. THE SCRIPT IS ASSIGNED, NOT CHOSEN, and the arms stay even.

import { describe, it, expect } from "vitest";
import {
  diagnose,
  topFindings,
  sellableAngles,
  diagnosticIsThin,
  trade,
  FIRST_PAGE_RANK,
  type DiagnosticInput,
} from "../src/lib/diagnostic";
import { readPage, readSite, mergeSignals, UNKNOWN_SIGNALS } from "../src/lib/siteSignals";
import { estimateAffordability, SIZE_LABEL } from "../src/lib/affordability";
import {
  assignScript,
  assignmentSpread,
  buildScript,
  hashString,
  SCRIPT_VERSIONS,
  SCRIPT_NAME,
} from "../src/lib/gatekeeperScripts";
import { computeGaps, buildRecommendations } from "../src/lib/workshopPacket";
import { composePersonalization, composeVariables } from "../src/lib/emailCompose";

const page = (body: string) => `<html><head><title>Ace Plumbing</title></head><body>${body}</body></html>`;

const base: DiagnosticInput = { businessName: "Ace Plumbing", city: "Dallas", industry: "plumbing" };

/* -------------------------------------------------------------------------- */
/* reading a site                                                             */
/* -------------------------------------------------------------------------- */

describe("what a page tells us", () => {
  it("sees a phone-ready site", () => {
    const s = readPage(
      page('<meta name="viewport" content="width=device-width"><a href="tel:+12145551212">Call</a>'),
      "https://acehvac.com/",
      true
    );
    expect(s.mobileViewport).toBe(true);
    expect(s.clickToCall).toBe(true);
    expect(s.https).toBe(true);
  });

  it("sees a site that is not", () => {
    const s = readPage(page("<p>Call us on 214-555-1212</p>"), "http://ace.com/", true);
    expect(s.mobileViewport).toBe(false);
    expect(s.clickToCall).toBe(false);
    expect(s.https).toBe(false);
  });

  it("tells an enquiry form from a search box", () => {
    const search = readPage(page('<form><input type="search" name="q"><button>Go</button></form>'), "https://a.com/", true);
    expect(search.contactForm).toBe(false);
    const enquiry = readPage(page('<form><input type="email"><textarea name="message"></textarea></form>'), "https://a.com/", true);
    expect(enquiry.contactForm).toBe(true);
  });

  it("names the booking tool when it can see one", () => {
    const s = readPage(page('<script src="https://book.housecallpro.com/w.js"></script>'), "https://a.com/", true);
    expect(s.tools).toEqual(["Housecall Pro"]);
    expect(s.onlineBooking).toBe(true);
  });

  it("A BOOKING WIDGET IT CANNOT SEE IS UNKNOWN, NOT ABSENT", () => {
    // The whole reason the signals are tri-state. A widget injected by
    // JavaScript never reaches the crawler, so claiming they have no online
    // booking would be a claim we never checked.
    const s = readPage(page("<p>Ace Plumbing, Dallas</p>"), "https://a.com/", true);
    expect(s.onlineBooking).toBeNull();
    expect(s.onlineBooking).not.toBe(false);
  });

  it("reads schema, meta and copyright", () => {
    const s = readPage(
      `<html><head><title>Ace</title><meta name="description" content="${"x".repeat(40)}"></head>` +
        `<body><script type="application/ld+json">{"@type":"Plumber"}</script>` +
        `<footer>© 2019 Ace</footer></body></html>`,
      "https://a.com/",
      true
    );
    expect(s.localBusinessSchema).toBe(true);
    expect(s.hasMetaDescription).toBe(true);
    expect(s.copyrightYear).toBe(2019);
  });

  it("merges pages so a signal found anywhere counts", () => {
    const merged = mergeSignals([
      { contactForm: false, onlineBooking: null },
      { contactForm: true, onlineBooking: true },
    ]);
    expect(merged.contactForm).toBe(true);
    expect(merged.onlineBooking).toBe(true);
  });

  it("an empty crawl knows nothing rather than assuming the worst", () => {
    const s = readSite([]);
    expect(s).toEqual(UNKNOWN_SIGNALS);
    expect(s.mobileViewport).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* the diagnosis                                                              */
/* -------------------------------------------------------------------------- */

describe("A NULL IS NEVER A CLAIM", () => {
  it("says nothing about booking, forms or mobile when it could not look", () => {
    const findings = diagnose({ ...base, website: "https://ace.com", site: null });
    const keys = findings.map((f) => f.key);
    expect(keys).not.toContain("no_form");
    expect(keys).not.toContain("not_mobile");
    expect(keys).not.toContain("no_schema");
    expect(keys).not.toContain("no_click_to_call");
  });

  it("but does when it looked and they are genuinely missing", () => {
    const findings = diagnose({
      ...base,
      website: "https://ace.com",
      site: { ...UNKNOWN_SIGNALS, mobileViewport: false, contactForm: false, localBusinessSchema: false, clickToCall: false },
    });
    const keys = findings.map((f) => f.key);
    expect(keys).toContain("not_mobile");
    expect(keys).toContain("no_form");
    expect(keys).toContain("no_schema");
  });

  it("makes no ranking claim without a rank", () => {
    const findings = diagnose({ ...base, mapRank: null });
    expect(findings.map((f) => f.key)).not.toContain("buried_in_search");
  });
});

describe("more than one thing to talk about", () => {
  const rich: DiagnosticInput = {
    ...base,
    website: "https://ace.com",
    rating: 4.8,
    reviewCount: 140,
    mapRank: 19,
    site: {
      ...UNKNOWN_SIGNALS,
      mobileViewport: false,
      contactForm: false,
      localBusinessSchema: false,
      claimsEmergency: true,
      https: true,
    },
  };

  it("AT LEAST TWO DIFFERENT SELLABLE POINTS on a normal lead", () => {
    const shown = topFindings(diagnose(rich));
    expect(sellableAngles(shown).length).toBeGreaterThanOrEqual(2);
    expect(diagnosticIsThin(shown)).toBe(false);
  });

  it("usually three or four", () => {
    const shown = topFindings(diagnose(rich));
    expect(sellableAngles(shown).length).toBeGreaterThanOrEqual(3);
    expect(shown.length).toBeLessThanOrEqual(4);
  });

  it("SPREADS ACROSS SERVICES rather than four versions of one point", () => {
    // A site with no HTTPS, no viewport, no form and a 2019 copyright would
    // otherwise produce four findings that are all "your website is bad" —
    // one sellable point wearing four hats.
    const allWebsite = diagnose({
      ...base,
      website: "http://ace.com",
      site: {
        ...UNKNOWN_SIGNALS,
        https: false,
        mobileViewport: false,
        contactForm: false,
        copyrightYear: 2018,
        hasMetaDescription: false,
        hasPageTitle: false,
      },
      currentYear: 2026,
      reviewCount: 8,
    });
    const shown = topFindings(allWebsite);
    const services = shown.map((f) => f.service);
    expect(new Set(services).size).toBe(services.length);
  });

  it("a lead with nothing on the record is honestly thin", () => {
    const shown = topFindings(diagnose({ businessName: "Ace", website: "https://ace.com" }));
    expect(diagnosticIsThin(shown)).toBe(true);
  });
});

describe("the findings themselves", () => {
  it("what the owner said outranks everything inferred", () => {
    const findings = diagnose({ ...base, reviewCount: 300, mapRank: 40, answeringSetup: "my wife picks up" });
    expect(findings[0].key).toBe("stated_setup");
  });

  it("a buried business is told where it comes and what page that is", () => {
    const f = diagnose({ ...base, mapRank: 19 }).find((x) => x.key === "buried_in_search")!;
    expect(f.headline).toContain("19th");
    expect(f.headline).toContain("plumbers in Dallas");
    expect(f.detail).toContain("page 2");
    expect(f.service).toBe("local_seo");
  });

  it("a business that already ranks is NOT pitched SEO", () => {
    const findings = diagnose({ ...base, mapRank: 2, reviewCount: 90 });
    const ranked = findings.find((x) => x.key === "ranks_well")!;
    expect(ranked.service).toBe("ai_receptionist");
    expect(findings.map((f) => f.key)).not.toContain("buried_in_search");
    expect(ranked.talkTrack).toMatch(/do not pitch seo/i);
  });

  it("a business that already books online is not sold booking", () => {
    const f = diagnose({
      ...base,
      website: "https://ace.com",
      site: { ...UNKNOWN_SIGNALS, onlineBooking: true, tools: ["Jobber"] },
    }).find((x) => x.key === "already_books_online")!;
    expect(f.talkTrack).toMatch(/do not pitch booking/i);
    expect(f.talkTrack).toContain("Jobber");
  });

  it("every finding traces to a field", () => {
    for (const f of diagnose({ ...base, reviewCount: 100, mapRank: 15, rating: 3.4, website: "" })) {
      expect(f.basis.length, f.key).toBeGreaterThan(0);
      expect(f.talkTrack.length, f.key).toBeGreaterThan(10);
    }
  });

  it("the page-one boundary is where it says it is", () => {
    expect(diagnose({ ...base, mapRank: FIRST_PAGE_RANK }).map((f) => f.key)).not.toContain("buried_in_search");
    expect(diagnose({ ...base, mapRank: FIRST_PAGE_RANK + 1 }).map((f) => f.key)).toContain("buried_in_search");
  });

  it("says trades the way a person would", () => {
    expect(trade("hvac")).toBe("HVAC");
    expect(trade("garage_door")).toBe("garage door repair");
    expect(trade(null)).toBe("your trade");
  });
});

/* -------------------------------------------------------------------------- */
/* the packet uses it                                                         */
/* -------------------------------------------------------------------------- */

describe("the owner's page shows the real diagnosis", () => {
  const findings = topFindings(
    diagnose({ ...base, mapRank: 19, reviewCount: 140, website: "https://ace.com", site: { ...UNKNOWN_SIGNALS, mobileViewport: false } })
  );

  it("uses the findings when there are some", () => {
    const gaps = computeGaps({ businessName: "Ace Plumbing", findings });
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    expect(gaps.map((g) => g.headline).join(" ")).toContain("19th");
  });

  it("falls back to the old three checks for a lead with no diagnosis", () => {
    const gaps = computeGaps({ businessName: "Ace Plumbing", reviewCount: 140 });
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps[0].basis).toBe("review_count");
  });

  it("the recommendations answer the findings rather than reciting the generic four", () => {
    const recs = buildRecommendations({ businessName: "Ace Plumbing", findings });
    expect(recs.map((r) => r.title).join(" ")).toMatch(/local results|phone|mobile/i);
  });

  it("the email leads with the diagnosis, not the review count", () => {
    const line = composePersonalization({
      businessName: "Ace Plumbing",
      reviewCount: 140,
      diagnosticHook: "You come up 19th for plumbers in Dallas",
    });
    expect(line).toContain("19th");
    expect(line).not.toContain("140 reviews");
  });

  it("but the owner's own words still beat the diagnosis", () => {
    const line = composePersonalization({
      businessName: "Ace",
      diagnosticHook: "You come up 19th",
      answeringSetup: "my wife picks up when she can",
    });
    expect(line).toContain("my wife picks up");
  });
});

/* -------------------------------------------------------------------------- */
/* affordability                                                              */
/* -------------------------------------------------------------------------- */

describe("sizing the business", () => {
  it("a three-van outfit and a regional company get different ceilings", () => {
    const small = estimateAffordability({ industry: "plumbing", reviewCount: 35 });
    const regional = estimateAffordability({
      industry: "hvac",
      reviewCount: 600,
      mapRank: 1,
      hasWebsite: true,
      hasBookingTool: true,
      hasSchema: true,
      mobileReady: true,
    });
    expect(small.oneOffCeiling).toBeLessThan(regional.oneOffCeiling);
    expect(small.monthlyBudget.high).toBeLessThan(regional.monthlyBudget.low);
  });

  it("a 3-person plumber is not quoted a 7k build", () => {
    const solo = estimateAffordability({ industry: "plumbing", reviewCount: 12, hasWebsite: false });
    expect(solo.band).toBe("solo");
    expect(solo.oneOffCeiling).toBeLessThan(7000);
    expect(solo.guidance).toMatch(/no setup fee|one job/i);
  });

  it("evidence of spending money moves the band up", () => {
    const plain = estimateAffordability({ reviewCount: 60 });
    const invested = estimateAffordability({
      reviewCount: 60,
      hasBookingTool: true,
      hasSchema: true,
      hasWebsite: true,
    });
    expect(invested.monthlyBudget.high).toBeGreaterThan(plain.monthlyBudget.high);
  });

  it("no website drags it down", () => {
    const withSite = estimateAffordability({ reviewCount: 60, hasWebsite: true });
    const without = estimateAffordability({ reviewCount: 60, hasWebsite: false });
    expect(without.monthlyBudget.high).toBeLessThan(withSite.monthlyBudget.high);
  });

  it("what the owner SAID about staff overrides the inference", () => {
    const said = estimateAffordability({ reviewCount: 400, officeStaffCount: "just me" });
    expect(said.band).toBe("solo");
    expect(said.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("NO REVIEW COUNT MEANS NO ESTIMATE, not a confident guess", () => {
    const none = estimateAffordability({ industry: "plumbing" });
    expect(none.confidence).toBe(0);
    expect(none.guidance).toMatch(/not enough to size/i);
  });

  it("always a band, never a single figure", () => {
    const a = estimateAffordability({ reviewCount: 100 });
    expect(a.monthlyBudget.low).toBeLessThan(a.monthlyBudget.high);
    expect(a.signals.length).toBeGreaterThan(0);
  });

  it("high-ticket and low-ticket trades are not the same at the same volume", () => {
    const roofing = estimateAffordability({ industry: "roofing", reviewCount: 60 });
    const cleaning = estimateAffordability({ industry: "cleaning", reviewCount: 60 });
    expect(roofing.monthlyBudget.high).toBeGreaterThan(cleaning.monthlyBudget.high);
  });

  it("every band has readable guidance", () => {
    for (const reviews of [5, 40, 150, 900]) {
      const a = estimateAffordability({ reviewCount: reviews });
      expect(SIZE_LABEL[a.band]).toBeTruthy();
      expect(a.guidance.length).toBeGreaterThan(30);
    }
  });
});

describe("THE SIZE ESTIMATE NEVER REACHES THE OWNER", () => {
  const input = {
    businessName: "Ace Plumbing",
    reviewCount: 400,
    rating: 4.8,
    website: "https://ace.com",
    findings: topFindings(diagnose({ ...base, reviewCount: 400, mapRank: 19 })).map((f) => ({
      key: f.key,
      headline: f.headline,
      detail: f.detail,
      basis: f.basis,
    })),
  };

  /** Everything a prospect could actually read. */
  const ownerFacing = () =>
    [
      ...computeGaps(input).map((g) => `${g.headline} ${g.detail}`),
      ...buildRecommendations(input).map((r) => `${r.title} ${r.detail}`),
      composePersonalization(input),
      ...Object.values(composeVariables(input)),
    ].join(" \n ");

  it("no dollar figure appears anywhere on the owner's page or in the email", () => {
    const text = ownerFacing();
    expect(text).not.toMatch(/[$£€]\s?\d/);
    expect(text).not.toMatch(/\b\d[\d,]{2,}\s*(?:a month|per month|dollars)\b/i);
  });

  it("no size band or budget word leaks into owner-facing copy", () => {
    const text = ownerFacing().toLowerCase();
    for (const word of ["owner-operator", "regional", "budget", "afford", "revenue", "one-off ceiling"]) {
      expect(text, word).not.toContain(word);
    }
  });

  it("the talk track — which DOES carry the internal read — is not on the page", () => {
    const tracks = topFindings(diagnose({ ...base, mapRank: 2, reviewCount: 90 })).map((f) => f.talkTrack);
    const text = ownerFacing();
    for (const t of tracks) expect(text).not.toContain(t);
  });
});

/* -------------------------------------------------------------------------- */
/* the scripts                                                                */
/* -------------------------------------------------------------------------- */

describe("THE SCRIPT IS ASSIGNED, NOT CHOSEN", () => {
  const ids = Array.from({ length: 4000 }, (_, i) => `1f2e3d4c-0000-4000-8000-${String(i).padStart(12, "0")}`);

  it("the same lead always gets the same opener", () => {
    const id = ids[7];
    expect(assignScript(id)).toBe(assignScript(id));
  });

  it("different leads get different openers", () => {
    const seen = new Set(ids.slice(0, 200).map((id) => assignScript(id)));
    expect(seen.size).toBe(SCRIPT_VERSIONS.length);
  });

  it("THE ARMS STAY EVEN — no variant gets a fifth more than another", () => {
    // A skewed split silently weakens every comparison drawn from it, and
    // sequential UUIDs are exactly the input a weak hash mishandles.
    const spread = assignmentSpread(ids);
    const counts = Object.values(spread);
    const expected = ids.length / SCRIPT_VERSIONS.length;
    for (const [version, n] of Object.entries(spread)) {
      expect(Math.abs(n - expected) / expected, version).toBeLessThan(0.2);
    }
    expect(counts.reduce((a, b) => a + b, 0)).toBe(ids.length);
  });

  it("a salt reshuffles everybody", () => {
    const before = ids.slice(0, 300).map((id) => assignScript(id));
    const after = ids.slice(0, 300).map((id) => assignScript(id, "v2"));
    const same = before.filter((v, i) => v === after[i]).length;
    // Roughly 1/N would match by chance; nowhere near all of them.
    expect(same).toBeLessThan(300 * 0.35);
  });

  it("the hash is ORDER-SENSITIVE, so ids that share characters do not collide", () => {
    // The property a naive summing hash does not have. UUIDs are drawn from a
    // tiny alphabet and differ mostly by arrangement, so a hash that only adds
    // character codes maps whole families of ids to the same arm.
    expect(hashString("ab")).not.toBe(hashString("ba"));
    expect(hashString("1f2e3d")).not.toBe(hashString("3d2e1f"));

    const permutations = ["abcd", "abdc", "acbd", "acdb", "adbc", "adcb", "bacd", "badc"];
    expect(new Set(permutations.map(hashString)).size).toBe(permutations.length);
  });

  it("and spreads adjacent inputs", () => {
    expect(hashString("a")).not.toBe(hashString("b"));
    expect(hashString("lead-1") % 7).not.toBe(hashString("lead-2") % 7);
  });
});

describe("more than three variants", () => {
  it("there are more than three, and every one is named and distinct", () => {
    expect(SCRIPT_VERSIONS.length).toBeGreaterThan(3);
    const openers = SCRIPT_VERSIONS.map(
      (v) => buildScript(v, { businessName: "Ace Plumbing", city: "Dallas", callerName: "Sam" }).opener
    );
    expect(new Set(openers).size).toBe(SCRIPT_VERSIONS.length);
    for (const v of SCRIPT_VERSIONS) expect(SCRIPT_NAME[v]).toBeTruthy();
  });

  it("each one states the single thing it is testing", () => {
    for (const v of SCRIPT_VERSIONS) {
      const s = buildScript(v, { businessName: "Ace" });
      expect(s.premise.length, v).toBeGreaterThan(20);
      expect(s.ifPushed.length, v).toBeGreaterThan(20);
    }
  });

  it("the specific-hook script uses the diagnosis when there is one", () => {
    const withHook = buildScript("C", {
      businessName: "Ace Plumbing",
      hook: "You come up 19th for plumbers in Dallas",
    });
    expect(withHook.opener).toContain("19th");
  });

  it("and never invents a review count when there is none", () => {
    const bare = buildScript("C", { businessName: "Ace Plumbing", reviewCount: null });
    expect(bare.opener).not.toMatch(/\d+ reviews/);
  });

  it("no script guesses the owner's gender", () => {
    for (const v of SCRIPT_VERSIONS) {
      const s = buildScript(v, { businessName: "Ace", ownerName: "Alex Rivera", city: "Dallas" });
      expect(`${s.opener} ${s.ifPushed}`, v).not.toMatch(/\b(?:he|she|him|her|his|hers)\b/i);
    }
  });

  it("drops the city cleanly when there is none", () => {
    const s = buildScript("E", { businessName: "Ace", city: null });
    expect(s.opener).not.toMatch(/undefined|null|in \s/);
  });
});
