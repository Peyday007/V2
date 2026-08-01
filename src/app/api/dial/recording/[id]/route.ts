import { NextRequest, NextResponse } from "next/server";
import { getCallerId } from "@/lib/callerSession";
import { discardRecording } from "@/lib/recordingStore";

export const dynamic = "force-dynamic";

/** Bin it. Used when the caller changes their mind, or on a refusal. */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const callerId = await getCallerId();
  if (!callerId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const reason = String(body.reason || "").trim() || "discarded_by_caller";

  const result = await discardRecording(id, reason, `caller:${callerId}`);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ ok: true });
}
