import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { recordEvent, eventChain } from "@/lib/events";
import { buildSuppressionIndex, partitionEligible } from "@/lib/suppression";

export const dynamic = "force-dynamic";

/** One packet, with the leads inside it. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = supabase();

  const { data: packet, error } = await db
    .from("packets")
    .select("*, callers(id, name)")
    .eq("id", id)
    .single();
  if (error || !packet) {
    return NextResponse.json({ error: "Packet not found" }, { status: 404 });
  }

  const { data: rows } = await db
    .from("packet_leads")
    .select("lead_id, position, status, leads(id, business_name, phone, city, state, industry, attempt_count, owner_name, do_not_call)")
    .eq("packet_id", id)
    .order("position");

  const { count: callsMade } = await db
    .from("calls")
    .select("*", { count: "exact", head: true })
    .eq("packet_id", id);

  return NextResponse.json({
    packet,
    leads: rows || [],
    callsMade: callsMade ?? 0,
    // Deleting a packet that has calls against it would orphan those calls,
    // so the UI must offer Close instead.
    canDelete: (callsMade ?? 0) === 0,
  });
}

/** Rename, or hand the packet to a different caller. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const db = supabase();

  const { data: before } = await db
    .from("packets")
    .select("id, name, caller_id, status")
    .eq("id", id)
    .single();
  if (!before) return NextResponse.json({ error: "Packet not found" }, { status: 404 });

  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.caller_id === "string" && body.caller_id) patch.caller_id = body.caller_id;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
  }

  const { error } = await db.from("packets").update(patch).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (patch.caller_id && patch.caller_id !== before.caller_id) {
    const { data: to } = await db
      .from("callers")
      .select("name")
      .eq("id", patch.caller_id)
      .single();
    await recordEvent({
      type: "packet.assigned",
      entityType: "packet",
      entityId: id,
      packetId: id,
      actorType: "admin",
      source: "ui",
      actorCallerId: String(patch.caller_id),
      previousValue: { caller_id: before.caller_id },
      newValue: { caller_id: patch.caller_id, caller_name: to?.name ?? null },
      metadata: { reassigned: true },
      verificationStatus: "verified",
    });
  }

  return NextResponse.json({ ok: true });
}

/**
 * add_leads   — top an open packet up from the ready pool
 * return_leads — pull the un-dialed leads back out and close the packet
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");
  const db = supabase();

  const { data: packet } = await db
    .from("packets")
    .select("id, name, caller_id, status, sourcing_campaign_id, campaign_id")
    .eq("id", id)
    .single();
  if (!packet) return NextResponse.json({ error: "Packet not found" }, { status: 404 });

  /* ------------------------------- add leads ------------------------------ */
  if (action === "add_leads") {
    const size = Math.max(1, Math.min(500, Number(body.size) || 25));

    const { data: suppressions, error: supErr } = await db
      .from("suppressions")
      .select("lead_id, normalized_phone");
    if (supErr) {
      return NextResponse.json(
        {
          error: `Could not read the do-not-call list, so no leads were added. (${supErr.message})`,
        },
        { status: 500 }
      );
    }

    const { data: candidates, error: leadErr } = await db
      .from("leads")
      .select("id, phone, normalized_phone, do_not_call")
      .eq("status", "new")
      .eq("do_not_call", false)
      .eq("machine_status", "ready_for_calling")
      .eq("phone_invalid", false)
      .is("archived_at", null)
      .order("created_at")
      .limit(size * 3 + 50);
    if (leadErr) return NextResponse.json({ error: leadErr.message }, { status: 500 });

    const index = buildSuppressionIndex(suppressions || []);
    const { eligible, blocked } = partitionEligible(candidates || [], index);
    if (blocked.length > 0) {
      await db
        .from("leads")
        .update({ do_not_call: true })
        .in("id", blocked.map((b) => b.lead.id));
    }
    const picked = eligible.slice(0, size);
    if (picked.length === 0) {
      return NextResponse.json(
        { error: "No leads are ready to add. Generate more on the Leads tab." },
        { status: 400 }
      );
    }

    const { data: last } = await db
      .from("packet_leads")
      .select("position")
      .eq("packet_id", id)
      .order("position", { ascending: false })
      .limit(1);
    let position = (last?.[0]?.position ?? 0) + 1;

    const { error: insErr } = await db.from("packet_leads").insert(
      picked.map((l) => ({ packet_id: id, lead_id: l.id, position: position++ }))
    );
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

    await db
      .from("leads")
      .update({ status: "in_packet", machine_status: "assigned_to_packet" })
      .in("id", picked.map((l) => l.id));

    // Re-open a completed packet: the caller has work again.
    if (packet.status !== "open") {
      await db.from("packets").update({ status: "open" }).eq("id", id);
    }

    const chain = eventChain({ actorType: "admin", source: "ui" });
    await chain.record({
      type: "lead.added_to_packet",
      entityType: "packet",
      entityId: id,
      packetId: id,
      newValue: { added: picked.length },
      metadata: { suppressed_excluded: blocked.length, reopened: packet.status !== "open" },
    });

    return NextResponse.json({
      ok: true,
      added: picked.length,
      suppressed_excluded: blocked.length,
    });
  }

  /* ----------------------------- return leads ----------------------------- */
  if (action === "return_leads") {
    const { data: pending } = await db
      .from("packet_leads")
      .select("lead_id")
      .eq("packet_id", id)
      .eq("status", "pending");
    const leadIds = (pending || []).map((p) => p.lead_id);

    if (leadIds.length > 0) {
      // Remove the packet_leads rows: the unique index on lead_id means a lead
      // cannot be handed to anyone else until this link is gone.
      await db.from("packet_leads").delete().eq("packet_id", id).in("lead_id", leadIds);
      // do_not_call leads go back to the pool as un-packeted, but must never
      // be marked ready for calling again.
      await db
        .from("leads")
        .update({ status: "new", machine_status: "ready_for_calling" })
        .in("id", leadIds)
        .eq("do_not_call", false);
    }

    await db.from("packets").update({ status: "completed" }).eq("id", id);

    await recordEvent({
      type: "lead.removed_from_packet",
      entityType: "packet",
      entityId: id,
      packetId: id,
      actorType: "admin",
      source: "ui",
      newValue: { returned: leadIds.length, packet_status: "completed" },
      metadata: { lead_ids: leadIds.slice(0, 200) },
      verificationStatus: "verified",
    });

    return NextResponse.json({ ok: true, returned: leadIds.length });
  }

  return NextResponse.json(
    { error: "Unknown action. Use add_leads or return_leads." },
    { status: 400 }
  );
}

