import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getCallerId } from "@/lib/callerSession";
import { logEvent } from "@/lib/events";
import { CALL_OUTCOMES } from "@/lib/constants";

const DM_OUTCOMES = new Set(["dm_conversation", "appointment_set"]);

export async function POST(req: NextRequest) {
  const callerId = await getCallerId();
  if (!callerId) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  const { lead_id, packet_id, outcome, notes } = await req.json();
  if (!lead_id || !outcome || !CALL_OUTCOMES.some((o) => o.value === outcome)) {
    return NextResponse.json({ error: "Invalid outcome" }, { status: 400 });
  }

  const db = supabase();
  const reachedDm = DM_OUTCOMES.has(outcome);

  const { data: call, error } = await db
    .from("calls")
    .insert({
      lead_id,
      packet_id: packet_id || null,
      caller_id: callerId,
      outcome,
      reached_dm: reachedDm,
      notes: notes || null,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (packet_id) {
    await db
      .from("packet_leads")
      .update({ status: "done" })
      .eq("packet_id", packet_id)
      .eq("lead_id", lead_id);

    const { count } = await db
      .from("packet_leads")
      .select("*", { count: "exact", head: true })
      .eq("packet_id", packet_id)
      .eq("status", "pending");
    if (count === 0) {
      await db.from("packets").update({ status: "completed" }).eq("id", packet_id);
      await logEvent("packet.completed", "packet", packet_id, { caller_id: callerId });
    }
  }

  await db.from("leads").update({ status: "called" }).eq("id", lead_id);

  await logEvent("call.logged", "call", call.id, {
    lead_id,
    packet_id,
    caller_id: callerId,
    outcome,
    reached_dm: reachedDm,
  });

  return NextResponse.json({ ok: true });
}
