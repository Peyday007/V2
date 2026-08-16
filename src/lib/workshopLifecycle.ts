// Where a prospect has got to, and what that does and does not mean.
//
// THE DISTINCTION THIS FILE EXISTS TO PROTECT.
//
// The old workshop had one meaningful state: `trial_requested`. Somebody
// pressed a button and the system recorded that they had agreed to a free
// trial — so interest, permission and activation were the same event. That is
// wrong in the direction that matters: it turns "I would like to see more"
// into "you may begin", and nobody agreed to the second thing.
//
// Interest, a demo request, a walkthrough, permission to touch a live system,
// and a paid engagement are five different acts. They get five states, and
// pressing the interest button reaches exactly one of them.
//
// Pure. No database, no network.

import { createHash } from "node:crypto";

/* -------------------------------------------------------------------------- */
/* the lifecycle                                                              */
/* -------------------------------------------------------------------------- */

export const WORKSHOP_STATUSES = [
  "not_sent",
  "sent",
  "opened",
  "engaged",
  "interested",
  "demo_requested",
  "walkthrough_requested",
  "walkthrough_scheduled",
  "live_change_approved",
  "converted",
  "expired",
  "revoked",
  /** Historical only. Rows written before the rebuild hold it. */
  "trial_requested",
] as const;
export type WorkshopStatus = (typeof WORKSHOP_STATUSES)[number];

/**
 * How far through the journey each state is.
 *
 * Used only to stop a record going BACKWARDS. Events arrive out of order all
 * the time — an "opened" webhook landing after somebody already clicked
 * interest — and letting the later-arriving event win would quietly erase the
 * interest, which is the one signal an operator is waiting for.
 */
const RANK: Record<WorkshopStatus, number> = {
  not_sent: 0,
  sent: 1,
  opened: 2,
  engaged: 3,
  interested: 4,
  demo_requested: 5,
  walkthrough_requested: 6,
  walkthrough_scheduled: 7,
  live_change_approved: 8,
  converted: 9,
  // Terminal states sit outside the progression: they are decisions, not
  // stages, and nothing may advance past them by accident.
  expired: -1,
  revoked: -1,
  /*
   * Historical trial requests rank alongside interest, because that is what
   * they actually were: somebody putting their hand up. They are NOT mapped to
   * anything further along — an old trial agreement was never permission to
   * change a live system, and restating it as one would be rewriting what
   * people agreed to.
   */
  trial_requested: 4,
};

/**
 * The status a record should hold after an event.
 *
 * Never goes backwards, and never moves off a terminal state. `expired` and
 * `revoked` are set deliberately by an operator and outrank everything.
 */
export function advanceStatus(current: WorkshopStatus, proposed: WorkshopStatus): WorkshopStatus {
  if (current === "revoked" || current === "expired") return current;
  if (proposed === "revoked" || proposed === "expired") return proposed;
  return RANK[proposed] > RANK[current] ? proposed : current;
}

/** What the operator sees. Old trial rows are labelled as the history they are. */
export const STATUS_LABEL: Record<WorkshopStatus, string> = {
  not_sent: "Not sent",
  sent: "Sent",
  opened: "Opened",
  engaged: "Read the findings",
  interested: "Interested",
  demo_requested: "Asked for a private example",
  walkthrough_requested: "Asked for a walkthrough",
  walkthrough_scheduled: "Walkthrough booked",
  live_change_approved: "Approved a live change",
  converted: "Converted",
  expired: "Expired",
  revoked: "Revoked",
  trial_requested: "Interested (legacy trial request)",
};

/**
 * THE FIVE THINGS THAT ARE NOT THE SAME THING.
 *
 * Asserted in tests. If someone later wires the interest button to any of the
 * other four, this is the line that says it was never meant to.
 */
export function grantsSystemAccess(status: WorkshopStatus): boolean {
  return status === "live_change_approved";
}
export function isPaidEngagement(status: WorkshopStatus): boolean {
  return status === "converted";
}
export function isInterestOnly(status: WorkshopStatus): boolean {
  return status === "interested" || status === "trial_requested";
}

/* -------------------------------------------------------------------------- */
/* events                                                                     */
/* -------------------------------------------------------------------------- */

