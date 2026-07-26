// Deterministic extraction of decision-maker names and titles from a page.
// Pure string work so it can be unit-tested against real HTML. It NEVER
// guesses: every result carries the raw text it came from.

export type PersonCandidate = {
  name: string;
  title: string;
  method: "json_ld" | "labelled_title" | "narrative";
  supportingText: string;
  confidence: number;
};

/** Titles that indicate someone who can approve a purchase. */
const TITLES: { pattern: string; weight: number }[] = [
  { pattern: "owner", weight: 0.9 },
  { pattern: "co-owner", weight: 0.9 },
  { pattern: "founder", weight: 0.9 },
  { pattern: "co-founder", weight: 0.85 },
  { pattern: "president", weight: 0.85 },
  { pattern: "proprietor", weight: 0.85 },
  { pattern: "managing member", weight: 0.85 },
  { pattern: "principal", weight: 0.75 },
  { pattern: "ceo", weight: 0.8 },
  { pattern: "chief executive officer", weight: 0.8 },
  { pattern: "general manager", weight: 0.75 },
  { pattern: "operations manager", weight: 0.7 },
  { pattern: "office manager", weight: 0.7 },
  { pattern: "service manager", weight: 0.65 },
  { pattern: "vice president", weight: 0.6 },
];

const TITLE_ALTERNATION = TITLES.map((t) => t.pattern).join("|");

function titleWeight(title: string): number {
  const lower = title.toLowerCase();
  const hit = TITLES.find((t) => lower.includes(t.pattern));
  return hit ? hit.weight : 0.5;
}

/** Words that look like names to a regex but never are. */
const NAME_STOPWORDS = new Set([
  "free estimate", "contact us", "about us", "our team", "google reviews",
  "read more", "learn more", "get started", "call now", "book now",
  "privacy policy", "terms of service", "all rights", "united states",
  "customer service", "same day", "emergency service", "service area",
  "our story", "meet the", "the team", "home services", "air conditioning",
  "heating cooling", "water heater", "new york", "los angeles",
]);

const NAME_RE = "[A-Z][a-z'’-]{1,15}(?:\\s+[A-Z]\\.?)?\\s+[A-Z][a-zA-Z'’-]{1,20}";

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function plausibleName(name: string, businessName?: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 5 || trimmed.length > 40) return false;
  const lower = trimmed.toLowerCase();
  for (const stop of NAME_STOPWORDS) if (lower.includes(stop)) return false;
  // A "name" that is just the company name is not a person.
  if (businessName) {
    const bn = businessName.toLowerCase();
    if (bn.includes(lower) || lower.includes(bn.slice(0, 12))) return false;
  }
  // Reject ALL CAPS runs and words that are obviously not names.
  if (/\b(LLC|INC|CORP|HVAC|LTD)\b/i.test(trimmed)) return false;
  return /^[A-Z]/.test(trimmed) && trimmed.split(/\s+/).length >= 2;
}

/** schema.org JSON-LD is the most reliable source when a site publishes it. */
function fromJsonLd(html: string, businessName?: string): PersonCandidate[] {
  const out: PersonCandidate[] = [];
  const blocks = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const block of blocks) {
    let json: unknown;
    try {
      json = JSON.parse(block[1].trim());
    } catch {
      continue;
    }
    const nodes = Array.isArray(json) ? json : [json];
    for (const node of nodes) {
      const n = node as Record<string, unknown>;
      for (const key of ["founder", "employee", "owner", "member"]) {
        const val = n[key];
        const people = Array.isArray(val) ? val : val ? [val] : [];
        for (const p of people) {
          const person = p as Record<string, unknown>;
          const name = typeof person.name === "string" ? person.name : null;
          if (!name || !plausibleName(name, businessName)) continue;
          const title =
            (typeof person.jobTitle === "string" && person.jobTitle) ||
            (key === "founder" ? "Founder" : key === "owner" ? "Owner" : "Team member");
          out.push({
            name: name.trim(),
            title,
            method: "json_ld",
            supportingText: `schema.org ${key}: ${name} (${title})`,
            confidence: 0.9,
          });
        }
      }
    }
  }
  return out;
}

