// How many leads a day the inboxes can actually carry, and when an account is
// ready to carry more.
//
// Two separate jobs, kept in one file because they share the same arithmetic
// and the same instinct: the sending accounts are the real constraint on a
// cold-email programme, and a number somebody typed into a box months ago is
// not that constraint.
//
// Pure. No network. Both decisions are testable, and both explain themselves
// in words, because "it didn't send as much as I expected" and "why did it
// change my account" are the two questions that will be asked.

export type SendingAccount = {
  email: string;
  /** What Instantly is currently allowed to send from this inbox per day. */
  dailyLimit: number;
  /** Instantly's own health score, 0-100. Below ~75 means real problems. */
  warmupScore: number | null;
  /** Their warmup state, as reported. */
  warmupStatus: string | null;
  /** True when the account is active and able to send. */
  active: boolean;
  /** When the inbox was added, so age can be judged. */
  createdAt: string | null;
  /** Bounces attributed to this inbox in the recent window. */
  recentBounces?: number;
  /** Sends attributed to this inbox in the same window. */
  recentSends?: number;
  /** When WE last changed this account's limit. */
  lastRaisedAt?: string | null;
};

/* -------------------------------------------------------------------------- */
/* how much can actually go out                                               */
/* -------------------------------------------------------------------------- */

/**
 * Deliberately not 100%.
 *
 * The accounts also carry replies, the odd manual send, and Instantly's own
 * retries. Planning to use every last slot means the first busy day silently
 * queues into the next one, and a sequence that slips a day stops being the
 * sequence anybody reviewed.
 */
export const DEFAULT_HEADROOM = 0.85;

export type Capacity = {
  /** Emails per day the healthy, active accounts can send between them. */
  dailySends: number;
  /** After headroom. This is the number to plan against. */
  usableSends: number;
  accountsCounted: number;
  accountsIgnored: number;
  /** The campaign's own daily limit, when it is known. */
  campaignDailyLimit: number | null;
  /** True when the campaign's limit — not the inboxes — is what decides. */
  cappedByCampaign: boolean;
  reason: string;
};

/**
 * What the inboxes can carry.
 *
 * An account that is inactive, or whose warmup score says it is in trouble, is
 * left out of the total entirely rather than counted at a discount. Capacity
 * you cannot safely use is not capacity, and including it produces a plan that
 * overruns the accounts that ARE healthy.
 */
export const MIN_HEALTHY_WARMUP = 75;

/**
 * THE CAMPAIGN HAS ITS OWN LIMIT, AND IT IS USUALLY THE ONE THAT DECIDES.
 *
 * Instantly caps sending in two independent places: each inbox has a daily
 * limit, and the campaign has a daily limit of its own — "max number of emails
 * to send per day for this campaign". Whichever is lower wins, and Instantly
 * spreads the campaign's allowance across the inboxes assigned to it.
 *
 * Leaving it out is not a rounding error. Eighteen inboxes at 90 sums to 1620,
 * which reads as a programme sending well over a thousand emails a day; if the
 * campaign is set to 60, sixty is what goes out, and each inbox shows three or
 * four sends against a limit of ninety. Every number derived from the total —
 * the leads-per-day cap, the top-up size — is then wrong by the same factor,
 * and it is wrong in the dangerous direction: it pushes leads faster than they
 * can be mailed, so the backlog grows forever and nobody can see why.
 *
 * Pass null when it genuinely is not known. The total then falls back to the
 * inbox sum, exactly as before, and the reason says the limit was not read
 * rather than implying it was checked.
 */
export function computeCapacity(
  accounts: SendingAccount[],
  headroom = DEFAULT_HEADROOM,
  campaignDailyLimit: number | null = null
): Capacity {
  let accountSends = 0;
  let counted = 0;
  let ignored = 0;

  for (const a of accounts) {
    const healthy =
      a.active && (a.warmupScore === null || a.warmupScore >= MIN_HEALTHY_WARMUP);
    if (!healthy || a.dailyLimit <= 0) {
      ignored += 1;
      continue;
    }
    accountSends += a.dailyLimit;
    counted += 1;
  }

  const limit =
    campaignDailyLimit !== null && Number.isFinite(campaignDailyLimit) && campaignDailyLimit > 0
      ? Math.floor(campaignDailyLimit)
      : null;
  const cappedByCampaign = limit !== null && limit < accountSends;
  const dailySends = cappedByCampaign ? limit! : accountSends;

  const usableSends = Math.floor(dailySends * clamp(headroom, 0.1, 1));
  const inboxes = `${counted} inbox${counted === 1 ? "" : "es"}`;
  const ignoredNote = ignored > 0 ? ` ${ignored} left out as inactive or unhealthy.` : "";

  return {
    dailySends,
    usableSends,
    accountsCounted: counted,
    accountsIgnored: ignored,
    campaignDailyLimit: limit,
    cappedByCampaign,
    reason:
      counted === 0
        ? "No healthy sending accounts, so nothing can go out."
        : cappedByCampaign
          ? `The campaign is limited to ${limit} emails a day in Instantly, which is less than the ${accountSends} ${inboxes} could carry — so ${limit} is the real number, spread across the inboxes at about ${Math.max(1, Math.round(limit! / counted))} each. Planning against ${usableSends}. Raise it in Instantly under the campaign's Options if you want more.${ignoredNote}`
          : `${inboxes} can send ${dailySends}/day between them; planning against ${usableSends} to leave room for replies and retries.${ignoredNote}` +
            (limit === null
              ? " The campaign's own daily limit has not been read, so this assumes the inboxes are the only cap."
              : ` The campaign's limit of ${limit} a day is not the constraint.`),
  };
}

