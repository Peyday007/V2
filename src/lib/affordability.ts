// Roughly how big is this business, and what can it actually spend?
//
// The reason this exists: a three-van plumbing outfit and a regional HVAC
// company get the same pitch today, and one of them is being quoted a number
// that ends the conversation. Sizing the offer before the call is the
// difference between a no and a smaller yes.
//
// THREE THINGS ABOUT THIS FILE.
//
//   1. IT IS AN ESTIMATE AND IT SAYS SO. Every number here is inferred from
//      public signals — review volume, rating, whether they rank, whether they
//      have a real website. It is not revenue. It carries a confidence and a
//      band, never a point figure, because a point figure invites people to
//      believe it.
//
//   2. IT IS INTERNAL. None of it goes on the owner's page, in an email, or in
//      an SMS. Telling a business what you think they earn is at best strange
//      and at worst insulting, and it converts nothing. The packet builder
//      never reads this module and there is a test asserting the estimate does
//      not appear in any owner-facing output.
//
//   3. IT SIZES THE OFFER, IT DOES NOT SET THE PRICE. It returns a band a
//      caller can work inside. The actual number a customer is quoted stays a
//      human decision — prices are never set automatically anywhere in this
//      system, and a model guessing at somebody's budget is not the exception.
//
// Pure. No database, no network.

export type SizeBand = "solo" | "small" | "established" | "regional";

export const SIZE_LABEL: Record<SizeBand, string> = {
  solo: "Owner-operator",
  small: "Small team",
  established: "Established local",
  regional: "Regional",
};

export type AffordabilityInput = {
  industry?: string | null;
  reviewCount?: number | null;
  rating?: number | null;
  /** Position in the map results for their trade and city. */
  mapRank?: number | null;
  /** Do they have a real website, and how complete is it? */
  hasWebsite?: boolean;
  /** Signals that cost money to have: schema, booking tools, a modern site. */
  hasBookingTool?: boolean;
  hasSchema?: boolean;
  mobileReady?: boolean;
  /** Anything the owner said about staff, e.g. "just me and my son". */
  officeStaffCount?: string | null;
  /** Population weight of the metro, if known. Not required. */
  majorMetro?: boolean;
};

export type Affordability = {
  band: SizeBand;
  /** A range, never a figure. Monthly, in whole dollars. */
  monthlyBudget: { low: number; high: number };
  /** The most it is worth proposing as a one-off build. */
  oneOffCeiling: number;
  /** 0-1. How much of this is actually evidenced. */
  confidence: number;
  /** Every signal that moved the estimate, so a caller can sanity-check it. */
  signals: string[];
  /** What to do with it, in one line. */
  guidance: string;
};

/*
 * Review count as a size proxy.
 *
 * The most honest signal available: a business cannot fake years of steady
 * customers, and review volume tracks job volume more closely than anything
 * else that is public. It is not proportional — a firm with 400 reviews is not
 * eight times the size of one with 50 — so the bands are deliberately wide and
 * the labels are about behaviour, not headcount.
 */
const REVIEW_BANDS: { max: number; band: SizeBand }[] = [
  { max: 20, band: "solo" },
  { max: 80, band: "small" },
  { max: 250, band: "established" },
  { max: Infinity, band: "regional" },
];

/** What a business in each band will plausibly commit to, per month. */
const BUDGET: Record<SizeBand, { low: number; high: number; oneOff: number }> = {
  // One or two people. Anything with a setup fee is a hard sell; the whole
  // conversation has to be "less than one job a month".
  solo: { low: 100, high: 300, oneOff: 750 },
  // A few vans. Has felt the pain of missed calls and can act without a board.
  small: { low: 250, high: 700, oneOff: 2500 },
  // Has an office person, probably some software already, buys on ROI.
  established: { low: 600, high: 1800, oneOff: 7000 },
  // Multi-location or multi-crew. Will want a contract and a pilot.
  regional: { low: 1500, high: 5000, oneOff: 20000 },
};

/** Trades where the average job is big enough to move the numbers up. */
const HIGH_TICKET = new Set(["hvac", "roofing", "restoration", "septic", "solar"]);
/** Trades where the average job is small and volume is the game. */
const LOW_TICKET = new Set(["cleaning", "locksmith", "appliance_repair", "pest_control"]);

function bandFromReviews(reviews: number): SizeBand {
  return REVIEW_BANDS.find((b) => reviews <= b.max)!.band;
}

function shift(band: SizeBand, by: number): SizeBand {
  const order: SizeBand[] = ["solo", "small", "established", "regional"];
  const i = order.indexOf(band);
  return order[Math.min(order.length - 1, Math.max(0, i + by))];
}

/**
 * Estimate what this business can spend.
 *
 * Starts from review volume, then moves the band on evidence of investment:
 * a business that has paid for structured data and a booking tool has a budget
 * and a habit of spending it, whatever its review count says.
 */
