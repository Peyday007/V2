import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { cancelCampaignJobs, enqueue } from "@/lib/jobs";
import { logEvent } from "@/lib/events";
import { placesKeyConfigured } from "@/lib/places";

export const dynamic = "force-dynamic";

/** Live progress for one campaign. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = supabaseAdmin();

  const { data: campaign, error } = await db
    .from("sourcing_campaigns")
    .select("*")
    .eq("id", id)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 404 });

  const [tasks, jobCounts, recentErrors, statusCounts] = await Promise.all([
    db.from("search_tasks").select("status").eq("campaign_id", id),
    db.from("jobs").select("type, status").eq("campaign_id", id),
    db
      .from("jobs")
      .select("type, last_error, attempts, status")
      .eq("campaign_id", id)
      .not("last_error", "is", null)
      .order("updated_at", { ascending: false })
      .limit(10),
    db.from("leads").select("machine_status").eq("sourcing_campaign_id", id),
  ]);

  function tally<T extends Record<string, unknown>>(rows: T[] | null, key: keyof T) {
    const out: Record<string, number> = {};
    for (const r of rows || []) {
      const k = String(r[key]);
      out[k] = (out[k] || 0) + 1;
    }
    return out;
  }

  const jobsByStatus = tally(jobCounts.data, "status");
  const outstanding = (jobsByStatus.pending || 0) + (jobsByStatus.running || 0);

  // 144 copies of the same message is noise. Collapse to distinct causes.
  const seen = new Set<string>();
  const distinctErrors: { type: string; last_error: string; count: number }[] = [];
  for (const e of recentErrors.data || []) {
    const key = String(e.last_error).slice(0, 120);
    if (seen.has(key)) {
      const hit = distinctErrors.find((d) => d.last_error.startsWith(key));
      if (hit) hit.count++;
      continue;
    }
    seen.add(key);
    distinctErrors.push({ type: e.type, last_error: String(e.last_error), count: 1 });
  }

  return NextResponse.json({
    campaign,
    places_key_configured: placesKeyConfigured(),
    search_tasks: tally(tasks.data, "status"),
    jobs: jobsByStatus,
    outstanding_jobs: outstanding,
    leads_by_machine_status: tally(statusCounts.data, "machine_status"),
    recent_errors: distinctErrors,
    env: {
      places_key: placesKeyConfigured(),
      caller_session_secret: !!process.env.CALLER_SESSION_SECRET,
      anthropic_key: !!process.env.ANTHROPIC_API_KEY,
    },
  });
}

/** start | pause | resume | stop */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { action } = await req.json();
  const db = supabaseAdmin();

  const { data: campaign, error } = await db
    .from("sourcing_campaigns")
    .select("*")
    .eq("id", id)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 404 });

  if (action === "start" || action === "resume") {
    if (!placesKeyConfigured()) {
      return NextResponse.json(
        {
          error:
            "GOOGLE_PLACES_API_KEY is not set on this deployment. Add it in Vercel → Settings → Environment Variables and redeploy.",
        },
        { status: 400 }
      );
    }
    if (campaign.status === "running") {
      return NextResponse.json({ ok: true, already: true });
    }

    await db
      .from("sourcing_campaigns")
      .update({
        status: "running",
        started_at: campaign.started_at || new Date().toISOString(),
        finished_at: null,
        last_error: null,
      })
      .eq("id", id);

    if (action === "resume") {
      // Re-arm tasks that were skipped while paused/stopped AND ones that
      // failed on a configuration problem (bad key, API not enabled), so
      // fixing Google Cloud and pressing Resume actually recovers them.
      const { data: skipped } = await db
        .from("search_tasks")
        .select("id")
        .eq("campaign_id", id)
        .in("status", ["skipped", "pending", "failed"]);

      // Clear out the dead jobs from the failed run so they don't linger.
      await db
        .from("jobs")
        .update({ status: "cancelled" })
        .eq("campaign_id", id)
        .in("status", ["pending", "failed"]);
      await db
        .from("sourcing_campaigns")
        .update({ error_count: 0, last_error: null })
        .eq("id", id);

      for (const t of skipped || []) {
        await db
          .from("search_tasks")
          .update({ status: "pending", retry_count: 0, last_error: null })
          .eq("id", t.id);
        await enqueue({
          type: "execute_places_search",
          payload: { task_id: t.id, campaign_id: id },
          idempotencyKey: `execute_places_search:${t.id}:resume:${Date.now()}`,
          campaignId: id,
        });
      }
    } else {
      await enqueue({
        type: "plan_search_tasks",
        payload: { campaign_id: id },
        idempotencyKey: `plan_search_tasks:${id}`,
        campaignId: id,
        priority: 10,
      });
    }

    await logEvent("campaign.started", "sourcing_campaign", id, { action });
    return NextResponse.json({ ok: true });
  }

  if (action === "pause") {
    await db.from("sourcing_campaigns").update({ status: "paused" }).eq("id", id);
    await logEvent("campaign.paused", "sourcing_campaign", id, {});
    return NextResponse.json({ ok: true });
  }

  if (action === "stop") {
    await db
      .from("sourcing_campaigns")
      .update({ status: "stopped", finished_at: new Date().toISOString() })
      .eq("id", id);
    const cancelled = await cancelCampaignJobs(id);
    await logEvent("campaign.stopped", "sourcing_campaign", id, {
      jobs_cancelled: cancelled,
    });
    return NextResponse.json({ ok: true, jobs_cancelled: cancelled });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
