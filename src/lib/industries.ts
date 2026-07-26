// Home-service verticals that plausibly benefit from an AI receptionist:
// phone-driven, appointment-based, often missing calls while on a job.
//
// `askFor` is the role-based recommendation used when no named decision-maker
// has been found yet (Success Level C). `whyFit` is shown to the caller as
// the angle for that trade.

export type Industry = {
  key: string;
  label: string;
  searchTerms: string[];
  askFor: string;
  whyFit: string;
};

export const INDUSTRIES: Industry[] = [
  {
    key: "roofing",
    label: "Roofing",
    searchTerms: ["roofer", "roofing contractor", "roof repair", "commercial roofing"],
    askFor: "the owner",
    whyFit: "Storm-driven call spikes; crews are on roofs and miss the phone.",
  },
  {
    key: "hvac",
    label: "HVAC",
    searchTerms: ["hvac contractor", "air conditioning repair", "furnace repair", "heating and cooling"],
    askFor: "the owner or service manager",
    whyFit: "Emergency no-heat/no-AC calls; after-hours calls go unanswered.",
  },
  {
    key: "plumbing",
    label: "Plumbing",
    searchTerms: ["plumber", "plumbing contractor", "emergency plumber", "drain cleaning"],
    askFor: "the owner or dispatcher",
    whyFit: "Emergency work; the first company to answer usually wins the job.",
  },
  {
    key: "electrical",
    label: "Electrical",
    searchTerms: ["electrician", "electrical contractor", "emergency electrician"],
    askFor: "the owner or office manager",
    whyFit: "Licensed techs on site all day with nobody on the phone.",
  },
  {
    key: "garage_door",
    label: "Garage Doors",
    searchTerms: ["garage door repair", "garage door installation", "overhead door company"],
    askFor: "the owner",
    whyFit: "Same-day urgency; small teams with no dedicated phone staff.",
  },
  {
    key: "pest_control",
    label: "Pest Control",
    searchTerms: ["pest control", "exterminator", "termite control", "wildlife removal"],
    askFor: "the owner or office manager",
    whyFit: "High call volume, recurring contracts, heavy scheduling load.",
  },
  {
    key: "landscaping",
    label: "Landscaping & Lawn",
    searchTerms: ["landscaping company", "lawn care service", "landscaper", "lawn maintenance"],
    askFor: "the owner",
    whyFit: "Crews in the field; seasonal call surges nobody is there to take.",
  },
  {
    key: "tree_service",
    label: "Tree Service",
    searchTerms: ["tree service", "tree removal", "arborist", "stump grinding"],
    askFor: "the owner",
    whyFit: "Storm-driven emergency demand; owner-operators run the phone themselves.",
  },
  {
    key: "cleaning",
    label: "Cleaning Services",
    searchTerms: ["house cleaning service", "commercial cleaning", "maid service", "janitorial service"],
    askFor: "the owner or scheduling manager",
    whyFit: "Constant rescheduling and quote requests by phone.",
  },
  {
    key: "restoration",
    label: "Water / Fire Restoration",
    searchTerms: ["water damage restoration", "fire damage restoration", "mold remediation", "flood cleanup"],
    askFor: "the owner or operations manager",
    whyFit: "24/7 emergency intake; a missed call is a lost five-figure job.",
  },
  {
    key: "appliance_repair",
    label: "Appliance Repair",
    searchTerms: ["appliance repair", "refrigerator repair", "washer dryer repair"],
    askFor: "the owner",
    whyFit: "One or two techs, phone rings all day while they are on calls.",
  },
  {
    key: "locksmith",
    label: "Locksmith",
    searchTerms: ["locksmith", "emergency locksmith", "auto locksmith"],
    askFor: "the owner",
    whyFit: "Pure emergency intake; speed to answer decides the job.",
  },
  {
    key: "septic",
    label: "Septic & Sewer",
    searchTerms: ["septic service", "septic tank pumping", "sewer repair"],
    askFor: "the owner",
    whyFit: "Emergency backups; small crews with no office staff.",
  },
  {
    key: "chimney",
    label: "Chimney & Fireplace",
    searchTerms: ["chimney sweep", "chimney repair", "fireplace installation"],
    askFor: "the owner",
    whyFit: "Sharp seasonal spike where every missed call is a booked inspection.",
  },
  {
    key: "fencing",
    label: "Fencing & Decks",
    searchTerms: ["fence company", "fence installation", "deck builder"],
    askFor: "the owner",
    whyFit: "Quote-heavy; owner is usually out measuring, not answering.",
  },
  {
    key: "painting",
    label: "Painting",
    searchTerms: ["painting contractor", "house painter", "commercial painting"],
    askFor: "the owner",
    whyFit: "Estimate requests come by phone while crews are on site.",
  },
  {
    key: "flooring",
    label: "Flooring",
    searchTerms: ["flooring contractor", "carpet installation", "hardwood flooring"],
    askFor: "the owner or showroom manager",
    whyFit: "Showroom staff juggling walk-ins and the phone at once.",
  },
  {
    key: "windows_siding",
    label: "Windows & Siding",
    searchTerms: ["window replacement", "siding contractor", "window installation"],
    askFor: "the owner or general manager",
    whyFit: "High-ticket quotes; lead response time drives close rate.",
  },
  {
    key: "concrete_paving",
    label: "Concrete & Paving",
    searchTerms: ["concrete contractor", "driveway paving", "asphalt paving"],
    askFor: "the owner",
    whyFit: "Crews pouring all day; quote calls go to voicemail.",
  },
  {
    key: "pool_service",
    label: "Pool Service",
    searchTerms: ["pool service", "pool cleaning", "pool repair"],
    askFor: "the owner",
    whyFit: "Route-based techs; seasonal surge in service requests.",
  },
  {
    key: "handyman",
    label: "Handyman & Remodeling",
    searchTerms: ["handyman service", "home remodeling contractor", "general contractor"],
    askFor: "the owner",
    whyFit: "Solo operators who cannot answer while working.",
  },
  {
    key: "moving",
    label: "Moving & Junk Removal",
    searchTerms: ["moving company", "junk removal", "hauling service"],
    askFor: "the owner or dispatcher",
    whyFit: "Quote-by-phone business; missed calls go straight to a competitor.",
  },
];

export const INDUSTRY_MAP: Record<string, Industry> = Object.fromEntries(
  INDUSTRIES.map((i) => [i.key, i])
);

/** Look up a vertical by key, label, or a loose industry string on a lead. */
export function findIndustry(value: string | null | undefined): Industry | null {
  if (!value) return null;
  const v = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (INDUSTRY_MAP[v]) return INDUSTRY_MAP[v];
  return (
    INDUSTRIES.find(
      (i) =>
        i.label.toLowerCase() === value.trim().toLowerCase() ||
        i.searchTerms.some((t) => value.trim().toLowerCase().includes(t))
    ) || null
  );
}

/** Role-based ask used until a named decision-maker is discovered. */
export function roleBasedAsk(industry: string | null | undefined): string {
  const match = findIndustry(industry);
  const who = match ? match.askFor : "the owner";
  return `Ask whether ${who} is available. If not, get their name and the best time to call back.`;
}

export function searchTermsFor(keys: string[]): string[] {
  const out = new Set<string>();
  for (const k of keys) {
    const ind = INDUSTRY_MAP[k];
    if (ind) ind.searchTerms.forEach((t) => out.add(t));
  }
  return [...out];
}
