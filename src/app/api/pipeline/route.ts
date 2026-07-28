import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { placesKeyConfigured } from "@/lib/places";
import { summarizeCounts, nextAction, plainDiscardReason } from "@/lib/pipelineState";
import {
  AVAILABILITY_COLUMNS,
  summarizeAvailability,
  explainNoneAvailable,
} from "@/lib/leadEligibility";

export const dynamic = "force-dynamic";

/**
 * System-wide state in plain numbers, for the top of the Sourcing page.
 *
 * Deliberately NOT scoped to one campaign: an operator wants to know how many
 * leads exist to call, not how one of three campaigns is doing.
 */
export async function GET() {
  const db = supabase();

  const [leads, callers, packets, discards] = await Promise.all([
    // Every column the availability rule needs — counting on machine_status
    // alone is what made this number disagree with the Add button.
    db.from("leads").select(AVAILABILITY_COLUMNS).is("archived_at", null),
    db.from("callers").select("id").eq("active", true),
    db.from("packets").select("id").eq("status", "open"),
    db
      .from("leads")
      .select("qualification_failure_reason")
      .eq("machine_status", "enrichment_failed")
      .not("qualification_failure_reason", "is", null)
      .limit(2000),
  ]);

  if (leads.error) {
    return NextResponse.json({ error: leads.error.message }, { status: 500 });
  }

  const byStatus: Record<string, number> = {};
  for (const l of leads.data || []) {
    const k = String(l.machine_status);
    byStatus[k] = (byStatus[k] || 0) + 1;
  }
  // "Ready to call" must mean exactly what the packet queries mean by it, or
  // the dashboard promises leads the Add button cannot deliver.
  const availability = summarizeAvailability(leads.data || []);
  const counts = summarizeCounts(byStatus, { readyToCall: availability.available });

  // How many leads are actually still to be dialed, across every open packet.
  let pendingInPackets = 0;
  const openPacketIds = (packets.data || []).map((p) => p.id);
  if (openPacketIds.length > 0) {
    const { count } = await db
      .from("packet_leads")
      .select("*", { count: "exact", head: true })
      .in("packet_id", openPacketIds)
      .eq("status", "pending");
    pendingInPackets = count ?? 0;
  }

  const { data: running } = await db
    .from("sourcing_campaigns")
    .select("id")
    .eq("status", "running")
    .limit(1);

  // Why leads were discarded, grouped and said in plain language.
  const reasons: Record<string, number> = {};
  for (const d of discards.data || []) {
    const plain = plainDiscardReason(d.qualification_failure_reason);
    reasons[plain] = (reasons[plain] || 0) + 1;
  }

  const input = {
    placesKeyConfigured: placesKeyConfigured(),
    callerSecretConfigured: !!process.env.CALLER_SESSION_SECRET,
    activeCallers: (callers.data || []).length,
    counts,
    pendingInPackets,
    campaignRunning: (running || []).length > 0,
  };

  return NextResponse.json({
    counts,
    pendingInPackets,
    activeCallers: input.activeCallers,
    openPackets: openPacketIds.length,
    campaignRunning: input.campaignRunning,
    placesKeyConfigured: input.placesKeyConfigured,
    callerSecretConfigured: input.callerSecretConfigured,
    discardReasons: Object.entries(reasons)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    // Where every lead that ISN'T available has gone, so a zero is explainable
    // on the page rather than only after pressing a button.
    availability,
    noneAvailableExplanation:
      availability.available === 0 ? explainNoneAvailable(availability) : null,
    next: nextAction(input),
  });
}
