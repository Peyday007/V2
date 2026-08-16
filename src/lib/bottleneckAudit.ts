// What the owner knows that we cannot see.
//
// The outside assessment is built from a listing, a website and a set of
// reviews. That is genuinely useful and it is genuinely partial: it cannot see
// how often the phone goes unanswered, which estimates never got chased, or
// how much of the week only happens because the owner is there.
//
// This is the short questionnaire that asks. It is deliberately conversational
// and deliberately light — three questions per area, none of them mandatory —
// because an owner who is asked for twenty data points closes the tab.
//
// WHAT IT PRODUCES IS AN OPPORTUNITY MAP, NOT AN AUDIT. An audit implies we
// checked. We did not check; we asked, and they told us. The output says so at
// every step, and keeps four things visibly apart: what we saw from outside,
// what they reported from inside, what we inferred from the two, and what
// still has to be verified before anybody acts on it.
//
// Pure. No database, no network.

import type { JourneyStage } from "./opportunityModel";

/* -------------------------------------------------------------------------- */
/* what we ask                                                                */
/* -------------------------------------------------------------------------- */

export type BottleneckArea =
  | "missed_calls"
  | "leads_not_booking"
  | "estimates_not_followed"
  | "owner_dependency"
  | "scheduling_messy"
  | "repeat_questions"
  | "reviews_inconsistent"
  | "hiring_coordination"
  | "marketing_attribution"
  | "cash_margins"
  | "customers_not_returning"
  | "tools_disconnected"
  | "no_reporting"
  | "other";

export type Frequency = "daily" | "weekly" | "occasionally" | "unsure";
export type Affects = "revenue" | "time" | "customers" | "employees" | "costs" | "visibility";

export const AREA_PROMPT: Record<BottleneckArea, string> = {
  missed_calls: "We miss calls or respond too slowly",
  leads_not_booking: "Leads come in but do not consistently book",
  estimates_not_followed: "Estimates do not get followed up",
  owner_dependency: "Too much work depends on the owner",
  scheduling_messy: "Scheduling or dispatch is messy",
  repeat_questions: "Customers repeatedly ask the same questions",
  reviews_inconsistent: "Reviews are not consistently requested or answered",
  hiring_coordination: "Hiring or employee coordination is difficult",
  marketing_attribution: "We do not know which marketing produces revenue",
  cash_margins: "Cash flow, pricing, or margins are hard to understand",
  customers_not_returning: "Customers do not return often enough",
  tools_disconnected: "Our tools do not communicate with each other",
  no_reporting: "We lack useful reporting or visibility",
  other: "Something else",
};

export const AREA_ORDER: BottleneckArea[] = [
  "missed_calls",
  "leads_not_booking",
  "estimates_not_followed",
  "owner_dependency",
  "scheduling_messy",
  "repeat_questions",
  "reviews_inconsistent",
  "hiring_coordination",
  "marketing_attribution",
  "cash_margins",
  "customers_not_returning",
  "tools_disconnected",
  "no_reporting",
  "other",
];

export const AUDIT_INTRO =
  "We found these opportunities from the outside. You know what happens inside the " +
  "business. Tell us where things feel slow, expensive, inconsistent, or dependent " +
  "on you, and we will map possible fixes.";

export type BottleneckAnswer = {
  area: BottleneckArea;
  detail?: string | null;
  frequency?: Frequency | null;
  affects?: Affects | null;
};

/* -------------------------------------------------------------------------- */
/* what each answer probably means                                            */
/* -------------------------------------------------------------------------- */

type AreaModel = {
  stage: JourneyStage;
  /** Plain-language causes. Possible causes — never asserted as the cause. */
  causes: string[];
  /** Where value may be leaking. Prose, never a figure. */
  leak: string;
  verify: string[];
  solutions: string[];
  demo: string | null;
  /** Needs access to something of theirs before anything can be done. */
  needsAccess: boolean;
  difficulty: "low" | "medium" | "high";
  /** Realistic time to something they can actually look at. */
  timeToSignal: string;
  /** How much weight this carries when several are reported together. */
  severity: number;
};