/** "John Smith, Owner" / "Owner: John Smith" / "Owner - John Smith" */
function fromLabelledTitles(text: string, businessName?: string): PersonCandidate[] {
  const out: PersonCandidate[] = [];

  const nameThenTitle = new RegExp(
    `(${NAME_RE})\\s*[,\\-–—]\\s*((?:${TITLE_ALTERNATION})[a-z ]{0,20})`,
    "gi"
  );
  for (const m of text.matchAll(nameThenTitle)) {
    if (!plausibleName(m[1], businessName)) continue;
    out.push({
      name: m[1].trim(),
      title: m[2].trim(),
      method: "labelled_title",
      supportingText: m[0].trim().slice(0, 200),
      confidence: titleWeight(m[2]),
    });
  }

  const titleThenName = new RegExp(
    `((?:${TITLE_ALTERNATION}))\\s*[:\\-–—]\\s*(${NAME_RE})`,
    "gi"
  );
  for (const m of text.matchAll(titleThenName)) {
    if (!plausibleName(m[2], businessName)) continue;
    out.push({
      name: m[2].trim(),
      title: m[1].trim(),
      method: "labelled_title",
      supportingText: m[0].trim().slice(0, 200),
      confidence: titleWeight(m[1]),
    });
  }

  return out;
}

/** "founded by John Smith" / "owned and operated by John Smith" */
function fromNarrative(text: string, businessName?: string): PersonCandidate[] {
  const out: PersonCandidate[] = [];
  const phrases: { re: RegExp; title: string; conf: number }[] = [
    {
      re: new RegExp(`founded (?:in \\d{4} )?by\\s+(${NAME_RE})`, "gi"),
      title: "Founder",
      conf: 0.8,
    },
    {
      re: new RegExp(`(?:owned and operated|owned) by\\s+(${NAME_RE})`, "gi"),
      title: "Owner",
      conf: 0.8,
    },
    {
      re: new RegExp(`started by\\s+(${NAME_RE})`, "gi"),
      title: "Founder",
      conf: 0.7,
    },
    {
      re: new RegExp(`(?:led|run|managed) by\\s+(${NAME_RE})`, "gi"),
      title: "Manager",
      conf: 0.6,
    },
  ];
  for (const { re, title, conf } of phrases) {
    for (const m of text.matchAll(re)) {
      if (!plausibleName(m[1], businessName)) continue;
      out.push({
        name: m[1].trim(),
        title,
        method: "narrative",
        supportingText: m[0].trim().slice(0, 200),
        confidence: conf,
      });
    }
  }
  return out;
}

/**
 * Extract decision-maker candidates from one page, best first.
 * Candidates with the same name are merged, keeping the strongest evidence.
 */
export function extractPeople(
  html: string,
  businessName?: string
): PersonCandidate[] {
  const text = stripHtml(html);
  const all = [
    ...fromJsonLd(html, businessName),
    ...fromLabelledTitles(text, businessName),
    ...fromNarrative(text, businessName),
  ];

  const byName = new Map<string, PersonCandidate>();
  for (const c of all) {
    const key = c.name.toLowerCase().replace(/\s+/g, " ");
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, c);
    } else if (c.confidence > existing.confidence) {
      // Keep the stronger claim but note that two sources agreed.
      byName.set(key, {
        ...c,
        confidence: Math.min(0.95, c.confidence + 0.05),
        supportingText: `${c.supportingText} | also: ${existing.supportingText}`,
      });
    } else if (existing.method !== c.method) {
      existing.confidence = Math.min(0.95, existing.confidence + 0.05);
    }
  }

  return [...byName.values()].sort((a, b) => b.confidence - a.confidence);
}

/** Relevant page paths to try, in priority order. */
export const CANDIDATE_PATHS = [
  "/about",
  "/about-us",
  "/our-team",
  "/team",
  "/staff",
  "/leadership",
  "/management",
  "/our-story",
  "/who-we-are",
  "/meet-the-team",
  "/contact",
  "/company",
];

/** Pull same-origin links from a homepage that look like people pages. */
export function discoverPeoplePages(html: string, origin: string): string[] {
  const found = new Set<string>();
  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi;
  const interesting =
    /(about|team|staff|leadership|management|our story|who we are|meet)/i;

  for (const m of html.matchAll(anchorRe)) {
    const href = m[1];
    const label = stripHtml(m[2]);
    if (!interesting.test(href) && !interesting.test(label)) continue;
    try {
      const url = new URL(href, origin);
      if (url.origin !== origin) continue;
      if (/\.(pdf|jpg|jpeg|png|gif|svg|zip|mp4)$/i.test(url.pathname)) continue;
      url.hash = "";
      found.add(url.toString());
    } catch {
      continue;
    }
  }
  return [...found].slice(0, 6);
}