export function estimateAffordability(input: AffordabilityInput): Affordability {
  const signals: string[] = [];
  const reviews = typeof input.reviewCount === "number" ? input.reviewCount : null;

  /*
   * With no review count there is nothing to estimate FROM.
   *
   * Returns the cautious band with a confidence of zero rather than guessing
   * the middle. A caller who sees "not enough to tell" asks the question on
   * the call; one who sees a confident "small team" does not.
   */
  if (reviews === null) {
    return {
      band: "small",
      monthlyBudget: BUDGET.small,
      oneOffCeiling: BUDGET.small.oneOff,
      confidence: 0,
      signals: ["No review count on the record, so there is nothing to size from."],
      guidance: "Not enough to size this one. Ask on the call how many vans they run.",
    };
  }

  let band = bandFromReviews(reviews);
  signals.push(`${reviews} reviews → ${SIZE_LABEL[band].toLowerCase()}`);
  let confidence = reviews >= 10 ? 0.5 : 0.3;

  const industry = (input.industry || "").toLowerCase();
  if (HIGH_TICKET.has(industry) && reviews >= 30) {
    band = shift(band, 1);
    signals.push(`${industry} jobs are large, so the same volume implies more revenue`);
    confidence += 0.1;
  } else if (LOW_TICKET.has(industry) && band !== "solo") {
    band = shift(band, -1);
    signals.push(`${industry} jobs are small, so review volume overstates revenue`);
    confidence += 0.1;
  }

  // Evidence they already spend money on getting work.
  let investment = 0;
  if (input.hasBookingTool) {
    investment += 1;
    signals.push("pays for a booking or field-service tool");
  }
  if (input.hasSchema) {
    investment += 1;
    signals.push("has structured data, so somebody was paid to build the site");
  }
  if (input.mobileReady && input.hasWebsite) {
    investment += 0.5;
    signals.push("site is built properly for mobile");
  }
  if (typeof input.mapRank === "number" && input.mapRank <= 3 && reviews >= 40) {
    investment += 1;
    signals.push(`ranks ${input.mapRank} locally, which is rarely an accident`);
  }
  if (investment >= 2) {
    band = shift(band, 1);
    confidence += 0.15;
  }

  // Evidence against.
  if (input.hasWebsite === false) {
    band = shift(band, -1);
    signals.push("no website at all — almost never a business with a marketing budget");
    confidence += 0.15;
  }

  const staff = (input.officeStaffCount || "").toLowerCase();
  if (/\bjust me\b|\bonly me\b|\bmyself\b|\bno one\b|\bnobody\b|^1$|\bone\b/.test(staff)) {
    band = "solo";
    signals.push(`the owner said "${input.officeStaffCount}"`);
    confidence = Math.max(confidence, 0.8);
  } else if (/\b([5-9]|[1-9]\d+)\s*(?:people|staff|office)/.test(staff)) {
    band = shift(band, 1);
    signals.push(`the owner described ${input.officeStaffCount}`);
    confidence = Math.max(confidence, 0.75);
  }

  if (input.majorMetro && band !== "solo") {
    signals.push("major metro, so both costs and job values run higher");
  }

  const budget = BUDGET[band];
  return {
    band,
    monthlyBudget: { low: budget.low, high: budget.high },
    oneOffCeiling: budget.oneOff,
    confidence: Math.min(0.9, Number(confidence.toFixed(2))),
    signals,
    guidance: guidanceFor(band, Math.min(0.9, confidence)),
  };
}

function guidanceFor(band: SizeBand, confidence: number): string {
  const hedge = confidence < 0.5 ? " Low confidence — check it on the call before quoting." : "";
  switch (band) {
    case "solo":
      return (
        "Keep it to a monthly number and no setup fee. Frame it against one job, not against " +
        "a marketing budget they do not have." + hedge
      );
    case "small":
      return (
        "Monthly, with a small setup at most. They can decide on the call without asking " +
        "anybody." + hedge
      );
    case "established":
      return (
        "Can carry a proper build. Expect them to want it justified against booked jobs, and " +
        "expect one other person to be involved." + hedge
      );
    case "regional":
      return (
        "Start with a pilot on one location or one crew rather than a number. They will want " +
        "a contract and a procurement conversation." + hedge
      );
  }
}

/**
 * Every field name this module produces.
 *
 * Exported so a test can assert that none of them ever appear in owner-facing
 * output. That test is the enforcement of rule 2 at the top of this file —
 * a comment saying "internal only" is not a control.
 */
export const INTERNAL_ONLY_FIELDS = [
  "band",
  "monthlyBudget",
  "oneOffCeiling",
  "affordability",
  "estimatedRevenue",
] as const;