const MODEL: Record<BottleneckArea, AreaModel> = {
  missed_calls: {
    stage: "contact",
    causes: [
      "Calls arriving while everybody is on a job",
      "No cover at evenings, weekends or lunch",
      "Voicemail that callers will not use",
    ],
    leak: "Demand you already paid to create may be arriving and going elsewhere before anybody speaks to it.",
    verify: ["How many calls go unanswered in a normal week", "What happens to them now"],
    solutions: [
      "Capture and qualify enquiries when nobody can pick up",
      "Answer the routine questions without a person",
      "Pass urgent work straight to a human",
    ],
    demo: "Missed-inquiry capture and qualification",
    needsAccess: false,
    difficulty: "low",
    timeToSignal: "Days",
    severity: 0.95,
  },
  leads_not_booking: {
    stage: "qualification",
    causes: [
      "Slow first response",
      "No qualifying questions before the diary is committed",
      "Enquiries arriving in several places and getting lost",
    ],
    leak: "Enquiries that cost money to generate may be dropping out between first contact and a booked job.",
    verify: ["How quickly a new enquiry gets a reply", "Where enquiries arrive and who watches each one"],
    solutions: [
      "Reply immediately, then qualify",
      "Sort work worth doing from work that wastes a van",
      "Bring every enquiry into one place",
    ],
    demo: "Intake and qualification workflow",
    needsAccess: false,
    difficulty: "medium",
    timeToSignal: "One to two weeks",
    severity: 0.9,
  },
  estimates_not_followed: {
    stage: "booking",
    causes: [
      "Nobody owns the chase",
      "No reminder when an estimate goes quiet",
      "Quotes sent and then forgotten under the day's work",
    ],
    leak: "Work already priced and quoted — the most expensive kind to produce — may be going unclaimed.",
    verify: ["How many estimates are outstanding right now", "How long before one is written off"],
    solutions: [
      "Chase estimates automatically after a set time",
      "Flag the ones worth a personal call",
      "Show what is outstanding in one list",
    ],
    demo: "Estimate follow-up and recovery",
    needsAccess: true,
    difficulty: "low",
    timeToSignal: "Days",
    severity: 0.95,
  },
  owner_dependency: {
    stage: "fulfilment",
    causes: [
      "Knowledge that exists only in the owner's head",
      "Decisions that cannot be made without them",
      "No written way of doing the routine things",
    ],
    leak: "Growth may be capped by one person's hours, and time off may cost the business directly.",
    verify: ["Which decisions genuinely need the owner", "What would stop in a fortnight away"],
    solutions: [
      "Write down the decisions that recur, so somebody else can make them",
      "Route only genuine exceptions to the owner",
      "Give the team what they need without asking",
    ],
    demo: "Owner-dependency reduction workflow",
    needsAccess: false,
    difficulty: "high",
    timeToSignal: "Four to eight weeks",
    severity: 0.85,
  },
  scheduling_messy: {
    stage: "booking",
    causes: ["Diary in several places", "Changes not reaching the vans", "No view of who is where"],
    leak: "Time may be lost to coordination rather than work, and mistakes may reach the customer.",
    verify: ["Where the diary actually lives", "How a change reaches the person doing the job"],
    solutions: ["One diary everybody sees", "Changes that reach the van", "Routing that reflects reality"],
    demo: "Booking and intake workflow",
    needsAccess: true,
    difficulty: "medium",
    timeToSignal: "Two to three weeks",
    severity: 0.7,
  },
  repeat_questions: {
    stage: "evaluation",
    causes: ["The answers are not published anywhere", "Buyers cannot self-serve before ringing"],
    leak: "Staff time may be going on questions that could answer themselves, and some buyers may not ring at all.",
    verify: ["Which questions come up most", "Whether the answers exist anywhere public"],
    solutions: ["Publish the answers where buyers look", "Answer them automatically on first contact"],
    demo: "Customer-journey prototype",
    needsAccess: false,
    difficulty: "low",
    timeToSignal: "Days",
    severity: 0.5,
  },
  reviews_inconsistent: {
    stage: "review",
    causes: ["No prompt at the moment people are happiest", "Nobody owns replying"],
    leak: "Buyers comparing you to a competitor may be choosing on reviews you never asked for.",
    verify: ["When and how reviews get requested now", "Who replies, and how quickly"],
    solutions: ["Ask at the right moment", "Reply consistently", "Learn from what people repeat"],
    demo: "Review and customer-language analysis",
    needsAccess: false,
    difficulty: "low",
    timeToSignal: "Two to four weeks",
    severity: 0.55,
  },
  hiring_coordination: {
    stage: "fulfilment",
    causes: ["Onboarding held in one person's memory", "No consistent way to brief the team"],
    leak: "New people may take longer to become useful than they need to.",
    verify: ["How a new starter currently learns the job", "What gets repeated every time"],
    solutions: ["Write the routine down once", "Brief the team in one place"],
    demo: null,
    needsAccess: false,
    difficulty: "medium",
    timeToSignal: "Three to six weeks",
    severity: 0.45,
  },
  marketing_attribution: {
    stage: "demand",
    causes: ["No record of where an enquiry came from", "Spend decided on impression rather than outcome"],
    leak: "Money may be going to sources that produce enquiries but not profitable work.",
    verify: ["Whether source is captured on any enquiry today", "What is being spent, and where"],
    solutions: ["Capture the source on every enquiry", "Report revenue by source, not leads by source"],
    demo: "Operational dashboard",
    needsAccess: true,
    difficulty: "medium",
    timeToSignal: "Three to four weeks",
    severity: 0.75,
  },
  cash_margins: {
    stage: "payment",
    causes: ["Job costing done by feel", "Invoices going out late", "No view of which work pays"],
    leak: "Some work may be being sold at a margin nobody has actually checked.",
    verify: ["How a job is costed now", "How quickly invoices follow the work"],
    solutions: ["Cost jobs consistently", "Invoice the day work completes", "Show margin by job type"],
    demo: "Financial and margin decision support",
    needsAccess: true,
    difficulty: "high",
    timeToSignal: "Four to six weeks",
    severity: 0.85,
  },
  customers_not_returning: {
    stage: "retention",
    causes: ["No contact after the job", "No reason given to come back", "Past customers not tracked"],
    leak: "The cheapest work available — somebody who already trusts you — may be going to whoever contacts them first.",
    verify: ["Whether past customers are contactable as a list", "What proportion return today"],
    solutions: ["Reactivate dormant customers", "Turn one-off jobs into planned work", "Stay in front without nagging"],
    demo: "Dormant-customer reactivation",
    needsAccess: true,
    difficulty: "low",
    timeToSignal: "One to two weeks",
    severity: 0.8,
  },
  tools_disconnected: {
    stage: "visibility",
    causes: ["Information retyped between systems", "No single record of a customer"],
    leak: "Time may be going on re-entry, and the same customer may exist three times with three histories.",
    verify: ["Which systems hold customer information", "What gets retyped"],
    solutions: ["Connect the systems that matter", "Agree one place each fact lives"],
    demo: "Operational dashboard",
    needsAccess: true,
    difficulty: "high",
    timeToSignal: "Four to eight weeks",
    severity: 0.65,
  },
  no_reporting: {
    stage: "visibility",
    causes: ["Numbers assembled by hand when somebody asks", "No agreed measures"],
    leak: "Problems may only become visible after they have cost something.",
    verify: ["What is measured today", "What decision would change with better information"],
    solutions: ["A small number of measures that matter", "Told to you rather than looked up"],
    demo: "Operational dashboard",
    needsAccess: true,
    difficulty: "medium",
    timeToSignal: "Two to four weeks",
    severity: 0.7,
  },
  other: {
    stage: "visibility",
    causes: ["Something specific to this business"],
    leak: "We would need to hear more before saying anything useful about this.",
    verify: ["What exactly happens, and how often"],
    solutions: ["Understand it properly before proposing anything"],
    demo: null,
    needsAccess: false,
    difficulty: "medium",
    timeToSignal: "Depends what it turns out to be",
    severity: 0.4,
  },
};

