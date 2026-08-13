// How much qualified supply the campaign needs, and how hard to work to get it.
//
// WHY THIS EXISTS.
//
// Ten inboxes could carry 850–1,000 emails a day. Twenty-two went out. The
// switches were all on, the worker was ticking every minute, the recipient
// rule was working, and every panel on the page was telling the truth. The
// supply system was the thing that was wrong, in three places at once, and
// none of the three announced itself:
//
//   1. A lead that finished its sequence still counted as occupying a slot in
//      the campaign, forever — so the top-up saw a full campaign and pushed
//      nothing, permanently.
//   2. Sourcing was gated behind "is anything awaiting enrichment", and leads
//      that can never be enriched kept that number above zero forever — so
//      the deadlock never cleared.
//   3. The targets were flat numbers typed in by hand, unrelated to what the
//      inboxes could actually carry.
//
// The shape of the fix is that supply is DERIVED FROM DEMAND rather than
// configured. Everything below is pure arithmetic on numbers the rest of the
// system already knows, so the decision to spend money can be tested without
// spending money.
//
// EVERY RULE HERE IS A CEILING, NEVER A FLOOR. The worst this can do is buy
// too little. That asymmetry is deliberate and is the reason the checks are
// ordered the way they are.

/* -------------------------------------------------------------------------- */
/* how long a lead occupies the campaign                                      */
/* -------------------------------------------------------------------------- */

/**
 * How many days pass between a lead's first email and its last.
 *
 * THE NUMBER THAT WAS MISSING. `leadsPerDay = capacity ÷ steps` is right for
 * the daily intake — over any long window a lead sends all of its emails, so
 * the send rate is intake × steps whatever the spacing. But it says nothing
 * about how many leads have to be ALIVE in the campaign at once to sustain
 * that rate, and that is a completely different number:
 *
 *     leads in campaign at steady state = intake per day × span in days
 *
 * With 212 leads a day on a sequence that runs 12 days, roughly 2,500 leads
 * are mid-sequence at any moment. The campaign target was 200. So the top-up
 * believed the campaign was twelve times fuller than it was, which is the
 * arithmetic behind "the campaign already holds 323 of a target 200" while
 * the inboxes sat idle.
 *
 * Step 1 is day 0 by definition; only the waits after it count.
 */
export function sequenceSpanDays(steps: { step: number; delayDays: number }[]): number {
  let span = 0;
  for (const s of steps) {
    if (s.step === 1) continue;
    const d = Number(s.delayDays);
    if (Number.isFinite(d) && d > 0) span += Math.floor(d);
  }
  return span;
}

/* -------------------------------------------------------------------------- */
/* is a thread still in the sequence                                          */
/* -------------------------------------------------------------------------- */

/**
 * Grace on top of the sequence span before a thread is called finished.
 *
 * Instantly sends on business days and pauses for holidays, so a 12-day
 * sequence can take 16 real days to land. Counting a thread as finished while
 * Instantly is still sending to it would push a replacement into a slot that
 * is not free, which is the one direction this must not err in.
 */
export const SEQUENCE_COMPLETION_GRACE_DAYS = 7;

/**
 * Has this thread run out of sequence to send?
 *
 * THE PRIMARY BUG. `email_threads` has no "completed" status and never will —
 * Instantly does not send an event when a lead reaches the end of a sequence
 * without replying, which is the ordinary outcome for most of them. So a lead
 * pushed in July, sent all four emails, and never heard from again keeps the
 * status `sent` forever, and every count of "how full is the campaign"
 * included it forever.
 *
 * Elapsed time is the only signal available, and it is a sound one: a thread
 * pushed longer ago than the whole sequence takes, plus a week of slack, has
 * by definition finished sending. It is not deleted, not rewritten, and its
 * history is untouched — it simply stops being counted as an occupied slot.
 */
