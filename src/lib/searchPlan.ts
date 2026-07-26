// Pure planning logic: turn a campaign config into the list of search
// combinations to run. No I/O, fully unit-testable.

export type CampaignPlanInput = {
  search_terms: string[] | null;
  industry: string | null;
  city: string | null;
  state: string | null;
  zips: string[] | null;
  /** Explicit multi-metro targeting, e.g. ["Detroit, MI", "Dallas, TX"]. */
  locations?: string[] | null;
};

export type PlannedSearch = { search_term: string; location: string };

/**
 * Build the keyword x location grid.
 * Locations come from ZIPs when supplied (most granular), otherwise city+state,
 * otherwise state alone. Terms fall back to the industry when none are given.
 */
export function planSearches(campaign: CampaignPlanInput): PlannedSearch[] {
  const terms = (campaign.search_terms || [])
    .map((t) => t.trim())
    .filter(Boolean);
  if (terms.length === 0 && campaign.industry) terms.push(campaign.industry.trim());

  const locations: string[] = [];
  const explicit = (campaign.locations || []).map((l) => l.trim()).filter(Boolean);
  const zips = (campaign.zips || []).map((z) => z.trim()).filter(Boolean);
  if (explicit.length > 0) {
    locations.push(...explicit);
  } else if (zips.length > 0) {
    for (const zip of zips) {
      locations.push(campaign.state ? `${zip} ${campaign.state}` : zip);
    }
  } else if (campaign.city) {
    locations.push(
      campaign.state ? `${campaign.city}, ${campaign.state}` : campaign.city
    );
  } else if (campaign.state) {
    locations.push(campaign.state);
  }

  const out: PlannedSearch[] = [];
  const seen = new Set<string>();
  for (const search_term of terms) {
    for (const location of locations) {
      const key = `${search_term.toLowerCase()}|${location.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ search_term, location });
    }
  }
  return out;
}

export function textQueryFor(search: PlannedSearch): string {
  return `${search.search_term} in ${search.location}`;
}