/* -------------------------------------------------------------------------- */
/* the opportunity map                                                        */
/* -------------------------------------------------------------------------- */

export type MapBand = "fix_first" | "quick_win" | "investigate_next";

export const BAND_LABEL: Record<MapBand, string> = {
  fix_first: "Fix first",
  quick_win: "Quick win",
  investigate_next: "Investigate next",
};

export type MappedOpportunity = {
  area: BottleneckArea;
  heading: string;
  stage: JourneyStage;
  band: MapBand;
  possibleCauses: string[];
  whereValueLeaks: string;
  toVerify: string[];
  solutionDirections: string[];
  canDemonstrate: string | null;
  needsPermission: boolean;
  difficulty: "low" | "medium" | "high";
  timeToSignal: string;
  confidence: "low" | "medium" | "high";
  /** What the owner actually told us, echoed back. */
  reported: { detail: string | null; frequency: Frequency | null; affects: Affects | null };
};

const FREQUENCY_WEIGHT: Record<Frequency, number> = {
  daily: 1,
  weekly: 0.75,
  occasionally: 0.4,
  unsure: 0.5,
};

/**
 * How many of these to show. Deliberately few.
 *
 * An owner who ticks nine boxes and receives nine recommendations has been
 * sold a catalogue. Showing the strongest few is both more useful and more
 * credible — and the rest are not lost, they are simply not the thing to do
 * first.
 */
