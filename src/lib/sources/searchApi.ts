import "server-only";
import { extractPeople } from "../extractPeople";
import type { EnrichmentSource, SourceFinding } from "./types";

// Public web search for owner names. Supports Brave Search or Google
// Programmable Search; both have free tiers. Disabled until a key is set.
//
//   SEARCH_API_PROVIDER = brave | google      (default: brave)
//   SEARCH_API_KEY      = <key>
//   GOOGLE_CSE_ID       = <cx>                (google only)

type SearchHit = { title: string; snippet: string; url: string };

function provider(): "brave" | "google" {
  return process.env.SEARCH_API_PROVIDER === "google" ? "google" : "brave";
}

async function braveSearch(query: string): Promise<SearchHit[]> {
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
    {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": process.env.SEARCH_API_KEY || "",
      },
      signal: AbortSignal.timeout(8000),
    }
  );
  if (!res.ok) throw new Error(`Brave search ${res.status}`);
  const json = (await res.json()) as {
    web?: { results?: { title?: string; description?: string; url?: string }[] };
  };
  return (json.web?.results || []).map((r) => ({
    title: r.title || "",
    snippet: r.description || "",
    url: r.url || "",
  }));
}

async function googleSearch(query: string): Promise<SearchHit[]> {
  const cx = process.env.GOOGLE_CSE_ID;
  const res = await fetch(
    `https://www.googleapis.com/customsearch/v1?key=${process.env.SEARCH_API_KEY}&cx=${cx}&q=${encodeURIComponent(query)}&num=5`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) throw new Error(`Google CSE ${res.status}`);
  const json = (await res.json()) as {
    items?: { title?: string; snippet?: string; link?: string }[];
  };
  return (json.items || []).map((r) => ({
    title: r.title || "",
    snippet: r.snippet || "",
    url: r.link || "",
  }));
}

/** Only accept a hit that actually refers to this business. */
function hitIsRelevant(
  hit: SearchHit,
  businessName: string,
  domain: string | null,
  city: string | null
): boolean {
  const haystack = `${hit.title} ${hit.snippet} ${hit.url}`.toLowerCase();
  if (domain && haystack.includes(domain.toLowerCase())) return true;

  // Require a meaningful chunk of the business name, not one generic word.
  const words = businessName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !["home", "services", "service", "company"].includes(w));
  const matched = words.filter((w) => haystack.includes(w)).length;
  if (words.length > 0 && matched / words.length < 0.5) return false;

  if (city && !haystack.includes(city.toLowerCase())) {
    // City missing is tolerable only when the domain matched, handled above.
    return matched === words.length && words.length >= 2;
  }
  return true;
}

export const searchApiSource: EnrichmentSource = {
  key: "search_api",
  label: "Web search",
  order: 30,
  isAvailable: () =>
    !!process.env.SEARCH_API_KEY &&
    (provider() === "brave" || !!process.env.GOOGLE_CSE_ID),

  async run(ctx) {
    if (!this.isAvailable()) {
      return { findings: [], skipped: "SEARCH_API_KEY not configured" };
    }

    const queries = [
      `"${ctx.businessName}" owner`,
      `"${ctx.businessName}" ${ctx.city || ""} president OR founder`.trim(),
    ];

    const findings: SourceFinding[] = [];
    const search = provider() === "google" ? googleSearch : braveSearch;

    for (const q of queries) {
      let hits: SearchHit[];
      try {
        hits = await search(q);
      } catch (e) {
        return {
          findings,
          skipped: e instanceof Error ? e.message : "search failed",
        };
      }

      for (const hit of hits) {
        if (!hitIsRelevant(hit, ctx.businessName, ctx.domain, ctx.city)) continue;
        // Reuse the same tested extraction rules on the snippet text.
        for (const c of extractPeople(
          `${hit.title}. ${hit.snippet}`,
          ctx.businessName
        )) {
          findings.push({
            name: c.name,
            title: c.title,
            sourceUrl: hit.url,
            supportingText: `search result: "${c.supportingText}"`,
            method: `search_${c.method}`,
            // A search snippet is weaker evidence than the company's own site.
            confidence: Math.min(0.75, c.confidence - 0.1),
          });
        }
      }
      if (findings.some((f) => f.confidence >= 0.7)) break;
    }

    return { findings };
  },
};