export const WORKSHOP_EVENTS = [
  "workshop.created",
  "workshop.delivery_requested",
  "workshop.delivered",
  "workshop.opened",
  "workshop.summary_viewed",
  "workshop.finding_viewed",
  "workshop.evidence_expanded",
  "workshop.preview_viewed",
  "workshop.audit_started",
  "workshop.audit_option_selected",
  "workshop.audit_completed",
  "workshop.map_viewed",
  "workshop.interest_clicked",
  "workshop.private_example_requested",
  "workshop.walkthrough_phone_requested",
  "workshop.walkthrough_video_requested",
  "workshop.walkthrough_recorded_requested",
  "workshop.live_change_discussed",
  "workshop.live_change_approved",
  "workshop.converted",
  "workshop.expired",
  "workshop.revoked",
] as const;
export type WorkshopEvent = (typeof WORKSHOP_EVENTS)[number];

/** The status each event implies, when it implies one at all. */
export const EVENT_STATUS: Partial<Record<WorkshopEvent, WorkshopStatus>> = {
  "workshop.delivered": "sent",
  "workshop.opened": "opened",
  "workshop.summary_viewed": "opened",
  "workshop.finding_viewed": "engaged",
  "workshop.evidence_expanded": "engaged",
  "workshop.audit_started": "engaged",
  "workshop.audit_completed": "engaged",
  "workshop.map_viewed": "engaged",
  // The one that matters, and the one that stops here.
  "workshop.interest_clicked": "interested",
  "workshop.private_example_requested": "demo_requested",
  "workshop.walkthrough_phone_requested": "walkthrough_requested",
  "workshop.walkthrough_video_requested": "walkthrough_requested",
  "workshop.walkthrough_recorded_requested": "walkthrough_requested",
  "workshop.live_change_approved": "live_change_approved",
  "workshop.converted": "converted",
  "workshop.expired": "expired",
  "workshop.revoked": "revoked",
};

/**
 * Events where a second occurrence must not count twice.
 *
 * A browser that re-fires a view on back-navigation, or an owner who
 * double-taps the interest button on a phone, must not produce two
 * conversions or two follow-up tasks. Views are deduplicated per target;
 * conversions are deduplicated outright.
 */
const ONCE_EVER: WorkshopEvent[] = [
  "workshop.interest_clicked",
  "workshop.private_example_requested",
  "workshop.walkthrough_phone_requested",
  "workshop.walkthrough_video_requested",
  "workshop.walkthrough_recorded_requested",
  "workshop.live_change_approved",
  "workshop.converted",
];

/**
 * The key that makes an event write idempotent.
 *
 * Null means "record every occurrence" — repeated finding views are genuine
 * signal about what someone kept coming back to. A key means the unique index
 * on (packet_id, idempotency_key) will reject the duplicate.
 */
export function idempotencyKeyFor(
  event: WorkshopEvent,
  target?: string | null
): string | null {
  if (ONCE_EVER.includes(event)) return event;
  // Views are once per target per packet: "did they read finding 2" is a
  // yes/no, and counting six re-reads as six is what inflates engagement.
  if (
    event === "workshop.finding_viewed" ||
    event === "workshop.summary_viewed" ||
    event === "workshop.preview_viewed" ||
    event === "workshop.map_viewed" ||
    event === "workshop.evidence_expanded"
  ) {
    return target ? `${event}:${target}` : event;
  }
  return null;
}

/** Events that mean a person should look at this today. */
export function needsAttention(event: WorkshopEvent): boolean {
  return (
    event === "workshop.interest_clicked" ||
    event === "workshop.private_example_requested" ||
    event === "workshop.walkthrough_phone_requested" ||
    event === "workshop.walkthrough_video_requested" ||
    event === "workshop.walkthrough_recorded_requested" ||
    event === "workshop.live_change_approved"
  );
}

