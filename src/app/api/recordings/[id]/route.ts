import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { discardRecording, playbackUrlFor, logCompliance } from "@/lib/recordingStore";

export const dynamic = "force-dynamic";

/** Playback link plus whatever transcript exists. Admin only, via middleware. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = supabaseAdmin();

  const { data: rec, error } = await db
    .from("recordings")
    .select(
      "id, call_id, lead_id, caller_id, capture_mode, duration_seconds, size_bytes, mime_type, started_at, ended_at, consent_status, consent_policy_applied, processing_status, transcription_error, deleted_at, discard_reason"
    )
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!rec) return NextResponse.json({ error: "No such recording" }, { status: 404 });

  const { data: segments } = await db
    .from("transcript_segments")
    .select("sequence, start_ms, end_ms, speaker, speaker_confidence, text")
    .eq("recording_id", id)
    .order("sequence", { ascending: true });

  const playbackUrl = rec.deleted_at ? null : await playbackUrlFor(id);

  // Listening to somebody's call is worth a record of who listened.
  if (playbackUrl) {
    await logCompliance({
      eventType: "recording_accessed",
      recordingId: id,
      callId: rec.call_id,
      leadId: rec.lead_id,
      actor: "admin",
    });
  }

  return NextResponse.json({ recording: rec, playbackUrl, segments: segments || [] });
}

/** Throw the audio away. The row and the audit trail stay. */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const reason = String(body.reason || "").trim() || "deleted_by_admin";

  const result = await discardRecording(id, reason, "admin");
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ ok: true });
}
