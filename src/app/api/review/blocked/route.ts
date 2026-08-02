import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recordEvent } from "@/lib/events";

export const dynamic = "force-dynamic";

/**
 * An action the model asked for and was refused. A person decides, and the
 * decision is recorded — the system still never performs these by itself.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const id = String(body.id || "");
  const approve = body.decision === "approved";
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: action } = await db
    .from("blocked_actions")
    .select("id, action, call_id, lead_id")
    .eq("id", id)
    .maybeSingle();
  if (!action) return NextResponse.json({ error: "No such action" }, { status: 404 });

  // Lifting a do-not-call is the one blocked action with a direct effect, and
  // it happens here only because a person clicked approve.
  if (approve && action.action === "release_do_not_call" && action.lead_id) {
    await db.from("leads").update({ do_not_call: false }).eq("id", action.lead_id);
  }

  await db
    .from("blocked_actions")
    .update({
      status: approve ? "approved" : "rejected",
      decided_by: "admin",
      decided_at: new Date().toISOString(),
    })
    .eq("id", id);

  await recordEvent({
    type: "action.blocked",
    entityType: "call",
    entityId: action.call_id,
    callId: action.call_id,
    leadId: action.lead_id,
    actorType: "admin",
    source: "ui",
    newValue: { action: action.action, decision: approve ? "approved" : "rejected" },
    verificationStatus: "verified",
  });

  return NextResponse.json({ ok: true });
}
