import "server-only";
import { supabaseAdmin } from "./supabaseAdmin";
import { recordEvent } from "./events";
import { isMissingColumnError } from "./enrichmentGrade";
import { pushLead, instantlyCapability } from "./instantly/client";
import type { PushSubject } from "./instantly/types";
import { loadSettings, migrationHint } from "./instantlyStore";
import {
  chooseEmail,
  emailUnavailableReason,
  explainNonePushable,
  summarizeEmailAvailability,
  orderForPush,
  onlyNamedPeopleWeCanGreet,
  canRepush,
  type EmailLeadRow,
} from "./emailEligibility";
import { composePersonalization, composeVariables, splitName, type ComposeInput } from "./emailCompose";
import { appOrigin, ensurePacketsFor } from "./workshopSend";
import { SEQUENCE_COMPLETION_GRACE_DAYS } from "./supplyPlan";

// Pushing leads into the campaign.
//
// Lifted out of the API route so the button and the automatic top-up run the
// SAME code. The alternative — a job handler with its own copy of the
// eligibility rules — is how the packet side ended up with a dashboard saying
// "47 ready" next to a button saying "none available". One implementation, two
// callers, no drift.
//
// Everything here is bounded: a per-run cap, one thread per lead, a lead that
// fails recorded as failed rather than skipped, and an early stop on anything
// that is not a per-lead problem.

/** Every lead column eligibility or composing needs. */
const CORE = [
  "id",
  "business_name",
  "city",
  "state",
  "website",
  "rating",
  "review_count",
  "answering_setup",
  "owner_name",
  "decision_maker_name",
  "industry",
  "owner_email",
  "do_not_call",
  "archived_at",
  "email_unsubscribed_at",
  "email_bounced_at",
].join(", ");

/**
 * The optional address columns, newest migration first.
 *
 * `website_email` arrives with 0030 and `direct_email` with 0023. Selecting a
 * column from an unrun migration fails the whole query rather than degrading,
 * which is exactly how the packet pipeline went down once already — so the
 * reader steps down instead of assuming.
 */
const COLUMN_TIERS = [
  `${CORE}, direct_email, website_email, website_email_kind`,
  `${CORE}, direct_email, website_email`,
  `${CORE}, direct_email`,
  `${CORE}, website_email, website_email_kind`,
  `${CORE}, website_email`,
  CORE,
];

type LeadRow = EmailLeadRow & {
  id: string;
  business_name: string;
  city: string | null;
  state: string | null;
  website: string | null;
  rating: number | null;
  review_count: number | null;
  answering_setup: string | null;
  owner_name: string | null;
  decision_maker_name: string | null;
  industry: string | null;
};

export type PushOutcome = {
  ok: boolean;
  pushed: number;
  failed: number;
  considered: number;
  limit: number;
  stoppedEarly: string | null;
  failures: { business: string; error: string }[];
  /** Set when nothing could be pushed, with the reason in words. */
  blocked: string | null;
};

const nothing = (blocked: string, limit = 0): PushOutcome => ({
  ok: false,
  pushed: 0,
  failed: 0,
  considered: 0,
  limit,
  stoppedEarly: null,
  failures: [],
  blocked,
});

/**
 * Push up to `limit` eligible leads.
 *
 * `actor` distinguishes the button from the top-up in the event log, because
 * "who pushed these 50" is the first question anybody asks about a send.
 */
