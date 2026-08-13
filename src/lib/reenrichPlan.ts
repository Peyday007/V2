// Which leads would actually gain something from being enriched again.
//
// WHY THIS EXISTS, because the reason is the whole design:
//
// 728 leads were enriched, successfully, on 27 July. The code that reads an
// email address off a business's website landed on 4 August. So did the deeper
// diagnostic. Nothing failed and nothing is stuck in a queue — those leads were
// enriched against a version of the application that had no idea how to collect
// any of it.
//
// The result is a thousand leads that are callable and empty: no email, so the
// cold-email programme has nobody to write to; no diagnostic, so every packet
// falls back to the same "you are missing calls" copy; no owner name, so every
// call opens by asking a gatekeeper who the owner is.
//
// Re-running enrichment fixes all three in one pass. This module decides who is
// worth re-running and, just as importantly, who is not.
//
// WHAT IT DELIBERATELY DOES NOT PROMISE: a direct number. That comes only from
// a paid contact provider, and with none configured a re-run cannot produce
// one. Saying otherwise on the button would be the same lie as the packet
// telling an owner we checked something we never looked at.
//
// Pure. No database, no network.

/** The three things a re-run can actually add. */
export type MissingThing =
  /** No address, so this lead cannot be emailed at all. */
  | "email"
  /** No findings, so their packet is the generic one. */
  | "diagnostic"
  /** Nobody to ask for, so the call opens blind. */
  | "decision_maker";

export type ReenrichLead = {
  id: string;
  business_name?: string | null;
  website?: string | null;
  website_email?: string | null;
  direct_email?: string | null;
  owner_email?: string | null;
  diagnostic_findings?: unknown[] | null;
  decision_maker_name?: string | null;
  owner_name?: string | null;
  do_not_call?: boolean | null;
  archived_at?: string | null;
  /**
   * How many times enrichment has already been run against this lead.
   * Absent until 0044 is run, which reads as zero — the old behaviour, so an
   * unrun migration degrades to "keep trying" rather than "give up on
   * everything".
   */
  enrich_attempts?: number | null;
};

/**
 * The reasons a lead is left alone, in the words the page shows.
 *
 * Counted and reported rather than silently filtered: "queued 340 of 1000" is
 * only trustworthy if the other 660 can be accounted for.
 */
export type SkipReason =
  | "Already has everything"
  | "On the do-not-call list"
  | "Binned"
  | "Enrichment has been tried enough";

/**
 * How many times a lead is re-crawled before it is left alone.
 *
 * THE SECOND HALF OF THE DEADLOCK. Enrichment retried every lead every day,
 * forever, with no ceiling. A one-van business whose website names no human
 * will not name one tomorrow either — but it stayed "awaiting enrichment"
 * permanently, and sourcing was gated behind that number reaching zero, so
 * the system spent every day re-crawling sites that could not help it and
 * never bought a replacement.
 *
 * Three passes is enough to cover a site that was down, a crawl that timed
 * out, and one genuine retry. After that the lead is not deleted and not
 * archived — it stays callable, it just stops being counted as outstanding
 * work, which lets the funnel go and source a replacement instead.
 */
export const MAX_ENRICH_ATTEMPTS = 3;

export function whatIsMissing(lead: ReenrichLead): MissingThing[] {
  const missing: MissingThing[] = [];

  // Any address counts. A lead with a provider-supplied direct_email does not
  // need the crawl to go looking for one.
  const hasEmail =
    !!(lead.direct_email || "").trim() ||
    !!(lead.owner_email || "").trim() ||
    !!(lead.website_email || "").trim();
  if (!hasEmail) missing.push("email");

  // An empty array is not a diagnosis. It is what a lead looks like when the
  // column exists and nothing has ever written to it.
  if (!Array.isArray(lead.diagnostic_findings) || lead.diagnostic_findings.length === 0) {
    missing.push("diagnostic");
  }

  const hasPerson =
    !!(lead.decision_maker_name || "").trim() || !!(lead.owner_name || "").trim();
  if (!hasPerson) missing.push("decision_maker");

  return missing;
}

/**
 * Why this lead is being skipped, or null when it should be queued.
 *
 * Suppression is checked FIRST and separately from "has everything". Somebody
 * on the do-not-call list must not have their website crawled again on our
 * behalf: they asked us to stop, and quietly continuing to gather data about
 * them is not honouring that just because no message is sent at the end of it.
 */
export function skipReasonFor(lead: ReenrichLead): SkipReason | null {
  if (lead.archived_at) return "Binned";
  if (lead.do_not_call) return "On the do-not-call list";
  if (whatIsMissing(lead).length === 0) return "Already has everything";
  if ((lead.enrich_attempts ?? 0) >= MAX_ENRICH_ATTEMPTS) {
    return "Enrichment has been tried enough";
  }
  return null;
}

