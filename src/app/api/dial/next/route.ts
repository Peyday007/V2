import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getCallerId } from "@/lib/callerSession";
import { anthropic, APPROACH_MODEL } from "@/lib/anthropic";

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
  const { data: lead } = await db
    .from("leads")
    .select("*")
    .eq("id", next.lead_id)
    .single();

  let approach: string | null = null;
  const ai = anthropic();
  if (ai && lead) {
    try {
      const msg = await ai.messages.create({
        model: APPROACH_MODEL,
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content: `You are coaching a cold caller selling an AI Receptionist service to roofing companies. Based only on this lead's real data, give a 2-3 sentence approach recommendation for the call. Be specific and practical, no fluff.

Business: ${lead.business_name}
City: ${lead.city || "unknown"}, ${lead.state || ""}
Google rating: ${lead.rating ?? "unknown"} (${lead.review_count ?? 0} reviews)
Website: ${lead.website || "none found"}
Decision maker: ${lead.dm_name ? `${lead.dm_name} (${lead.dm_title || "title unknown"})` : "not identified"}
Notes: ${lead.notes || "none"}`,
          },
        ],
      });
      const block = msg.content[0];
      approach = block.type === "text" ? block.text : null;
    } catch (e) {
      console.error("approach generation failed:", e);
    }
  }

  return NextResponse.json({
    caller: caller.name,
    lead,
    packetId: next.packet_id,
    approach,
    remaining: pending.length,
  });
}