export async function pushEligibleLeads(
  limit: number,
  actor: "admin" | "worker"
): Promise<PushOutcome> {
  const { settings, error: settingsError } = await loadSettings();
  if (settingsError) return nothing(settingsError);

  const capability = instantlyCapability();
  if (!capability.available) return nothing(capability.reason);
  if (!settings.enabled) {
    return nothing("The email programme is switched off. Turn it on at the top of the Email page.");
  }
  if (!settings.campaign_id) {
    return nothing("No Instantly campaign is selected — there is nowhere to push to.");
  }

  const cap = Math.max(1, Math.min(limit || settings.max_push_per_run, settings.max_push_per_run));
  const db = supabaseAdmin();

  let rows: LeadRow[] | null = null;
  let readError: string | null = null;
  for (const columns of COLUMN_TIERS) {
    const res = await db.from("leads").select(columns).is("archived_at", null).limit(20000);
    if (!res.error) {
      rows = res.data as unknown as LeadRow[];
      break;
    }
    if (!isMissingColumnError(res.error)) {
      readError = migrationHint(res.error.message) || res.error.message;
      break;
    }
  }
  if (readError) return nothing(readError, cap);
  if (!rows) return nothing("Could not read the leads table.", cap);

  const { data: existing, error: threadsErr } = await db
    .from("email_threads")
    .select("lead_id, status")
    .limit(50000);
  if (threadsErr) {
    return nothing(migrationHint(threadsErr.message) || threadsErr.message, cap);
  }
  /*
   * A FAILED PUSH IS NOT A PUSH.
   *
   * This set used to hold every lead with a thread row, whatever its status.
   * A push that Instantly refused still writes a row — deliberately, so the
   * lead is not silently lost — and that row then excluded the lead from every
   * future attempt, permanently. Ninety-one leads went in as failures and none
   * was ever retried, while the page reported them as "already in a campaign".
   *
   * canRepush has existed for exactly this since the module was written and was
   * never called here. It says: a push that errored never reached Instantly, so
   * retrying is not a second sequence — it is the first one, again.
   */
  const alreadyPushed = new Set(
    (existing || [])
      .filter((t) => !canRepush(t.status as string | null))
      .map((t) => String(t.lead_id))
  );

  /*
   * Retried leads keep their old thread row, so clear it before the new push
   * writes another — otherwise the unique-per-lead intent decays into a pile of
   * failure rows and `alreadyPushed` stops meaning anything.
   */
  const retrying = (existing || [])
    .filter((t) => canRepush(t.status as string | null))
    .map((t) => String(t.lead_id));
  if (retrying.length > 0) {
    await db.from("email_threads").delete().in("lead_id", retrying).eq("status", "failed");
  }

  const eligible = rows.filter(
    (l) => !alreadyPushed.has(l.id) && emailUnavailableReason(l) === null
  );

  if (eligible.length === 0) {
    const availability = summarizeEmailAvailability(rows);
    return nothing(
      alreadyPushed.size > 0
        ? `Nothing new to push — ${alreadyPushed.size} lead${alreadyPushed.size === 1 ? " is" : "s are"} already in a campaign. ${explainNonePushable(availability)}`
        : explainNonePushable(availability),
      cap
    );
  }

  /*
   * THE RECIPIENT POLICY, ENFORCED HERE AND NOT NEGOTIABLE.
   *
   * This used to be two optional switches, both off by default, so the
   * shipped behaviour was: push anything with an address. The result was a
   * campaign of info@, office@ and customercare@ addressed to nobody, and
   * emails that opened "Hi," because no name was on record.
   *
   * A setting cannot relax this. It is applied unconditionally, before the
   * ordering, so no row in instantly_settings — however old, however it was
   * left — can put a general inbox back into the campaign.
   *
   * Ordering still matters underneath it: chooseEmail picks the best address
   * within a lead, orderForPush decides which leads go first. Slicing an
   * unordered list is what filled the campaign with front desks even when
   * named owners were available.
   */
  const wanted = onlyNamedPeopleWeCanGreet(eligible);
  if (wanted.length === 0 && eligible.length > 0) {
    return nothing(
      `${eligible.length} lead${eligible.length === 1 ? " has" : "s have"} an address, but none of ` +
        `them meets the recipient rule — a personal address with a name on record. They are ` +
        `general inboxes, or contacts we cannot greet by name. Enrich further to find named ` +
        `decision-makers; the rule is deliberate and cannot be switched off.`,
      cap
    );
  }
  const batch = orderForPush(wanted).slice(0, cap);

  /*
   * A packet for everyone in this batch, so the email has something to link to.
   *
   * This used to read existing packets only, on the reasoning that a packet is
   * something a caller makes on a call. The consequence was that
   * {{workshop_link}} was empty for every cold-emailed lead — a lead being
   * cold-emailed has by definition not been spoken to — so the variable was
   * plumbed all the way through and permanently blank.
   *
   * Now the prospect gets a link to the same page a caller would have texted
   * them: their own gaps, their own recommendations, the same offer. The
   * packet is created at `not_sent` and only moves to `sent` when Instantly
   * confirms the email actually went (see the webhook), so the funnel on the
   * board stays true.
   */
  let links = new Map<string, string>();
  try {
    const origin = await appOrigin();
    links = await ensurePacketsFor(
      batch.map((l) => ({
        id: l.id,
        ownerName: (l.decision_maker_name || l.owner_name || "").trim() || null,
        ownerEmail: chooseEmail(l)?.email ?? null,
      })),
      origin
    );
  } catch {
    // A missing link is a slightly plainer email, not a failed push.
  }

  /*
   * Can the thread carry who it was aimed at?
   *
   * Probed once per run rather than assumed. An insert naming a column that
   * does not exist fails WHOLESALE — the lead would be pushed to Instantly and
   * then have no thread row, so nothing would ever match its replies and it
   * could be pushed again tomorrow. Losing the measurement is an acceptable
   * cost of an unrun migration; losing the thread is not.
   */
  const probe = await db.from("email_threads").select("email_audience").limit(1);
  const recordAudience = !probe.error || !isMissingColumnError(probe.error);

  const audienceColumns = (c: { source: string; audience: string }) =>
    recordAudience ? { email_source: c.source, email_audience: c.audience } : {};

  let pushed = 0;
  let failed = 0;
  const failures: { business: string; error: string }[] = [];
  let stoppedEarly: string | null = null;

  for (const lead of batch) {
    const chosen = chooseEmail(lead);
    // Re-checked rather than trusted from the filter: this is the last point
    // before an address leaves the building.
    if (!chosen) continue;

    const ownerName = (lead.decision_maker_name || lead.owner_name || "").trim() || null;
    const { firstName, lastName } = splitName(ownerName);
    const composeInput: ComposeInput = {
      businessName: lead.business_name,
      city: lead.city,
      state: lead.state,
      website: lead.website,
      rating: lead.rating,
      reviewCount: lead.review_count,
      answeringSetup: lead.answering_setup,
      ownerName,
      industry: lead.industry,
      workshopLink: links.get(lead.id) || null,
    };

    const subject: PushSubject = {
      leadId: lead.id,
      email: chosen.email,
      firstName,
      lastName,
      companyName: lead.business_name,
      website: (lead.website || "").trim() || null,
      phone: null,
      personalization: composePersonalization(composeInput),
      customVariables: composeVariables(composeInput),
    };

    const result = await pushLead(settings.campaign_id, subject);
    const now = new Date().toISOString();

    if (result.ok) {
      pushed += 1;
      await db.from("email_threads").insert({
        lead_id: lead.id,
        instantly_lead_id: result.instantlyLeadId,
        campaign_id: settings.campaign_id,
        email: chosen.email,
        status: "pushed",
        last_event_at: now,
        // Written from the same decision that picked the address, so the
        // record cannot disagree with what was actually sent. Dropped
        // silently if 0036 has not run — see threadColumns below.
        ...audienceColumns(chosen),
      });
      await recordEvent({
        type: "email.pushed",
        entityType: "email_thread",
        entityId: lead.id,
        leadId: lead.id,
        actorType: actor === "worker" ? "worker" : "admin",
        source: actor === "worker" ? "worker" : "ui",
        newValue: { email: chosen.email, campaign_id: settings.campaign_id },
        metadata: {
          email_source: chosen.source,
          email_audience: chosen.audience,
          personalized: subject.personalization !== "",
          workshop_link: !!composeInput.workshopLink,
          automatic: actor === "worker",
        },
        verificationStatus: "verified",
      });
    } else {
      failed += 1;
      failures.push({ business: lead.business_name, error: result.error });
      // Recorded, not skipped. A failed push that leaves no row is a lead that
      // silently never gets emailed and that nobody can find again.
      await db.from("email_threads").insert({
        lead_id: lead.id,
        campaign_id: settings.campaign_id,
        email: chosen.email,
        status: "failed",
        push_error: result.error,
        last_event_at: now,
        ...audienceColumns(chosen),
      });
      await recordEvent({
        type: "email.push_failed",
        entityType: "email_thread",
        entityId: lead.id,
        leadId: lead.id,
        actorType: actor === "worker" ? "worker" : "admin",
        source: actor === "worker" ? "worker" : "ui",
        newValue: { error: result.error, retryable: result.retryable },
      });

      // Rate limiting or a bad key is not a per-lead problem. Carrying on
      // would mark the whole batch failed for one reason.
      if (result.retryable || /rejected the API key|could not find that campaign/i.test(result.error)) {
        stoppedEarly = result.error;
        break;
      }
    }
  }

  return {
    ok: true,
    pushed,
    failed,
    considered: eligible.length,
    limit: cap,
    stoppedEarly,
    failures: failures.slice(0, 10),
    blocked: null,
  };
}

