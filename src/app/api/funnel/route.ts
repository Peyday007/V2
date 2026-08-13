import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { campaignSendLedger } from "@/lib/instantly/client";
import { funnelSnapshot, readSupplyPicture } from "@/lib/funnelStore";
import { activeThreadCount, completedThreadCount } from "@/lib/emailPush";
import { funnelHealth } from "@/lib/funnelHealth";
import { loadSettings, selectEmailLeads } from "@/lib/instantlyStore";
import { loadAutoReenrichSettings } from "@/lib/reenrichStore";
import { summarizeEmailAvailability } from "@/lib/emailEligibility";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/*
 * The whole chain, on one request.
 *
 * Every stage of this pipeline already reported on itself accurately and it
 * was not enough: the top-up said "no leads eligible", the campaign said "323
 * of 323 contacted", the enrichment page said "nothing queued". All true, and
 * the real answer — nothing had sourced a lead in weeks — was on none of them,
 * because no screen owned the chain.
 */

async function sentLast24h(): Promise<number> {
  try {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const { count } = await supabaseAdmin()
      .from("email_events")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "sent")
      .gte("occurred_at", since);
    return count ?? 0;
  } catch {
    return 0;
  }
}

async function inCampaign(): Promise<number> {
  try {
    const { count } = await supabaseAdmin()
      .from("email_threads")
      .select("id", { count: "exact", head: true })
      .in("status", ["pushed", "sent", "opened"]);
    return count ?? 0;
  } catch {
    return 0;
  }
}

export async function GET() {
  const [snapshot, instantly, reenrich, webhookSent, live, leads] = await Promise.all([
    funnelSnapshot(),
    loadSettings(),
    loadAutoReenrichSettings(),
    sentLast24h(),
    inCampaign(),
    selectEmailLeads(),
  ]);

  /*
   * INSTANTLY'S LEDGER OUTRANKS OUR WEBHOOK TABLE.
   *
   * sentLast24h() counts email_events, which webhooks fill. A missed webhook —
   * endpoint down, secret wrong, delivery dropped — reads as "nothing sent",
   * and the pipeline card would then name SENDING as the broken stage on a
   * campaign that is sending fine, sending somebody to debug the wrong end.
   *
   * The larger of the two, for the same reason as the health card: neither
   * source can be subtracted from the other, and taking the maximum is the
   * only reconciliation that cannot under-report. Null from the ledger means
   * "could not ask" and leaves the webhook figure alone.
   */
  let sent = webhookSent;
  if (instantly.settings.campaign_id) {
    try {
      const now = new Date();
      const ledger = await campaignSendLedger(
        instantly.settings.campaign_id,
        new Date(now.getTime() - 24 * 3600_000),
        now
      );
      if (ledger) sent = Math.max(sent, ledger.sent);
    } catch {
      // A failed read never lowers the number, and never fails the page.
    }
  }

  const availability = summarizeEmailAvailability(leads.rows);

  /*
   * THE EIGHT NUMBERS THE PAGE ACTUALLY NEEDS.
   *
   * Everything above answers "what happened". This answers "is the machine
   * keeping the inboxes busy, and if not, why not" — which is the question
   * nobody could answer while 850 sends of capacity delivered 22.
   *
   * Read through readSupplyPicture so the page and the worker cannot disagree
   * about how many contacts are ready: they call the same function.
   */
  let supply: Awaited<ReturnType<typeof readSupplyPicture>> | null = null;
  let inSequence: number | null = null;
  let completed: number | null = null;
  try {
    supply = await readSupplyPicture();
    if (instantly.settings.campaign_id) {
      [inSequence, completed] = await Promise.all([
        activeThreadCount(instantly.settings.campaign_id, supply.spanDays),
        completedThreadCount(instantly.settings.campaign_id, supply.spanDays),
      ]);
    }
  } catch {
    // The supply picture failing must not take the rest of the page down.
  }

  const capacity = supply?.demand.plannedSendsPerDay ?? 0;
  const utilisation = capacity > 0 ? Math.min(1, sent / capacity) : null;

  const health = funnelHealth({
    totalLeads: leads.rows.length,
    awaitingEnrichment: snapshot.awaitingEnrichment,
    eligibleToEmail: snapshot.eligibleToEmail,
    inCampaign: live,
    sentLast24h: sent,
    autoSourceEnabled: snapshot.settings.enabled,
    autoReenrichEnabled: reenrich.enabled,
    autoPushEnabled: instantly.settings.auto_push_enabled,
    programmeEnabled: instantly.settings.enabled,
    sourcingRunning: snapshot.sourcingRunning,
  });

  return NextResponse.json({
    health,
    /*
     * The operating picture, in the order the page asks the questions.
     *
     * `capacity` is an ESTIMATE and is labelled as one wherever it is shown —
     * it is what the inboxes and the campaign limit say they will carry, not
     * a measurement. `sentLast24h` is the only figure here that is measured,
     * and it comes from Instantly's own ledger reconciled with our webhooks.
     */
    supply: supply
      ? {
          automationRunning:
            instantly.settings.enabled && instantly.settings.auto_push_enabled,
          sentLast24h: sent,
          capacityPerDay: capacity,
          capacityIsEstimate: true,
          utilisation,
          qualifiedReady: supply.qualifiedReady,
          daysOfReserve:
            supply.demand.intakePerDay > 0
              ? Math.round((supply.qualifiedReady / supply.demand.intakePerDay) * 10) / 10
              : null,
          reserveTarget: supply.demand.reserveTarget,
          reserveDays: instantly.settings.reserve_days,
          intakePerDay: supply.demand.intakePerDay,
          targetInCampaign: supply.demand.targetInCampaign,
          // The four states that were one number before, and the reason a
          // stalled campaign looked full.
          inSequence,
          completed,
          enrichableNow: supply.enrichableNow,
          givenUp: supply.givenUp,
          sequenceSteps: supply.sequenceSteps,
          spanDays: supply.spanDays,
          qualificationYield: supply.qualificationYield,
          yieldIsMeasured: supply.yieldIsMeasured,
          sourcingNote: snapshot.settings.lastCheckNote,
          sourcingCheckedAt: snapshot.settings.lastCheckedAt,
        }
      : null,
    // The address-versus-name split, which is the other question that kept
    // coming back and had no number attached to it.
    reach: availability.reach,
    settings: {
      autoSource: snapshot.settings.enabled,
      refillWhenBelow: snapshot.settings.refillWhenBelow,
      leadsPerRun: snapshot.settings.leadsPerRun,
      lastCheckNote: snapshot.settings.lastCheckNote,
      lastCheckedAt: snapshot.settings.lastCheckedAt,
      autoReenrich: reenrich.enabled,
      namedPeopleOnly: instantly.settings.named_people_only,
      requireNamedPerson: instantly.settings.require_named_person,
    },
    error: null,
  });
}

