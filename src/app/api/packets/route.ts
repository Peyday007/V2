import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logEvent } from "@/lib/events";

export async function GET(req: NextRequest) {
  const campaignId = req.nextUrl.searchParams.get("campaign_id");
  const db = supabase();
  let q = db
    .from("packets")
    .select("*, callers(name)")
    .order("created_at", { ascending: false });
  if (campaignId) q = q.eq("campaign_id", campaignId);
  const { data: packets, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const result = [];
  for (const p of packets || []) {
    const { count: total } = await db
      .from("packet_leads")
      .select("*", { count: "exact", head: true })
      .eq("packet_id", p.id);
    const { count: done } = await db
      .from("packet_leads")
      .select("*", { count: "exact", head: true })
      .eq("packet_id", p.id)
      .eq("status", "done");
    result.push({ ...p, total: total || 0, done: done || 0 });
  }
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  const { campaign_id, sourcing_campaign_id, caller_id, size } = await req.json();
  if (!caller_id || !size || size < 1) {
    return NextResponse.json({ error: "Pick a caller and a packet size" }, { status: 400 });
  }
  const db = supabase();

  // Eligibility rules:
  //  - status 'new'  -> never placed in a packet (no duplicate calling)
  //  - machine_status 'ready_for_calling' -> the engine has finished with it
  // Leads from the sourcing engine carry sourcing_campaign_id; older/imported
  // leads carry campaign_id. Support both, and allow pulling from every ready
  // lead when no campaign is specified.
  let query = db
    .from("leads")
    .select("id")
    .eq("status", "new")
    .eq("do_not_call", false)
    .eq("machine_status", "ready_for_calling")
    .eq("phone_invalid", false)
    .is("archived_at", null);

  if (sourcing_campaign_id) {
    query = query.eq("sourcing_campaign_id", sourcing_campaign_id);
  } else if (campaign_id) {
    query = query.eq("campaign_id", campaign_id);
  }

  const { data: leads, error: leadsErr } = await query.order("created_at").limit(size);
  if (leadsErr) return NextResponse.json({ error: leadsErr.message }, { status: 500 });
  if (!leads || leads.length === 0) {
    return NextResponse.json(
      {
        error:
          "No leads are ready for calling. Generate leads on the Sourcing tab, then press 'Release leads to calling' there.",
      },
      { status: 400 }
    );
  }

  const { data: caller } = await db
    .from("callers")
    .select("name")
    .eq("id", caller_id)
    .single();

  const packetName = `${caller?.name || "Caller"} — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })} (${leads.length} leads)`;

  const { data: packet, error: pErr } = await db
    .from("packets")
    .insert({
      campaign_id: campaign_id || null,
      sourcing_campaign_id: sourcing_campaign_id || null,
      caller_id,
      name: packetName,
    })
    .select()
    .single();
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 });

  const rows = leads.map((l, i) => ({
    packet_id: packet.id,
    lead_id: l.id,
    position: i + 1,
  }));
  const { error: plErr } = await db.from("packet_leads").insert(rows);
  if (plErr) {
    await db.from("packets").delete().eq("id", packet.id);
    return NextResponse.json({ error: plErr.message }, { status: 500 });
  }

  await db
    .from("leads")
    .update({ status: "in_packet", machine_status: "assigned_to_packet" })
    .in("id", leads.map((l) => l.id));

  await logEvent("packet.created", "packet", packet.id, {
    campaign_id,
    caller_id,
    lead_count: leads.length,
  });

  return NextResponse.json({ ...packet, total: leads.length, done: 0 });
}