/** How many leads could be pushed right now. Used by the top-up planner. */
export async function countEligible(): Promise<number> {
  const db = supabaseAdmin();
  for (const columns of COLUMN_TIERS) {
    const res = await db.from("leads").select(columns).is("archived_at", null).limit(20000);
    if (res.error) {
      if (isMissingColumnError(res.error)) continue;
      return 0;
    }
    const rows = res.data as unknown as LeadRow[];
    /*
     * The same rule as the push itself, for the same reason.
     *
     * countEligible feeds planRefill's `eligible`, so counting a failed push as
     * done made the top-up believe there was nobody left — the second half of
     * why one lead reached Instantly in nine hours. Two places deciding what
     * "already pushed" means is how they disagreed.
     */
    const { data: existing } = await db
      .from("email_threads")
      .select("lead_id, status")
      .limit(50000);
    const already = new Set(
      (existing || [])
        .filter((t) => !canRepush(t.status as string | null))
        .map((t) => String(t.lead_id))
    );
    /*
     * THE SAME POLICY THE PUSH APPLIES, for the same reason the "already
     * pushed" rule is shared: two places deciding who is emailable is how they
     * disagree, and this number drives the top-up, the automatic sourcing and
     * the funnel health card. Counting general inboxes here would report
     * supply that the push will refuse, and send the funnel off buying leads
     * to solve a shortage that was never real.
     */
    const usable = rows.filter(
      (l) => !already.has(l.id) && emailUnavailableReason(l) === null
    );
    return onlyNamedPeopleWeCanGreet(usable).length;
  }
  return 0;
}

