// Is the email programme actually running?
//
// WHY THIS EXISTS: every fact needed to answer that was already on the Email
// page, spread across six cards, and none of them answered it. The campaign
// selector read "AI Dispatch — 3". Three is Instantly's status code for
// Completed — a campaign that will not send anything to anybody — and nothing
// on the page said so. Leads could be pushed into it all day and the page
// would look healthy.
//
// So this walks the chain from one end to the other and stops at the first
// thing that is broken. One sentence at the top, the whole chain underneath.
//
// THE RULE: never claim emails are going out. Only the send events prove that,
// and they come from Instantly's webhook. Everything before that link is
// "nothing is stopping it", which is a different and weaker claim.
//
// Pure. No database, no network.

/**
 * Instantly's campaign status codes.
 *
 * Confirmed for 3: the campaign selector showed "AI Dispatch — 3" while
 * Instantly's own screen showed "Completed" with a Resume button. The rest
 * follow Instantly's documented order and are UNVERIFIED AGAINST A LIVE
 * ACCOUNT — which is why an unrecognised value is reported verbatim rather
 * than guessed at.
 */
export const CAMPAIGN_STATUS: Record<string, string> = {
  "0": "Draft",
  "1": "Active",
  "2": "Paused",
  "3": "Completed",
  "4": "Running subsequences",
};

/** Which statuses actually send. Anything else is a stopped campaign. */
const SENDING_STATUSES = new Set(["1", "4", "active", "running"]);

export function campaignStatusLabel(status: string | null | undefined): string {
  const raw = (status ?? "").trim();
  if (!raw) return "unknown";
  return CAMPAIGN_STATUS[raw] ?? `status "${raw}"`;
}

export function campaignIsSending(status: string | null | undefined): boolean {
  const raw = (status ?? "").trim().toLowerCase();
  if (!raw) return false;
  return SENDING_STATUSES.has(raw);
}

export type HealthFacts = {
  /** INSTANTLY_API_KEY present and the adapter usable. */
  connected: boolean;
  connectionReason: string;
  /** The programme switch on this page. */
  programmeOn: boolean;
  campaignId: string | null;
  campaignName: string | null;
  /** Raw status from Instantly for the SELECTED campaign, if we could read it. */
  campaignStatus: string | null;
  campaignReadable: boolean;
  /** A published sequence in force. */
  hasActiveSequence: boolean;
  /** Leads with an address, not suppressed, not already pushed. */
  sendable: number;
  /** Threads that exist at all — leads that reached Instantly. */
  pushedTotal: number;
  /** Minutes since the worker last did anything, or null if never. */
  workerMinutesAgo: number | null;
  autoPushOn: boolean;
  /** Send events seen from Instantly in the last 24 hours. */
  sentLast24h: number;
  /** Replies in the last 7 days, so a live programme reads as live. */
  repliesLast7d: number;
  /**
   * What the automatic top-up last decided, and when.
   *
   * Null when 0037 has not run or the worker has not ticked since. This is the
   * one that explains an empty campaign with everything else green: the
   * top-up runs every minute and almost always decides to do nothing, and
   * until now it said so only to a server log.
   */
  refillNote: string | null;
  refillCheckedMinutesAgo: number | null;
};

export type HealthStep = {
  label: string;
  state: "ok" | "stopped" | "waiting" | "unknown";
  detail: string;
};

export type Health = {
  /** The one line at the top. */
  headline: string;
  /** True only when Instantly has actually sent something recently. */
  sending: boolean;
  /** The first thing that is broken, in words, or null. */
  blocker: string | null;
  steps: HealthStep[];
};

/** How stale the worker may be before it counts as stopped. */
export const WORKER_STALE_MINUTES = 15;

