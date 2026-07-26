import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { logEvent } from "@/lib/events";
import { planSearches } from "@/lib/searchPlan";
import { placesKeyConfigured } from "@/lib/places";
import { enqueue } from "@/lib/jobs";
import { requestBudgetFor } from "@/lib/budget";

export const dynamic = "force-dynamic";

export async function GET() {
  const { data, error } = await supabaseAdmin()
    .from("sourcing_campaigns")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    const missingTable = /does not exist|schema cache/i.test(error.message);
    return NextResponse.json(
      {
        error: missingTable
          ? "The sourcing engine tables don't exist yet. Run supabase/migrations/0006_engine_foundation.sql in the Supabase SQL Editor."
          : `Could not load campaigns: ${error.message}`,
        migration_required: missingTable,
        places_key_configured: placesKeyConfigured(),
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    campaigns: data,
    places_key_configured: placesKeyConfigured(),
  });
}

function toArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string") {
    return v
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function toNumber(v: unknown): number | null {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  const searchTerms = toArray(body.search_terms);
  const zips = toArray(body.zips);
  if (searchTerms.length === 0 && !body.industry?.trim()) {
    return NextResponse.json(
      { error: "Pick at least one trade" },
      { status: 400 }
    );
  }
  if (zips.length === 0 && !body.city?.trim() && !body.state?.trim()) {
    return NextResponse.json(
      { error: "Add a city or state to search" },
      { status: 400 }
    );
  }

  const target = toNumber(body.target_lead_count) ?? 300;

  // Name the campaign from what it actually targets, so nobody has to invent one.
  const where = [body.city?.trim(), body.state?.trim()?.toUpperCase()]
    .filter(Boolean)
    .join(", ");
  const autoName =
    body.name?.trim() ||
    `${body.industry?.trim() || "Home Services"}${where ? ` — ${where}` : ""}`;

  const record = {
    name: autoName,
    industry: body.industry?.trim() || null,
    state: body.state?.trim()?.toUpperCase() || null,
    city: body.city?.trim() || null,
    zips: zips.length ? zips : null,
    latitude: toNumber(body.latitude),
    longitude: toNumber(body.longitude),
    radius_m: toNumber(body.radius_m),
    search_terms: searchTerms,
    target_lead_count: target,
    // Sensible defaults; the create form never asks about these.
    min_rating: toNumber(body.min_rating) ?? 3.5,
    min_review_count: toNumber(body.min_review_count),
    max_review_count: toNumber(body.max_review_count),
    require_website: !!body.require_website,
    exclude_franchises: body.exclude_franchises !== false,
    max_api_requests: toNumber(body.max_api_requests) ?? requestBudgetFor(target),
    daily_api_request_cap: toNumber(body.daily_api_request_cap) ?? 500,
    auto_assign_packets: body.auto_assign_packets !== false,
    packet_size: toNumber(body.packet_size) ?? 50,
    status: "draft",
  };

  const { data, error } = await supabaseAdmin()
    .from("sourcing_campaigns")
    .insert(record)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logEvent("campaign.created", "sourcing_campaign", data.id, {
    name: data.name,
  });

  // Start immediately unless explicitly told not to — creating a campaign and
  // then having to press Start is a pointless second step.
  let started = false;
  let startError: string | null = null;
  if (body.autostart !== false) {
    if (!placesKeyConfigured()) {
      startError =
        "Campaign saved, but GOOGLE_PLACES_API_KEY is not available to this deployment. Add it in Vercel and redeploy, then press Start.";
    } else {
      const { error: startErr } = await supabaseAdmin()
        .from("sourcing_campaigns")
        .update({ status: "running", started_at: new Date().toISOString() })
        .eq("id", data.id);
      if (startErr) {
        startError = startErr.message;
      } else {
        await enqueue({
          type: "plan_search_tasks",
          payload: { campaign_id: data.id },
          idempotencyKey: `plan_search_tasks:${data.id}`,
          campaignId: data.id,
          priority: 10,
        });
        await logEvent("campaign.started", "sourcing_campaign", data.id, {
          auto: true,
        });
        started = true;
      }
    }
  }

  return NextResponse.json({
    campaign: { ...data, status: started ? "running" : data.status },
    planned_searches: planSearches(data).length,
    started,
    start_error: startError,
  });
}