export function sequenceIsFinished(
  pushedAt: string | null,
  spanDays: number,
  now: Date = new Date()
): boolean {
  if (!pushedAt) return false;
  const t = Date.parse(pushedAt);
  if (Number.isNaN(t)) return false;
  const lifetime = (Math.max(0, spanDays) + SEQUENCE_COMPLETION_GRACE_DAYS) * 86_400_000;
  return now.getTime() - t > lifetime;
}

/* -------------------------------------------------------------------------- */
/* what the campaign will consume                                             */
/* -------------------------------------------------------------------------- */

export type Demand = {
  /** New leads to start per day to keep the inboxes busy. */
  intakePerDay: number;
  /** How many leads are mid-sequence at steady state. The real campaign target. */
  targetInCampaign: number;
  /** Qualified contacts to keep banked ahead of demand. */
  reserveTarget: number;
  /** Sends per day this plans to produce, for reporting. */
  plannedSendsPerDay: number;
  /** Said in words, because every number on the page needs a sentence. */
  reason: string;
};

export type DemandInputs = {
  /** Sends per day the inboxes and campaign limit will actually carry. */
  usableSends: number;
  /** Emails in the sequence. */
  sequenceSteps: number;
  /** Days from first email to last. */
  spanDays: number;
  /** How many sending days of qualified contacts to keep in hand. */
  reserveDays: number;
};

/** Guard rails so a nonsense setting cannot become a nonsense spend. */
export const MIN_RESERVE_DAYS = 1;
export const MAX_RESERVE_DAYS = 14;
export const DEFAULT_RESERVE_DAYS = 3;

export function computeDemand(input: DemandInputs): Demand {
  const sends = Math.max(0, Math.floor(input.usableSends || 0));
  const steps = Math.max(1, Math.floor(input.sequenceSteps || 1));
  const span = Math.max(0, Math.floor(input.spanDays || 0));
  const reserveDays = clamp(
    Math.floor(input.reserveDays || DEFAULT_RESERVE_DAYS),
    MIN_RESERVE_DAYS,
    MAX_RESERVE_DAYS
  );

  const intakePerDay = Math.floor(sends / steps);

  /*
   * Why span + 1 rather than span.
   *
   * A sequence that runs 12 days has leads from 13 distinct cohorts alive at
   * once — today's, which has had step 1, through the one from 12 days ago,
   * which is receiving its last. Using `span` alone is off by one cohort, and
   * one cohort short means the campaign runs dry for a day every cycle.
   *
   * A single-step sequence gives span 0 and therefore a one-day target, which
   * is correct: nothing is waiting on a follow-up.
   */
  const targetInCampaign = intakePerDay * (span + 1);
  const reserveTarget = intakePerDay * reserveDays;

  return {
    intakePerDay,
    targetInCampaign,
    reserveTarget,
    plannedSendsPerDay: intakePerDay * steps,
    reason:
      intakePerDay === 0
        ? "No usable sending capacity was read, so no intake is planned."
        : `${sends} sends a day ÷ ${steps} emails per lead = ${intakePerDay} new leads a day. ` +
          `The sequence runs ${span} days, so about ${targetInCampaign} leads are mid-sequence at ` +
          `any time, and ${reserveDays} days of cover means keeping ${reserveTarget} qualified ` +
          `contacts in hand.`,
  };
}

/* -------------------------------------------------------------------------- */
/* how many leads to source for a given number of qualified contacts          */
/* -------------------------------------------------------------------------- */

/**
 * The floor and ceiling on the measured qualification yield.
 *
 * A yield of zero would demand an infinite purchase, and a yield of 1 would
 * under-buy on the first bad batch. Both bounds exist to keep one strange
 * measurement from turning into a strange spend.
 */
export const MIN_YIELD = 0.02;
export const MAX_YIELD = 0.9;
/** Assumed only until enough real outcomes exist to measure. */
export const ASSUMED_YIELD = 0.1;
/** Sourced leads that must be resolved before the measurement is believed. */
export const YIELD_SAMPLE_FLOOR = 50;
/** Bought on top, because some of every batch is duplicates or dead sites. */
export const SOURCING_SAFETY_MARGIN = 1.25;