export function emailHealth(f: HealthFacts): Health {
  const steps: HealthStep[] = [];
  let blocker: string | null = null;
  const stop = (why: string) => {
    if (!blocker) blocker = why;
  };

  /* ------------------------------ connection ----------------------------- */
  steps.push(
    f.connected
      ? { label: "Connected to Instantly", state: "ok", detail: "" }
      : { label: "Connected to Instantly", state: "stopped", detail: f.connectionReason }
  );
  if (!f.connected) stop(f.connectionReason);

  /* ------------------------------ the switch ----------------------------- */
  steps.push(
    f.programmeOn
      ? { label: "Programme switched on", state: "ok", detail: "" }
      : {
          label: "Programme switched on",
          state: "stopped",
          detail: "Nothing is pushed while this is off. The tick box is above.",
        }
  );
  if (!f.programmeOn) stop("The email programme is switched off on this page.");

  /* ------------------------------ campaign ------------------------------- */
  if (!f.campaignId) {
    steps.push({
      label: "Campaign chosen",
      state: "stopped",
      detail: "No campaign selected — there is nowhere to push to.",
    });
    stop("No Instantly campaign is selected.");
  } else if (!f.campaignReadable) {
    steps.push({
      label: "Campaign chosen",
      state: "unknown",
      detail:
        "Instantly would not tell us this campaign's state, so whether it is sending is unknown.",
    });
  } else if (!campaignIsSending(f.campaignStatus)) {
    const label = campaignStatusLabel(f.campaignStatus);
    steps.push({
      label: `Campaign is running in Instantly`,
      state: "stopped",
      detail:
        `${f.campaignName || "The campaign"} is ${label} in Instantly. ` +
        `A campaign that is not running sends nothing, however many leads are pushed into it. ` +
        `Resume it in Instantly — this application cannot start it for you.`,
    });
    stop(
      `The campaign is ${label} in Instantly, so nothing will send no matter what this page does.`
    );
  } else {
    steps.push({
      label: "Campaign is running in Instantly",
      state: "ok",
      detail: `${f.campaignName || "Campaign"} — ${campaignStatusLabel(f.campaignStatus)}.`,
    });
  }

  /* ------------------------------ the words ------------------------------ */
  steps.push(
    f.hasActiveSequence
      ? { label: "A sequence is published", state: "ok", detail: "" }
      : {
          label: "A sequence is published",
          state: "waiting",
          detail:
            "No sequence written here is active. Instantly will use whatever copy is in the campaign already.",
        }
  );

  /* ------------------------------ somebody ------------------------------- */
  if (f.sendable > 0) {
    steps.push({
      label: "Somebody to email",
      state: "ok",
      detail: `${f.sendable} lead${f.sendable === 1 ? "" : "s"} with an address, not suppressed.`,
    });
  } else if (f.pushedTotal > 0) {
    steps.push({
      label: "Somebody to email",
      state: "waiting",
      detail: "Everyone with an address is already in the campaign. Enrich more leads for more.",
    });
  } else {
    steps.push({
      label: "Somebody to email",
      state: "stopped",
      detail: "No lead has an email address yet. Re-enrich on the Enrichment page.",
    });
    stop("No lead has an email address yet.");
  }

  /* ------------------------------- the worker ---------------------------- */
  if (f.workerMinutesAgo === null) {
    steps.push({
      label: "Worker running",
      state: f.autoPushOn ? "stopped" : "waiting",
      detail:
        "The background worker has never run. Nothing happens on its own — " +
        "use Run the worker now, or schedule it with 0035.",
    });
    if (f.autoPushOn) stop("The background worker has never run, so nothing is pushed on its own.");
  } else if (f.workerMinutesAgo > WORKER_STALE_MINUTES) {
    steps.push({
      label: "Worker running",
      state: f.autoPushOn ? "stopped" : "waiting",
      detail: `Last did something ${f.workerMinutesAgo} minutes ago. It should be every minute.`,
    });
    if (f.autoPushOn) stop(`The worker has not run for ${f.workerMinutesAgo} minutes.`);
  } else {
    steps.push({
      label: "Worker running",
      state: "ok",
      detail: `Last ran ${f.workerMinutesAgo} minute${f.workerMinutesAgo === 1 ? "" : "s"} ago.`,
    });
  }

  /* --------------------------- the automatic top-up ---------------------- */
  /*
   * Only shown when it is switched on and has actually spoken. A note from a
   * top-up nobody enabled is noise, and no note at all means 0037 has not run
   * or the worker has not reached it yet — neither is a fault to report.
   */
  if (f.autoPushOn && f.refillNote) {
    const pushing = /^Pushing /.test(f.refillNote);
    steps.push({
      label: "Automatic top-up",
      state: pushing ? "ok" : "waiting",
      detail:
        `${f.refillNote}` +
        (f.refillCheckedMinutesAgo !== null
          ? ` (checked ${f.refillCheckedMinutesAgo} minute${f.refillCheckedMinutesAgo === 1 ? "" : "s"} ago)`
          : ""),
    });
    /*
     * One decision IS a fault: it cannot read the campaign and is therefore
     * declining forever. Everything else it says is a normal quiet answer.
     */
    if (/Could not read how many leads are in the campaign/.test(f.refillNote)) {
      stop(
        "The automatic top-up cannot read how many leads are in the campaign, so it refuses to push — " +
          "correctly, because pushing blind double-fills a campaign. Push by hand with the button below."
      );
    }
  }

  /* ------------------------- did anything actually go -------------------- */
  /*
   * The only line that proves anything. Everything above says "nothing is
   * stopping it"; this says it happened. They are different claims and this
   * page used to make neither.
   */
  const sending = f.sentLast24h > 0;
  steps.push(
    sending
      ? {
          label: "Emails actually sent",
          state: "ok",
          detail: `${f.sentLast24h} in the last 24 hours${f.repliesLast7d > 0 ? `, ${f.repliesLast7d} repl${f.repliesLast7d === 1 ? "y" : "ies"} this week` : ""}.`,
        }
      : {
          label: "Emails actually sent",
          state: f.pushedTotal > 0 ? "waiting" : "stopped",
          detail:
            f.pushedTotal > 0
              ? "Leads are in the campaign but Instantly has not reported a send in 24 hours. " +
                "If the campaign is running, check its schedule and the sending accounts."
              : "Nothing has been pushed to Instantly yet, so nothing can have been sent.",
        }
  );

  /*
   * "Nothing is stopping it" and "there is nothing to send" are different, and
   * the difference is the next thing to do.
   *
   * This was wrong on first contact with the real thing: with the campaign
   * resumed, the worker alive and 92 addresses ready, nothing was blocked and
   * nothing had been pushed — and the headline said to go and check the
   * schedule in Instantly. The schedule was fine. The campaign was empty.
   */
  const nothingPushedYet = f.pushedTotal === 0 && f.sendable > 0;

  const headline = sending
    ? `Emails are going out — ${f.sentLast24h} in the last 24 hours.`
    : blocker
      ? `Nothing is being sent. ${blocker}`
      : nothingPushedYet
        ? `Ready, but the campaign is empty — no lead has been pushed to Instantly yet. ` +
          `Press "Push up to ${f.sendable}" below, or switch on the automatic top-up.`
        : "Nothing has been sent in the last 24 hours, and nothing here is obviously broken — check the campaign's schedule in Instantly.";

  return { headline, sending, blocker, steps };
}
