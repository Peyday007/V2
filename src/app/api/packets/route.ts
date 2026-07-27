import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logEvent } from "@/lib/events";
import { buildSuppressionIndex, partitionEligible } from "@/lib/suppression";

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
    .select("id, phone, normalized_phone, do_not_call")
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

  // Over-fetch, because suppressed leads are removed after the query. A DNC
  // is matched on the phone number, which no single column filter can express.
  const { data: candidates, error: leadsErr } = await query
    .order("created_at")
    .limit(size * 3 + 50);
  if (leadsErr) return NextResponse.json({ error: leadsErr.message }, { status: 500 });

  // The do-not-call list is authoritative and is checked against the NUMBER,
  // so a second record for the same business can never slip into a packet.
  const { data: suppressions, error: supErr } = await db
    .from("suppressions")
    .select("lead_id, normalized_phone");
  if (supErr) {
    // Never build a packet from an unknown suppression state — that is how
    // someone who asked not to be called gets called.
    return NextResponse.json(
      {
        error:
          `Could not read the do-not-call list, so no packet was created. ` +
          `If this mentions a missing table or column, run ` +
          `supabase/migrations/0014_dnc_enforcement.sql. (${supErr.message})`,
      },
      { status: 500 }
    );
  }

  const index = buildSuppressionIndex(suppressions || []);
  const { eligible, blocked } = partitionEligible(candidates || [], index);
  const leads = eligible.slice(0, size);

  if (blocked.length > 0) {
    // Self-heal: flag them so the cheap column filter catches them next time.
    await db
      .from("leads")
      .update({ do_not_call: true })
      .in("id", blocked.map((b) => b.lead.id));
    await logEvent("lead.suppressed", "lead", null, {
      lead_ids: blocked.map((b) => b.lead.id),
      count: blocked.length,
      reason: "Excluded from packet generation: phone number is on the do-not-call list",
    });
  }

  if (!leads || leads.length === 0) {
    return NextResponse.json(
      {
        error:
          blocked.length > 0
            ? `No callable leads are left — ${blocked.length} were excluded because their phone number is on the do-not-call list. Generate more leads on the Sourcing tab.`
            : "No leads are ready for calling. Generate leads on the Sourcing tab, then press 'Release leads to calling' there.",
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

  await logEvent("packet.assigned", "packet", packet.id, {
    caller_id,
    lead_count: leads.length,
    assigned_manually: true,
  });
  await logEvent("packet.created", "packet", packet.id, {
    campaign_id,
    caller_id,
    lead_count: leads.length,
  });

  return NextResponse.json({
    ...packet,
    total: leads.length,
    done: 0,
    suppressed_excluded: blocked.length,
  });
}
