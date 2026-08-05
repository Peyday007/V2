// Finding an email address on a business's own website.
//
// Written against the shapes real trade websites actually use. The tests that
// matter most are the negative ones: this reads pages nobody controls, and the
// cost of a wrong address is a bounce, which is what gets a sending domain
// blocked.

import { describe, it, expect } from "vitest";
import {
  extractEmails,
  bestEmail,
  classifyLocalPart,
  matchesOwnerName,
  isPlausibleEmail,
  deobfuscate,
  rootDomain,
  MIN_STORE_CONFIDENCE,
} from "../src/lib/extractEmails";

const page = (body: string) => `<html><body>${body}</body></html>`;
const opts = { pageUrl: "https://acehvac.com/contact", websiteDomain: "acehvac.com" };

describe("reading an address off a page", () => {
  it("finds a mailto link", () => {
    const found = extractEmails(
      page('<a href="mailto:info@acehvac.com">Email us</a>'),
      opts
    );
    expect(found[0].email).toBe("info@acehvac.com");
    expect(found[0].kind).toBe("role");
    expect(found[0].onDomain).toBe(true);
  });

  it("finds one written in the body text", () => {
    const found = extractEmails(page("<p>Reach us at office@acehvac.com any time.</p>"), opts);
    expect(found[0].email).toBe("office@acehvac.com");
  });

  it("scores a mailto above the same address in loose text", () => {
    const linked = extractEmails(page('<a href="mailto:sam@acehvac.com">x</a>'), opts)[0];
    const loose = extractEmails(page("<p>sam@acehvac.com</p>"), opts)[0];
    expect(linked.confidence).toBeGreaterThan(loose.confidence);
  });

  it("lower-cases and strips trailing punctuation", () => {
    const found = extractEmails(page("<p>Write to Info@AceHVAC.com.</p>"), opts);
    expect(found[0].email).toBe("info@acehvac.com");
  });

  it("keeps the URL and the surrounding words, so a claim can be checked", () => {
    const found = extractEmails(
      page("<p>Maria handles all bookings — maria@acehvac.com — call or write.</p>"),
      { ...opts, ownerName: "Maria Rivera" }
    );
    expect(found[0].sourceUrl).toBe("https://acehvac.com/contact");
    expect(found[0].supportingText).toContain("bookings");
  });

  it("does not return the same address twice", () => {
    const found = extractEmails(
      page('<a href="mailto:info@acehvac.com">x</a><p>or info@acehvac.com</p>'),
      opts
    );
    expect(found.length).toBe(1);
  });

  it("reads an obfuscated address the way a person would", () => {
    expect(deobfuscate("sam (at) acehvac (dot) com")).toBe("sam@acehvac.com");
    expect(deobfuscate("sam [at] acehvac [dot] com")).toBe("sam@acehvac.com");
    const found = extractEmails(page("<p>sam (at) acehvac (dot) com</p>"), opts);
    expect(found[0]?.email).toBe("sam@acehvac.com");
  });
});

describe("what must NEVER be returned", () => {
  it("NEVER CONSTRUCTS AN ADDRESS THAT IS NOT ON THE PAGE", () => {
    // The whole rule of this module. A page naming the owner and showing no
    // address yields nothing — firstname@domain is a guess, and a guessed
    // contact detail is fabricated data.
    const found = extractEmails(
      page("<h2>Maria Rivera, Owner</h2><p>Call us on (214) 555-1212.</p>"),
      { ...opts, ownerName: "Maria Rivera" }
    );
    expect(found).toEqual([]);
    expect(bestEmail(found)).toBeNull();
  });

  it("does not return the web designer's address in the footer", () => {
    const found = extractEmails(
      page('<footer>Site by <a href="mailto:support@wixpress.com">Wix</a></footer>'),
      opts
    );
    expect(found).toEqual([]);
  });

  it("skips every platform and widget vendor", () => {
    for (const vendor of [
      "help@podium.com",
      "support@housecallpro.com",
      "noreply@mailchimp.com",
      "team@birdeye.com",
      "hello@servicetitan.com",
    ]) {
      expect(extractEmails(page(`<p>${vendor}</p>`), opts), vendor).toEqual([]);
    }
  });

  it("skips no-reply and abuse boxes", () => {
    for (const junk of [
      "noreply@acehvac.com",
      "no-reply@acehvac.com",
      "postmaster@acehvac.com",
      "unsubscribe@acehvac.com",
      "privacy@acehvac.com",
    ]) {
      expect(isPlausibleEmail(junk), junk).toBe(false);
    }
  });

  it("is not fooled by things that merely contain an @", () => {
    for (const notAnEmail of ["logo@2x.png", "hero@3x.jpg", "react@18.2.0", "sam@192.168.1.1"]) {
      expect(isPlausibleEmail(notAnEmail), notAnEmail).toBe(false);
    }
    const found = extractEmails(
      page('<img src="logo@2x.png"><script>import "react@18.2.0"</script>'),
      opts
    );
    expect(found).toEqual([]);
  });

  it("ignores markup inside script and style blocks", () => {
    const found = extractEmails(
      page("<style>@media screen{}</style><script>var a='x@y.z'</script><p>info@acehvac.com</p>"),
      opts
    );
    expect(found.map((f) => f.email)).toEqual(["info@acehvac.com"]);
  });
});

