import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getCallerId } from "@/lib/callerSession";
import { anthropic, APPROACH_MODEL } from "@/lib/anthropic";
import { recommendApproach } from "@/lib/approach";
import { buildSuppressionIndex, checkSuppressed } from "@/lib/suppression";
import { logEvent } from "@/lib/events";

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

  /* ------------------------------ due callbacks ------------------------------
   * A booked callback used to fall out of the packet the moment its outcome
   * was logged, leaving the admin to put the lead back by hand. Callbacks are
   * now their own queue, served AHEAD of packet work: the caller promised a
   * time, so that promise outranks the list.
   */
  const nowIso = new Date().toISOString();
  const { data: dueCallbacks } = await db
    .from("callbacks")
    .select("id, lead_id, caller_id, scheduled_for, reason, requested_by_name, callers(active)")
    .eq("status", "pending")
    .lte("scheduled_for", nowIso)
    .order("scheduled_for")
    .limit(50);

  // Yours first. A callback booked by someone who has since been deactivated
  // would otherwise never be honoured, so anyone may pick those up.
  const mine = (dueCallbacks || []).filter((c) => c.caller_id === callerId);
  const orphaned = (dueCallbacks || []).filter((c) => {
    if (c.caller_id === callerId) return false;
    const owner = Array.isArray(c.callers) ? c.callers[0] : c.callers;
    return owner ? !owner.active : true;
  });
  const callbackQueue = [...mine, ...orphaned];

  const { data: packets } = await db
    .from("packets")
    .select("id, name")
    .eq("caller_id", callerId)
    .eq("status", "open")
    .order("created_at");
  const packetIds = (packets || []).map((p) => p.id);
  let pending: { packet_id: string; lead_id: string; position: number }[] = [];
  if (packetIds.length > 0) {
    const { data } = await db
      .from("packet_leads")
      .select("packet_id, lead_id, position")
      .in("packet_id", packetIds)
      .eq("status", "pending")
      .order("position")
      .limit(200);
    pending = data || [];
  }

  /** One thing to dial: either a promised callback or the next packet lead. */
  type Candidate = {
    lead_id: string;
    packet_id: string | null;
    callback_id: string | null;
    scheduled_for: string | null;
    reason: string | null;
  };

  const seenLeads = new Set<string>();
  const candidates: Candidate[] = [];
  for (const cb of callbackQueue) {
    if (seenLeads.has(cb.lead_id)) continue;
    seenLeads.add(cb.lead_id);
    candidates.push({
      lead_id: cb.lead_id,
      packet_id: null,
      callback_id: cb.id,
      scheduled_for: cb.scheduled_for,
      reason: cb.reason ?? null,
    });
  }
  for (const p of pending) {
    if (seenLeads.has(p.lead_id)) continue; // already queued as a callback
    seenLeads.add(p.lead_id);
    candidates.push({
      lead_id: p.lead_id,
      packet_id: p.packet_id,
      callback_id: null,
      scheduled_for: null,
      reason: null,
    });
  }

  if (candidates.length === 0) {
    return NextResponse.json({ caller: caller.name, lead: null, remaining: 0 });
  }

  /* -------------------- do-not-call, checked at the last moment --------------------
   * A lead can be suppressed after the packet was built — someone else calls
   * the same number and gets a DNC, or it is added to the list by hand. This
   * is the final gate before a number reaches a caller's screen, so a
   * suppressed business is never dialed even if it is already sitting in an
   * open packet.
   */
  const scanIds = candidates.slice(0, 50).map((p) => p.lead_id);
  const [{ data: scanLeads }, { data: suppressions, error: supErr }] = await Promise.all([
    db.from("leads").select("id, phone, normalized_phone, do_not_call").in("id", scanIds),
    db.from("suppressions").select("lead_id, normalized_phone"),
  ]);

  if (supErr) {
    // Refuse to serve a lead rather than guess. Being unable to read the
    // do-not-call list is exactly how someone who asked not to be called
    // gets called.
    return NextResponse.json(
      {
        caller: caller.name,
        lead: null,
        remaining: candidates.length,
        error:
          "The do-not-call list could not be read, so no lead was served. " +
          "Tell your admin to run supabase/migrations/0014_dnc_enforcement.sql.",
      },
      { status: 503 }
    );
  }

  const index = buildSuppressionIndex(suppressions || []);
  const leadById = new Map((scanLeads || []).map((l) => [l.id, l]));

  let next: Candidate | null = null;
  const skipped: string[] = [];
  for (const candidate of candidates) {
    const row = leadById.get(candidate.lead_id);
    if (!row) continue; // outside the scan window; leave it for the next call
    if (checkSuppressed(row, index).suppressed) {
      skipped.push(candidate.lead_id);
      continue;
    }
    next = candidate;
    break;
  }

  if (skipped.length > 0) {
    // Close them out of the packet and flag them, so this work is done once.
    await db.from("packet_leads").update({ status: "done" }).in("lead_id", skipped);
    // A suppressed lead's callback must die with it, or it comes straight back.
    await db.from("callbacks").update({ status: "cancelled" }).in("lead_id", skipped);
    await db.from("leads").update({ do_not_call: true }).in("id", skipped);
    await logEvent("lead.suppressed", "lead", null, {
      lead_ids: skipped,
      count: skipped.length,
      caller_id: callerId,
      reason: "Removed from a packet at dial time: phone number is on the do-not-call list",
    });
  }

  if (!next) {
    return NextResponse.json({
      caller: caller.name,
      lead: null,
      remaining: 0,
      suppressed_removed: skipped.length,
    });
  }

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
    // The dialer shows this so a caller knows they are honouring a promise,
    // not cold-calling someone who already said "call me Thursday".
    dueCallback: next.callback_id
      ? { scheduled_for: next.scheduled_for, reason: next.reason }
      : null,
    callbacksWaiting: candidates.filter((c) => c.callback_id).length,
    remaining: candidates.length - skipped.length,
  });
}
