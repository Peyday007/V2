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
/* HOW MANY FIRST-TOUCH EMAILS TODAY CAN CARRY                                */
/* -------------------------------------------------------------------------- */

/*
 * THE CORRECTION.
 *
 * `capacity ÷ steps` answers "how many new leads a day can this sustain
 * forever" and it is right for that. It was then used as a HARD DAILY CAP on
 * pushing, which is a different question with a different answer, and using
 * one for the other throws capacity away every single day.
 *
 * With 850 sends and a four-step sequence it allowed 212 new leads a day, on
 * the reasoning that the other 638 sends are follow-ups. That reasoning only
 * holds once the pipeline is full. Today there might be 250 follow-ups due,
 * or 40, or none — and on a day with 250 due, 600 first-touch emails could go
 * out and only 212 were allowed to. Nearly 400 sends of paid, warmed capacity
 * discarded, every day, by arithmetic that was never about today.
 *
 * What today can carry is simply what is left:
 *
 *     first touch today = usable today − follow-ups due today − already sent
 *
 * The steady-state figure keeps its job — forecasting how much to source and
 * how large a reserve to hold — and loses the one it should never have had.
 */

export type TodayCapacity = {
  /** First-touch emails today can still carry. The push cap. */
  firstTouchAllowed: number;
  /** What the inboxes and campaign limit will carry today, before deductions. */
  usableToday: number;
  followUpsDue: number;
  alreadySentToday: number;
  /** How much is expected to go unused, and why. */
  expectedUnused: number;
  unusedCause: string | null;
  reason: string;
};

export function firstTouchCapacity(input: {
  usableToday: number;
  /** The WHOLE day's follow-up load, sent and unsent alike. */
  followUpsDue: number;
  /** Everything Instantly has already put out today, of either kind. */
  alreadySentToday: number;
  /** Of those, how many were first touches — i.e. leads we pushed today. */
  firstTouchesSentToday?: number;
  /** Qualified contacts on hand. Only used to explain unused capacity. */
  qualifiedReady?: number;
}): TodayCapacity {
  const usableToday = Math.max(0, Math.floor(input.usableToday || 0));
  const followUpsDue = Math.max(0, Math.floor(input.followUpsDue || 0));
  const alreadySentToday = Math.max(0, Math.floor(input.alreadySentToday || 0));
  const firstTouchesSent = Math.max(0, Math.floor(input.firstTouchesSentToday || 0));

  /*
   * NO DOUBLE-COUNTING, and this is the subtle part.
   *
   * `followUpsDue` is the whole day's follow-up load and `alreadySentToday`
   * is everything already out — which INCLUDES whichever of those follow-ups
   * have gone already. Subtracting both charges the morning's follow-ups
   * twice and needlessly starves the afternoon: by 2pm a day with 250
   * follow-ups, 200 of them already sent, would deduct 450 instead of 250.
   *
   * Splitting today's sends is possible because we know one half exactly: a
   * first touch happens only when we push a lead, and pushedToday counts
   * those. Everything else Instantly sent today was a follow-up.
   */
  const followUpsAlreadySent = Math.max(0, alreadySentToday - firstTouchesSent);
  const followUpsRemaining = Math.max(0, followUpsDue - followUpsAlreadySent);

  const firstTouchAllowed = Math.max(
    0,
    usableToday - alreadySentToday - followUpsRemaining
  );

  const ready = input.qualifiedReady;
  const shortOfContacts = typeof ready === "number" && ready < firstTouchAllowed;
  const expectedUnused = shortOfContacts ? firstTouchAllowed - ready! : 0;

  return {
    firstTouchAllowed,
    usableToday,
    followUpsDue,
    alreadySentToday,
    expectedUnused,
    unusedCause: shortOfContacts
      ? `Only ${ready} qualified contacts are ready against ${firstTouchAllowed} first-touch sends today, so about ${expectedUnused} sends will go unused unless sourcing and enrichment catch up.`
      : null,
    reason:
      usableToday === 0
        ? "No sending capacity was read for today."
        : `${usableToday} sends today, less ${alreadySentToday} already sent and ${followUpsRemaining} follow-ups still due, leaves ${firstTouchAllowed} for first-touch emails.`,
  };
}

/* -------------------------------------------------------------------------- */
/* how many follow-ups are actually due today                                 */
/* -------------------------------------------------------------------------- */

