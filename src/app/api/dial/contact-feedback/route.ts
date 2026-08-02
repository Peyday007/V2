import { NextRequest, NextResponse } from "next/server";
import { getCallerId } from "@/lib/callerSession";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recordEvent } from "@/lib/events";
import { enqueue } from "@/lib/jobs";
import {
  CONTACT_OUTCOMES,
  correctedConfidence,
  effectOf,
  type ContactOutcome,
} from "@/lib/contactFeedback";
import { gradeLead } from "@/lib/enrichmentGrade";
import type { PhoneClass } from "@/lib/phoneIntel";

export const dynamic = "force-dynamic";

/**
 * What the caller found out about the contact details.
 *
 * A caller who dialled the number is better evidence than any provider's
 * confidence score, so this is where the data gets corrected: confidence
 * moves, wrong numbers stop being handed out, and the lead is re-graded — which
 * may take it straight out of the direct-call queue.
 */
export async function POST(req: NextRequest) {
  const callerId = await getCallerId();
  if (!callerId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const leadId = String(body.lead_id || "");
  const outcome = String(body.outcome || "") as ContactOutcome;
  if (!leadId || !(CONTACT_OUTCOMES as readonly string[]).includes(outcome)) {
    return NextResponse.json({ error: "Unknown contact outcome" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data: lead } = await db
    .from("leads")
    .select(
      "id, decision_maker_name, decision_maker_confidence, direct_phone, direct_phone_class, direct_phone_provider, enrichment_grade"
    )
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return NextResponse.json({ error: "No such lead" }, { status: 404 });

  const effect = effectOf(outcome);
  const before = lead.decision_maker_confidence ?? null;
  const { confidence, stillAsserted } = correctedConfidence(before, outcome);

  const patch: Record<string, unknown> = { decision_maker_confidence: confidence };

  if (effect.suppressPhone) {
    // Kept on the record but no longer offered: deleting it outright would let
    // the next enrichment run rediscover and re-sell the same bad number.
    patch.direct_phone = null;
    patch.direct_phone_class = effect.reclassifyAs ?? "unknown";
    patch.contact_reported_wrong_at = new Date().toISOString();
  }
  if (effect.suppressDecisionMaker || !stillAsserted) {
    patch.decision_maker_name = null;
    patch.decision_maker_first_name = null;
    patch.decision_maker_last_name = null;
  }

  const regraded = gradeLead({
    decisionMakerName: (patch.decision_maker_name ?? lead.decision_maker_name) as string | null,
    decisionMakerConfidence: confidence,
    phoneClass: ((patch.direct_phone_class ?? lead.direct_phone_class) || "unknown") as PhoneClass,
    directPhone: (patch.direct_phone ?? lead.direct_phone) as string | null,
  });
  patch.enrichment_grade = regraded.grade;
  patch.enrichment_grade_reason = `${regraded.reason} (after a caller reported: ${outcome.replace(/_/g, " ")})`;
  if (!regraded.callReady) {
    // Out of the queue immediately. A lead nobody can reach must not be handed
    // to the next caller while it waits for re-enrichment.
    patch.machine_status = "enrichment_failed";
  }

  await db.from("leads").update(patch).eq("id", leadId);

  await db.from("contact_feedback").insert({
    lead_id: leadId,
    call_id: typeof body.call_id === "string" ? body.call_id : null,
    caller_id: callerId,
    outcome,
    phone_dialed: typeof body.phone_dialed === "string" ? body.phone_dialed : lead.direct_phone,
    phone_class: lead.direct_phone_class,
    provider: lead.direct_phone_provider,
    confidence_before: before,
    confidence_after: confidence,
    suppressed_phone: effect.suppressPhone,
    suppressed_decision_maker: effect.suppressDecisionMaker || !stillAsserted,
    note: typeof body.note === "string" ? body.note.slice(0, 500) : null,
  });

  // Send it back round for another look.
  //
  // A fresh idempotency key deliberately: the original enrich_owner_contact
  // job for this lead has already run, so reusing its key would make this a
  // silent no-op and the lead would sit suppressed forever. Whether anything
  // is actually spent is still decided by enrichment_settings.enabled and the
  // budget caps inside the handler — this only asks.
  let requeued = false;
  if (effect.requeue) {
    try {
      requeued = await enqueue({
        type: "enrich_owner_contact",
        payload: { lead_id: leadId, caller_reported_wrong: true },
        idempotencyKey: `enrich_owner_contact:${leadId}:${Date.now()}`,
      });
    } catch {
      // Re-enrichment is an optimisation. Never fail the caller's feedback —
      // the correction above is the part that matters and it is already saved.
      requeued = false;
    }
  }

  await recordEvent({
    type: "lead.contact_feedback",
    entityType: "lead",
    entityId: leadId,
    leadId,
    actorCallerId: callerId,
    actorType: "caller",
    source: "ui",
    previousValue: { confidence: before, grade: lead.enrichment_grade },
    newValue: { confidence, grade: regraded.grade, outcome },
    metadata: { effect: effect.explanation, provider: lead.direct_phone_provider },
    verificationStatus: "verified",
  });

  return NextResponse.json({
    ok: true,
    grade: regraded.grade,
    callReady: regraded.callReady,
    explanation: effect.explanation,
    requeue: effect.requeue,
    requeued,
  });
}
