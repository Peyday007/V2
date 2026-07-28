// What the Sourcing page should actually say to a human.
//
// The engine tracks twelve machine statuses, search tasks, job queues and API
// budgets. None of that answers the only three questions an operator has:
//
//   How many leads can be called right now?
//   Is anything happening?
//   What should I do next?
//
// This module turns engine internals into those answers. Pure functions, so
// the wording and the decision rules are testable and cannot drift from what
// the page renders.

import type { MachineStatus } from "./machineStatus";

/* -------------------------------------------------------------------------- */
/* the four numbers that matter                                               */
/* -------------------------------------------------------------------------- */

export type PipelineCounts = {
  /** Processed, callable, and not yet given to anyone. */
  readyToCall: number;
  /** The engine still has work to do on these. */
  beingResearched: number;
  /** Sitting in a caller's packet, waiting to be dialed. */
  withCallers: number;
  /** Already dialed at least once. */
  called: number;
  /** Will never be callable, with the reasons kept separate. */
  notUsable: number;
  total: number;
};

const RESEARCHING: MachineStatus[] = [
  "discovered",
  "normalized",
  "duplicate_review",
  "enrichment_queued",
  "enriching",
  "decision_maker_found",
  "role_only_found",
];

export function summarizeCounts(
  byStatus: Record<string, number>,
  opts?: {
    /**
     * The real number of leads a packet could take right now. Pass it from
     * leadEligibility — machine_status alone overcounts, because a lead can be
     * ready_for_calling and still be suppressed, unreachable or already held.
     */
    readyToCall?: number;
  }
): PipelineCounts {
  const n = (k: string) => byStatus[k] || 0;
  const beingResearched = RESEARCHING.reduce((sum, k) => sum + n(k), 0);
  const counts = {
    readyToCall: opts?.readyToCall ?? n("ready_for_calling"),
    beingResearched,
    withCallers: n("assigned_to_packet"),
    called: n("contacted"),
    notUsable: n("enrichment_failed") + n("archived"),
  };
  return {
    ...counts,
    total: Object.values(byStatus).reduce((a, b) => a + b, 0),
  };
}

/* -------------------------------------------------------------------------- */
/* what to do next                                                            */
/* -------------------------------------------------------------------------- */

export type NextActionKey =
  | "fix_places_key"
  | "fix_caller_secret"
  | "add_caller"
  | "callers_are_working"
  | "assign_packet"
  | "wait_for_engine"
  | "push_engine"
  | "generate_first"
  | "generate_more";

export type NextAction = {
  key: NextActionKey;
  /** One sentence. What is true right now. */
  headline: string;
  /** Two sentences at most. What it means and what happens if you act. */
  detail: string;
  /** The single button to show, if there is one. */
  cta: { label: string; goes: string } | null;
  tone: "blocked" | "action" | "waiting" | "good";
};

export type PipelineInput = {
  placesKeyConfigured: boolean;
  callerSecretConfigured: boolean;
  activeCallers: number;
  counts: PipelineCounts;
  /** Leads still to be dialed inside open packets. */
  pendingInPackets: number;
  campaignRunning: boolean;
};

/**
 * Exactly one recommendation, in priority order. Never a list of options —
 * a list is what makes this page frightening.
 */
