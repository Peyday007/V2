// Fast deterministic qualification. No network calls, no LLM, no crawling.

export type QualifyRules = {
  min_rating: number | null;
  min_review_count: number | null;
  max_review_count: number | null;
  require_website: boolean;
  exclude_franchises: boolean;
};

export type QualifyInput = {
  business_name: string | null;
  phone: string | null;
  normalized_phone: string | null;
  website: string | null;
  rating: number | null;
  review_count: number | null;
  business_status: string | null;
  do_not_call?: boolean;
  archived_at?: string | null;
};

export type QualifyResult = { passed: true } | { passed: false; reason: string };

/**
 * Well-known national/regional chains in home services. Matched on word
 * boundaries against the normalized name so "Roofing by Owens" is not
 * mistaken for the manufacturer.
 */
const FRANCHISE_MARKERS = [
  "home depot", "lowes", "sears", "1-800", "1 800",
  "mr handyman", "mr rooter", "roto rooter", "roto-rooter",
  "servpro", "servicemaster", "restoration 1", "paul davis",
  "aire serv", "one hour heating", "benjamin franklin plumbing",
  "mister sparky", "five star bath", "bath fitter", "re-bath", "rebath",
  "leaffilter", "leaf filter", "leafguard", "gutter helmet",
  "renewal by andersen", "champion windows", "window world",
  "power home remodeling", "erie home", "west shore home",
  "sears home", "ace hardware", "true value", "menards",
];

export function looksLikeFranchise(businessName: string | null): boolean {
  if (!businessName) return false;
  const name = businessName.toLowerCase().replace(/[^a-z0-9\s-]/g, " ");
  return FRANCHISE_MARKERS.some((marker) => name.includes(marker));
}

export function qualifyBusiness(
  input: QualifyInput,
  rules: QualifyRules
): QualifyResult {
  if (!input.business_name || !input.business_name.trim()) {
    return { passed: false, reason: "missing business name" };
  }
  if (!input.normalized_phone) {
    return { passed: false, reason: "no usable main phone" };
  }
  if (input.business_status && input.business_status !== "OPERATIONAL") {
    return {
      passed: false,
      reason: `not operational (${input.business_status.toLowerCase()})`,
    };
  }
  if (input.archived_at) {
    return { passed: false, reason: "archived" };
  }
  if (input.do_not_call) {
    return { passed: false, reason: "on do-not-call suppression list" };
  }
  if (rules.require_website && !input.website) {
    return { passed: false, reason: "no website (required by campaign)" };
  }
  if (rules.min_rating != null) {
    if (input.rating == null) {
      return { passed: false, reason: "no rating (minimum required)" };
    }
    if (input.rating < rules.min_rating) {
      return {
        passed: false,
        reason: `rating ${input.rating} below minimum ${rules.min_rating}`,
      };
    }
  }
  const reviews = input.review_count ?? 0;
  if (rules.min_review_count != null && reviews < rules.min_review_count) {
    return {
      passed: false,
      reason: `${reviews} reviews below minimum ${rules.min_review_count}`,
    };
  }
  if (rules.max_review_count != null && reviews > rules.max_review_count) {
    return {
      passed: false,
      reason: `${reviews} reviews above maximum ${rules.max_review_count}`,
    };
  }
  if (rules.exclude_franchises && looksLikeFranchise(input.business_name)) {
    return { passed: false, reason: "looks like a franchise/big-box chain" };
  }
  return { passed: true };
}
