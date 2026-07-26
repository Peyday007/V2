import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getCallerId } from "@/lib/callerSession";
import { logEvent } from "@/lib/events";
import { missingRequired, DM_REACHED_OUTCOMES, OUTCOME_FORM_MAP } from "@/lib/outcomeForms";
import { nextAttemptAt } from "@/lib/callWindows";
import { coerceStage, nextStageAfterOutcome } from "@/lib/stages";
import { normalizePhone } from "@/lib/normalize";

type Values = Record<string, string>;

function combine(date?: string, time?: string): Date | null {
  if (!date) return null;
  const iso = `${date}T${time || "09:00"}:00`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Non-empty values only, so a blank field never wipes existing intelligence. */
function keep(patch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined && v !== null && v !== "")
  );
}

export async function POST(req: NextRequest) {
  const callerId = await getCallerId();
  if (!callerId) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  const body = await req.json();
  const { lead_id, packet_id, outcome, notes } = body;
  const values: Values = body.values || {};
  const intel: Values = body.intel || {};

  const form = OUTCOME_FORM_MAP[outcome];
  if (!lead_id || !form) {
    return NextResponse.json({ error: "Invalid outcome" }, { status: 400 });
  }

  // Server-side enforcement — the same rules the UI shows.
  const missing = missingRequired(outcome, values);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Missing required: ${missing.join(", ")}` },
      { status: 400 }
    );
  }
  if (form.confirmation && body.confirmed !== true) {
    return NextResponse.json(
      { error: `You must confirm: ${form.confirmation}` },
      { status: 400 }
    );
  }

  const db = supabase();
  const { data: lead } = await db
    .from("leads")
    .select("id, attempt_count, pipeline_stage, normalized_phone, owner_reached")
    .eq("id", lead_id)
    .single();
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  const reachedDm = DM_REACHED_OUTCOMES.includes(outcome);
  const spokeWithRole =
    outcome === "gatekeeper"
      ? "gatekeeper"
      : reachedDm
        ? "owner"
        : outcome === "not_interested"
          ? values.said_by_role === "Owner / decision-maker"
            ? "owner"
            : "gatekeeper"
          : "unknown";

  const { data: call, error } = await db
    .from("calls")
    .insert({
      lead_id,
      packet_id: packet_id || null,
      caller_id: callerId,
      outcome,
      reached_dm: reachedDm,
      notes: notes || values.note || null,
      details: values,
      next_step: values.next_step || null,
      spoke_with_role: spokeWithRole,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  /* ---------------- durable lead intelligence ---------------- */
  const leadPatch: Record<string, unknown> = {
    attempt_count: (lead.attempt_count ?? 0) + 1,
    last_attempted_at: new Date().toISOString(),
    status: "called",
  };

  // From the Update Lead Intelligence panel
  Object.assign(
    leadPatch,
    keep({
      owner_name: intel.owner_name,
      owner_title: intel.owner_title,
      owner_email: intel.email,
      gatekeeper_name: intel.gatekeeper_name,
      best_call_day: intel.best_call_day,
      best_call_time: intel.best_call_time,
      direct_number: intel.direct_number,
      extension: intel.extension,
      answering_setup: intel.answering_setup,
      existing_provider: intel.existing_provider,
      office_staff_count: intel.office_staff_count,
      after_hours_process: intel.after_hours_process,
      other_decision_maker: intel.other_decision_maker,
      ownership_type: intel.ownership_type,
      company_notes: intel.company_notes,
    })
  );

  // From the outcome form itself
  Object.assign(
    leadPatch,
    keep({
      gatekeeper_name: values.gatekeeper_name,
      owner_name: values.owner_name || values.dm_name,
      owner_title: values.dm_role,
      best_call_day: values.best_call_day,
      best_call_time: values.best_call_time,
      extension: values.extension,
      direct_number: values.direct_number,
      answering_setup: values.answering_setup,
      last_next_step: values.next_step,
      last_objection: values.objection,
    })
  );

  if (reachedDm) leadPatch.owner_reached = true;
  if (outcome === "bad_number") leadPatch.phone_invalid = true;

  /* ---------------- scheduled callback ---------------- */
  let explicitTime: Date | null = null;
  if (outcome === "callback") {
    explicitTime = combine(values.callback_date, values.callback_time);
    if (!explicitTime) {
      return NextResponse.json(
        { error: "Callback needs a valid date and time" },
        { status: 400 }
      );
    }
    await db.from("callbacks").insert({
      lead_id,
      caller_id: callerId,
      call_id: call.id,
      scheduled_for: explicitTime.toISOString(),
      requested_by_name: values.requested_by_name || null,
      requested_by_role: values.requested_by_role || null,
      reason: values.reason || null,
    });
  }
  if (outcome === "not_interested" && values.try_again === "Yes" && values.follow_up_date) {
    explicitTime = combine(values.follow_up_date, "09:00");
  }

  /* ---------------- appointment (strictly gated) ---------------- */
  if (outcome === "appointment_set") {
    const when = combine(values.appt_date, values.appt_time);
    if (!when) {
      return NextResponse.json(
        { error: "Appointment needs a valid date and time" },
        { status: 400 }
      );
    }
    await db.from("appointments").insert({
      lead_id,
      caller_id: callerId,
      call_id: call.id,
      decision_maker_name: values.dm_name,
      decision_maker_role: values.dm_role,
      scheduled_for: when.toISOString(),
      timezone: values.timezone || null,
      phone: values.phone || null,
      email: values.email || null,
      product: values.product || null,
      meeting_reason: values.meeting_reason || null,
      pain_point: values.pain_point || null,
      confirmation_method: values.confirmation_method || null,
      notes: values.note || null,
    });
  }

  /* ---------------- do not call: suppress everywhere ---------------- */
  if (outcome === "do_not_call") {
    leadPatch.do_not_call = true;
    await db.from("suppressions").insert({
      lead_id,
      normalized_phone: lead.normalized_phone || normalizePhone(values.phone) || null,
      requested_by: values.requested_by || "unknown",
      reason: values.reason || null,
      note: values.note || null,
    });
    // Pull it out of every open packet so nobody dials it again.
    await db.from("packet_leads").update({ status: "done" }).eq("lead_id", lead_id);
  }

  /* ---------------- retry scheduling ---------------- */
  const retry = nextAttemptAt({
    outcome,
    attemptCount: lead.attempt_count ?? 0,
    explicitTime,
  });
  if (retry && outcome !== "do_not_call" && outcome !== "bad_number") {
    leadPatch.next_attempt_at = retry.at.toISOString();
  }

  /* ---------------- board stage ---------------- */
  const current = coerceStage(lead.pipeline_stage);
  // A gatekeeper brush-off must not close the company out.
  const stageOutcome =
    outcome === "not_interested" &&
    values.said_by_role !== "Owner / decision-maker" &&
    values.gatekeeper_has_authority !== "Yes"
      ? "gatekeeper"
      : outcome;
  const target = nextStageAfterOutcome(current, stageOutcome);
  if (target) leadPatch.pipeline_stage = target;

  const { error: leadErr } = await db.from("leads").update(leadPatch).eq("id", lead_id);
  if (leadErr) console.error("[dial/outcome] lead update failed:", leadErr);

  /* ---------------- packet progress ---------------- */
  if (packet_id) {
    await db
      .from("packet_leads")
      .update({ status: "done" })
      .eq("packet_id", packet_id)
      .eq("lead_id", lead_id);
    const { count } = await db
      .from("packet_leads")
      .select("*", { count: "exact", head: true })
      .eq("packet_id", packet_id)
      .eq("status", "pending");
    if (count === 0) {
      await db.from("packets").update({ status: "completed" }).eq("id", packet_id);
    }
  }

  await logEvent("call.logged", "call", call.id, {
    lead_id,
    caller_id: callerId,
    outcome,
    spoke_with_role: spokeWithRole,
    reached_dm: reachedDm,
    next_attempt_at: leadPatch.next_attempt_at || null,
  });

  return NextResponse.json({
    ok: true,
    next_attempt: retry ? { at: retry.at.toISOString(), window: retry.window } : null,
  });
}
