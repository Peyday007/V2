import { NextRequest, NextResponse } from "next/server";
import { transcribeRecording } from "@/lib/recordingStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** Re-run transcription: after adding a provider key, or after a failure. */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const result = await transcribeRecording(id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, segments: result.segments });
}