/* -------------------------------------------------------------------------- */
/* turning sends into leads                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How many NEW leads a day that capacity supports.
 *
 * THIS IS THE PIECE PEOPLE GET WRONG, so it is worth writing out. Pushing a
 * lead is not sending an email — a lead entering a 4-step sequence will send
 * four emails, spread over the following weeks.
 *
 * At steady state the arithmetic is simple. Push N leads every day into an
 * S-step sequence and, once the pipeline fills, every day you are sending:
 * today's cohort's first email, plus an older cohort's second, plus an older
 * one's third, and so on — N emails S times over. So:
 *
 *     daily sends = N × S        →        N = capacity ÷ S
 *
 * Which is why a cap somebody typed in is almost always wrong in one direction
 * or the other. With ten inboxes at 90 and a 4-step sequence the real number
 * is 191 leads a day; a hand-set 100 wastes nearly half the inboxes, and a
 * hand-set 400 quietly queues into tomorrow forever.
 *
 * The ramp-up period is deliberately not modelled. During the first S days the
 * pipeline is not full and this under-uses the accounts slightly. Planning for
 * the steady state and being under for a week is the right way round — the
 * other way overruns exactly when the accounts are newest.
 */
export function leadsPerDay(usableSends: number, sequenceSteps: number): number {
  const steps = Math.max(1, Math.floor(sequenceSteps || 1));
  return Math.max(0, Math.floor(usableSends / steps));
}

export type SmartCap = {
  leadsPerDay: number;
  capacity: Capacity;
  sequenceSteps: number;
  reason: string;
};

export function smartDailyCap(
  accounts: SendingAccount[],
  sequenceSteps: number,
  headroom = DEFAULT_HEADROOM,
  campaignDailyLimit: number | null = null
): SmartCap {
  const capacity = computeCapacity(accounts, headroom, campaignDailyLimit);
  const steps = Math.max(1, Math.floor(sequenceSteps || 1));
  const perDay = leadsPerDay(capacity.usableSends, steps);
  return {
    leadsPerDay: perDay,
    capacity,
    sequenceSteps: steps,
    reason:
      perDay === 0
        ? capacity.reason
        : `${capacity.usableSends} sends a day ÷ ${steps} emails per lead = ${perDay} new leads a day. ${capacity.reason}`,
  };
}

/* -------------------------------------------------------------------------- */
/* moving an account's own limit                                              */
/* -------------------------------------------------------------------------- */

export type RampPolicy = {
  /** Nothing goes above this. */
  ceiling: number;
  /** Days an inbox must exist before it is touched at all. */
  minAgeDays: number;
  /** Days between two changes to the same account. */
  cooldownDays: number;
  /** Warmup score below which an account is never raised. */
  minWarmupScore: number;
  /** Bounce rate above which an account is REDUCED. */
  maxBounceRate: number;
};

export const DEFAULT_RAMP: RampPolicy = {
  ceiling: 90,
  // Three weeks is the ordinary warmup period. An inbox younger than that has
  // no reputation to spend.
  minAgeDays: 21,
  cooldownDays: 2,
  minWarmupScore: 80,
  // Above 3% and the mailbox providers are already noticing.
  maxBounceRate: 0.03,
};

export type LimitChange = {
  email: string;
  from: number;
  to: number;
  direction: "raise" | "lower";
  reason: string;
};

/** No change, and why not. */
export type NoChange = { email: string; reason: string };

export type RampDecision = { change: LimitChange } | { hold: NoChange };

/**
 * The biggest single step worth taking.
 *
 * Half again, capped at twenty. Going 30 → 90 in one move is the thing that
 * actually burns a domain: mailbox providers score the RATE of change, not
 * just the volume, and a tripling overnight from an address that has been
 * sending thirty looks exactly like a compromised account.
 *
 * With these numbers 30 reaches the 90 ceiling in four moves — 30, 45, 65, 85,
 * 90 — which at a two-day cooldown is about eight days. That is the whole cost
 * of doing it safely, and it is worth stating on the page so nobody thinks it
 * is stuck.
 */
export function stepFor(current: number): number {
  return Math.min(20, Math.max(5, Math.round(current * 0.5)));
}

function ageDays(createdAt: string | null, now: Date): number | null {
  if (!createdAt) return null;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / 86_400_000;
}

function daysSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / 86_400_000;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Should this account's daily limit move, and to what?
 *
 * The order of the checks is the safety property, and it is the same shape as
 * every other decision in this system: everything that could make it send MORE
 * is gated hard, and the one thing that makes it send LESS runs first and is
 * gated barely at all.
 */
export function planLimitChange(
  account: SendingAccount,
  policy: RampPolicy = DEFAULT_RAMP,
  now: Date = new Date()
): RampDecision {
  const email = account.email;

  /* ------------------------------ come down ----------------------------- */
  /*
   * Checked before anything else, and before the cooldown, the age check and
   * the warmup check. An account that is bouncing is doing damage now, and
   * "wait two days, it is in cooldown" is not an answer to that.
   */
  const sends = account.recentSends ?? 0;
  const bounces = account.recentBounces ?? 0;
  // Under 20 sends a single bounce is 5% and means nothing. Acting on that
  // would sawtooth every new account down to nothing.
  if (sends >= 20) {
    const rate = bounces / sends;
    if (rate > policy.maxBounceRate) {
      const to = Math.max(10, Math.floor(account.dailyLimit * 0.5));
      if (to < account.dailyLimit) {
        return {
          change: {
            email,
            from: account.dailyLimit,
            to,
            direction: "lower",
            reason: `${bounces} bounces in ${sends} sends is ${(rate * 100).toFixed(1)}%, over the ${(policy.maxBounceRate * 100).toFixed(0)}% line. Halved to protect the domain.`,
          },
        };
      }
    }
  }

  /* ------------------------------- go up -------------------------------- */
  if (!account.active) {
    return { hold: { email, reason: "The account is not active in Instantly." } };
  }
  if (account.dailyLimit >= policy.ceiling) {
    return { hold: { email, reason: `Already at the ${policy.ceiling}/day ceiling.` } };
  }

  const age = ageDays(account.createdAt, now);
  if (age !== null && age < policy.minAgeDays) {
    return {
      hold: {
        email,
        reason: `Only ${Math.floor(age)} days old; inboxes are left alone for the first ${policy.minAgeDays} while they warm.`,
      },
    };
  }

  if (account.warmupScore !== null && account.warmupScore < policy.minWarmupScore) {
    return {
      hold: {
        email,
        reason: `Warmup score is ${account.warmupScore}, below ${policy.minWarmupScore}. Raising an inbox that is already struggling makes it worse.`,
      },
    };
  }

  const since = daysSince(account.lastRaisedAt, now);
  if (since !== null && since < policy.cooldownDays) {
    return {
      hold: {
        email,
        reason: `Raised ${since < 1 ? "today" : `${Math.floor(since)} day${Math.floor(since) === 1 ? "" : "s"} ago`}; ${policy.cooldownDays} days between steps so the new volume has time to settle.`,
      },
    };
  }

  const to = Math.min(policy.ceiling, account.dailyLimit + stepFor(account.dailyLimit));
  if (to <= account.dailyLimit) {
    return { hold: { email, reason: "Already as high as it goes." } };
  }

  const remaining = policy.ceiling - to;
  const moreSteps = remaining > 0 ? Math.ceil(remaining / stepFor(to)) : 0;
  return {
    change: {
      email,
      from: account.dailyLimit,
      to,
      direction: "raise",
      reason:
        `Warmed and quiet, so up from ${account.dailyLimit} to ${to}.` +
        (moreSteps > 0
          ? ` About ${moreSteps} more step${moreSteps === 1 ? "" : "s"} to reach ${policy.ceiling}.`
          : ` That is the ceiling.`),
    },
  };
}

/** Every account's decision in one pass, for the job and for the page. */
export function planAllLimits(
  accounts: SendingAccount[],
  policy: RampPolicy = DEFAULT_RAMP,
  now: Date = new Date()
): { changes: LimitChange[]; holds: NoChange[] } {
  const changes: LimitChange[] = [];
  const holds: NoChange[] = [];
  for (const a of accounts) {
    const d = planLimitChange(a, policy, now);
    if ("change" in d) changes.push(d.change);
    else holds.push(d.hold);
  }
  return { changes, holds };
}

/**
 * How long until everything is at the ceiling, roughly.
 *
 * Shown on the page so "why is it still 45" has an answer that is not "wait
 * and see". Counts the slowest account, since that is the one that decides.
 */
export function daysToCeiling(
  accounts: SendingAccount[],
  policy: RampPolicy = DEFAULT_RAMP
): number {
  let worst = 0;
  for (const a of accounts) {
    if (!a.active || a.dailyLimit >= policy.ceiling) continue;
    let limit = a.dailyLimit;
    let steps = 0;
    while (limit < policy.ceiling && steps < 50) {
      limit = Math.min(policy.ceiling, limit + stepFor(limit));
      steps += 1;
    }
    worst = Math.max(worst, steps);
  }
  return worst * policy.cooldownDays;
}