/** What an operator should do next, given where the prospect got to. */
export function nextAction(status: WorkshopStatus, hasAudit: boolean): string {
  switch (status) {
    case "not_sent":
      return "Send the workshop link.";
    case "sent":
      return "Not opened yet. Give it a day before chasing.";
    case "opened":
      return "Opened but nothing read yet.";
    case "engaged":
      return hasAudit
        ? "They filled in the bottleneck check. Read their answers and ring them."
        : "They read the findings. Worth a call.";
    case "interested":
      return "They put their hand up. Build the private example and get back to them.";
    case "demo_requested":
      return "Private example requested. Build it, then send the link.";
    case "walkthrough_requested":
      return "Walkthrough requested. Book a time.";
    case "walkthrough_scheduled":
      return "Booked. Prepare the example beforehand.";
    case "live_change_approved":
      return "They approved a live change. Confirm scope in writing before touching anything.";
    case "converted":
      return "Converted. Nothing outstanding here.";
    case "trial_requested":
      return "Legacy trial request — they asked to see more. Follow up as interest.";
    case "expired":
    case "revoked":
      return "Closed. Regenerate a fresh workshop if they come back.";
  }
}

/* -------------------------------------------------------------------------- */
/* experiments                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The presentation choices that may be tested.
 *
 * WHAT IS ABSENT IS THE POINT. No variant changes a finding, its evidence, its
 * confidence, the consent wording, or what clicking the button means. Those are
 * not presentation — testing them would mean showing different people
 * different truths to see which converts better, which is not an experiment,
 * it is lying to half the sample.
 */
export const WORKSHOP_VARIANTS = ["control", "compact", "narrative"] as const;
export type WorkshopVariant = (typeof WORKSHOP_VARIANTS)[number];

export type VariantConfig = {
  /** Two or three findings on the summary. */
  summaryFindings: 2 | 3;
  /** Evidence shown inline, or behind a disclosure. */
  evidenceInline: boolean;
  /** Dense layout or a more discursive one. */
  layout: "compact" | "narrative";
  /** Where the interest button sits. */
  ctaPosition: "top" | "bottom";
  headline: string;
};

export const VARIANT_CONFIG: Record<WorkshopVariant, VariantConfig> = {
  control: {
    summaryFindings: 3,
    evidenceInline: false,
    layout: "narrative",
    ctaPosition: "bottom",
    headline: "What we found when we looked at your business",
  },
  compact: {
    summaryFindings: 2,
    evidenceInline: true,
    layout: "compact",
    ctaPosition: "top",
    headline: "Three things worth your attention",
  },
  narrative: {
    summaryFindings: 3,
    evidenceInline: true,
    layout: "narrative",
    ctaPosition: "bottom",
    headline: "Where your business may be leaving work on the table",
  },
};

/**
 * The variant for a packet — stable, derived, and assigned once.
 *
 * Hashed from the token rather than randomised per request, so the same
 * prospect opening the link on their phone and again on a laptop sees the same
 * page. A layout that reshuffles on every visit is not an experiment; it is a
 * broken website, and it destroys the result either way.
 */
export function variantForToken(token: string): WorkshopVariant {
  if (!token) return "control";
  const digest = createHash("sha256").update(token).digest();
  return WORKSHOP_VARIANTS[digest[0] % WORKSHOP_VARIANTS.length];
}

/* -------------------------------------------------------------------------- */
/* experiment reporting                                                       */
/* -------------------------------------------------------------------------- */

export type VariantTally = {
  variant: WorkshopVariant | string;
  delivered: number;
  opened: number;
  engaged: number;
  interested: number;
  auditCompleted: number;
  privateBuildRequested: number;
  walkthroughRequested: number;
  converted: number;
};

/** Below this, a percentage is noise dressed up as a finding. */
export const LOW_SAMPLE_THRESHOLD = 30;

export type VariantReport = VariantTally & {
  openRate: number | null;
  interestRate: number | null;
  conversionRate: number | null;
  lowSample: boolean;
  caveat: string | null;
};

/**
 * Rates alongside raw counts, and a warning when the sample cannot carry them.
 *
 * Never names a winner. Two conversions out of five is forty per cent and
 * means nothing, and a dashboard that prints "compact is winning" from that is
 * how a worse page gets rolled out to everybody.
 */
export function reportVariants(tallies: VariantTally[]): VariantReport[] {
  return tallies.map((t) => {
    const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
    const lowSample = t.delivered < LOW_SAMPLE_THRESHOLD;
    return {
      ...t,
      openRate: pct(t.opened, t.delivered),
      interestRate: pct(t.interested, t.opened),
      conversionRate: pct(t.converted, t.delivered),
      lowSample,
      caveat: lowSample
        ? `Only ${t.delivered} delivered. Too few to read anything into the percentages — treat these as raw counts.`
        : null,
    };
  });
}