export type YieldSample = {
  /** Leads sourced whose enrichment has finished, one way or the other. */
  resolved: number;
  /** Of those, how many became a personal address with a name. */
  qualified: number;
};

/**
 * The share of sourced businesses that become someone we can actually email.
 *
 * Measured rather than assumed, once there is enough to measure. A guessed
 * ratio that never updates is how a system keeps buying ten times too little
 * for a year — the assumed 10% is a starting point, not a belief.
 */
export function measuredYield(sample: YieldSample): { yield: number; measured: boolean } {
  const resolved = Math.max(0, Math.floor(sample.resolved || 0));
  const qualified = Math.max(0, Math.floor(sample.qualified || 0));
  if (resolved < YIELD_SAMPLE_FLOOR) {
    return { yield: ASSUMED_YIELD, measured: false };
  }
  return { yield: clamp(qualified / resolved, MIN_YIELD, MAX_YIELD), measured: true };
}

/** How many businesses to ask Google for, to end up with `wanted` qualified. */
export function sourcingVolumeFor(wanted: number, qualificationYield: number): number {
  if (wanted <= 0) return 0;
  const y = clamp(qualificationYield || ASSUMED_YIELD, MIN_YIELD, MAX_YIELD);
  return Math.ceil((wanted / y) * SOURCING_SAFETY_MARGIN);
}

/* -------------------------------------------------------------------------- */
/* the decision                                                               */
/* -------------------------------------------------------------------------- */

export type SupplyFacts = {
  /** Automatic sourcing. Nothing is bought while this is false. */
  sourcingEnabled: boolean;

  /** What the campaign will consume. */
  demand: Demand;

  /** Qualified now: personal address, name on record, not yet pushed. */
  qualifiedReady: number;

  /**
   * Leads here that enrichment has not finished with AND has not given up on.
   *
   * Critically NOT "leads missing something". A lead whose website will never
   * name a human is missing something forever, and treating that as
   * outstanding work is what deadlocked sourcing behind an enrichment queue
   * that could never empty.
   */
  enrichableNow: number;

  /** Roughly how many of those the enrichment run can finish per day. */
  enrichmentPerDay: number;

  /** Measured share of sourced businesses that become qualified contacts. */
  qualificationYield: number;
  yieldIsMeasured: boolean;

  /** A run already going. Two at once buys the same leads twice. */
  sourcingRunning: boolean;
  hoursSinceLastRun: number | null;
  minHoursBetweenRuns: number;

  /** Ceiling on one purchase, so a bad measurement costs a batch. */
  maxLeadsPerRun: number;
};

export type SupplyDecision = {
  act: "hold" | "enrich" | "source";
  /** Businesses to ask Google for. Zero for every act except "source". */
  sourceCount: number;
  /** Qualified contacts short of the reserve. Zero when covered. */
  shortfall: number;
  /** Sending days of qualified contacts currently in hand. */
  daysOfCover: number;
  reason: string;
  /**
   * TRUE ONLY WHEN A HUMAN IS NEEDED.
   *
   * Routine filtering is not a fault. A batch that produced mostly general
   * inboxes is the system working — it rejected them and will source more.
   * This is reserved for the states nothing automatic can clear: sourcing
   * switched off, no capacity, or a backlog that cannot cover demand in time.
   */
  needsHuman: boolean;
};

