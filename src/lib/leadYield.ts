// How many businesses to search for, given that a lot of them get discarded.
//
// The engine used to stop the moment it had SAVED the number of businesses you
// asked for. But saving is not the finish line: a saved business still has to
// survive qualification (big enough to answer its own phone, small enough that
// the owner takes the call, actually open) and enrichment (a phone number we
// can dial). Roughly half do not. Asking for 100 produced about 40 callable
// leads, and the operator had to learn to ask for double.
//
// This module decides when to stop by projecting how many CALLABLE leads the
// current haul will turn into, using the yield actually observed in this
// campaign rather than a guess.
//
// Pure functions: no database, so the rule is testable.

export type YieldInput = {
  /** Callable leads the operator asked for. */
  target: number;
  /** Reached a good terminal state: ready, in a packet, or already called. */
  callable: number;
  /** Reached a bad terminal state: unusable or archived. */
  discarded: number;
  /** Saved, but the engine has not finished with them yet. */
  inFlight: number;
};

export type YieldDecision = {
  keepSearching: boolean;
  /** The rate this campaign is actually converting at, once it is knowable. */
  observedYield: number | null;
  /** The rate used for the projection — observed once trustworthy, else the default. */
  appliedYield: number;
  /** Callable leads we expect to end up with if we stop searching now. */
  projectedCallable: number;
  /** Callable leads still to find. Zero when the projection covers the target. */
  stillNeeded: number;
  /** Plain-language explanation, safe to show and to log. */
  reason: string;
};

/**
 * What we assume before this campaign has told us anything. Deliberately
 * conservative: over-searching costs a few API requests, under-searching costs
 * the operator a day.
 */
export const DEFAULT_YIELD = 0.5;

/** Below this many finished leads, the observed rate is noise. */
export const MIN_SAMPLE_FOR_OBSERVED = 25;

/**
 * Never project on a yield lower than this. A bad early patch — one metro with
 * no websites, say — must not send the engine searching without limit. The
 * campaign's API request cap is the hard stop; this keeps it from being reached
 * in the first place.
 */
export const MIN_APPLIED_YIELD = 0.15;

export function decideSearching(input: YieldInput): YieldDecision {
  const { target, callable, discarded, inFlight } = input;
  const processed = callable + discarded;

  const observedYield = processed > 0 ? callable / processed : null;

  const appliedYield =
    processed >= MIN_SAMPLE_FOR_OBSERVED && observedYield !== null
      ? Math.max(MIN_APPLIED_YIELD, observedYield)
      : DEFAULT_YIELD;

  // Everything still in flight is expected to convert at the applied rate.
  const projectedCallable = callable + inFlight * appliedYield;
  const stillNeeded = Math.max(0, Math.ceil(target - projectedCallable));

  if (callable >= target) {
    return {
      keepSearching: false,
      observedYield,
      appliedYield,
      projectedCallable,
      stillNeeded: 0,
      reason: `target reached: ${callable} callable leads`,
    };
  }

  if (stillNeeded === 0) {
    return {
      keepSearching: false,
      observedYield,
      appliedYield,
      projectedCallable,
      stillNeeded: 0,
      reason:
        `enough in hand: ${callable} callable plus ${inFlight} still processing ` +
        `projects to ${Math.round(projectedCallable)} at the ${Math.round(appliedYield * 100)}% ` +
        `rate this campaign is running at`,
    };
  }

  return {
    keepSearching: true,
    observedYield,
    appliedYield,
    projectedCallable,
    stillNeeded,
    reason:
      `${stillNeeded} more callable leads needed — ${callable} callable so far, ` +
      `${inFlight} still processing, projecting ${Math.round(projectedCallable)} of ${target}`,
  };
}

/**
 * How many raw businesses to go and find to end up with `stillNeeded` callable
 * ones. Used only for display, so the operator can see why the engine is still
 * running.
 */
export function rawBusinessesNeeded(stillNeeded: number, appliedYield: number): number {
  if (stillNeeded <= 0) return 0;
  return Math.ceil(stillNeeded / Math.max(MIN_APPLIED_YIELD, appliedYield));
}

/**
 * Progress toward the goal the operator actually set. Counts callable leads,
 * not saved businesses, so the bar cannot read 100% while the packet is empty.
 */
export function callableProgressPercent(callable: number, target: number): number {
  if (target <= 0) return 100;
  return Math.min(100, Math.round((callable / target) * 100));
}
