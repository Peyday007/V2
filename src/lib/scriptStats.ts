// How the three gatekeeper openers are doing.
//
// Counting and four fixed thresholds. No model, no significance test, no
// judgement — deliberately, because this is a two-week experiment and the
// thresholds are there to stop somebody declaring a winner on nine calls,
// not to decide anything on their own.
//
// The flags say "review this", never "change this". A script is only ever
// swapped by a person.

import { SCRIPT_VERSIONS, SCRIPT_NAME, type ScriptVersion } from "./gatekeeperScripts";

export type ScriptCall = {
  script_version?: string | null;
  outcome: string;
  reached_dm?: boolean | null;
  spoke_with_role?: string | null;
  lead_id?: string | null;
};

/** Outcomes where nobody picked up. Everything else reached a human. */
const NO_CONTACT = ["no_answer", "voicemail", "bad_number"];

export function connected(c: ScriptCall): boolean {
  if (c.spoke_with_role === "owner" || c.spoke_with_role === "gatekeeper") return true;
  if (c.spoke_with_role === "employee") return true;
  return !NO_CONTACT.includes(c.outcome);
}

/**
 * Did this call reach the decision-maker?
 *
 * `reached_dm` is the recorded field and is trusted. The role is a fallback for
 * older rows. The outcome chip alone is not enough — it is a button a caller
 * can press optimistically, and this is the number the whole test turns on.
 */
export function reachedOwner(c: ScriptCall): boolean {
  if (c.reached_dm === true) return true;
  return c.spoke_with_role === "owner";
}

/** A real conversation with the owner, not merely reaching them. */
export function dmConversation(c: ScriptCall): boolean {
  return reachedOwner(c) && (c.outcome === "dm_conversation" || c.outcome === "appointment_set");
}

/* -------------------------------------------------------------------------- */
/* the thresholds                                                             */
/* -------------------------------------------------------------------------- */

/** Below this many calls, nothing about a version is worth reading. */
export const MIN_CALLS = 25;
/** The bar at which the two rate flags start applying. */
export const REVIEW_AFTER_CALLS = 50;
export const MIN_GATEKEEPER_PASS = 0.15;
export const MIN_DM_CONVERSION = 0.2;
/** Trials expected per DM conversation, once there are enough to look at. */
export const MIN_DM_CONVERSATIONS_FOR_CLOSE = 10;
export const MIN_TRIALS_PER_DM = 1 / 20;

export type FlagLevel = "green" | "yellow" | "red";

export type Flag = {
  level: FlagLevel;
  message: string;
};

export type ScriptRow = {
  version: ScriptVersion;
  name: string;
  dials: number;
  connects: number;
  ownerReaches: number;
  dmConversations: number;
  trialsRequested: number;

  connectRate: number | null;
  /** Owner reaches ÷ connects. The thing these scripts actually differ on. */
  gatekeeperPassRate: number | null;
  /** DM conversations ÷ owner reaches. */
  dmConversationRate: number | null;
  /** Trials ÷ DM conversations. */
  trialRate: number | null;

  flags: Flag[];
};

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

/**
 * The four checkpoint flags, in order of how early they can fire.
 *
 * Every one of them is guarded on a sample size. A red banner off twelve calls
 * would get a script retired that never had a chance, which is the specific
 * failure this whole panel exists to avoid.
 */
