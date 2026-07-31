import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { buildTimesheet, type ActivityEvent } from "@/lib/timeTracking";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const db = supabase();
  const days = Math.max(1, Math.min(365, Number(req.nextUrl.searchParams.get("days")) || 30));
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  const { data, error } = await db
    .from("calls")
    .select("created_at, started_at, duration_seconds, outcome, callers(name)")
    .gte("created_at", since)
    .order("created_at")
    .limit(50000);

  if (error) {
    const hint = /column .* does not exist|schema cache/i.test(error.message)
      ? "The call timing columns are missing. Run supabase/migrations/0013_call_analytics.sql, then reload."
      : error.message;
    return NextResponse.json({ error: hint }, { status: 500 });
  }

  const events: ActivityEvent[] = (data || []).map((c) => {
    const caller = Array.isArray(c.callers) ? c.callers[0] : c.callers;
    return {
      callerName: caller?.name ?? "Unknown",
      at: c.created_at,
      startedAt: c.started_at ?? null,
      durationSeconds: c.duration_seconds ?? null,
      outcome: c.outcome,
    };
  });

  return NextResponse.json({
    windowDays: days,
    timesheets: buildTimesheet(events),
    // Stated on the page so the numbers are never mistaken for presence.
    basis:
      "Derived from the server timestamp on every saved call outcome. The app sees logged work, not whether someone was at their desk.",
  });
}