/** The automatic-sourcing switch and its numbers. */
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (typeof body.auto_source_enabled === "boolean") {
    /*
     * Switching this on spends money at Google on a schedule with nobody
     * watching. Same treatment as automatic sending: the caller has to say
     * explicitly that they mean it, so a box ticked on the way past is not an
     * administrator enabling autonomous spend.
     */
    if (body.auto_source_enabled && body.acknowledge_spend !== true) {
      return NextResponse.json(
        {
          error:
            "Automatic sourcing buys leads from Google on a schedule, without asking. Confirm you intend that.",
        },
        { status: 400 }
      );
    }
    patch.auto_source_enabled = body.auto_source_enabled;
  }

  const num = (v: unknown, min: number, max: number): number | undefined => {
    const n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    return Math.max(min, Math.min(max, Math.round(n)));
  };
  for (const [key, min, max] of [
    ["refill_when_below", 0, 10_000],
    ["leads_per_run", 10, 2000],
    ["max_api_requests_per_run", 10, 2000],
    ["min_hours_between_runs", 1, 168],
  ] as [string, number, number][]) {
    if (body[key] !== undefined) {
      const v = num(body[key], min, max);
      if (v !== undefined) patch[key] = v;
    }
  }

  const { error } = await supabaseAdmin().from("funnel_settings").update(patch).eq("id", true);
  if (error) {
    return NextResponse.json(
      {
        error: /relation .* does not exist|column .* does not exist|schema cache/i.test(error.message)
          ? `Run supabase/migrations/0041_keep_the_funnel_full.sql in the Supabase SQL Editor, then reload. (${error.message})`
          : error.message,
      },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true });
}