export function flagsFor(row: Omit<ScriptRow, "flags" | "version" | "name">): Flag[] {
  const flags: Flag[] = [];

  if (row.dials < MIN_CALLS) {
    flags.push({
      level: "yellow",
      message: `Insufficient data — keep testing. ${row.dials} of ${MIN_CALLS} calls.`,
    });
    // Nothing else is worth saying yet, and saying it anyway is how a script
    // gets judged on noise.
    return flags;
  }

  if (row.dials >= REVIEW_AFTER_CALLS) {
    if (row.gatekeeperPassRate !== null && row.gatekeeperPassRate < MIN_GATEKEEPER_PASS) {
      flags.push({
        level: "red",
        message: `Review this script — high failure at gatekeeper. ${pct(
          row.gatekeeperPassRate
        )} of connects reached the owner, against a ${pct(MIN_GATEKEEPER_PASS)} bar.`,
      });
    }
    if (row.dmConversationRate !== null && row.dmConversationRate < MIN_DM_CONVERSION) {
      flags.push({
        level: "red",
        message: `Review opener — low conversion once past gatekeeper. ${pct(
          row.dmConversationRate
        )} of owner-reaches became a conversation, against a ${pct(MIN_DM_CONVERSION)} bar.`,
      });
    }
  }

  if (row.dmConversations >= MIN_DM_CONVERSATIONS_FOR_CLOSE) {
    const trialRate = rate(row.trialsRequested, row.dmConversations);
    if (trialRate !== null && trialRate < MIN_TRIALS_PER_DM) {
      flags.push({
        level: "red",
        message: `Review offer/close — ${row.trialsRequested} trial${
          row.trialsRequested === 1 ? "" : "s"
        } from ${row.dmConversations} owner conversations, against a bar of 1 in 20.`,
      });
    }
  }

  if (flags.length === 0) {
    flags.push({
      level: "green",
      message: `Nothing above a threshold. ${row.dials} calls in.`,
    });
  }
  return flags;
}

export type StatsInput = {
  calls: ScriptCall[];
  /** Lead ids that have reached trial_requested, for attributing trials. */
  trialLeadIds: string[];
};

/**
 * A trial is credited to a script version when a call running that version
 * reached the owner on that lead. A lead called under two versions credits
 * both — rare, visible in the totals, and better than silently crediting the
 * most recent one.
 */
export function buildScriptStats(input: StatsInput): ScriptRow[] {
  const trials = new Set(input.trialLeadIds);

  return SCRIPT_VERSIONS.map((version) => {
    const mine = input.calls.filter((c) => c.script_version === version);
    const connects = mine.filter(connected).length;
    const ownerReaches = mine.filter(reachedOwner).length;
    const dms = mine.filter(dmConversation).length;

    const leadsWithOwnerReach = new Set(
      mine.filter(reachedOwner).map((c) => c.lead_id).filter((id): id is string => !!id)
    );
    const trialsRequested = [...leadsWithOwnerReach].filter((id) => trials.has(id)).length;

    const base = {
      dials: mine.length,
      connects,
      ownerReaches,
      dmConversations: dms,
      trialsRequested,
      connectRate: rate(connects, mine.length),
      gatekeeperPassRate: rate(ownerReaches, connects),
      dmConversationRate: rate(dms, ownerReaches),
      trialRate: rate(trialsRequested, dms),
    };

    return { version, name: SCRIPT_NAME[version], ...base, flags: flagsFor(base) };
  });
}

/**
 * Which version is ahead, or an honest refusal.
 *
 * No significance test — that was explicitly out of scope — so this only ever
 * reports a leader once every version has cleared the minimum, and says in
 * words that it is a raw comparison rather than a result.
 */
export function leaderNote(rows: ScriptRow[]): string {
  const ready = rows.filter((r) => r.dials >= MIN_CALLS);
  if (ready.length < 2) {
    return `Only ${ready.length} of ${rows.length} versions have ${MIN_CALLS}+ calls. Keep testing before comparing.`;
  }
  const ranked = [...ready].sort(
    (a, b) => (b.gatekeeperPassRate ?? -1) - (a.gatekeeperPassRate ?? -1)
  );
  const top = ranked[0];
  const next = ranked[1];
  const gap =
    top.gatekeeperPassRate !== null && next.gatekeeperPassRate !== null
      ? top.gatekeeperPassRate - next.gatekeeperPassRate
      : null;

  return (
    `${top.version} is ahead on gatekeeper pass rate at ${pct(top.gatekeeperPassRate)}` +
    (gap !== null ? `, ${Math.round(gap * 100)} points above ${next.version}` : "") +
    `. Raw counts, not a significance test — treat a small gap as a tie.`
  );
}
