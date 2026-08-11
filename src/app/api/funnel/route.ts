import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { funnelSnapshot } from "@/lib/funnelStore";
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
  const [snapshot, instantly, reenrich, sent, live, leads] = await Promise.all([
    funnelSnapshot(),
    loadSettings(),
    loadAutoReenrichSettings(),
    sentLast24h(),
    inCampaign(),
    selectEmailLeads(),
  ]);

  const availability = summarizeEmailAvailability(leads.rows);

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