/**
 * The day each step lands on, counting from the day the lead was pushed.
 *
 * A four-step sequence with waits of 3, 4 and 5 days gives [0, 3, 7, 12]. Step
 * one is day zero — it is the first touch, not a follow-up — so only the rest
 * are follow-ups and only they are counted below.
 */
export function cumulativeStepOffsets(
  steps: { step: number; delayDays: number }[]
): number[] {
  const offsets: number[] = [];
  let running = 0;
  for (const s of [...steps].sort((a, b) => a.step - b.step)) {
    if (s.step !== 1) {
      const d = Number(s.delayDays);
      running += Number.isFinite(d) && d > 0 ? Math.floor(d) : 0;
    }
    offsets.push(running);
  }
  return offsets;
}

/** A thread as far as follow-up scheduling is concerned. */
export type ScheduledThread = {
  /** When the lead was pushed, which is when step one went. */
  pushedAt: string | null;
  /** Ended threads send nothing further. */
  status: string | null;
};

/** Statuses that stop a sequence dead. No further step is ever sent. */
const ENDED_STATUSES = new Set(["replied", "bounced", "unsubscribed", "failed"]);

export type FollowUpEstimate = {
  due: number;
  /**
   * How much to trust it.
   *
   * "measured" — computed from our own push dates and the live sequence.
   * "unknown" — the sequence or the threads could not be read.
   */
  confidence: "measured" | "unknown";
  /** The limitation, in words, for anywhere this number is displayed. */
  caveat: string;
};

/**
 * How many follow-ups Instantly should send today.
 *
 * WHY THIS IS COMPUTED RATHER THAN ASKED FOR. Instantly's API exposes what it
 * HAS sent — /campaigns/analytics/daily — and not what it is ABOUT to send.
 * There is no endpoint for "steps scheduled for today", so the only honest
 * options are to derive it or to guess, and dividing capacity by four was the
 * guess this replaces.
 *
 * Deriving it is sound because we own both halves: the day each lead was
 * pushed, and the day offsets of the live sequence. A lead pushed eight days
 * ago on a [0, 3, 7, 12] sequence has no step falling today; one pushed seven
 * days ago has step three due.
 *
 * WHAT IT CANNOT KNOW, and why every caller must show the caveat: Instantly
 * sends inside the campaign's schedule, so a step whose nominal day lands on a
 * weekend or a holiday goes on the next sending day instead. Real sends
 * therefore drift later than these offsets, by roughly two days a week. The
 * estimate is good to within a day or so on a weekday and worst on a Monday.
 *
 * Being wrong here is bounded on both sides and neither side is dangerous:
 * Instantly's own campaign and per-inbox limits are the hard ceiling, so an
 * under-estimate cannot produce an unsafe send — it can only queue a few
 * leads into tomorrow. An over-estimate leaves a little capacity unused, which
 * the dashboard reports rather than hides.
 */
export function followUpsDueToday(
  threads: ScheduledThread[],
  offsets: number[],
  now: Date = new Date()
): FollowUpEstimate {
  const followUpOffsets = offsets.filter((d) => d > 0);
  if (followUpOffsets.length === 0) {
    return {
      due: 0,
      confidence: threads.length === 0 ? "unknown" : "measured",
      caveat:
        "The sequence has no follow-up steps, so every send today is a first touch.",
    };
  }

  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let due = 0;
  for (const t of threads) {
    if (!t.pushedAt) continue;
    if (t.status && ENDED_STATUSES.has(t.status)) continue;
    const pushed = Date.parse(t.pushedAt);
    if (Number.isNaN(pushed)) continue;
    const pushedDay = Date.UTC(
      new Date(pushed).getUTCFullYear(),
      new Date(pushed).getUTCMonth(),
      new Date(pushed).getUTCDate()
    );
    const age = Math.round((startOfToday - pushedDay) / 86_400_000);
    if (age <= 0) continue; // pushed today: that was the first touch
    // One step per lead per day. A sequence with two steps on the same day is
    // refused by validatePlan, so this cannot silently under-count.
    if (followUpOffsets.includes(age)) due += 1;
  }

  return {
    due,
    confidence: "measured",
    caveat:
      "Worked out from when each lead was pushed and the live sequence timings. " +
      "Instantly only sends inside the campaign schedule, so a step falling on a " +
      "non-sending day moves to the next one — real follow-ups drift a little later " +
      "than this. Instantly's own daily limits remain the hard ceiling either way.",
  };
}