export const MAX_MAPPED = 5;

/**
 * Turn what they told us into a ranked map.
 *
 * Confidence is bounded at medium throughout: this is self-reported, and self
 * reported information is a strong signal about what somebody experiences and
 * a weak one about what is causing it. Claiming high confidence from a
 * questionnaire would be exactly the overreach this whole rebuild removes.
 */
export function buildOpportunityMap(answers: BottleneckAnswer[]): MappedOpportunity[] {
  const scored = answers
    .filter((a) => !!MODEL[a.area])
    .map((a) => {
      const m = MODEL[a.area];
      const freq = a.frequency ? FREQUENCY_WEIGHT[a.frequency] : 0.5;
      const score = m.severity * (0.6 + 0.4 * freq);
      return { a, m, score, freq };
    })
    .sort((x, y) => y.score - x.score)
    .slice(0, MAX_MAPPED);

  return scored.map(({ a, m, score, freq }) => {
    /*
     * Banding. "Fix first" is reserved for things that both matter a lot and
     * happen often. A quick win is cheap and fast regardless of severity —
     * worth doing precisely because it costs almost nothing to try.
     */
    const band: MapBand =
      score >= 0.8 ? "fix_first" : m.difficulty === "low" ? "quick_win" : "investigate_next";

    return {
      area: a.area,
      heading: AREA_PROMPT[a.area],
      stage: m.stage,
      band,
      possibleCauses: m.causes,
      whereValueLeaks: m.leak,
      toVerify: m.verify,
      solutionDirections: m.solutions,
      canDemonstrate: m.demo,
      needsPermission: m.needsAccess,
      difficulty: m.difficulty,
      timeToSignal: m.timeToSignal,
      // Never "high" from a questionnaire alone.
      confidence: freq >= 0.75 ? "medium" : "low",
      reported: {
        detail: a.detail?.trim() || null,
        frequency: a.frequency ?? null,
        affects: a.affects ?? null,
      },
    };
  });
}

/**
 * The four things that must stay visibly apart in the combined view.
 *
 * Merging them is how a questionnaire answer becomes, three screens later,
 * something we appear to have discovered.
 */
export const PROVENANCE_HEADINGS = {
  observed: "What we saw from the outside",
  reported: "What you told us",
  inferred: "What we are reading from the two together",
  unverified: "What still needs checking before anyone acts on it",
} as const;
