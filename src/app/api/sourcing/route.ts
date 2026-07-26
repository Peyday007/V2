import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { logEvent } from "@/lib/events";
import { planSearches } from "@/lib/searchPlan";
import { placesKeyConfigured } from "@/lib/places";

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
  if (!body.name?.trim()) {
    return NextResponse.json({ error: "Campaign name required" }, { status: 400 });
  }

  const searchTerms = toArray(body.search_terms);
  const zips = toArray(body.zips);
  if (searchTerms.length === 0 && !body.industry?.trim()) {
    return NextResponse.json(
      { error: "Add at least one search term or an industry" },
      { status: 400 }
    );
  }
  if (zips.length === 0 && !body.city?.trim() && !body.state?.trim()) {
    return NextResponse.json(
      { error: "Add a city, state, or ZIP codes to search" },
      { status: 400 }
    );
  }

  const record = {
    name: body.name.trim(),
    industry: body.industry?.trim() || null,
    state: body.state?.trim()?.toUpperCase() || null,
    city: body.city?.trim() || null,
    zips: zips.length ? zips : null,
    latitude: toNumber(body.latitude),
    longitude: toNumber(body.longitude),
    radius_m: toNumber(body.radius_m),
    search_terms: searchTerms,
    target_lead_count: toNumber(body.target_lead_count) ?? 100,
    min_rating: toNumber(body.min_rating),
    min_review_count: toNumber(body.min_review_count),
    max_review_count: toNumber(body.max_review_count),
    require_website: !!body.require_website,
    exclude_franchises: body.exclude_franchises !== false,
    max_api_requests: toNumber(body.max_api_requests) ?? 200,
    daily_api_request_cap: toNumber(body.daily_api_request_cap) ?? 500,
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

  return NextResponse.json({
    campaign: data,
    planned_searches: planSearches(data).length,
  });
}
