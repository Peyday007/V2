import "server-only";
import { crawlSite } from "../crawler";
import { extractPeople, discoverPeoplePages, CANDIDATE_PATHS } from "../extractPeople";
import { extractEmails, type EmailCandidate } from "../extractEmails";
import { readSite, type SiteSignals } from "../siteSignals";
import type { EnrichmentSource, SourceFinding } from "./types";

/** The company's own site: free, fast, and where owner names usually live. */
export const websiteSource: EnrichmentSource = {
  key: "website",
  label: "Business website",
  order: 20,
  isAvailable: () => true,

  async run(ctx) {
    if (!ctx.website) return { findings: [], skipped: "no website on record" };

    const { pages, blockedByRobots } = await crawlSite(ctx.website, {
      candidatePaths: CANDIDATE_PATHS,
      discover: discoverPeoplePages,
      maxPages: 5,
      stopWhen: (page) =>
        extractPeople(page.html, ctx.businessName).some((c) => c.confidence >= 0.85),
    });

    if (blockedByRobots) {
      return { findings: [], skipped: "site robots.txt disallows crawling" };
    }

    const findings: SourceFinding[] = [];
    const emails: EmailCandidate[] = [];
    for (const page of pages) {
      for (const c of extractPeople(page.html, ctx.businessName)) {
        findings.push({
          name: c.name,
          title: c.title,
          sourceUrl: page.url,
          supportingText: c.supportingText,
          method: c.method,
          confidence: c.confidence,
        });
      }
      /*
       * The address, off the page we already fetched.
       *
       * Free — this is the same crawl, not a second one. Worth stating why it
       * belongs here rather than in its own source: the contact page that
       * names the owner is nearly always the page that shows their email, so
       * doing it separately would mean fetching the same five pages twice.
       */
      emails.push(...extractEmails(page.html, { pageUrl: page.url, websiteDomain: ctx.domain || ctx.website }));
    }

    /*
     * What the site says about how they get work.
     *
     * Read from the same pages, for the same reason as the emails: the crawl
     * has already happened, and the diagnostic was previously reduced to
     * "missing calls" for every single business because nothing else was ever
     * collected.
     */
    const signals = readSite(pages);

    // The owner's name is only known after the findings are ranked, which
    // happens upstream — so re-scoring against it is left to the caller. What
    // is returned here is every address seen, with its evidence.
    return { findings, emails, signals };
  },
};
