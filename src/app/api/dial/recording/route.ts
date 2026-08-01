import { NextRequest, NextResponse } from "next/server";
import { getCallerId } from "@/lib/callerSession";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { decideConsent } from "@/lib/consent";
import { loadRecordingSettings, startRecording } from "@/lib/recordingStore";
import { transcriptionCapability } from "@/lib/transcription";

export const dynamic = "force-dynamic";

/**
 * These live under /api/dial/ rather than /api/recordings/ on purpose: the
 * admin passphrase gate in middleware.ts protects everything except a short
 * list of prefixes, and callers sign in with a PIN, not the passphrase. The
 * admin-only half (playback, transcript, delete) stays under /api/recordings/
 * where the gate does apply.
 */

function migrationHint(message: string): string | null {
  if (/relation .* does not exist|column .* does not exist|schema cache|Bucket not found/i.test(message)) {
    return (
      "Recording is not set up yet. Run supabase/migrations/0019_call_intelligence.sql and " +
      `0021_browser_recordings.sql in the Supabase SQL Editor, then reload. (${message})`
    );
  }
  return null;
}

/**
 * What the dialer needs before it offers a Record button: whether recording is
 * on at all, what the law requires for THIS lead, and whether a half-finished
 * recording was left open by a refresh.
 */
export async function GET(req: NextRequest) {
  const callerId = await getCallerId();
  if (!callerId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const leadId = req.nextUrl.searchParams.get("lead_id");
  const settings = await loadRecordingSettings();

  let leadState: string | null = null;
  if (leadId) {
    try {
      const { data } = await supabaseAdmin().from("leads").select("state").eq("id", leadId).maybeSingle();
      leadState = data?.state ?? null;
    } catch {
      leadState = null;
    }
  }

  const decision = decideConsent({
    policy: settings.consentPolicy,
    recordingEnabled: settings.recordingEnabled,
    leadState,
  });

  let open:
    | { id: string; partsUploaded: number; consentStatus: string; startedAt: string | null }
    | null = null;
  try {
    const { data } = await supabaseAdmin()
      .from("recordings")
      .select("id, parts_uploaded, consent_status, started_at")
      .eq("caller_id", callerId)
      .eq("capture_mode", "browser_room")
      .is("deleted_at", null)
      .is("finalized_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) {
      open = {
        id: data.id,
        partsUploaded: data.parts_uploaded ?? 0,
        consentStatus: data.consent_status,
        startedAt: data.started_at,
      };
    }
  } catch {
    open = null;
  }

  const transcription = transcriptionCapability();

  return NextResponse.json({
    enabled: settings.recordingEnabled,
    decision,
    announcement: settings.announcement,
    leadState,
    retentionDays: settings.retentionDays,
    transcription: {
      enabled: settings.transcriptionEnabled,
      available: transcription.available,
      reason: transcription.reason,
    },
    open,
  });
}

/** Begin a capture. Fails closed: no consent decision, no recording. */
export async function POST(req: NextRequest) {
  const callerId = await getCallerId();
  if (!callerId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const clientCaptureId = String(body.client_capture_id || "").trim();
  const leadId = String(body.lead_id || "").trim();
  const mimeType = String(body.mime_type || "audio/webm").trim();

  if (!clientCaptureId || !leadId) {
    return NextResponse.json({ error: "Missing lead or capture id" }, { status: 400 });
  }

  try {
    const { data: lead } = await supabaseAdmin()
      .from("leads")
      .select("state")
      .eq("id", leadId)
      .maybeSingle();

    const result = await startRecording({
      clientCaptureId,
      leadId,
      callerId,
      leadState: lead?.state ?? null,
      mimeType,
    });

    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
    return NextResponse.json({
      recording_id: result.recordingId,
      consent_status: result.consentStatus,
      policy_applied: result.policyApplied,
      reason: result.reason,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: migrationHint(msg) || msg }, { status: 500 });
  }
}