/**
 * Does this lead still stand a chance of becoming someone we can email?
 *
 * The number the funnel must gate on. "Missing something" and "still worth
 * working" are different questions, and answering the first when you meant
 * the second is what held sourcing shut for months: a lead is missing a name
 * forever, but it is only worth another crawl a few times.
 *
 * A lead with no website can never gain an address from a free crawl, so it
 * is not counted here however few attempts it has had.
 */
export function stillEnrichable(lead: ReenrichLead): boolean {
  if (skipReasonFor(lead) !== null) return false;
  const missing = whatIsMissing(lead);
  const needsCrawl = missing.includes("email") || missing.includes("decision_maker");
  if (!needsCrawl) return false;
  return !!(lead.website || "").trim();
}

/** How many leads are genuinely still workable, for the supply decision. */
export function countStillEnrichable(leads: ReenrichLead[]): number {
  let n = 0;
  for (const l of leads) if (stillEnrichable(l)) n += 1;
  return n;
}

/**
 * How much this lead stands to gain, for ordering.
 *
 * A lead with a website gains the most: the crawl can read an address off the
 * contact page and the diagnostic has real signals to work from. One without a
 * website still gains a diagnosis — "no website on your listing" is itself a
 * finding, and a strong one — but it can never gain an email, so it goes last.
 */
export function gainScore(lead: ReenrichLead): number {
  const missing = whatIsMissing(lead);
  const hasSite = !!(lead.website || "").trim();
  let score = missing.length;
  if (hasSite && missing.includes("email")) score += 3;
  if (hasSite && missing.includes("diagnostic")) score += 1;
  return score;
}

/**
 * A cap, because this queues real work against real websites.
 *
 * The batch is bounded for the same reason the email push is: a mistake should
 * cost a batch, not the whole list. Pressing the button again tomorrow picks up
 * where it left off, and the leads that gain most are already at the front.
 */
export const MAX_BATCH = 400;
export const DEFAULT_BATCH = 200;

export type ReenrichPlan = {
  queue: { id: string; missing: MissingThing[] }[];
  skipped: { reason: SkipReason; count: number }[];
  /** Eligible but over the cap — waiting for the next press. */
  waiting: number;
  /** What the button should say afterwards. */
  summary: string;
};

export function planReenrichment(leads: ReenrichLead[], limit = DEFAULT_BATCH): ReenrichPlan {
  const cap = Math.max(1, Math.min(Math.round(limit) || DEFAULT_BATCH, MAX_BATCH));

  const skips = new Map<SkipReason, number>();
  const eligible: { lead: ReenrichLead; missing: MissingThing[]; score: number }[] = [];

  for (const lead of leads) {
    const skip = skipReasonFor(lead);
    if (skip) {
      skips.set(skip, (skips.get(skip) || 0) + 1);
      continue;
    }
    eligible.push({ lead, missing: whatIsMissing(lead), score: gainScore(lead) });
  }

  eligible.sort((a, b) => b.score - a.score);
  const taken = eligible.slice(0, cap);

  const counts = { email: 0, diagnostic: 0, decision_maker: 0 };
  for (const e of taken) for (const m of e.missing) counts[m] += 1;

  const bits: string[] = [];
  if (counts.email) bits.push(`${counts.email} with no email address`);
  if (counts.diagnostic) bits.push(`${counts.diagnostic} with no diagnosis`);
  if (counts.decision_maker) bits.push(`${counts.decision_maker} with nobody named`);

  const summary =
    taken.length === 0
      ? "Nothing to re-enrich — every lead already has an address, a diagnosis and a name."
      : `Queued ${taken.length} lead${taken.length === 1 ? "" : "s"} — ${bits.join(", ")}. ` +
        `They are worked by the background worker, so nothing changes on this page immediately.`;

  return {
    queue: taken.map((e) => ({ id: e.lead.id, missing: e.missing })),
    skipped: [...skips.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    waiting: Math.max(0, eligible.length - taken.length),
    summary,
  };
}

/**
 * One key per lead per day.
 *
 * Pressing the button twice in an afternoon must not queue the work twice —
 * enqueue() rejects a duplicate key and returns false, so the second press is
 * a no-op that reports honestly. Tomorrow it can run again, which is what makes
 * this usable as "chip away at the backlog" rather than a one-shot.
 */
export function reenrichKey(leadId: string, today: Date = new Date()): string {
  return `reenrich:${leadId}:${today.toISOString().slice(0, 10)}`;
}