export function planSupply(f: SupplyFacts): SupplyDecision {
  const intake = Math.max(0, f.demand.intakePerDay);
  const ready = Math.max(0, f.qualifiedReady);
  const daysOfCover = intake > 0 ? round1(ready / intake) : ready > 0 ? Infinity : 0;
  const shortfall = Math.max(0, f.demand.reserveTarget - ready);

  /*
   * No capacity is a human problem, and the only one at the top of this
   * function. Everything downstream divides by the intake, and buying leads
   * for inboxes that cannot send is spending money on nothing.
   */
  if (intake === 0) {
    return {
      act: "hold",
      sourceCount: 0,
      shortfall: 0,
      daysOfCover: 0,
      reason:
        "No sending capacity was read from Instantly, so there is nothing to keep fed. " +
        "Check the sending accounts and the campaign's daily limit.",
      needsHuman: true,
    };
  }

  /*
   * COVERED. Stop.
   *
   * The requirement that keeps this from becoming an unbounded spend: once
   * the reserve is met, no more is bought however cheap it looks.
   */
  if (shortfall <= 0) {
    return {
      act: "hold",
      sourceCount: 0,
      shortfall: 0,
      daysOfCover,
      reason: `${ready} qualified contacts in hand — about ${fmtDays(daysOfCover)} of sending at ${intake} a day, which covers the reserve. Nothing to buy.`,
      needsHuman: false,
    };
  }

  if (!f.sourcingEnabled) {
    /*
     * Short AND unable to do anything about it. This one does warrant the
     * banner: no automatic path closes the gap, so it will stay open until
     * somebody switches sourcing on.
     */
    return {
      act: "hold",
      sourceCount: 0,
      shortfall,
      daysOfCover,
      reason:
        `${ready} qualified contacts is about ${fmtDays(daysOfCover)} of sending, ${shortfall} short of the ` +
        `${f.demand.reserveTarget} the campaign needs — and automatic sourcing is switched off, so nothing will close the gap.`,
      needsHuman: true,
    };
  }

  /*
   * ENRICH FIRST, BUT ONLY WHILE IT CAN KEEP UP.
   *
   * The old rule was "any lead awaiting enrichment blocks sourcing", full
   * stop. That is right when the backlog can produce what is needed in time
   * and catastrophic when it cannot: 935 leads that will never yield a named
   * contact held the gate shut permanently, and no lead was ever bought again.
   *
   * So the question is not "is there a backlog" but "can the backlog cover
   * the shortfall before the reserve runs out". If it can, enrichment is free
   * and buying would be paying to lengthen a queue. If it cannot, both happen
   * — the backlog keeps being worked AND leads are bought, because waiting on
   * a queue that will not arrive in time is how the inboxes went quiet.
   */
  const reachableFromBacklog = Math.floor(f.enrichableNow * f.qualificationYield);
  const daysToWorkBacklog =
    f.enrichmentPerDay > 0 ? f.enrichableNow / f.enrichmentPerDay : Infinity;

  if (reachableFromBacklog >= shortfall && daysToWorkBacklog <= Math.max(1, daysOfCover)) {
    return {
      act: "enrich",
      sourceCount: 0,
      shortfall,
      daysOfCover,
      reason:
        `${shortfall} short of the reserve, and ${f.enrichableNow} leads already here should yield about ` +
        `${reachableFromBacklog} qualified contacts within ${fmtDays(daysToWorkBacklog)} — sooner than the ` +
        `${fmtDays(daysOfCover)} of cover in hand. Working those first; they are free.`,
      needsHuman: false,
    };
  }

  if (f.sourcingRunning) {
    return {
      act: "hold",
      sourceCount: 0,
      shortfall,
      daysOfCover,
      reason: "A sourcing run is already going. Waiting for it rather than starting a second and buying the same leads twice.",
      needsHuman: false,
    };
  }

  if (f.hoursSinceLastRun !== null && f.hoursSinceLastRun < f.minHoursBetweenRuns) {
    const wait = Math.ceil(f.minHoursBetweenRuns - f.hoursSinceLastRun);
    return {
      act: "hold",
      sourceCount: 0,
      shortfall,
      daysOfCover,
      reason: `${shortfall} short, but the last run was ${Math.floor(f.hoursSinceLastRun)}h ago and runs are spaced ${f.minHoursBetweenRuns}h apart so the crawl can keep up. Next one in about ${wait}h.`,
      needsHuman: false,
    };
  }

  /*
   * Buy, scaled to what the last batches actually produced.
   *
   * Sourcing 100 businesses to get 100 contacts is what a 10% yield turns
   * into 10, and it is why the reserve never filled however often this ran.
   */
  const wanted = Math.max(0, shortfall - reachableFromBacklog);
  const raw = sourcingVolumeFor(wanted, f.qualificationYield);
  const sourceCount = Math.min(raw, Math.max(1, Math.floor(f.maxLeadsPerRun)));
  const pct = Math.round(f.qualificationYield * 100);

  return {
    act: "source",
    sourceCount,
    shortfall,
    daysOfCover,
    reason:
      `${ready} qualified contacts is ${fmtDays(daysOfCover)} of sending, ${shortfall} short of the ` +
      `${f.demand.reserveTarget} needed. ${f.yieldIsMeasured ? "Recent batches qualified" : "Assuming"} ` +
      `${pct}% of sourced businesses, so sourcing ${sourceCount} to find ${wanted}` +
      (raw > sourceCount ? ` (capped at ${sourceCount} for one run; the rest follows next run)` : "") +
      ".",
    needsHuman: false,
  };
}

