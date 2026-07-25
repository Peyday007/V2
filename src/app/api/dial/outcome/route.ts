import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getCallerId } from "@/lib/callerSession";
import { logEvent } from "@/lib/events";
import { CALL_OUTCOMES } from "@/lib/constants";
import { coerceStage, nextStageAfterOutcome } from "@/lib/stages";

const DM_OUTCOMES = new Set(["dm_conversation", "appointment_set"]);

type Discovery = {
  owner_name?: string;
  title?: string;
  direct_number?: string;
  extension?: string;
  email?: string;
  best_callback_time?: string;
  transfer_instructions?: string;
  gatekeeper_name?: string;
};

export async function POST(req: NextRequest) {
  const callerId = await getCallerId();
  if (!callerId) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  const { lead_id, packet_id, outcome, notes, discovery } = await req.json();
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

  // Persist anything the caller learned — the company never rediscovers it.
  const d: Discovery = discovery || {};
  const hasDiscovery = Object.values(d).some((v) => v && String(v).trim());
  if (hasDiscovery) {
    const clean = Object.fromEntries(
      Object.entries(d)
        .filter(([, v]) => v && String(v).trim())
        .map(([k, v]) => [k, String(v).trim()])
    );
    await db.from("call_discoveries").insert({
      lead_id,
      call_id: call.id,
      caller_id: callerId,
      ...clean,
    });

    // A discovered name becomes a real contact, marked caller-discovered.
    if (clean.owner_name) {
      const { data: existing } = await db
        .from("contacts")
        .select("id")
        .eq("lead_id", lead_id)
        .ilike("full_name", clean.owner_name)
        .limit(1);
      const contactFields = {
        full_name: clean.owner_name,
        title: clean.title || null,
        role_category: "owner",
        direct_phone: clean.direct_number || null,
        extension: clean.extension || null,
        email: clean.email || null,
        contact_source: "caller_discovered",
        confidence: 0.9,
        verified_status: "verified_by_live_call",
        updated_at: new Date().toISOString(),
      };
      if (existing && existing.length > 0) {
        await db.from("contacts").update(contactFields).eq("id", existing[0].id);
      } else {
        await db.from("contacts").insert({ lead_id, ...contactFields });
      }
    }

    await logEvent("lead.discovery_logged", "lead", lead_id, {
      call_id: call.id,
      caller_id: callerId,
      discovered: Object.keys(clean),
    });
  }

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

  const leadPatch: Record<string, unknown> = { status: "called" };
  if (outcome === "do_not_call") leadPatch.do_not_call = true;

  const { data: leadRow } = await db
    .from("leads")
    .select("pipeline_stage")
    .eq("id", lead_id)
    .single();
  const current = coerceStage(leadRow?.pipeline_stage);
  const target = nextStageAfterOutcome(current, outcome);
  if (target) {
    leadPatch.pipeline_stage = target;
    await logEvent("lead.stage_changed", "lead", lead_id, {
      from: current,
      to: target,
      via: `call outcome ${outcome}`,
    });
  }

  const { error: leadErr } = await db.from("leads").update(leadPatch).eq("id", lead_id);
  if (leadErr) console.error("[dial/outcome] lead update failed:", leadErr);

  await logEvent("call.logged", "call", call.id, {
    lead_id,
    packet_id,
    caller_id: callerId,
    outcome,
    reached_dm: reachedDm,
  });

  return NextResponse.json({ ok: true });
}