/**
 * Delete a packet outright. Only allowed when nobody has dialed from it —
 * otherwise the calls already logged would point at a packet that no longer
 * exists, and the history would be wrong.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = supabase();

  const { count: callsMade } = await db
    .from("calls")
    .select("*", { count: "exact", head: true })
    .eq("packet_id", id);
  if ((callsMade ?? 0) > 0) {
    return NextResponse.json(
      {
        error:
          `This packet has ${callsMade} call${callsMade === 1 ? "" : "s"} logged against it, ` +
          `so deleting it would break that history. Use "Return leads" instead — it takes the ` +
          `un-dialed leads back and closes the packet.`,
      },
      { status: 400 }
    );
  }

  const { data: rows } = await db
    .from("packet_leads")
    .select("lead_id")
    .eq("packet_id", id);
  const leadIds = (rows || []).map((r) => r.lead_id);

  if (leadIds.length > 0) {
    await db
      .from("leads")
      .update({ status: "new", machine_status: "ready_for_calling" })
      .in("id", leadIds)
      .eq("do_not_call", false);
  }

  const { error } = await db.from("packets").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await recordEvent({
    type: "lead.removed_from_packet",
    entityType: "packet",
    entityId: id,
    actorType: "admin",
    source: "ui",
    newValue: { deleted: true, returned: leadIds.length },
    metadata: { lead_ids: leadIds.slice(0, 200) },
    verificationStatus: "verified",
  });

  return NextResponse.json({ ok: true, returned: leadIds.length });
}
