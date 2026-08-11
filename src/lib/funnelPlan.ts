// When to go and get more leads, and what to search for.
//
// WHY THIS EXISTS. Every switch downstream of here was already on and correct.
// The email top-up ran every minute and reported, accurately, "No leads are
// eligible to email right now" — because a sourcing campaign runs to its
// target and then completes forever, and nothing ever starts another one. The
// supply of leads was a series of one-off manual events, so the programme went
// quiet the moment the last batch was spent.
//
// Pure. No database, no Google, no network. The decision of whether to spend
// money at Google is exactly the sort of thing that has to be testable without
// spending money at Google.
//
// THE ORDER OF THE CHECKS IS THE SAFETY PROPERTY, and it is the same shape as
// every other decision in this codebase: everything that could cause a SPEND
// is gated hard, and every reason not to spend is checked first.

export type FunnelFacts = {
  /** The switch. Nothing happens while this is false. */
  enabled: boolean;
  /** Leads with an address that have not been pushed yet. */
  eligibleToEmail: number;
  /** Go looking when the pool drops below this. */
  refillWhenBelow: number;
  /**
   * Leads already in hand that have never been through enrichment, or whose
   * enrichment predates the code that reads addresses.
   *
   * THE MOST IMPORTANT FIELD HERE. Buying more leads while hundreds sit
   * un-enriched is paying Google to solve a problem that a free crawl already
   * solves. Enrichment always goes first.
   */
  awaitingEnrichment: number;
  /** A sourcing campaign already running. Two at once helps nobody. */
  sourcingRunning: boolean;
  /** Hours since the last automatic run, or null if there has never been one. */
  hoursSinceLastRun: number | null;
  minHoursBetweenRuns: number;
};

export type FunnelDecision =
  | { act: "wait"; reason: string }
  | { act: "enrich"; reason: string }
  | { act: "source"; reason: string };

/**
 * Should anything happen, and what?
 *
 * Never throws, never returns "source" on a technicality. Every branch says
 * why in a sentence somebody can read on the page, because "nothing happened
 * and nobody knows why" is the failure this whole area keeps producing.
 */
export function decideFunnel(f: FunnelFacts): FunnelDecision {
  if (!f.enabled) {
    return {
      act: "wait",
      reason:
        "Automatic lead sourcing is switched off, so the pool is only topped up when somebody starts a run by hand.",
    };
  }

  if (f.eligibleToEmail >= f.refillWhenBelow) {
    return {
      act: "wait",
      reason: `${f.eligibleToEmail} leads are still waiting to be emailed, which is above the ${f.refillWhenBelow} mark. Nothing needed.`,
    };
  }

  /*
   * ENRICH BEFORE BUYING. Always.
   *
   * A lead already in the database with no address is a free crawl away from
   * being emailable. A new lead from Google costs money AND still needs the
   * same crawl afterwards. Sourcing while there is enrichment outstanding is
   * paying to make a queue longer.
   */
  if (f.awaitingEnrichment > 0) {
    return {
      act: "enrich",
      reason: `${f.eligibleToEmail} leads left to email, but ${f.awaitingEnrichment} leads already here have never been through enrichment. Working those first — they are free, and buying more before they are done would be paying to lengthen the queue.`,
    };
  }

  if (f.sourcingRunning) {
    return {
      act: "wait",
      reason: "A sourcing run is already going. Waiting for it rather than starting a second.",
    };
  }

  if (f.hoursSinceLastRun !== null && f.hoursSinceLastRun < f.minHoursBetweenRuns) {
    const wait = Math.ceil(f.minHoursBetweenRuns - f.hoursSinceLastRun);
    return {
      act: "wait",
      reason: `The last automatic run was ${Math.floor(f.hoursSinceLastRun)}h ago. Leaving at least ${f.minHoursBetweenRuns}h between them, so the next one is in about ${wait}h. Leads found now still have to be enriched before they can be emailed, and a run every few minutes would spend money faster than the crawl can turn it into addresses.`,
    };
  }

  return {
    act: "source",
    reason: `Only ${f.eligibleToEmail} leads left to email and nothing waiting to be enriched, so the pool needs refilling from Google.`,
  };
}

/* -------------------------------------------------------------------------- */
/* what to search for next                                                    */
/* -------------------------------------------------------------------------- */

export type SearchedPair = { trade: string; metro: string; at: string };

/**
 * The next trade and place worth asking Google about.
 *
 * Moves through the grid rather than repeating: asking for plumbers in Dallas
 * a second time returns mostly the same businesses, every one of which is
 * dropped as a duplicate — so it is a page of API requests bought to add
 * nothing. Least-recently-searched first means the run always spends on the
 * corner of the grid most likely to hold businesses we do not have.
 *
 * Returns null when every combination has been searched inside the cooling
 * period, which is a real answer and not a failure: it means the grid is
 * exhausted for now and somebody should widen the trades or the metros rather
 * than the system quietly buying the same leads again.
 */
export function nextSearchTarget(
  trades: string[],
  metros: string[],
  history: SearchedPair[],
  now: Date = new Date(),
  cooldownDays = 30
): { trade: string; metro: string } | null {
  if (trades.length === 0 || metros.length === 0) return null;

  const lastSeen = new Map<string, number>();
  for (const h of history) {
    const key = `${h.trade}|${h.metro}`;
    const t = Date.parse(h.at);
    if (Number.isNaN(t)) continue;
    lastSeen.set(key, Math.max(lastSeen.get(key) ?? 0, t));
  }

  const cutoff = now.getTime() - cooldownDays * 86_400_000;
  let best: { trade: string; metro: string; at: number } | null = null;

  for (const trade of trades) {
    for (const metro of metros) {
      const at = lastSeen.get(`${trade}|${metro}`) ?? 0;
      // Never searched wins outright, and wins immediately.
      if (at === 0) return { trade, metro };
      if (at > cutoff) continue;
      if (!best || at < best.at) best = { trade, metro, at };
    }
  }

  return best ? { trade: best.trade, metro: best.metro } : null;
}