describe("ranking", () => {
  it("a named person's address beats the office one", () => {
    const found = extractEmails(
      page(
        '<a href="mailto:info@acehvac.com">office</a><a href="mailto:maria@acehvac.com">Maria</a>'
      ),
      { ...opts, ownerName: "Maria Rivera" }
    );
    expect(bestEmail(found)!.email).toBe("maria@acehvac.com");
    expect(bestEmail(found)!.kind).toBe("personal");
  });

  it("an off-domain address is kept but scored down", () => {
    // A one-van operation with a .com site and a gmail inbox is extremely
    // common, and that gmail is the real one. Dropping it would be wrong.
    const found = extractEmails(page('<a href="mailto:acehvacdallas@gmail.com">x</a>'), opts);
    expect(found.length).toBe(1);
    expect(found[0].onDomain).toBe(false);
    const onDomain = extractEmails(page('<a href="mailto:info@acehvac.com">x</a>'), opts)[0];
    expect(onDomain.confidence).toBeGreaterThan(found[0].confidence);
  });

  it("returns null rather than settling for something weak", () => {
    // "None" is a good answer. "Probably" is a bounce.
    const weak = extractEmails(page("<p>somebody@randomsite.example.org</p>"), opts);
    for (const c of weak) expect(c.confidence).toBeLessThan(MIN_STORE_CONFIDENCE);
    expect(bestEmail(weak)).toBeNull();
  });
});

describe("classifying the local part", () => {
  it("knows a role account", () => {
    for (const role of ["info", "contact", "office", "bookings", "dispatch", "sales"]) {
      expect(classifyLocalPart(role), role).toBe("role");
    }
  });

  it("knows a person", () => {
    for (const person of ["sam", "maria", "sam.rivera", "m-rivera"]) {
      expect(classifyLocalPart(person), person).toBe("personal");
    }
  });

  it("treats anything with digits as generic", () => {
    expect(classifyLocalPart("ace2024")).toBe("generic");
  });
});

describe("matching an address to a name we already hold", () => {
  it("matches the usual shapes", () => {
    for (const local of ["maria", "rivera", "mariarivera", "mrivera", "m.rivera", "maria.rivera"]) {
      expect(matchesOwnerName(local, "Maria Rivera"), local).toBe(true);
    }
  });

  it("does not match somebody else", () => {
    expect(matchesOwnerName("dave", "Maria Rivera")).toBe(false);
    expect(matchesOwnerName("info", "Maria Rivera")).toBe(false);
  });

  it("with no name on record, matches nothing", () => {
    expect(matchesOwnerName("maria", null)).toBe(false);
    expect(matchesOwnerName("maria", "")).toBe(false);
  });
});

describe("domains", () => {
  it("strips www and the scheme", () => {
    expect(rootDomain("https://www.acehvac.com/contact")).toBe("acehvac.com");
  });

  it("handles a subdomain", () => {
    expect(rootDomain("mail.acehvac.com")).toBe("acehvac.com");
  });

  it("handles co.uk without a public-suffix list", () => {
    expect(rootDomain("www.ace-plumbing.co.uk")).toBe("ace-plumbing.co.uk");
  });
});

/* -------------------------------------------------------------------------- */
/* the scoring bug that discarded owners' addresses                           */
/* -------------------------------------------------------------------------- */

/*
 * Confidence used to give role accounts +0.05 and personal ones nothing.
 * Off-domain starts at 0.4, a mailto added 0.15, the store floor is 0.6 — so
 * info@gmail.com landed on exactly 0.60 and survived while sam@gmail.com on
 * the same page landed on 0.55 and was thrown away. That 0.05 discarded the
 * owner's real inbox at exactly the businesses this sells to best.
 */
describe("A DELIBERATELY PUBLISHED ADDRESS IS NEVER DISCARDED FOR BEING PERSONAL", () => {
  const site = "acmeplumbing.com";
  const at = (html: string) =>
    extractEmails(html, { pageUrl: `https://${site}/contact`, websiteDomain: site, ownerName: null });

  it("keeps the owner's gmail when it is published in a mailto:", () => {
    const c = at(`<a href="mailto:sam@gmail.com">Email Sam</a>`);
    expect(bestEmail(c)?.email).toBe("sam@gmail.com");
  });

  it("does not favour a generic address over a personal one on the same page", () => {
    const c = at(
      `<a href="mailto:info@gmail.com">Us</a><a href="mailto:sam@gmail.com">Sam</a>`
    );
    const personal = c.find((x) => x.email === "sam@gmail.com")!;
    const role = c.find((x) => x.email === "info@gmail.com")!;
    // Equal reachability — confidence answers "does this reach the business",
    // never "who does it reach".
    expect(personal.confidence).toBe(role.confidence);
    // The preference lives in the ranking, where it can be argued with.
    expect(bestEmail(c)?.email).toBe("sam@gmail.com");
  });

  it("still refuses an off-domain address that was only loose body text", () => {
    // A bare address in a paragraph can be a customer's, quoted in a review.
    expect(bestEmail(at(`<p>write to sam@gmail.com</p>`))).toBeNull();
  });

  it("...unless it matches an owner we already identified", () => {
    const c = extractEmails(`<p>write to sam@gmail.com</p>`, {
      pageUrl: `https://${site}/contact`,
      websiteDomain: site,
      ownerName: "Sam Rivera",
    });
    expect(bestEmail(c)?.email).toBe("sam@gmail.com");
  });

  it("on-domain personal still beats on-domain generic", () => {
    const c = at(
      `<a href="mailto:info@${site}">Us</a><a href="mailto:sam@${site}">Sam</a>`
    );
    expect(bestEmail(c)?.email).toBe(`sam@${site}`);
    expect(bestEmail(c)?.kind).toBe("personal");
  });

  it("junk is still junk", () => {
    expect(bestEmail(at(`<a href="mailto:noreply@${site}">x</a>`))).toBeNull();
    expect(bestEmail(at(`<a href="mailto:support@wixpress.com">x</a>`))).toBeNull();
  });
});
