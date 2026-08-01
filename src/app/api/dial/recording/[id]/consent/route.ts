import { NextRequest, NextResponse } from "next/server";
import { getCallerId } from "@/lib/callerSession";
import { recordConsent } from "@/lib/recordingStore";

export const dynamic = "force-dynamic";

/**
 * The caller marks what the prospect actually said. A refusal DELETES the
 * audio captured so far — it does not merely stop the recording.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const callerId = await getCallerId();
  if (!callerId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const status = body.status === "granted" ? "granted" : body.status === "refused" ? "refused" : null;
  if (!status) {
    return NextResponse.json({ error: "Consent must be granted or refused" }, { status: 400 });
  }

  const result = await recordConsent(id, status, `caller:${callerId}`);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ ok: true, discarded: result.discarded });
}
