import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recordEvent } from "@/lib/events";

export const dynamic = "force-dynamic";

/**
 * A human looked. Two possible verdicts, and neither re-runs the model.
 *
 * "agreed" closes it. "corrected" overwrites the applied reading with what the
 * person says happened — the model's own reading is left untouched beside it,
 * because that pair is the only thing that makes accuracy measurable later.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const verdict = body.verdict === "corrected" ? "corrected" : "agreed";

  const db = supabaseAdmin();
  const { data: before } = await db
    .from("call_analysis")
    .select("id, call_id, lead_id, applied_result")
    .eq("id", id)
    .maybeSingle();
  if (!before) return NextResponse.json({ error: "No such analysis" }, { status: 404 });

  const patch: Record<string, unknown> = {
    reviewed_at: new Date().toISOString(),
    reviewed_by: "admin",
    review_verdict: verdict,
    needs_review: false,
  };

  if (verdict === "corrected" && body.corrections && typeof body.corrections === "object") {
    patch.applied_result = { ...(before.applied_result || {}), ...body.corrections };
    patch.authority = "human";
  }

  const { error } = await db.from("call_analysis").update(patch).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await recordEvent({
    type: verdict === "corrected" ? "analysis.corrected" : "analysis.confirmed",
    entityType: "call",
    entityId: before.call_id,
    callId: before.call_id,
    leadId: before.lead_id,
    actorType: "admin",
    source: "ui",
    previousValue: before.applied_result ?? null,
    newValue: patch.applied_result ?? before.applied_result ?? null,
    metadata: { verdict },
    verificationStatus: verdict === "corrected" ? "corrected" : "verified",
  });

  return NextResponse.json({ ok: true });
}
