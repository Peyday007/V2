import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { buildScriptStats, leaderNote, type ScriptCall } from "@/lib/scriptStats";

export const dynamic = "force-dynamic";

function payload(over: Record<string, unknown> = {}) {
  return {
    rows: [],
    leader: "",
    untagged: 0,
    days: 30,
    error: null as string | null,
    ...over,
  };
}

function migrationHint(message: string): string | null {
  if (/relation .* does not exist|column .* does not exist|schema cache/i.test(message)) {
    return (
      "Run supabase/migrations/0024_workshop_packets.sql in the Supabase SQL Editor, then reload. " +
      `(${message})`
    );
  }
  return null;
}

export async function GET(req: NextRequest) {
  const db = supabaseAdmin();
  const days = Math.max(1, Math.min(365, Number(req.nextUrl.searchParams.get("days")) || 30));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  try {
    const [callsRes, packetsRes] = await Promise.all([
      db
        .from("calls")
        .select("script_version, outcome, reached_dm, spoke_with_role, lead_id")
        .gte("created_at", since)
        .limit(50000),
      db
        .from("workshop_packets")
        .select("lead_id, status")
        .eq("status", "trial_requested")
        .limit(5000),
    ]);

    const firstError = callsRes.error || packetsRes.error;
    if (firstError) {
      return NextResponse.json(
        payload({ days, error: migrationHint(firstError.message) || firstError.message }),
        { status: 200 }
      );
    }

    const calls = (callsRes.data || []) as ScriptCall[];
    const rows = buildScriptStats({
      calls,
      trialLeadIds: (packetsRes.data || []).map((p) => String(p.lead_id)),
    });

    return NextResponse.json(
      payload({
        rows,
        days,
        leader: leaderNote(rows),
        // Calls made without picking a version. Reported rather than hidden:
        // a big number here means the dropdown is being skipped and the test
        // is quietly running on a fraction of the dials.
        untagged: calls.filter((c) => !c.script_version).length,
      })
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(payload({ days, error: migrationHint(msg) || msg }), { status: 200 });
  }
}
