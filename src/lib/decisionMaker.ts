// Who counts as the decision-maker, and how sure we are.
//
// These are owner-operated home-service businesses, so the hierarchy is short
// and the owner is nearly always the person who can say yes. The ranking below
// is the priority order the pipeline searches for and the order a conflict is
// resolved in.
//
// The rule that matters most: a person is never asserted without evidence. A
// title scraped from a page that does not name the business, a "team" page
// listing twelve people with no roles, a directory entry with no date — none
// of those produce a decision-maker. An unidentified lead is a D and stays out
// of the calling queue, which is a better outcome than a caller asking for
// somebody who does not work there.

/* -------------------------------------------------------------------------- */
/* the hierarchy                                                              */
/* -------------------------------------------------------------------------- */

export const DM_ROLES = [
  "owner",
  "founder",
  "co_owner",
  "managing_partner",
  "president",
  "general_manager",
  "operations_manager",
  "office_manager",
  "unknown",
] as const;

export type DmRole = (typeof DM_ROLES)[number];

/** Lower is better. The search order, and the tie-break when two are found. */
export const DM_ROLE_RANK: Record<DmRole, number> = {
  owner: 1,
  founder: 2,
  co_owner: 3,
  managing_partner: 4,
  president: 5,
  general_manager: 6,
  operations_manager: 7,
  office_manager: 8,
  unknown: 9,
};

export const DM_ROLE_LABEL: Record<DmRole, string> = {
  owner: "Owner",
  founder: "Founder",
  co_owner: "Co-owner",
  managing_partner: "Managing partner",
  president: "President",
  general_manager: "General manager",
  operations_manager: "Operations manager",
  office_manager: "Office manager",
  unknown: "Unknown role",
};

/**
 * Ordered longest-phrase-first so "general manager" is not swallowed by
 * "manager", and "co-owner" is not read as "owner".
 */
const TITLE_PATTERNS: [RegExp, DmRole][] = [
  [/\bco[-\s]?owner\b/i, "co_owner"],
  [/\bco[-\s]?founder\b/i, "founder"],
  [/\bmanaging (?:partner|member|director)\b/i, "managing_partner"],
  [/\bgeneral manager\b|\bgm\b/i, "general_manager"],
  [/\boperations manager\b|\bops manager\b/i, "operations_manager"],
  [/\b(?:office|practice) manager\b/i, "office_manager"],
  [/\bowner\b|\bproprietor\b/i, "owner"],
  [/\bfounder\b/i, "founder"],
  [/\bpresident\b/i, "president"],
  [/\b(?:ceo|chief executive)\b/i, "president"],
];

export function roleFromTitle(title: string | null | undefined): DmRole {
  const t = (title || "").trim();
  if (!t) return "unknown";
  for (const [pattern, role] of TITLE_PATTERNS) {
    if (pattern.test(t)) return role;
  }
  return "unknown";
}

/** Search terms, in the priority order the brief asks for. */
export const DM_SEARCH_TERMS = [
  "owner",
  "founder",
  "co-founder",
  "co-owner",
  "managing partner",
  "president",
  "general manager",
  "practice manager",
];

/* -------------------------------------------------------------------------- */
/* is this actually the person, at this business                              */
/* -------------------------------------------------------------------------- */

export type Candidate = {
  name: string;
  title: string | null;
  sourceUrl: string | null;
  supportingText: string;
  /** How the claim was extracted — used to weight it. */
  method: string;
  confidence: number;
};

export type MatchContext = {
  businessName: string;
  domain: string | null;
  city: string | null;
  state: string | null;
};

/** A name that is obviously not a person. */
const NOT_A_PERSON =
  /\b(inc|llc|ltd|corp|company|services|plumbing|heating|roofing|electric|hvac|team|staff|department|support|info|contact|admin|sales)\b/i;

export function looksLikePersonName(name: string | null | undefined): boolean {
  const n = (name || "").trim();
  if (n.length < 4 || n.length > 60) return false;
  if (NOT_A_PERSON.test(n)) return false;
  const parts = n.split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return false;
  // Each part starts with a capital and contains no digits.
  return parts.every((p) => /^[A-Z][A-Za-z'’.-]*$/.test(p));
}

export function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts[parts.length - 1] };
}

/**
 * How strongly the evidence ties this person to THIS business.
 *
 * Multiple signals, because any one of them produces false matches: a name on
 * a page that merely mentions the trade, a directory listing for a different
 * branch, a namesake in the same city.
 */