/* -------------------------------------------------------------------------- */
/* what the campaign is short of RIGHT NOW                                    */
/* -------------------------------------------------------------------------- */

/**
 * How many qualified contacts to push into Instantly this minute.
 *
 * Separate from planSupply because they answer different questions on
 * different clocks: this one moves contacts we already have into the campaign
 * every minute, that one decides whether to go and find more, hourly.
 *
 * `activeInCampaign` must already exclude finished sequences — see
 * sequenceIsFinished. Passing the old all-time count here reproduces the
 * original bug exactly.
 */
export function pushBatchSize(input: {
  activeInCampaign: number | null;
  targetInCampaign: number;
  qualifiedReady: number;
  dailyIntakeCap: number;
  pushedToday: number;
  maxPerRun: number;
}): { count: number; reason: string } {
  if (input.activeInCampaign === null) {
    return {
      count: 0,
      reason:
        "Could not read how many leads are mid-sequence, so nothing was pushed. Pushing blind is how a campaign gets double-filled.",
    };
  }

  const room = input.targetInCampaign - input.activeInCampaign;
  if (room <= 0) {
    return {
      count: 0,
      reason: `${input.activeInCampaign} leads are mid-sequence against a target of ${input.targetInCampaign}. The campaign is full.`,
    };
  }

  const dailyRoom = input.dailyIntakeCap - input.pushedToday;
  if (dailyRoom <= 0) {
    return {
      count: 0,
      reason: `Today's intake of ${input.dailyIntakeCap} is used up. It resets tomorrow.`,
    };
  }

  if (input.qualifiedReady <= 0) {
    return {
      count: 0,
      reason:
        "No contacts meet the recipient rule right now — a personal address with a name on record. Sourcing and enrichment are what move this number.",
    };
  }

  const count = Math.min(room, dailyRoom, input.qualifiedReady, Math.max(1, input.maxPerRun));
  const binding =
    count === room
      ? `filling the campaign to ${input.targetInCampaign}`
      : count === dailyRoom
        ? `what is left of today's intake of ${input.dailyIntakeCap}`
        : count === input.qualifiedReady
          ? "every qualified contact there is"
          : `the per-run cap of ${input.maxPerRun}`;

  return { count, reason: `Pushing ${count} — ${binding}.` };
}

/* -------------------------------------------------------------------------- */

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function fmtDays(d: number): string {
  if (!Number.isFinite(d)) return "an unknown number of days";
  if (d < 1) return "under a day";
  return `${round1(d)} day${d >= 2 ? "s" : ""}`;
}
