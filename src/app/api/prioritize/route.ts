import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { anthropic, PRIORITIZER_MODEL } from "@/lib/anthropic";

export const dynamic = "force-dynamic";

export async function GET() {
  const ai = anthropic();
  if (!ai) {
    return NextResponse.json(
      {
        error:
          "ANTHROPIC_API_KEY is not available to this deployment. If you just added it in Vercel, you must REDEPLOY — environment variables only apply to new builds, not to already-running ones. Vercel → Deployments → ⋯ on the newest one → Redeploy.",
      },
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
      .eq("status", "new")
      .eq("do_not_call", false);
    leadCounts[c.name] = { total: total || 0, available: available || 0 };
  }

  // Sourcing engine state — without this the model gives generic advice like
  // "go pull a list off Google Maps", which this system automates.
  const { data: sourcing } = await db
    .from("sourcing_campaigns")
    .select(
      "name, status, target_lead_count, unique_saved, api_requests_used, max_api_requests, qualification_failures"
    )
    .order("created_at", { ascending: false })
    .limit(10);

  const { data: msRows } = await db.from("leads").select("machine_status").limit(5000);
  const byMachineStatus: Record<string, number> = {};
  for (const r of msRows || []) {
    const k = String(r.machine_status);
    byMachineStatus[k] = (byMachineStatus[k] || 0) + 1;
  }

  const snapshot = {
    today: new Date().toISOString().slice(0, 10),
    sourcing_campaigns: sourcing || [],
    leads_by_machine_status: byMachineStatus,
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
          content: `You are the sales operations brain for a 3-person cold-calling team selling AI Receptionist services to local service businesses (currently roofing).

IMPORTANT — what this system already does, so do not recommend doing it by hand:
- Lead generation is AUTOMATED. The admin creates a sourcing campaign (industry, city/ZIPs, search terms, target count, rating/review filters) on the Sourcing tab and presses Start. The engine queries Google Places in the background, saves, normalizes, and deduplicates businesses automatically. NEVER tell the user to manually pull lists from Google Maps, Angi, Apollo, or a list vendor, or to upload a CSV — that is the workflow this replaced.
- Decision-maker enrichment runs as a separate background stage. Leads move through machine statuses: discovered -> normalized -> enrichment_queued -> enriching -> decision_maker_found / role_only_found / enrichment_failed -> ready_for_calling. NOTE: the enrichment worker is not built yet, so leads currently STOP at enrichment_queued. Do not tell the user to wait for enrichment to finish — it will not.
- Only leads at ready_for_calling can be pulled into caller packets.
- The dialer already logs 10 outcomes (no answer, voicemail, gatekeeper, transferred, DM conversation, appointment set, callback, not interested, bad number, do not call). Do not recommend adding dispositions.
- Callers are managed on the Callers tab with 6-digit PINs; packets are generated per caller on the Campaigns tab.

Based ONLY on the real snapshot below, tell the admin what to attack today. Be direct and specific — a short prioritized list, max 5 items, each an action they can take inside THIS system. If the data is thin, say exactly which step of the pipeline is the bottleneck and what unblocks it. Do not invent numbers.

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
