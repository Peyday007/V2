import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { recordEvent } from "@/lib/events";

export const dynamic = "force-dynamic";

const DECISIONS = ["added", "cut", "extended"] as const;
type Decision = (typeof DECISIONS)[number];

/** Record the hire/cut decision, or abandon the trial. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const db = supabase();

  const { data: trial } = await db
    .from("caller_trials")
    .select("id, caller_id, packet_id, status, target_calls, callers(name)")
    .eq("id", id)
    .single();
  if (!trial) return NextResponse.json({ error: "Trial not found" }, { status: 404 });

  const callerRel = Array.isArray(trial.callers) ? trial.callers[0] : trial.callers;
  const callerName = callerRel?.name || "the caller";

  /* ------------------------------- abandon ------------------------------- */
  if (body.action === "abandon") {
    await db
      .from("caller_trials")
      .update({ status: "abandoned", finished_at: new Date().toISOString() })
      .eq("id", id);
    await recordEvent({
      type: "packet.completed",
      entityType: "packet",
      entityId: trial.packet_id,
      packetId: trial.packet_id,
      actorType: "admin",
      source: "ui",
      newValue: { trial_status: "abandoned" },
      metadata: { trial_id: id, caller: callerName },
    });
    return NextResponse.json({ ok: true, status: "abandoned" });
  }

  /* ------------------------------- decide -------------------------------- */
  const decision = body.decision as Decision;
  if (!DECISIONS.includes(decision)) {
    return NextResponse.json(
      { error: `decision must be one of: ${DECISIONS.join(", ")}` },
      { status: 400 }
    );
  }

  const note = typeof body.note === "string" ? body.note.trim() : "";

  const { error } = await db
    .from("caller_trials")
    .update({
      status: decision === "extended" ? "running" : "decided",
      decision,
      decision_note: note || null,
      decided_at: new Date().toISOString(),
      finished_at: decision === "extended" ? null : new Date().toISOString(),
      // Extending means "keep going", so the target moves rather than the
      // trial being reopened with an already-met goal.
      target_calls:
        decision === "extended"
          ? trial.target_calls + Math.max(10, Number(body.extend_by) || 100)
          : trial.target_calls,
    })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Cutting revokes their sign-in. The record and every call they made stay.
  if (decision === "cut") {
    await db.from("callers").update({ active: false }).eq("id", trial.caller_id);
  }

  await recordEvent({
    type: decision === "cut" ? "caller.deactivated" : "caller.activated",
    entityType: "caller",
    entityId: trial.caller_id,
    actorCallerId: trial.caller_id,
    actorType: "admin",
    source: "ui",
    newValue: { trial_decision: decision },
    metadata: { trial_id: id, note: note || null, caller: callerName },
    verificationStatus: "verified",
  });

  return NextResponse.json({ ok: true, decision });
}
