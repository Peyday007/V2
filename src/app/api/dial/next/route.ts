import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getCallerId } from "@/lib/callerSession";
import { anthropic, APPROACH_MODEL } from "@/lib/anthropic";
import { recommendApproach } from "@/lib/approach";
import { buildSuppressionIndex, checkSuppressed } from "@/lib/suppression";
import { buildDossier, type CallRow } from "@/lib/relationship";
import { orderCandidates } from "@/lib/dialOrder";
import { buildPrompt } from "@/lib/promptStore";
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
  // Wider scan than we will serve: ordering is decided across the whole
  // window, not just the next few in list order.
  const scanIds = candidates.slice(0, 150).map((p) => p.lead_id);
  const [{ data: scanLeads }, { data: suppressions, error: supErr }] = await Promise.all([
    db
      .from("leads")
      .select(
        "id, phone, normalized_phone, do_not_call, state, timezone, industry, best_call_day, best_call_time, next_attempt_at, attempt_count"
      )
      .in("id", scanIds),
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

  /* ------------------------- adaptive ordering -------------------------
   * The packet is not worked in the order it was built. Every remaining lead
   * is scored against the business's OWN clock at the moment of serving, so a
   * caller starting at 9am in Michigan is not handed California plumbers at
   * 6am their time.
   */
  const skipped: string[] = [];
  const callable: Candidate[] = [];
  for (const candidate of candidates) {
    const row = leadById.get(candidate.lead_id);
    if (!row) continue; // outside the scan window; leave it for the next call
    if (checkSuppressed(row, index).suppressed) {
      skipped.push(candidate.lead_id);
      continue;
    }
    callable.push(candidate);
  }

  const ordered = orderCandidates(
    callable.map((c, i) => {
      const row = leadById.get(c.lead_id);
      return {
        leadId: c.lead_id,
        packetId: c.packet_id,
        callbackId: c.callback_id,
        callbackDue: c.scheduled_for,
        state: row?.state ?? null,
        timezone: row?.timezone ?? null,
        industry: row?.industry ?? null,
        bestCallDay: row?.best_call_day ?? null,
        bestCallTime: row?.best_call_time ?? null,
        nextAttemptAt: row?.next_attempt_at ?? null,
        attemptCount: row?.attempt_count ?? 0,
        position: i,
      };
    })
  );

  const best = ordered[0] ?? null;
  const next: Candidate | null = best
    ? callable.find((c) => c.lead_id === best.candidate.leadId) ?? null
    : null;

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
      const content = await buildPrompt("call_tip", {
        business_name: lead.business_name,
        industry: lead.industry || "unknown",
        city: lead.city || "unknown",
        state: lead.state || "",
        rating: lead.rating ?? "unknown",
        review_count: lead.review_count ?? 0,
        website: lead.website || "none found",
        contacts:
          (contacts || [])
            .map((c) => `${c.full_name || "?"} (${c.title || c.role_category})`)
            .join(", ") || "none",
        approach: approach?.text || "n/a",
        notes: lead.notes || "none",
      });
      const msg = await ai.messages.create({
        model: APPROACH_MODEL,
        max_tokens: 200,
        messages: [{ role: "user", content }],
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

  /* --------------------------- the relationship ----------------------------
   * The caller gets the FACTS assembled from the record — who we've spoken to,
   * what they told us, what we promised. Free and instant. The written
   * strategic read costs an API call and lives on the admin lead page.
   */
  const [{ data: allCalls }, { data: leadCallbacks }, { data: leadAppts }, { data: leadObjections }] =
    await Promise.all([
      db
        .from("calls")
        .select("outcome, reached_dm, notes, details, next_step, spoke_with_role, attempt_number, created_at")
        .eq("lead_id", next.lead_id)
        .order("created_at", { ascending: false })
        .limit(100),
      db
        .from("callbacks")
        .select("scheduled_for, status, reason, requested_by_name")
        .eq("lead_id", next.lead_id),
      db.from("appointments").select("*").eq("lead_id", next.lead_id),
      db
        .from("call_objections")
        .select("objection_key, objection_label")
        .eq("lead_id", next.lead_id),
    ]);

  const dossier = lead
    ? buildDossier({
        lead,
        calls: (allCalls || []) as CallRow[],
        appointments: leadAppts || [],
        callbacks: leadCallbacks || [],
        objections: leadObjections || [],
      })
    : null;

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
    dossier,
    // Deliberately NOT returned: why this lead was chosen, its calling window,
    // and how much of the packet is in business hours. The ordering still runs
    // (see orderCandidates above) — the caller simply cannot act on it, and it
    // was crowding out the conversation they can act on. It stays visible to
    // admins in the packet and analytics screens.
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
