import { NextRequest, NextResponse } from "next/server";
import { getCallerId } from "@/lib/callerSession";
import { finalizeRecording, loadRecordingSettings, transcribeRecording } from "@/lib/recordingStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Stitching parts and posting to a transcription provider outlasts a default
// serverless slice on a long call.
export const maxDuration = 300;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const callerId = await getCallerId();
  if (!callerId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));

  const result = await finalizeRecording(id, {
    durationSeconds: Number.isFinite(Number(body.duration_seconds)) ? Number(body.duration_seconds) : null,
    partsExpected: Number.isFinite(Number(body.parts)) ? Number(body.parts) : null,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });

  // Transcription is a bonus. It never turns a saved recording into a failure.
  const settings = await loadRecordingSettings();
  let transcript: { ok: boolean; segments: number; error?: string } | null = null;
  if (settings.transcriptionEnabled) {
    transcript = await transcribeRecording(id).catch((e) => ({
      ok: false,
      segments: 0,
      error: e instanceof Error ? e.message : String(e),
    }));
  }

  return NextResponse.json({ ok: true, size_bytes: result.sizeBytes ?? 0, transcript });
}
