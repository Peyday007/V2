import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { transcriptionCapability } from "@/lib/transcription";

export const dynamic = "force-dynamic";

/**
 * Recordings for a lead or a call, for the admin screens. Behind the admin
 * passphrase via middleware — the caller-facing half lives under
 * /api/dial/recording/ because callers sign in with a PIN instead.
 */
export async function GET(req: NextRequest) {
  const leadId = req.nextUrl.searchParams.get("lead_id");
  const callId = req.nextUrl.searchParams.get("call_id");
  if (!leadId && !callId) {
    return NextResponse.json({ error: "Need lead_id or call_id" }, { status: 400 });
  }

  try {
    let q = supabaseAdmin()
      .from("recordings")
      .select(
        "id, call_id, lead_id, caller_id, capture_mode, duration_seconds, size_bytes, started_at, ended_at, consent_status, consent_policy_applied, processing_status, transcription_error, deleted_at, discard_reason, created_at, callers(name)"
      )
      .order("created_at", { ascending: false })
      .limit(100);
    q = leadId ? q.eq("lead_id", leadId) : q.eq("call_id", callId!);

    const { data, error } = await q;
    if (error) {
      const hint = /relation .* does not exist|column .* does not exist|schema cache/i.test(error.message)
        ? "Run supabase/migrations/0019_call_intelligence.sql and 0021_browser_recordings.sql, then reload."
        : error.message;
      return NextResponse.json({ recordings: [], error: hint }, { status: 200 });
    }

    const cap = transcriptionCapability();
    return NextResponse.json({
      recordings: data || [],
      transcription: { available: cap.available, reason: cap.reason, remedy: cap.remedy ?? null },
      error: null,
    });
  } catch (e) {
    return NextResponse.json(
      { recordings: [], error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
