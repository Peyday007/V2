import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getCallerId } from "@/lib/callerSession";
import { anthropic, APPROACH_MODEL } from "@/lib/anthropic";
import { recommendApproach } from "@/lib/approach";

export async function GET() {
  const callerId = await getCallerId();
  if (!callerId) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  const db = supabase();
  const { data: caller } = await db
    .from("callers")
    .select("id, name, active")
    .eq("id", callerId)
    .single();
  if (!caller || !caller.active) {
    return NextResponse.json({ error: "Access revoked" }, { status: 401 });
  }

  const { data: packets } = await db
    .from("packets")
    .select("id, name")
    .eq("caller_id", callerId)
    .eq("status", "open")
    .order("created_at");
  if (!packets || packets.length === 0) {
    return NextResponse.json({ caller: caller.name, lead: null, remaining: 0 });
  }

  const packetIds = packets.map((p) => p.id);
  const { data: pending } = await db
    .from("packet_leads")
    .select("packet_id, lead_id, position")
    .in("packet_id", packetIds)
    .eq("status", "pending")
    .order("position")
    .limit(200);

  if (!pending || pending.length === 0) {
    return NextResponse.json({ caller: caller.name, lead: null, remaining: 0 });
  }

  const next = pending[0];
  const [{ data: lead }, { data: contacts }, { data: discoveries }, { data: history }] =
    await Promise.all([
      db.from("leads").select("*").eq("id", next.lead_id).single(),
      db
        .from("contacts")
        .select("*")
        .eq("lead_id", next.lead_id)
        .eq("active", true)
        .order("confidence", { ascending: false }),
      db
        .from("call_discoveries")
        .select("*")
        .eq("lead_id", next.lead_id)
        .order("created_at", { ascending: false })
        .limit(1),
      db
        .from("calls")
        .select("outcome, notes, created_at, details, next_step, spoke_with_role, callers(name)")
        .eq("lead_id", next.lead_id)
        .order("created_at", { ascending: false })
        .limit(5),
    ]);

  const latestDiscovery = discoveries?.[0] || null;
  // The engine's stored recommendation wins when nothing newer was learned
  // on a call; otherwise recompute from live contacts/discoveries.
  const computed = lead
    ? recommendApproach(lead, contacts || [], latestDiscovery)
    : null;
  const approach =
    lead?.recommended_ask && !latestDiscovery && (contacts || []).length === 0
      ? { route: "C" as const, text: lead.recommended_ask }
      : computed;

  let aiTip: string | null = null;
  const ai = anthropic();
  if (ai && lead) {
    try {
      const msg = await ai.messages.create({
        model: APPROACH_MODEL,
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content: `You are coaching a cold caller selling an AI Receptionist service to local service businesses. Based only on this lead's real data, give a 2-3 sentence practical tip for this specific call. No fluff, no invented facts.

Business: ${lead.business_name}
Industry: ${lead.industry || "unknown"}
City: ${lead.city || "unknown"}, ${lead.state || ""}
Google rating: ${lead.rating ?? "unknown"} (${lead.review_count ?? 0} reviews)
Website: ${lead.website || "none found"}
Known contacts: ${
              (contacts || [])
                .map((c) => `${c.full_name || "?"} (${c.title || c.role_category})`)
                .join(", ") || "none"
            }
Recommended approach: ${approach?.text || "n/a"}
Notes: ${lead.notes || "none"}`,
          },
        ],
      });
      const block = msg.content[0];
      aiTip = block.type === "text" ? block.text : null;
    } catch (e) {
      console.error("AI tip failed:", e);
    }
  }

  // Pending callback, so the caller knows one is already booked.
  const { data: pendingCallbacks } = await db
    .from("callbacks")
    .select("scheduled_for, reason, requested_by_name")
    .eq("lead_id", next.lead_id)
    .eq("status", "pending")
    .order("scheduled_for")
    .limit(1);

  const { count: doneToday } = await db
    .from("calls")
    .select("*", { count: "exact", head: true })
    .eq("caller_id", callerId)
    .gte("created_at", new Date(new Date().setHours(0, 0, 0, 0)).toISOString());

  return NextResponse.json({
    caller: caller.name,
    lead,
    pendingCallback: pendingCallbacks?.[0] || null,
    doneToday: doneToday ?? 0,
    contacts: contacts || [],
    discovery: latestDiscovery,
    history: history || [],
    approach,
    aiTip,
    packetId: next.packet_id,
    remaining: pending.length,
  });
}
