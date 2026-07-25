import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { anthropic, PRIORITIZER_MODEL } from "@/lib/anthropic";

export const dynamic = "force-dynamic";

export async function GET() {
  const ai = anthropic();
  if (!ai) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not set on the server" },
      { status: 500 }
    );
  }

  const db = supabase();
  const [campaigns, callers, recentCalls, packets] = await Promise.all([
    db.from("campaigns").select("id, name, status"),
    db.from("callers").select("id, name, active"),
    db
      .from("calls")
      .select("outcome, reached_dm, created_at, caller_id")
      .order("created_at", { ascending: false })
      .limit(500),
    db.from("packets").select("id, caller_id, status, campaign_id"),
  ]);

  const leadCounts: Record<string, { total: number; available: number }> = {};
  for (const c of campaigns.data || []) {
    const { count: total } = await db
      .from("leads")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", c.id);
    const { count: available } = await db
      .from("leads")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", c.id)
      .eq("status", "new");
    leadCounts[c.name] = { total: total || 0, available: available || 0 };
  }

  const snapshot = {
    today: new Date().toISOString().slice(0, 10),
    campaigns: (campaigns.data || []).map((c) => ({
      name: c.name,
      status: c.status,
      ...leadCounts[c.name],
    })),
    callers: (callers.data || []).map((k) => ({
      name: k.name,
      active: k.active,
      open_packets: (packets.data || []).filter(
        (p) => p.caller_id === k.id && p.status === "open"
      ).length,
    })),
    last_500_calls: {
      total: (recentCalls.data || []).length,
      dm_conversations: (recentCalls.data || []).filter((c) => c.reached_dm).length,
      outcomes: (recentCalls.data || []).reduce(
        (acc: Record<string, number>, c) => {
          acc[c.outcome] = (acc[c.outcome] || 0) + 1;
          return acc;
        },
        {}
      ),
    },
  };

  try {
    const msg = await ai.messages.create({
      model: PRIORITIZER_MODEL,
      max_tokens: 600,
      messages: [
        {
          role: "user",
          content: `You are the sales operations brain for a 3-person cold-calling team selling AI Receptionist services to roofing companies. Based ONLY on this real pipeline snapshot, tell the admin what to attack today: which campaign needs leads, who should get packets, what the numbers say to fix first. Be direct and specific — a short prioritized list, max 5 items. If data is thin, say what to do to generate signal.

${JSON.stringify(snapshot, null, 2)}`,
        },
      ],
    });
    const block = msg.content[0];
    const recommendation = block.type === "text" ? block.text : "";
    return NextResponse.json({ recommendation, snapshot });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Claude request failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