/**
 * How many of our leads are still being worked by the campaign.
 *
 * WHY THIS EXISTS AND activeLeadCount() NO LONGER DECIDES:
 *
 * The automatic top-up asked Instantly how many leads were in the campaign.
 * Instantly's /leads/list returns a page of items and no total, so
 * activeLeadCount() found no `total`, `total_count` or `count` key and returned
 * null — every minute, forever. planRefill treats null as DO NOT PUSH, which is
 * right (pushing blind double-fills a campaign) and meant the top-up declined
 * sixty times an hour while the campaign sat empty.
 *
 * We already know the answer. Every lead we push writes a thread row. Counting
 * our own rows needs no API, cannot return null, and is the same number for the
 * purpose that matters: how many of OUR leads are in flight.
 *
 * WHICH STATUSES COUNT: pushed, sent and opened — still in the sequence.
 * Replied is excluded because the conversation has moved to a human, and
 * bounced, unsubscribed and failed are dead. Excluding them means those slots
 * are refilled, which is the entire point of a top-up.
 *
 * The one thing it cannot see is a lead removed inside Instantly by hand: we
 * would still count it and push one fewer. That errs toward under-filling,
 * which is the safe direction.
 *
 * AND THE STATUS IS ONLY HALF THE QUESTION — see below.
 */
export const IN_FLIGHT_STATUSES = ["pushed", "sent", "opened"] as const;

/**
 * How many of our leads are STILL RECEIVING EMAILS from this campaign.
 *
 * THE BUG THAT STOPPED THE CAMPAIGN. There is no "finished the sequence"
 * status and there cannot be one: Instantly does not raise an event when a
 * lead reaches the end without replying, and that is what happens to most of
 * them. So a lead pushed in July, sent all four emails and never heard from
 * again keeps the status `sent` forever — and this function counted it as
 * occupying a slot forever.
 *
 * The consequence was total. Once the number of leads ever emailed passed the
 * campaign target, the top-up saw a permanently full campaign and pushed
 * nothing, every minute, for good. Ten inboxes with 850 sends a day between
 * them delivered 22, because the only emails left to send were the last
 * follow-ups of a cohort that finished months ago.
 *
 * Elapsed time is the signal Instantly does not give us. A thread pushed
 * longer ago than the sequence takes to run, plus a week of slack for
 * weekends and holds, has finished sending by definition. Nothing is deleted
 * or rewritten — the row keeps its status and its history, it simply stops
 * counting as an occupied slot so a replacement can take it.
 *
 * `spanDays` of 0 disables the cutoff entirely and restores the old
 * all-time count, which is what an unreadable sequence should fall back to:
 * under-filling rather than double-filling.
 */
