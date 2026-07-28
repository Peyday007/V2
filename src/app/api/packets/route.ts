import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logEvent } from "@/lib/events";
import { buildSuppressionIndex, partitionEligible } from "@/lib/suppression";
import {
  applyAvailableFilter,
  summarizeAvailability,
  explainNoneAvailable,
  AVAILABILITY_COLUMNS,
} from "@/lib/leadEligibility";
import { buildCallerProfile } from "@/lib/callerProfile";
import type { CallFact } from "@/lib/analytics";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Industries where this caller beats the rest of the team by more than chance.
 * Empty until the evidence is there, which is the normal state early on.
 */
async function industryStrengthsFor(
  db: SupabaseClient,
  callerId: string
): Promise<string[]> {
  const { data, error } = await db
    .from("calls")
    .select(
      "caller_id, outcome, reached_dm, created_at, lead_industry, spoke_with_role, duration_seconds, attempt_number, dialed_hour, dialed_dow, lead_state, owner_known_before"
    )
    .not("lead_industry", "is", null)
    .limit(20000);
  // Routing is an optimisation; never let it break packet creation.
  if (error || !data) return [];

  const toFact = (c: (typeof data)[number]): CallFact => ({
    outcome: c.outcome,
    reached_dm: !!c.reached_dm,
    caller_name: String(c.caller_id),
    lead_industry: c.lead_industry ?? null,
    lead_state: c.lead_state ?? null,
    dialed_hour: c.dialed_hour ?? null,
    dialed_dow: c.dialed_dow ?? null,
    attempt_number: c.attempt_number ?? null,
    duration_seconds: c.duration_seconds ?? null,
    owner_known_before: c.owner_known_before ?? null,
    created_at: c.created_at,
    spoke_with_role: c.spoke_with_role ?? null,
  });

  const mine = data.filter((c) => c.caller_id === callerId).map(toFact);
  const others = data.filter((c) => c.caller_id !== callerId).map(toFact);
  if (mine.length === 0) return [];

  return buildCallerProfile({ callerName: callerId, mine, others }).routeToIndustries;
}

export async function GET(req: NextRequest) {
  const campaignId = req.nextUrl.searchParams.get("campaign_id");
  const db = supabase();
  let q = db
    .from("packets")
    .select("*, callers(id, name, active)")
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
    const { count: callsMade } = await db
      .from("calls")
      .select("*", { count: "exact", head: true })
      .eq("packet_id", p.id);
    result.push({
      ...p,
      total: total || 0,
      done: done || 0,
      remaining: (total || 0) - (done || 0),
      callsMade: callsMade || 0,
      // A packet with calls against it can be closed but never deleted:
      // removing it would leave those calls pointing at nothing.
      canDelete: (callsMade || 0) === 0,
    });
  }
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { campaign_id, sourcing_campaign_id, caller_id, size } = body;
  // Trial packets must NOT be weighted toward a caller's strengths, or two
  // candidates would be judged on different difficulty.
  const unbiased = body.unbiased === true;
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
  let query = applyAvailableFilter(
    db.from("leads").select("id, phone, normalized_phone, do_not_call, industry")
  );

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

  /* --------------------------- play to their strengths ---------------------------
   * If this caller is MEASURABLY better in certain industries, put those leads
   * at the front of their packet. Only kicks in once the edge has cleared a
   * significance test against the rest of the team — otherwise the order is
   * untouched, because routing on noise just moves luck around.
   *
   * It biases the order; it never filters. A caller with a specialism still
   * gets a full packet.
   */
  const strengths = unbiased ? [] : await industryStrengthsFor(db, caller_id);
  const leads = strengths.length
    ? [
        ...eligible.filter((l) => l.industry && strengths.includes(l.industry)),
        ...eligible.filter((l) => !l.industry || !strengths.includes(l.industry)),
      ].slice(0, size)
    : eligible.slice(0, size);

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
    // Say where the leads actually went, rather than a bare "none available"
    // while the dashboard is showing a number.
    const { data: everything } = await db
      .from("leads")
      .select(AVAILABILITY_COLUMNS)
      .limit(20000);
    const availability = summarizeAvailability(everything || []);
    return NextResponse.json(
      {
        error:
          blocked.length > 0
            ? `No callable leads are left — ${blocked.length} were excluded because their phone number is on the do-not-call list. ${explainNoneAvailable(availability)}`
            : explainNoneAvailable(availability),
        availability,
      },
      { status: 400 }
    );
  }

  const { data: caller } = await db
    .from("callers")
    .select("name")
    .eq("id", caller_id)
    .single();

  const when = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const packetName = unbiased
    ? `TRIAL — ${caller?.name || "Caller"} — ${when} (${leads.length} leads)`
    : `${caller?.name || "Caller"} — ${when} (${leads.length} leads)`;

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
