// Is the sourcing run alive, and is it producing anything?
//
// WHY THIS EXISTS.
//
// The page said "A sourcing run is already going" while zero qualified
// contacts existed, zero were pushed, and 989 sends of capacity went unused.
// Both statements were true. The run WAS marked running. It had also been
// dead for days.
//
// `sourcing_campaigns.status` is a lock with no lease. The jobs table gets
// this right — claim_jobs reclaims any lease older than 300 seconds, so a
// worker that dies mid-job cannot wedge the queue. The campaign-level lock
// had no equivalent: it is set to 'running' when a run starts and cleared
// only by finishCampaignIfDone, which is only ever called from inside a job
// handler FOR THAT CAMPAIGN. Exhaust max_attempts on those jobs and nothing
// is left to clear it. The campaign stays 'running' forever, sourcingIsRunning
// keeps returning true, planSupply keeps returning hold, and no lead is ever
// sourced again.
//
// So "running" is not a status any more. It is a claim that has to be backed
// by recent progress, and this module is where that judgement lives — pure, so
// the stale-lock rules can be tested without a database or a dead job.

/* -------------------------------------------------------------------------- */
/* how long is too long                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Minutes without progress before a run is presumed dead.
 *
 * A Places search plus its pagination takes seconds; enrichment of a batch
 * takes minutes. Thirty minutes is comfortably longer than any single step and
 * far shorter than the days this run sat wedged.
 */
export const STALE_AFTER_MINUTES = 30;

/**
 * Minutes before a run that never moved at all is presumed dead on arrival.
 *
 * Shorter than STALE_AFTER_MINUTES on purpose: a run that has completed a
 * search has demonstrated the machinery works and deserves patience, while one
 * that has not moved since it was created has usually failed to enqueue.
 */
export const NEVER_STARTED_AFTER_MINUTES = 15;

/* -------------------------------------------------------------------------- */
/* the live state of a run                                                    */
/* -------------------------------------------------------------------------- */

/** Every counter the run keeps, as stored on sourcing_campaigns. */
export type RunCounters = {
  searchesPlanned: number;
  searchesCompleted: number;
  apiRequestsUsed: number;
  businessesReturned: number;
  uniqueSaved: number;
  duplicatesSkipped: number;
  qualificationFailures: number;
  enrichmentQueued: number;
  errorCount: number;
  lastError: string | null;
};

export type RunFacts = {
  id: string;
  name: string;
  status: string;
  startedAt: string | null;
  /** Any write to the row. The heartbeat. */
  updatedAt: string | null;
  counters: RunCounters;
};

export type RunState =
  /** Moving. Counters advanced recently. */
  | "progressing"
  /** Marked running, but nothing has changed for a long time. Dead. */
  | "stalled"
  /** Marked running and never moved at all. Failed to start. */
  | "never_started"
  /** Not running. Nothing to judge. */
  | "not_running";

export type RunAssessment = {
  state: RunState;
  /** Minutes since anything about this run changed. Null when unknown. */
  minutesSinceProgress: number | null;
  minutesSinceStart: number | null;
  /** Should the lock be released so sourcing can start again? */
  shouldRecover: boolean;
  /** Whether this run may block a new one. */
  blocksNewRun: boolean;
  reason: string;
};

function minutesBetween(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 60_000));
}

/**
 * Is this run alive?
 *
 * THE RULE: a lock only counts while it is backed by progress. `updated_at` is
 * the heartbeat — every counter increment writes the row — so a run whose row
 * has not changed in half an hour is not working, whatever its status column
 * says.
 *
 * Erring toward recovery is safe here and erring toward patience is not. A run
 * wrongly recovered starts a second search and buys some duplicate leads,
 * which dedup discards. A run wrongly trusted stops the entire pipeline
 * indefinitely, which is what happened.
 */
