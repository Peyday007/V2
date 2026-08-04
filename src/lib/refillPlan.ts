// How many leads to push, without being asked.
//
// The brief was for the campaign to keep itself fed rather than waiting for
// somebody to press a button. This is the arithmetic behind that, kept pure
// and separate from the pushing so the decision can be tested without a
// network — and so the reason it decided to push nothing is always a sentence
// somebody can read rather than a silent no-op.
//
// The thing this is really protecting is deliverability. A domain that goes
// from nothing to a thousand emails in an afternoon gets filtered, and a
// filtered domain does not recover — every sequence after that lands in spam
// regardless of how good it is. So every rule below is a ceiling, never a
// floor: the worst this can do is send less than it could have.

export type RefillInputs = {
  /** Off unless an administrator switched it on. */
  autoPushEnabled: boolean;
  /** The whole programme. Off means nothing happens at all. */
  programmeEnabled: boolean;
  /** Is there a campaign to push into? */
  campaignId: string | null;

  /**
   * How many leads Instantly says are in the campaign, or null when the count
   * could not be read. Null is treated as "do not push" — see below.
   */
  activeInCampaign: number | null;
  /** How many to keep alive in the campaign. */
  targetActive: number;

  /** The ceiling for one calendar day. */
  dailyCap: number;
  /** How many have already gone today. */
  pushedToday: number;

  /** How many leads are eligible right now. */
  eligible: number;
  /** The per-run cap that the manual button also respects. */
  maxPerRun: number;
};

export type RefillDecision = {
  /** How many to push. Zero is a normal answer. */
  count: number;
  /** Why, in words, whatever the answer. */
  reason: string;
};

export function planRefill(input: RefillInputs): RefillDecision {
  if (!input.programmeEnabled) {
    return { count: 0, reason: "The email programme is switched off." };
  }
  if (!input.autoPushEnabled) {
    return { count: 0, reason: "Automatic top-ups are switched off; pushing is manual." };
  }
  if (!input.campaignId) {
    return { count: 0, reason: "No campaign is selected." };
  }

  /*
   * A count we could not read is NOT zero.
   *
   * This is the one that would actually hurt. Instantly rate-limits, and a
   * failed count returning 0 would read as "the campaign is empty" and push a
   * full batch into a campaign that is already full — every day, on every
   * failure, until somebody noticed the send volume. Not knowing means not
   * pushing.
   */
  if (input.activeInCampaign === null) {
    return {
      count: 0,
      reason:
        "Could not read how many leads are in the campaign, so nothing was pushed. Pushing blind is how a campaign gets double-filled.",
    };
  }

  const room = input.targetActive - input.activeInCampaign;
  if (room <= 0) {
    return {
      count: 0,
      reason: `The campaign already holds ${input.activeInCampaign} of a target ${input.targetActive}.`,
    };
  }

  const dailyRoom = input.dailyCap - input.pushedToday;
  if (dailyRoom <= 0) {
    return {
      count: 0,
      reason: `Today's cap of ${input.dailyCap} is used up. It resets tomorrow.`,
    };
  }

  if (input.eligible <= 0) {
    return { count: 0, reason: "No leads are eligible to email right now." };
  }

  // The smallest of every ceiling. Deliberately written out rather than a
  // chained Math.min, so which one bit is visible in the reason.
  const count = Math.min(room, dailyRoom, input.eligible, input.maxPerRun);
  const binding =
    count === room
      ? `topping the campaign up to ${input.targetActive}`
      : count === dailyRoom
        ? `what is left of today's cap of ${input.dailyCap}`
        : count === input.eligible
          ? "every eligible lead there is"
          : `the per-run cap of ${input.maxPerRun}`;

  return { count, reason: `Pushing ${count} — ${binding}.` };
}

/**
 * Has the daily counter rolled over?
 *
 * Compared as calendar dates rather than by elapsed hours: a cap that resets
 * 24 hours after the last push drifts later every day and eventually sends in
 * the middle of the night, which is both worse for replies and a good way to
 * look automated.
 */
export function dailyCounterFor(
  stored: { pushedToday: number; pushedTodayDate: string | null },
  today: string
): number {
  return stored.pushedTodayDate === today ? stored.pushedToday : 0;
}

/** Today, as a date string, in the same shape Postgres stores a `date`. */
export function todayString(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
