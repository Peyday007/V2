import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * Queryable event history.
 *
 *   /api/events?lead_id=…        per-lead history
 *   /api/events?caller_id=…      per-caller history
 *   /api/events?packet_id=…      per-packet history
 *   /api/events?call_id=…        per-call history
 *   /api/events?campaign_id=…    per-campaign history
 *   /api/events?correlation_id=… everything from one workflow
 *   /api/events?type=lead.enriched&since=2026-07-01&q=turner
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const limit = Math.min(Number(p.get("limit")) || 100, 500);
  const offset = Math.max(Number(p.get("offset")) || 0, 0);

  let q = supabase()
    .from("events")
    .select(
      "id, event_type, entity_type, entity_id, lead_id, campaign_id, packet_id, call_id, " +
        "actor_type, actor_caller_id, previous_value, new_value, data, correlation_id, " +
        "causation_event_id, source, confidence, verification_status, occurred_at, created_at",
      { count: "exact" }
    );

  const eq: [string, string | null][] = [
    ["lead_id", p.get("lead_id")],
    ["packet_id", p.get("packet_id")],
    ["call_id", p.get("call_id")],
    ["campaign_id", p.get("campaign_id")],
    ["actor_caller_id", p.get("caller_id")],
    ["correlation_id", p.get("correlation_id")],
    ["event_type", p.get("type")],
    ["entity_type", p.get("entity_type")],
    ["actor_type", p.get("actor_type")],
    ["source", p.get("source")],
  ];
  for (const [col, val] of eq) if (val) q = q.eq(col, val);

  const since = p.get("since");
  const until = p.get("until");
  if (since) q = q.gte("occurred_at", since);
  if (until) q = q.lte("occurred_at", until);

  // Free-text across the payload, for "what happened to Turner Roofing".
  const search = p.get("q");
  if (search) q = q.ilike("data", `%${search}%`);

  const { data, error, count } = await q
    .order("occurred_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    const needsMigration = /column .* does not exist|schema cache/i.test(error.message);
    return NextResponse.json(
      {
        error: needsMigration
          ? "The events table is missing its memory columns. Run supabase/migrations/0012_event_memory.sql in the Supabase SQL Editor."
          : `Could not load events: ${error.message}`,
        migration_required: needsMigration,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    events: data || [],
    total: count ?? 0,
    limit,
    offset,
  });
}