export function nextAction(input: PipelineInput): NextAction {
  const { counts } = input;

  if (!input.placesKeyConfigured) {
    return {
      key: "fix_places_key",
      headline: "The Google key is not reaching this deployment",
      detail:
        "No new leads can be generated until it does. If you already added GOOGLE_PLACES_API_KEY in Vercel, you still have to redeploy — environment variables are baked in when the site is built.",
      cta: null,
      tone: "blocked",
    };
  }

  if (!input.callerSecretConfigured) {
    return {
      key: "fix_caller_secret",
      headline: "Callers cannot sign in",
      detail:
        "CALLER_SESSION_SECRET is missing, so a correct PIN will still fail. Add it in Vercel → Settings → Environment Variables (any long random string), then redeploy.",
      cta: null,
      tone: "blocked",
    };
  }

  if (input.activeCallers === 0) {
    return {
      key: "add_caller",
      headline: "There are no callers yet",
      detail:
        "Leads cannot be handed to anyone until at least one caller exists. Adding one generates their PIN automatically.",
      cta: { label: "Add a caller", goes: "/admin/callers" },
      tone: "action",
    };
  }

  if (input.pendingInPackets > 0) {
    return {
      key: "callers_are_working",
      headline: `Your callers have ${input.pendingInPackets} lead${input.pendingInPackets === 1 ? "" : "s"} waiting`,
      detail:
        "Nothing needs doing here. They sign in at /dial with their PIN and work through the list one at a time.",
      cta: { label: "See packets", goes: "/admin/campaigns" },
      tone: "good",
    };
  }

  if (counts.readyToCall > 0) {
    return {
      key: "assign_packet",
      headline: `${counts.readyToCall} lead${counts.readyToCall === 1 ? " is" : "s are"} ready to call`,
      detail:
        "They have finished processing and nobody has them yet. Hand them to a caller and they show up in that caller's dialer immediately.",
      cta: { label: "Assign to a caller", goes: "#assign" },
      tone: "action",
    };
  }

  if (input.campaignRunning) {
    return {
      key: "wait_for_engine",
      headline: "The engine is working",
      detail:
        counts.beingResearched > 0
          ? `${counts.beingResearched} leads are being looked up right now. This page updates itself every few seconds — nothing needs pressing.`
          : "Searching Google for businesses. This page updates itself every few seconds.",
      cta: null,
      tone: "waiting",
    };
  }

  if (counts.beingResearched > 0) {
    return {
      key: "push_engine",
      headline: `${counts.beingResearched} leads are part-way through processing`,
      detail:
        "The engine is not currently running, so they are sitting still. Pushing it along finishes them; it cannot lose or duplicate anything.",
      cta: { label: "Push these along", goes: "#push" },
      tone: "action",
    };
  }

  if (counts.total === 0) {
    return {
      key: "generate_first",
      headline: "No leads yet",
      detail:
        "Generate the first batch. You only choose how many — the engine picks a mix of home-service trades across major metros so the data comes back varied enough to learn from.",
      cta: { label: "Generate leads", goes: "#generate" },
      tone: "action",
    };
  }

  return {
    key: "generate_more",
    headline: "Everything has been processed and handed out",
    detail:
      "There are no unassigned leads left. Generate another batch when your callers are getting close to the end of theirs.",
    cta: { label: "Generate more leads", goes: "#generate" },
    tone: "action",
  };
}

/* -------------------------------------------------------------------------- */
/* plain wording for the parts that stay visible                              */
/* -------------------------------------------------------------------------- */

export const CAMPAIGN_STATUS_TEXT: Record<string, string> = {
  draft: "Not started",
  running: "Running now",
  paused: "Paused",
  stopped: "Stopped",
  completed: "Finished",
};

export function campaignStatusText(status: string): string {
  return CAMPAIGN_STATUS_TEXT[status] || status;
}

/**
 * Why leads get discarded, said plainly. The engine records these as
 * "enrichment_failed", which reads like a system fault when it is usually a
 * correct decision about an unsuitable business.
 */
export const DISCARD_REASONS: { match: string; plain: string }[] = [
  { match: "no usable main phone", plain: "No phone number we could call" },
  { match: "too many reviews", plain: "Too big — a call centre, not an owner-operator" },
  { match: "permanently closed", plain: "Business is closed down" },
  { match: "franchise", plain: "Franchise or chain, so the owner does not decide this" },
  { match: "duplicate", plain: "Already in the database under another record" },
];

export function plainDiscardReason(reason: string | null | undefined): string {
  if (!reason) return "Did not meet the criteria";
  const hit = DISCARD_REASONS.find((d) =>
    reason.toLowerCase().includes(d.match.toLowerCase())
  );
  return hit ? hit.plain : reason;
}