export async function activeThreadCount(
  campaignId: string,
  spanDays = 0,
  now: Date = new Date()
): Promise<number | null> {
  if (!campaignId) return null;
  try {
    let q = supabaseAdmin()
      .from("email_threads")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .in("status", IN_FLIGHT_STATUSES as unknown as string[]);

    if (spanDays > 0) {
      const cutoff = new Date(
        now.getTime() - (spanDays + SEQUENCE_COMPLETION_GRACE_DAYS) * 86_400_000
      ).toISOString();
      q = q.gte("created_at", cutoff);
    }

    const { count, error } = await q;
    if (error) return null;
    return count ?? 0;
  } catch {
    return null;
  }
}

/**
 * Every thread still inside its sequence, with the day it was pushed.
 *
 * Feeds followUpsDueToday. Instantly's API has no "what is scheduled for
 * today" endpoint — /campaigns/analytics/daily reports what it HAS sent, not
 * what it is about to — so the day's follow-up load has to be derived, and
 * this is the half of the derivation we own. The other half is the sequence's
 * step offsets.
 *
 * Bounded rather than unbounded: a campaign at steady state holds a few
 * thousand of these, and the cap stops one enormous campaign turning the
 * refill into a slow query every minute.
 */
export async function threadsInSequence(
  campaignId: string,
  spanDays: number,
  now: Date = new Date()
): Promise<{ pushedAt: string | null; status: string | null }[] | null> {
  if (!campaignId) return null;
  try {
    let q = supabaseAdmin()
      .from("email_threads")
      .select("created_at, status")
      .eq("campaign_id", campaignId)
      .in("status", IN_FLIGHT_STATUSES as unknown as string[]);

    if (spanDays > 0) {
      const cutoff = new Date(
        now.getTime() - (spanDays + SEQUENCE_COMPLETION_GRACE_DAYS) * 86_400_000
      ).toISOString();
      q = q.gte("created_at", cutoff);
    }

    const { data, error } = await q.limit(20000);
    if (error || !data) return null;
    return data.map((r) => ({
      pushedAt: (r.created_at as string) ?? null,
      status: (r.status as string) ?? null,
    }));
  } catch {
    return null;
  }
}

/**
 * How many emails Instantly has already put out today, from our own events.
 *
 * The refill reconciles this against Instantly's ledger before using it — see
 * the handler — for the same reason the health card does: a missed webhook
 * reads as zero, and a zero here would hand the day's whole capacity back to
 * first touches that Instantly has in fact already spent.
 */
export async function sentTodayCount(now: Date = new Date()): Promise<number> {
  try {
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    ).toISOString();
    const { count } = await supabaseAdmin()
      .from("email_events")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "sent")
      .gte("occurred_at", start);
    return count ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Threads that have finished sending, counted separately.
 *
 * Not a number anything acts on — it exists so the page can say "1,240
 * completed" beside "180 in sequence" instead of one number that silently
 * meant both. Those were the two states the dashboard could not tell apart,
 * and conflating them is what made a stalled campaign look full.
 */
export async function completedThreadCount(
  campaignId: string,
  spanDays: number,
  now: Date = new Date()
): Promise<number | null> {
  if (!campaignId || spanDays <= 0) return null;
  try {
    const cutoff = new Date(
      now.getTime() - (spanDays + SEQUENCE_COMPLETION_GRACE_DAYS) * 86_400_000
    ).toISOString();
    const { count, error } = await supabaseAdmin()
      .from("email_threads")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .in("status", IN_FLIGHT_STATUSES as unknown as string[])
      .lt("created_at", cutoff);
    if (error) return null;
    return count ?? 0;
  } catch {
    return null;
  }
}