export type MatchAssessment = {
  /** 0-1. Multiplies the source's own confidence. */
  strength: number;
  signals: string[];
  missing: string[];
  /** True when the evidence is too thin or too contradictory to use. */
  ambiguous: boolean;
};

export function assessMatch(
  candidate: Candidate,
  ctx: MatchContext,
  allCandidates: Candidate[] = []
): MatchAssessment {
  const signals: string[] = [];
  const missing: string[] = [];
  const text = `${candidate.supportingText} ${candidate.sourceUrl ?? ""}`.toLowerCase();

  // The strongest signal available without paying: the claim came from a page
  // on the business's own domain.
  if (ctx.domain && candidate.sourceUrl?.toLowerCase().includes(ctx.domain.toLowerCase())) {
    signals.push("on the business's own domain");
  } else {
    missing.push("not on the business's own website");
  }

  const nameWords = ctx.businessName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !/^(the|and|inc|llc|ltd|corp)$/.test(w));
  if (nameWords.length > 0 && nameWords.some((w) => text.includes(w))) {
    signals.push("business name appears in the evidence");
  } else {
    missing.push("business name not in the evidence");
  }

  if (ctx.city && text.includes(ctx.city.toLowerCase())) signals.push("city matches");
  if (ctx.state && new RegExp(`\\b${ctx.state}\\b`, "i").test(text)) signals.push("state matches");

  const role = roleFromTitle(candidate.title);
  if (role !== "unknown") signals.push(`title is ${DM_ROLE_LABEL[role].toLowerCase()}`);
  else missing.push("no decision-making title");

  if (!looksLikePersonName(candidate.name)) {
    return {
      strength: 0,
      signals,
      missing: [...missing, "the name does not look like a person"],
      ambiguous: true,
    };
  }

  // Two different people claimed as the decision-maker, both weakly evidenced.
  const rivals = allCandidates.filter(
    (c) => c.name.toLowerCase() !== candidate.name.toLowerCase() && c.confidence >= 0.5
  );
  const contested = rivals.length > 0 && candidate.confidence < 0.8;
  if (contested) missing.push(`${rivals.length} other name(s) claimed for this business`);

  const strength = Math.min(1, signals.length / 4);
  // Two independent signals is the floor. One is a coincidence.
  const ambiguous = signals.length < 2 || contested;

  return { strength, signals, missing, ambiguous };
}

/**
 * Pick the decision-maker from everything the sources returned, or refuse.
 *
 * Refusing is a real outcome and a common one. A lead with no identified
 * decision-maker is graded D and kept out of the direct-call queue, which is
 * the entire point.
 */
export type Selection =
  | {
      chosen: true;
      name: string;
      firstName: string;
      lastName: string;
      title: string | null;
      role: DmRole;
      confidence: number;
      sourceUrl: string | null;
      evidence: string;
      signals: string[];
    }
  | { chosen: false; reason: string; considered: number };

/** Below this, a decision-maker is not asserted at all. */
export const MIN_DM_CONFIDENCE = 0.5;

export function selectDecisionMaker(
  candidates: Candidate[],
  ctx: MatchContext
): Selection {
  if (candidates.length === 0) {
    return { chosen: false, reason: "No decision-maker found in any source.", considered: 0 };
  }

  const scored = candidates
    .map((c) => {
      const match = assessMatch(c, ctx, candidates);
      const role = roleFromTitle(c.title);
      // Evidence strength multiplies the source's own confidence rather than
      // replacing it: a strong source with weak ties is still weak.
      const confidence = Math.min(0.98, c.confidence * (0.5 + match.strength * 0.5));
      return { c, match, role, confidence };
    })
    .filter((s) => !s.match.ambiguous)
    .sort(
      (a, b) =>
        DM_ROLE_RANK[a.role] - DM_ROLE_RANK[b.role] || b.confidence - a.confidence
    );

  if (scored.length === 0) {
    return {
      chosen: false,
      reason:
        "Names were found but none could be tied to this business with two independent signals.",
      considered: candidates.length,
    };
  }

  const best = scored[0];
  if (best.confidence < MIN_DM_CONFIDENCE) {
    return {
      chosen: false,
      reason: `Best candidate scored ${best.confidence.toFixed(2)}, below the ${MIN_DM_CONFIDENCE} floor.`,
      considered: candidates.length,
    };
  }

  const { first, last } = splitName(best.c.name);
  return {
    chosen: true,
    name: best.c.name,
    firstName: first,
    lastName: last,
    title: best.c.title,
    role: best.role,
    confidence: best.confidence,
    sourceUrl: best.c.sourceUrl,
    evidence: best.c.supportingText,
    signals: best.match.signals,
  };
}
