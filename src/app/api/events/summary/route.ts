import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/** Counts by type/actor/source, so the admin view can offer real filters. */
export async function GET() {
  const db = supabase();
  const { data, error } = await db
    .from("events")
    .select("event_type, actor_type, source, occurred_at")
    .order("occurred_at", { ascending: false })
    .limit(5000);

  if (error) {
    const needsMigration = /column .* does not exist|schema cache/i.test(error.message);
    return NextResponse.json(
      {
        error: needsMigration
          ? "Run supabase/migrations/0012_event_memory.sql — the events table is missing its memory columns."
          : error.message,
        migration_required: needsMigration,
      },
      { status: 500 }
    );
  }

  const rows = data || [];
  function tally(key: "event_type" | "actor_type" | "source") {
    const out: Record<string, number> = {};
    for (const r of rows) {
      const k = String(r[key] ?? "unknown");
      out[k] = (out[k] || 0) + 1;
    }
    return Object.fromEntries(
      Object.entries(out).sort((a, b) => b[1] - a[1])
    );
  }

  return NextResponse.json({
    sampled: rows.length,
    newest: rows[0]?.occurred_at ?? null,
    oldest: rows[rows.length - 1]?.occurred_at ?? null,
    by_type: tally("event_type"),
    by_actor: tally("actor_type"),
    by_source: tally("source"),
  });
}
