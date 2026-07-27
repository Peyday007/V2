import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { cancelCampaignJobs, enqueue } from "@/lib/jobs";
import { logEvent } from "@/lib/events";
import { placesKeyConfigured } from "@/lib/places";
import { requestBudgetFor } from "@/lib/budget";

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

/** Rename a batch, or change how many callable leads it should end up with. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const db = supabaseAdmin();

  const { data: before } = await db
    .from("sourcing_campaigns")
    .select("id, name, target_lead_count, max_api_requests, status")
    .eq("id", id)
    .single();
  if (!before) return NextResponse.json({ error: "Batch not found" }, { status: 404 });

  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();

  if (body.target_lead_count !== undefined) {
    const target = Number(body.target_lead_count);
    if (!Number.isFinite(target) || target < 1) {
      return NextResponse.json({ error: "Target must be at least 1" }, { status: 400 });
    }
    patch.target_lead_count = Math.floor(target);
    // Raising the target needs room to spend, or the campaign would stop
    // immediately on a cap set for the smaller number.
    const needed = requestBudgetFor(Math.floor(target));
    if (needed > before.max_api_requests) patch.max_api_requests = needed;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
  }

  const { error } = await db.from("sourcing_campaigns").update(patch).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logEvent("campaign.created", "sourcing_campaign", id, {
    edited: true,
    previous: { name: before.name, target_lead_count: before.target_lead_count },
    next: patch,
  });

  return NextResponse.json({ ok: true, ...patch });
}

/** start | pause | resume | stop | topup */
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

  /**
   * Go back out for the leads a finished batch never delivered. Re-arms every
   * search that was skipped or failed, which is the same recovery path Resume
   * uses — the difference is only that this one is offered on a batch that
   * already reported itself finished.
   */
  if (action === "topup") {
    if (!placesKeyConfigured()) {
      return NextResponse.json(
        { error: "GOOGLE_PLACES_API_KEY is not set on this deployment." },
        { status: 400 }
      );
    }
    const { data: reusable } = await db
      .from("search_tasks")
      .select("id")
      .eq("campaign_id", id)
      .in("status", ["skipped", "pending", "failed"]);

    if (!reusable || reusable.length === 0) {
      return NextResponse.json(
        {
          error:
            "This batch has already used every search it planned. Generate a new batch instead — it will search different trades and metros.",
        },
        { status: 400 }
      );
    }

    // Give it room to spend, in case the cap was set for a smaller target.
    const needed = requestBudgetFor(campaign.target_lead_count);
    await db
      .from("sourcing_campaigns")
      .update({
        status: "running",
        finished_at: null,
        completion_reason: null,
        last_error: null,
        error_count: 0,
        max_api_requests: Math.max(campaign.max_api_requests, needed),
      })
      .eq("id", id);

    for (const t of reusable) {
      await db
        .from("search_tasks")
        .update({ status: "pending", retry_count: 0, last_error: null })
        .eq("id", t.id);
      await enqueue({
        type: "execute_places_search",
        payload: { task_id: t.id, campaign_id: id },
        idempotencyKey: `execute_places_search:${t.id}:topup:${Date.now()}`,
        campaignId: id,
      });
    }

    await logEvent("campaign.refilled", "sourcing_campaign", id, {
      searches_rearmed: reusable.length,
      requested_by: "admin",
    });
    return NextResponse.json({ ok: true, searches: reusable.length });
  }

  /**
   * Bin every lead from this batch that nobody has dialed and nobody is
   * holding. For when a whole batch turns out not to be worth calling.
   *
   * Archived, not deleted: the records and their history survive, they are
   * simply never eligible for a packet again. Leads already in a packet or
   * already called are left alone — clearing those is the packet page's job,
   * so this can never quietly undo a caller's work.
   */
  if (action === "discard_leads") {
    const { data: victims } = await db
      .from("leads")
      .select("id")
      .eq("sourcing_campaign_id", id)
      .eq("status", "new")
      .is("archived_at", null);
    const ids = (victims || []).map((l) => l.id);

    if (ids.length === 0) {
      return NextResponse.json({
        ok: true,
        discarded: 0,
        message:
          "Nothing to bin — every lead in this batch is either with a caller, already called, or already binned.",
      });
    }

    await db
      .from("leads")
      .update({
        status: "disqualified",
        machine_status: "archived",
        archived_at: new Date().toISOString(),
        qualification_failure_reason: "batch discarded by admin",
      })
      .in("id", ids);

    await logEvent("lead.archived", "sourcing_campaign", id, {
      discarded: ids.length,
      reason: "batch discarded by admin",
      lead_ids: ids.slice(0, 200),
    });

    return NextResponse.json({ ok: true, discarded: ids.length });
  }

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