/* -------------------------------------------------------------------------- */
/* what the campaign will consume                                             */
/* -------------------------------------------------------------------------- */

export type Demand = {
  /**
   * STEADY-STATE PLANNING ONLY. NOT A DAILY DISPATCH CAP.
   *
   * How many new leads a day this capacity sustains once the pipeline is full
   * and every cohort is mid-sequence. It is the right number for deciding how
   * much to source and how large a reserve to hold, and the wrong number for
   * deciding how many to push today — see firstTouchCapacity, which is what
   * actually caps the push. Using this as a daily ceiling discarded hundreds
   * of sends a day on every day the follow-up load was light.
   */
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

/**
 * Below this much cover, the spacing between runs stops applying.
 *
 * Under a day of contacts means the next sending window opens before the next
 * scheduled run does. The inboxes then idle for a day, and a day of sending
 * capacity is not recoverable — unlike a slightly larger Google bill.
 */
export const URGENT_COVER_DAYS = 1;

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

/**
 * A hard ceiling on one purchase, whatever the arithmetic asks for.
 *
 * Sits above the per-run figure so a bad yield measurement costs a large
 * batch rather than an unbounded one, and is deliberately a constant rather
 * than a setting: the thing it protects against is a number somebody typed in
 * being wrong.
 */
export const ABSOLUTE_MAX_LEADS_PER_RUN = 3000;

/**
 * How big one sourcing run may be.
 *
 * `leads_per_run` defaults to 300, and four runs a day at six-hour spacing
 * caps sourcing at 1,200 businesses — about 120 qualified contacts at a 10%
 * yield. The campaign wants 212 a day. So the supply system was structurally
 * incapable of feeding the demand it had correctly calculated, and would have
 * sat permanently short however well every other part worked.
 *
 * The run is therefore sized against what a day actually consumes, not
 * against a stored number: enough to cover a day's intake in a single run at
 * the measured yield, or the operator's figure, whichever is larger. Still
 * one run at a time — the concurrency lock is untouched, and it is the lock
 * rather than the size that stops duplicate purchases.
 */
export function sourcingCeilingFor(configured: number, intakePerDay: number): number {
  const needed = Math.ceil(Math.max(0, intakePerDay) / ASSUMED_YIELD);
  return Math.min(ABSOLUTE_MAX_LEADS_PER_RUN, Math.max(configured, needed));
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

  /*
   * THE COOLDOWN YIELDS WHEN THE CAMPAIGN IS ABOUT TO RUN DRY.
   *
   * Six hours between runs exists so sourcing does not outpace the crawl that
   * turns leads into contacts. That is the right rule at four runs a day when
   * there is cover in hand — and the wrong one at 4am with under a day of
   * contacts left, because the next window opens before the next run does and
   * the inboxes sit idle for a day that cannot be got back.
   *
   * ONLY THE SPACING IS RELAXED, never the concurrency lock above it. Two runs
   * at once buy the same leads twice; two runs closer together than usual just
   * buy them sooner. Those are different risks and only the first is a real
   * one.
   */
  const urgent = daysOfCover < URGENT_COVER_DAYS;
  if (
    !urgent &&
    f.hoursSinceLastRun !== null &&
    f.hoursSinceLastRun < f.minHoursBetweenRuns
  ) {
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
  /**
   * TODAY's remaining first-touch capacity, from firstTouchCapacity — not the
   * steady-state intake. This parameter was `dailyIntakeCap` and was fed
   * capacity ÷ steps, which is what wasted the unused capacity.
   */
  firstTouchAllowed: number;
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

  /*
   * firstTouchAllowed already has today's sends subtracted, so `pushedToday`
   * is not deducted a second time — that would charge each push twice and
   * halve the day.
   */
  const dailyRoom = input.firstTouchAllowed;
  if (dailyRoom <= 0) {
    return {
      count: 0,
      reason:
        "Today's sending capacity is fully committed to follow-ups and emails already sent. More first touches would queue into tomorrow.",
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
        ? `all ${dailyRoom} first-touch sends today can still carry`
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