export function assessRun(run: RunFacts | null, now: Date = new Date()): RunAssessment {
  if (!run || run.status !== "running") {
    return {
      state: "not_running",
      minutesSinceProgress: null,
      minutesSinceStart: null,
      shouldRecover: false,
      blocksNewRun: false,
      reason: "No sourcing run is marked as running.",
    };
  }

  const sinceProgress = minutesBetween(run.updatedAt, now);
  const sinceStart = minutesBetween(run.startedAt, now);
  const moved = run.counters.searchesCompleted > 0 || run.counters.uniqueSaved > 0;

  /*
   * Never moved. The usual cause is the plan_search_tasks job failing every
   * attempt — a bad Places key, an exhausted quota — after which the campaign
   * row is left marked running with every counter at zero and nothing alive to
   * correct it.
   */
  if (!moved) {
    const waited = sinceStart ?? sinceProgress ?? 0;
    if (waited >= NEVER_STARTED_AFTER_MINUTES) {
      return {
        state: "never_started",
        minutesSinceProgress: sinceProgress,
        minutesSinceStart: sinceStart,
        shouldRecover: true,
        blocksNewRun: false,
        reason:
          `"${run.name}" was started ${waited} minutes ago and has completed no searches and saved no leads. ` +
          (run.counters.lastError
            ? `Its last error was: ${run.counters.lastError}`
            : "It never got going — the search jobs are failing or were never queued.") +
          " Releasing it so sourcing can start again.",
      };
    }
    return {
      state: "progressing",
      minutesSinceProgress: sinceProgress,
      minutesSinceStart: sinceStart,
      shouldRecover: false,
      blocksNewRun: true,
      reason: `"${run.name}" started ${waited} minutes ago and is still getting going.`,
    };
  }

  if (sinceProgress !== null && sinceProgress >= STALE_AFTER_MINUTES) {
    return {
      state: "stalled",
      minutesSinceProgress: sinceProgress,
      minutesSinceStart: sinceStart,
      shouldRecover: true,
      blocksNewRun: false,
      reason:
        `"${run.name}" is marked running but nothing has changed for ${sinceProgress} minutes ` +
        `(${run.counters.searchesCompleted} of ${run.counters.searchesPlanned} searches done, ` +
        `${run.counters.uniqueSaved} leads saved). ` +
        (run.counters.lastError ? `Last error: ${run.counters.lastError}. ` : "") +
        "Treating it as dead and releasing the lock.",
    };
  }

  return {
    state: "progressing",
    minutesSinceProgress: sinceProgress,
    minutesSinceStart: sinceStart,
    shouldRecover: false,
    blocksNewRun: true,
    reason:
      `"${run.name}" is working — ${run.counters.searchesCompleted} of ${run.counters.searchesPlanned} ` +
      `searches done, ${run.counters.uniqueSaved} leads saved` +
      (sinceProgress !== null ? `, last progress ${sinceProgress} minutes ago.` : "."),
  };
}

/* -------------------------------------------------------------------------- */
/* the one-line production status                                             */
/* -------------------------------------------------------------------------- */

export type ProductionStatus =
  | "QUALIFIED CONTACTS READY"
  | "SOURCING AND MAKING PROGRESS"
  | "SOURCING STALLED"
  | "PROVIDER BLOCKED"
  | "ENRICHMENT PRODUCING ZERO"
  | "IDLE — NOTHING TO DO";

export type StatusFacts = {
  qualifiedReady: number;
  run: RunAssessment;
  /** Leads sourced that enrichment has finished with, one way or the other. */
  enrichmentResolved: number;
  /** Of those, how many became a personal address with a name. */
  enrichmentQualified: number;
  /** A provider that is refusing to work at all: missing key, quota, auth. */
  providerBlocker: string | null;
  /** Is the operator asking for more supply at all? */
  sourcingEnabled: boolean;
};

export type StatusReport = {
  status: ProductionStatus;
  /** The numbers behind it, so the headline is never bare. */
  detail: string;
  /** True when a person has to do something. */
  needsHuman: boolean;
};

/**
 * One line that says what the machine is actually doing.
 *
 * Ordered by what a reader most needs to know. A blocked provider outranks a
 * stalled run because it explains it; a stalled run outranks "enrichment
 * produced nothing" for the same reason. Contacts being ready outranks
 * everything, because when supply exists the rest is detail.
 */
export function productionStatus(f: StatusFacts): StatusReport {
  if (f.providerBlocker) {
    return {
      status: "PROVIDER BLOCKED",
      detail: f.providerBlocker,
      needsHuman: true,
    };
  }

  if (f.run.state === "stalled" || f.run.state === "never_started") {
    return {
      status: "SOURCING STALLED",
      detail: f.run.reason,
      // Recovered automatically on the next tick, so not a human's problem
      // unless it keeps happening — which the reason above will show.
      needsHuman: false,
    };
  }

  if (f.qualifiedReady > 0) {
    return {
      status: "QUALIFIED CONTACTS READY",
      detail: `${f.qualifiedReady} contacts have a personal address and a name on record, ready to push.`,
      needsHuman: false,
    };
  }

  /*
   * Sourcing worked and enrichment produced nothing usable. A real and
   * separate failure from sourcing being stuck: leads arrived, the crawl ran,
   * and not one of them yielded a named person with a direct address.
   *
   * The sample floor matters. Three leads yielding nothing is noise; a hundred
   * yielding nothing is a broken enrichment path or a lead source that only
   * ever returns businesses with no website.
   */
  const ZERO_YIELD_SAMPLE = 25;
  if (f.enrichmentResolved >= ZERO_YIELD_SAMPLE && f.enrichmentQualified === 0) {
    return {
      status: "ENRICHMENT PRODUCING ZERO",
      detail:
        `${f.enrichmentResolved} leads have been through enrichment and none produced a personal ` +
        `address with a name. The crawl is running but finding nothing usable — check that the ` +
        `sourced businesses actually have websites, and that the enrichment provider is answering.`,
      needsHuman: true,
    };
  }

  if (f.run.state === "progressing") {
    return {
      status: "SOURCING AND MAKING PROGRESS",
      detail: f.run.reason,
      needsHuman: false,
    };
  }

  return {
    status: "IDLE — NOTHING TO DO",
    detail: f.sourcingEnabled
      ? "No qualified contacts and no sourcing run in progress. The next hourly check will start one."
      : "No qualified contacts, and automatic sourcing is switched off so nothing will find more.",
    needsHuman: !f.sourcingEnabled,
  };
}
