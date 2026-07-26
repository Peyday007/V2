import "server-only";
import { crawlSite } from "../crawler";
import { extractPeople, discoverPeoplePages, CANDIDATE_PATHS } from "../extractPeople";
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
    }
    return { findings };
  },
};
