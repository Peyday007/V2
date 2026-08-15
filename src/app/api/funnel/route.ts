import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { campaignDailyRows } from "@/lib/instantly/client";
import { funnelSnapshot, readSupplyPicture } from "@/lib/funnelStore";
import {
  activeThreadCount,
  completedThreadCount,
  threadsInSequence,
  sentTodayCount,
} from "@/lib/emailPush";
import { firstTouchCapacity, followUpsDueToday } from "@/lib/supplyPlan";
import {
  rollingDayWindow,
  todayWindow,
  calendarDayWindow,
  localDateKey,
  sentInWindow,
  reconcile,
  DEFAULT_REPORT_TIMEZONE,
  type SendWindow,
} from "@/lib/sendWindows";
import { productionStatus } from "@/lib/sourcingHealth";
import { placesKeyConfigured } from "@/lib/places";
import { instantlyCapability } from "@/lib/instantly/client";
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

/** Our own recorded sends between two instants. One window, stated by caller. */
async function sentBetween(fromIso: string, toIso: string): Promise<number> {
  try {
    const { count } = await supabaseAdmin()
      .from("email_events")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "sent")
      .gte("occurred_at", fromIso)
      .lt("occurred_at", toIso);
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
  const now = new Date();
  const tz = DEFAULT_REPORT_TIMEZONE;

  /*
   * EVERY SEND FIGURE CARRIES ITS WINDOW.
   *
   * Instantly reported 51 for Friday while this page reported 3, and both were
   * right about different questions. Three windows are now computed and each
   * is labelled with its kind, its timezone and its endpoints, so no two
   * numbers can be compared without their definitions attached.
   */
  const windows = {
    rolling: rollingDayWindow(now),
    today: todayWindow(now, tz),
    yesterday: calendarDayWindow(
      localDateKey(new Date(now.getTime() - 86_400_000), tz),
      tz
    ),
  };

  async function reconcileWindow(w: SendWindow, ourCount: number) {
    let rows: Awaited<ReturnType<typeof campaignDailyRows>> = null;
    if (instantly.settings.campaign_id) {
      try {
        rows = await campaignDailyRows(instantly.settings.campaign_id, w);
      } catch {
        // A failed read leaves the webhook figure alone and says so below.
      }
    }
    return reconcile({ window: w, webhookSent: ourCount, ledger: sentInWindow(rows, w) });
  }

  const [rollingRec, todayRec, yesterdayRec] = await Promise.all([
    reconcileWindow(windows.rolling, webhookSent),
    reconcileWindow(windows.today, await sentBetween(windows.today.fromIso, windows.today.toIso)),
    reconcileWindow(
      windows.yesterday,
      await sentBetween(windows.yesterday.fromIso, windows.yesterday.toIso)
    ),
  ]);

  const sent = rollingRec.reported;

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

  /*
   * TODAY'S ACTUAL HEADROOM, not the steady-state forecast.
   *
   * `capacity` is what the inboxes and the campaign limit will carry today.
   * The forecast figure (capacity ÷ steps) is still computed for reserve
   * planning and is reported separately and labelled as such — it is not a
   * ceiling on anything and displaying it as one is what wasted the capacity.
   */
  const capacity = instantly.settings.computed_daily_sends ?? 0;
  const utilisation = capacity > 0 ? Math.min(1, sent / capacity) : null;

  let todayCapacity: ReturnType<typeof firstTouchCapacity> | null = null;
  let followUps: ReturnType<typeof followUpsDueToday> | null = null;
  if (supply && instantly.settings.campaign_id) {
    try {
      const [scheduled, sentToday] = await Promise.all([
        threadsInSequence(instantly.settings.campaign_id, supply.spanDays),
        sentTodayCount(),
      ]);
      followUps = followUpsDueToday(scheduled || [], supply.offsets);
      todayCapacity = firstTouchCapacity({
        usableToday: capacity,
        followUpsDue: followUps.due,
        alreadySentToday: sentToday,
        firstTouchesSentToday: instantly.settings.pushed_today ?? 0,
        qualifiedReady: supply.qualifiedReady,
      });
    } catch {
      // The breakdown failing must not take the page down.
    }
  }

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

  /*
   * WHAT IS ACTUALLY HAPPENING, in one line with its numbers.
   *
   * A provider that cannot work outranks everything, because it explains the
   * rest. Note the deliberate exclusion: a lock on its own never produces
   * "sourcing and making progress" — snapshot.runAssessment has already
   * decided whether the lock is backed by movement.
   */
  const providerBlocker = !placesKeyConfigured()
    ? "GOOGLE_PLACES_API_KEY is not set on this deployment, so no lead can be sourced. Add it in the Vercel dashboard and redeploy."
    : !instantlyCapability().available
      ? instantlyCapability().reason
      : null;

  const status = productionStatus({
    qualifiedReady: supply?.qualifiedReady ?? 0,
    run: snapshot.runAssessment ?? {
      state: "not_running",
      minutesSinceProgress: null,
      minutesSinceStart: null,
      shouldRecover: false,
      blocksNewRun: false,
      reason: "No sourcing run is marked as running.",
    },
    enrichmentResolved: supply?.yieldSample ?? 0,
    enrichmentQualified: supply
      ? Math.round(supply.qualificationYield * supply.yieldSample)
      : 0,
    providerBlocker,
    sourcingEnabled: snapshot.settings.enabled,
  });

  return NextResponse.json({
    status,
    /*
     * The sourcing run's live state, every counter it keeps. Written out in
     * full because "a sourcing run is already going" told nobody whether it
     * had ever done anything, and that was the whole question.
     */
    sourcingRun: snapshot.run
      ? {
          name: snapshot.run.name,
          startedAt: snapshot.run.startedAt,
          lastProgressAt: snapshot.run.updatedAt,
          minutesSinceProgress: snapshot.runAssessment?.minutesSinceProgress ?? null,
          state: snapshot.runAssessment?.state ?? null,
          searchesPlanned: snapshot.run.counters.searchesPlanned,
          searchesCompleted: snapshot.run.counters.searchesCompleted,
          apiRequestsUsed: snapshot.run.counters.apiRequestsUsed,
          businessesFound: snapshot.run.counters.businessesReturned,
          duplicatesRejected: snapshot.run.counters.duplicatesSkipped,
          leadsInserted: snapshot.run.counters.uniqueSaved,
          qualificationFailures: snapshot.run.counters.qualificationFailures,
          enrichmentQueued: snapshot.run.counters.enrichmentQueued,
          errorCount: snapshot.run.counters.errorCount,
          lastError: snapshot.run.counters.lastError,
          reason: snapshot.runAssessment?.reason ?? null,
        }
      : null,
    /** True when this request released a wedged lock. Visible, not silent. */
    staleLockRecovered: snapshot.runRecovered,
    /** Enrichment's own yield, so "producing zero" is evidenced. */
    enrichment: supply
      ? {
          resolved: supply.yieldSample,
          qualified: Math.round(supply.qualificationYield * supply.yieldSample),
          stillWorkable: supply.enrichableNow,
          givenUp: supply.givenUp,
          yield: supply.qualificationYield,
          yieldIsMeasured: supply.yieldIsMeasured,
        }
      : null,
    /*
     * Every send figure with its window spelled out. Three of them, because
     * "51 on Friday" and "3 in the last 24 hours" are different questions and
     * comparing them without labels is what broke trust in this number.
     */
    sendWindows: [rollingRec, todayRec, yesterdayRec].map((r) => ({
      label: r.window.label,
      kind: r.window.kind,
      timezone: r.window.timezone,
      from: r.window.fromIso,
      to: r.window.toIso,
      ourEvents: r.webhookSent,
      instantlyLedger: r.ledgerSent,
      reported: r.reported,
      source: r.source,
      discrepancy: r.discrepancy,
    })),
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
          /*
           * TODAY, broken down. Every figure the dashboard needs to explain
           * where the day's capacity is going and what is left of it.
           */
          today: todayCapacity
            ? {
                safeCapacity: todayCapacity.usableToday,
                sentSoFar: todayCapacity.alreadySentToday,
                followUpsDue: todayCapacity.followUpsDue,
                firstTouchRemaining: todayCapacity.firstTouchAllowed,
                expectedUnused: todayCapacity.expectedUnused,
                unusedCause: todayCapacity.unusedCause,
                followUpConfidence: followUps?.confidence ?? "unknown",
                followUpCaveat: followUps?.caveat ?? null,
              }
            : null,
          /*
           * STEADY-STATE FORECAST ONLY. Explicitly not a daily ceiling — it
           * was used as one and threw away every send the follow-up load did
           * not claim.
           */
          forecastIntakePerDay: supply.demand.intakePerDay,
          qualifiedReady: supply.qualifiedReady,
          daysOfReserve:
            supply.demand.intakePerDay > 0
              ? Math.round((supply.qualifiedReady / supply.demand.intakePerDay) * 10) / 10
              : null,
          reserveTarget: supply.demand.reserveTarget,
          reserveDays: instantly.settings.reserve_days,
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
