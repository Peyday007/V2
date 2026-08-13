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

export type FunnelDecision =
  | { act: "wait"; reason: string }
  | { act: "enrich"; reason: string }
  | { act: "source"; reason: string };

/*
 * WHERE decideFunnel WENT.
 *
 * This module used to hold the sourcing decision too: compare the eligible
 * count against a flat `refillWhenBelow` of 200, and — the fatal line —
 * return "enrich" whenever ANY lead was awaiting enrichment, before the
 * sourcing branch could be reached.
 *
 * That second rule was right when the backlog could produce what was needed
 * in time and catastrophic when it could not. 935 leads whose websites will
 * never name a human kept "awaiting enrichment" above zero permanently, so
 * the gate never opened and no replacement lead was bought again. Meanwhile
 * the flat 200 had no relationship to what the inboxes could carry.
 *
 * The replacement is supplyPlan.planSupply, which asks how many SENDING DAYS
 * of qualified contacts are in hand and lets enrichment and sourcing run
 * together when the backlog cannot arrive in time. Deleted rather than left
 * exported and unused: a pure function nothing calls is the same trap as a
 * setting nobody turns on.
 */

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
