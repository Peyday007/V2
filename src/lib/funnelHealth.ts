// Is the whole thing actually running, and if not, where did it stop?
//
// WHY THIS EXISTS. Every stage of this pipeline reports on itself honestly and
// separately, and that turned out not to be enough. The email top-up said "no
// leads are eligible" — true. The campaign said 323 of 323 contacted — true.
// The enrichment page said nothing was queued — true. Every screen was
// correct, and the actual answer ("nothing has sourced a lead in weeks") was
// on none of them, because no screen owned the whole chain.
//
// This walks the chain in order and stops at the FIRST thing that is stuck,
// because that is the only one worth acting on. Fixing stage four while stage
// one is dry is how a fortnight goes by.
//
// Pure. Facts in, verdict out.

export type FunnelFacts = {
  /** Leads on the books at all, excluding binned ones. */
  totalLeads: number;
  /** Leads with no address that enrichment has never been through. */
  awaitingEnrichment: number;
  /** Leads with an address that have not been pushed yet. */
  eligibleToEmail: number;
  /** Leads currently live in the Instantly campaign. */
  inCampaign: number;
  /** Emails Instantly actually sent in the last 24 hours. */
  sentLast24h: number;

  /* --- the switches, so a stopped stage can name the one that stopped it -- */
  autoSourceEnabled: boolean;
  autoReenrichEnabled: boolean;
  autoPushEnabled: boolean;
  programmeEnabled: boolean;
  /** A sourcing run happening right now. */
  sourcingRunning: boolean;
};

export type Stage = {
  key: "supply" | "enrichment" | "push" | "sending";
  label: string;
  state: "ok" | "stuck" | "working";
  detail: string;
  /** What a person would do about it, when there is something to do. */
  fix: string | null;
};

export type FunnelHealth = {
  headline: string;
  /** True only when leads are genuinely moving all the way through. */
  flowing: boolean;
  stages: Stage[];
};

/**
 * The chain, in order, with the first break called out.
 *
 * A stage is "working" rather than "ok" when it has a queue it is getting
 * through — that is a healthy state and must not read as a problem, or the
 * card cries wolf every time enrichment is busy.
 */
export function funnelHealth(f: FunnelFacts): FunnelHealth {
  const stages: Stage[] = [];

  /* ------------------------------- supply -------------------------------- */
  const hasWorkInHand = f.awaitingEnrichment > 0 || f.eligibleToEmail > 0;
  stages.push(
    f.sourcingRunning
      ? {
          key: "supply",
          label: "New leads coming in",
          state: "working",
          detail: "A sourcing run is going now.",
          fix: null,
        }
      : hasWorkInHand
        ? {
            key: "supply",
            label: "New leads coming in",
            state: "ok",
            detail: `${f.totalLeads} leads on the books, with work still in hand.`,
            fix: null,
          }
        : {
            key: "supply",
            label: "New leads coming in",
            state: "stuck",
            detail:
              "Nothing left to enrich and nothing left to email, and no sourcing run going. The supply has run out.",
            fix: f.autoSourceEnabled
              ? "Automatic sourcing is on, so the next run should start within the hour. If it does not, check the note under Keeping it fed."
              : 'Switch on "Go and find more leads when we run low" — without it, leads only ever arrive when somebody starts a run by hand.',
          }
  );

  /* ----------------------------- enrichment ------------------------------ */
  stages.push(
    f.awaitingEnrichment === 0
      ? {
          key: "enrichment",
          label: "Finding addresses and names",
          state: "ok",
          detail: "Every lead here has been through enrichment.",
          fix: null,
        }
      : f.autoReenrichEnabled
        ? {
            key: "enrichment",
            label: "Finding addresses and names",
            state: "working",
            detail: `${f.awaitingEnrichment} leads still to go through. It works through a batch a day.`,
            fix: null,
          }
        : {
            key: "enrichment",
            label: "Finding addresses and names",
            state: "stuck",
            detail: `${f.awaitingEnrichment} leads have no email address and nothing is working through them.`,
            fix: 'On the Enrichment page, switch on "Catch these up without me pressing anything". It costs nothing — it reads the address off the business\'s own website.',
          }
  );

  /* -------------------------------- push --------------------------------- */
  stages.push(
    !f.programmeEnabled
      ? {
          key: "push",
          label: "Leads into the campaign",
          state: "stuck",
          detail: "The email programme is switched off, so nothing is pushed at all.",
          fix: 'Tick "Programme is on" under Campaign.',
        }
      : !f.autoPushEnabled
        ? {
            key: "push",
            label: "Leads into the campaign",
            state: "stuck",
            detail: "Automatic top-ups are off, so leads only reach the campaign when somebody presses Push.",
            fix: 'Tick "Top the campaign up without asking me".',
          }
        : f.eligibleToEmail === 0
          ? {
              key: "push",
              label: "Leads into the campaign",
              state: "ok",
              detail: `${f.inCampaign} in the campaign. Nothing waiting — everything with an address has been pushed.`,
              fix: null,
            }
          : {
              key: "push",
              label: "Leads into the campaign",
              state: "working",
              detail: `${f.eligibleToEmail} waiting to go in, ${f.inCampaign} already there.`,
              fix: null,
            }
  );

  /* ------------------------------- sending ------------------------------- */
  stages.push(
    f.sentLast24h > 0
      ? {
          key: "sending",
          label: "Emails going out",
          state: "ok",
          detail: `${f.sentLast24h} sent in the last 24 hours.`,
          fix: null,
        }
      : f.inCampaign === 0
        ? {
            key: "sending",
            label: "Emails going out",
            state: "stuck",
            detail: "Nothing has been sent, and the campaign is empty.",
            fix: "Fix the stages above first — there is nobody to write to.",
          }
        : {
            key: "sending",
            label: "Emails going out",
            state: "stuck",
            detail: `Nothing sent in the last 24 hours, though ${f.inCampaign} leads are in the campaign.`,
            fix: "Check the campaign is Active in Instantly and that its schedule covers today.",
          }
  );

  const firstStuck = stages.find((s) => s.state === "stuck");
  const flowing = !firstStuck && f.sentLast24h > 0;

  /*
   * ONE SENTENCE, naming the FIRST break and nothing else.
   *
   * Listing every problem at once is what produced weeks of fixing stage four
   * while stage one was dry. The chain runs in order; only the earliest break
   * is worth anybody's attention.
   */
  const headline = flowing
    ? `Leads are moving all the way through — ${f.sentLast24h} emails in the last 24 hours.`
    : firstStuck
      ? `Stopped at: ${firstStuck.label.toLowerCase()}. ${firstStuck.detail}`
      : f.sentLast24h === 0
        ? "Nothing is obviously broken, but no email has gone out in 24 hours. Check the campaign's schedule in Instantly."
        : "Running.";

  return { headline, flowing, stages };
}
