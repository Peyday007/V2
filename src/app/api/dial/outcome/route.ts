import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getCallerId } from "@/lib/callerSession";
import { eventChain } from "@/lib/events";
import { missingRequired, DM_REACHED_OUTCOMES, OUTCOME_FORM_MAP } from "@/lib/outcomeForms";
import { nextAttemptAt, localHourParts, timezoneForState } from "@/lib/callWindows";
import { coerceStage, nextStageAfterOutcome } from "@/lib/stages";
import { normalizePhone } from "@/lib/normalize";

type Values = Record<string, string>;

/** An objection the caller hit during the call, sent from the dialer. */
type RaisedObjection = { key: string; label?: string; rebuttal_shown?: boolean };

/** How the dialer measures a call. Anything absurd is discarded, not stored. */
const MAX_PLAUSIBLE_CALL_SECONDS = 3 * 60 * 60;

function durationFrom(startedAt: unknown, endedAt: Date): number | null {
  if (typeof startedAt !== "string") return null;
  const start = new Date(startedAt);
  if (Number.isNaN(start.getTime())) return null;
  const seconds = Math.round((endedAt.getTime() - start.getTime()) / 1000);
  if (seconds < 0 || seconds > MAX_PLAUSIBLE_CALL_SECONDS) return null;
  return seconds;
}

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
    .select("id, attempt_count, pipeline_stage, normalized_phone, owner_reached, owner_name, owner_title, gatekeeper_name, best_call_day, best_call_time, direct_number, extension, answering_setup, existing_provider, other_decision_maker, industry, city, state, rating, review_count, timezone, enrichment_confidence")
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

  /* ----- facts that can only be captured now, never reconstructed later ----- */
  const endedAt = new Date();
  const durationSeconds = durationFrom(body.started_at, endedAt);
  const leadTz = lead.timezone || timezoneForState(lead.state);
  const { hour, dayOfWeek, timezone: usedTz } = localHourParts(endedAt, leadTz);
  const attemptNumber = (lead.attempt_count ?? 0) + 1;
  // Snapshotted deliberately: the lead changes after this call, and joining
  // back to it later would silently rewrite what we knew at dial time.
  const ownerKnownBefore = !!lead.owner_name;

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
      started_at:
        typeof body.started_at === "string" && durationSeconds !== null
          ? body.started_at
          : null,
      ended_at: endedAt.toISOString(),
      duration_seconds: durationSeconds,
      attempt_number: attemptNumber,
      dialed_hour: hour,
      dialed_dow: dayOfWeek,
      lead_timezone: usedTz,
      lead_industry: lead.industry ?? null,
      lead_city: lead.city ?? null,
      lead_state: lead.state ?? null,
      lead_rating: lead.rating ?? null,
      lead_review_count: lead.review_count ?? null,
      owner_known_before: ownerKnownBefore,
      enrichment_confidence: lead.enrichment_confidence ?? null,
      script_variant: typeof body.script_variant === "string" ? body.script_variant : "owner_first_v1",
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // One correlation id ties every fact learned on this call together.
  const chain = eventChain({
    actorType: "caller",
    actorCallerId: callerId,
    source: "ui",
  });
  await chain.record({
    type: "call.outcome_recorded",
    entityType: "call",
    entityId: call.id,
    leadId: lead_id,
    packetId: packet_id || null,
    callId: call.id,
    newValue: {
      outcome,
      spoke_with_role: spokeWithRole,
      reached_dm: reachedDm,
      duration_seconds: durationSeconds,
      attempt_number: attemptNumber,
      dialed_hour: hour,
      owner_known_before: ownerKnownBefore,
    },
    metadata: {
      fields: Object.keys(values),
      notes: notes || values.note || null,
      lead_industry: lead.industry ?? null,
      lead_state: lead.state ?? null,
      lead_timezone: usedTz,
    },
    verificationStatus: "verified",
  });

  /* ---------------- objections raised on this call ---------------- */
  // Previously the objection panel was display-only. Every objection a
  // caller hit was thrown away, so "which objection kills the most calls"
  // was unanswerable. Now each one is a row tied to the call's outcome.
  const rawObjections: RaisedObjection[] = Array.isArray(body.objections)
    ? body.objections
    : [];
  const seen = new Set<string>();
  const objections = rawObjections.filter((o) => {
    if (!o || typeof o.key !== "string" || !o.key) return false;
    if (seen.has(o.key)) return false;
    seen.add(o.key);
    return true;
  });
  // The outcome form also captures a free-text objection; count it too.
  if (values.objection && !seen.has(`typed:${values.objection}`)) {
    objections.push({ key: `typed:${values.objection}`, label: values.objection });
  }

  if (objections.length > 0) {
    const { error: objErr } = await db.from("call_objections").insert(
      objections.map((o) => ({
        call_id: call.id,
        lead_id,
        caller_id: callerId,
        objection_key: o.key,
        objection_label: o.label || o.key,
        rebuttal_shown: o.rebuttal_shown === true,
        outcome,
        reached_dm: reachedDm,
      }))
    );
    if (objErr) {
      console.error(
        "[dial/outcome] objections not saved — run supabase/migrations/0013_call_analytics.sql:",
        objErr.message
      );
    } else {
      await chain.record({
        type: "objection.raised",
        entityType: "objection",
        entityId: call.id,
        leadId: lead_id,
        callId: call.id,
        newValue: { objections: objections.map((o) => o.key), outcome },
        metadata: { count: objections.length },
        verificationStatus: "verified",
      });
    }
  }

  /* ---------------- durable lead intelligence ---------------- */
  const leadPatch: Record<string, unknown> = {
    attempt_count: (lead.attempt_count ?? 0) + 1,
    last_attempted_at: new Date().toISOString(),
    status: "called",
    // The engine's own view has to move too. Without this a dialed lead stayed
    // at assigned_to_packet forever, so "Called" read zero on every dashboard
    // and "With your callers" counted people who had already been rung.
    machine_status: "contacted",
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
    await chain.record({
      type: "callback.scheduled",
      entityType: "callback",
      leadId: lead_id,
      callId: call.id,
      newValue: {
        scheduled_for: explicitTime.toISOString(),
        requested_by_name: values.requested_by_name || null,
        requested_by_role: values.requested_by_role || null,
      },
      metadata: { reason: values.reason || null },
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
    await chain.record({
      type: "appointment.booked",
      entityType: "appointment",
      leadId: lead_id,
      callId: call.id,
      newValue: {
        decision_maker_name: values.dm_name,
        decision_maker_role: values.dm_role,
        scheduled_for: when.toISOString(),
        timezone: values.timezone || null,
      },
      metadata: {
        product: values.product,
        pain_point: values.pain_point,
        confirmation_method: values.confirmation_method,
      },
      confidence: 1,
      verificationStatus: "verified",
    });
  }

  /* ---------------- do not call: suppress everywhere ---------------- */
  if (outcome === "do_not_call") {
    leadPatch.do_not_call = true;
    const suppressedPhone =
      normalizePhone(lead.normalized_phone) || normalizePhone(values.phone) || null;

    // upsert, not insert: the same number can be asked to stop twice, and a
    // duplicate key must not turn a compliance request into a 500.
    await db
      .from("suppressions")
      .upsert(
        {
          lead_id,
          normalized_phone: suppressedPhone,
          requested_by: values.requested_by || "unknown",
          reason: values.reason || null,
          note: values.note || null,
          source: "call",
        },
        { onConflict: "normalized_phone", ignoreDuplicates: false }
      );

    // A DNC is about the phone number, not about this row. The same business
    // is routinely in the database more than once — imported twice, sourced
    // from two search terms, listed under a second trade. Suppress every
    // record that shares the number, or the next caller dials them again.
    let siblingIds: string[] = [];
    if (suppressedPhone) {
      const { data: siblings } = await db
        .from("leads")
        .select("id")
        .eq("normalized_phone", suppressedPhone)
        .neq("id", lead_id)
        .eq("do_not_call", false);
      siblingIds = (siblings || []).map((s) => s.id);
      if (siblingIds.length > 0) {
        await db.from("leads").update({ do_not_call: true }).in("id", siblingIds);
      }
    }

    // Pull this lead and every sibling out of every open packet so nobody
    // dials the number again tomorrow morning.
    await db
      .from("packet_leads")
      .update({ status: "done" })
      .in("lead_id", [lead_id, ...siblingIds]);

    await chain.record({
      type: "lead.suppressed",
      entityType: "lead",
      entityId: lead_id,
      leadId: lead_id,
      callId: call.id,
      newValue: {
        do_not_call: true,
        requested_by: values.requested_by || "unknown",
        normalized_phone: suppressedPhone,
      },
      metadata: {
        reason: values.reason || null,
        note: values.note || null,
        sibling_leads_suppressed: siblingIds.length,
      },
      verificationStatus: "verified",
    });

    // Each sibling gets its own event, so a lead's own history explains why
    // it stopped being called without anyone having to know about the other
    // record.
    for (const id of siblingIds) {
      await chain.record({
        type: "lead.suppressed",
        entityType: "lead",
        entityId: id,
        leadId: id,
        previousValue: { do_not_call: false },
        newValue: { do_not_call: true },
        metadata: {
          reason: "Shares a phone number with a lead that requested do not call",
          normalized_phone: suppressedPhone,
          origin_lead_id: lead_id,
        },
        verificationStatus: "verified",
      });
    }
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

  // Record what the call actually taught us, with before/after, so nothing
  // is silently overwritten in the historical record.
  const INTEL_KEYS = [
    "owner_name", "owner_title", "gatekeeper_name", "best_call_day",
    "best_call_time", "direct_number", "extension", "answering_setup",
    "existing_provider", "other_decision_maker",
  ];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const k of INTEL_KEYS) {
    const lv = (lead as unknown as Record<string, unknown>)[k] ?? null;
    if (k in leadPatch && leadPatch[k] !== lv) {
      before[k] = lv;
      after[k] = leadPatch[k];
    }
  }
  if (Object.keys(after).length > 0) {
    await chain.record({
      type: "lead.intelligence_updated",
      entityType: "lead",
      entityId: lead_id,
      leadId: lead_id,
      callId: call.id,
      previousValue: before,
      newValue: after,
      confidence: 0.95,
      verificationStatus: "verified",
    });
    if (after.owner_name && !before.owner_name) {
      await chain.record({
        type: "lead.decision_maker_found",
        entityType: "lead",
        entityId: lead_id,
        leadId: lead_id,
        callId: call.id,
        newValue: { owner_name: after.owner_name, owner_title: after.owner_title ?? null },
        metadata: { discovered_on_call: true },
        confidence: 0.95,
      });
    }
  }

  if (leadPatch.pipeline_stage && leadPatch.pipeline_stage !== current) {
    await chain.record({
      type: "lead.stage_changed",
      entityType: "lead",
      entityId: lead_id,
      leadId: lead_id,
      callId: call.id,
      previousValue: { pipeline_stage: current },
      newValue: { pipeline_stage: leadPatch.pipeline_stage },
      metadata: { via: `call outcome ${outcome}` },
    });
  }

  /* ---------------- close out the callback that brought us here ----------------
   * Any pending callback for this lead is now honoured — the caller has just
   * dialed it. Without this it would keep resurfacing forever. A brand new
   * callback booked on THIS call was inserted above with its own row, so it
   * survives: only callbacks older than this call are closed.
   */
  await db
    .from("callbacks")
    .update({ status: "done" })
    .eq("lead_id", lead_id)
    .eq("status", "pending")
    .lt("created_at", call.created_at);

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
      await chain.record({
        type: "packet.completed",
        entityType: "packet",
        entityId: packet_id,
        packetId: packet_id,
        newValue: { status: "completed" },
      });
    }
  }

  return NextResponse.json({
    ok: true,
    next_attempt: retry ? { at: retry.at.toISOString(), window: retry.window } : null,
  });
}
