import "server-only";
import { supabase } from "./supabase";
import { recordEvent } from "./events";
import { analyzeFromOutcomeForm, type CallAnalysisResult } from "./callAnalysis";
import { triggerFor, deadlineFor, draftFollowup } from "./followup";

/**
 * The write path that runs after a caller logs an outcome.
 *
 * Every step is optional and independently guarded: an unrun migration, a
 * missing table or a failed insert must never break logging a call. The caller
 * is on the phone; their outcome saving is the only thing that truly matters.
 */

export type Settings = {
  recording_enabled: boolean;
  consent_policy: string;
  transcription_enabled: boolean;
  live_coaching_enabled: boolean;
  followup_deadline_minutes: number;
  automatic_drafting: boolean;
  automatic_sending: boolean;
  minimum_learning_sample: number;
  experiment_traffic_percent: number;
  retention_days: number;
};

export const DEFAULT_SETTINGS: Settings = {
  recording_enabled: false,
  consent_policy: "all_party",
  transcription_enabled: false,
  live_coaching_enabled: true,
  followup_deadline_minutes: 10,
  automatic_drafting: true,
  automatic_sending: false,
  minimum_learning_sample: 40,
  experiment_traffic_percent: 50,
  retention_days: 90,
};

/** Settings, or the shipped defaults when the migration has not been run. */
export async function loadSettings(): Promise<Settings> {
  try {
    const { data } = await supabase()
      .from("call_intelligence_settings")
      .select("*")
      .eq("id", true)
      .maybeSingle();
    return data ? { ...DEFAULT_SETTINGS, ...data } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export type AfterCallInput = {
  callId: string;
  leadId: string;
  callerId: string;
  callerName?: string | null;
  businessName: string;
  contactName?: string | null;
  outcome: string;
  reachedDm: boolean;
  spokeWithRole?: string | null;
  notes?: string | null;
  details: Record<string, string>;
  durationSeconds?: number | null;
  callStage?: string | null;
};

export type AfterCallResult = {
  analysisId: string | null;
  followupId: string | null;
  followupDueAt: string | null;
  warnings: string[];
};

/**
 * Analyse the call and, when it warrants one, open a follow-up.
 *
 * Runs inline rather than as a background job because the whole point of the
 * ten-minute target is that the draft is waiting when the caller looks. It is
 * a few milliseconds of pure computation plus two inserts.
 */
export async function processCompletedCall(
  input: AfterCallInput
): Promise<AfterCallResult> {
  const db = supabase();
  const warnings: string[] = [];
  const settings = await loadSettings();

  const { result, confidence } = analyzeFromOutcomeForm({
    outcome: input.outcome,
    reachedDm: input.reachedDm,
    spokeWithRole: input.spokeWithRole,
    notes: input.notes,
    details: input.details,
    durationSeconds: input.durationSeconds,
  });

  /* ------------------------------- analysis ------------------------------- */
  let analysisId: string | null = null;
  try {
    const { data, error } = await db
      .from("call_analysis")
      .upsert(
        {
          call_id: input.callId,
          lead_id: input.leadId,
          caller_id: input.callerId,
          source: "outcome_form",
          ai_result: result,
          ai_confidence: confidence,
          ai_model: "deterministic/outcome_form",
          person_reached: result.personReached ?? null,
          live_answer: result.liveAnswer ?? null,
          owner_reached: result.ownerReached ?? null,
          interest_level: result.interestLevel ?? null,
          qualification_status: result.qualificationStatus ?? null,
          meeting_status: result.meetingStatus ?? null,
          meeting_at: result.meetingAt ?? null,
          followup_requested: result.followupRequested ?? null,
          followup_deadline: result.followupDeadline ?? null,
          do_not_call_requested: result.doNotCallRequested ?? null,
          coaching_point: result.coachingPoint ?? null,
        },
        { onConflict: "call_id" }
      )
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    analysisId = data?.id ?? null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(
      /relation .* does not exist|schema cache/i.test(msg)
        ? "Call analysis skipped — run supabase/migrations/0019_call_intelligence.sql."
        : `Call analysis failed: ${msg}`
    );
  }

  /* ------------------------------ follow-up ------------------------------- */
  let followupId: string | null = null;
  let followupDueAt: string | null = null;
  const trigger = triggerFor(input.outcome, result);

  if (trigger) {
    const now = new Date();
    const due = deadlineFor(
      trigger,
      now,
      settings.followup_deadline_minutes,
      result.followupDeadline
    );

    let subject: string | null = null;
    let body: string | null = null;
    if (settings.automatic_drafting) {
      const draft = draftFollowup({
        businessName: input.businessName,
        contactName: input.contactName ?? result.personReached ?? null,
        callerName: input.callerName || "the team",
        trigger,
        analysis: result,
      });
      subject = draft.subject;
      body = draft.body;
    }

    try {
      // Keyed on call_id by a partial unique index, so a retried save cannot
      // open a second follow-up for the same conversation.
      const { data, error } = await db
        .from("followup_tasks")
        .upsert(
          {
            call_id: input.callId,
            lead_id: input.leadId,
            assigned_to: input.callerId,
            kind: trigger.kind,
            reason: trigger.reason,
            channel_target: trigger.target,
            draft_subject: subject,
            draft_body: body,
            due_at: due.toISOString(),
            status: subject ? "drafted" : "pending",
            drafted_at: subject ? now.toISOString() : null,
          },
          { onConflict: "call_id" }
        )
        .select("id, due_at")
        .single();
      if (error) throw new Error(error.message);
      followupId = data?.id ?? null;
      followupDueAt = data?.due_at ?? null;

      await recordEvent({
        type: "followup.created",
        entityType: "followup",
        entityId: followupId,
        leadId: input.leadId,
        callId: input.callId,
        actorCallerId: input.callerId,
        actorType: "system",
        source: "api",
        newValue: {
          kind: trigger.kind,
          due_at: followupDueAt,
          drafted: !!subject,
          target: trigger.target,
        },
        metadata: { reason: trigger.reason },
        verificationStatus: "verified",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(
        /relation .* does not exist|schema cache/i.test(msg)
          ? "Follow-up not created — run supabase/migrations/0019_call_intelligence.sql."
          : `Follow-up not created: ${msg}`
      );
    }
  }

  /* --------------------------- confirmed outcomes -------------------------- */
  // Only the outcomes a call can actually establish. Sales and revenue are
  // entered by a person elsewhere; inferring them from a call is exactly the
  // mistake section 6 warns about.
  const outcomes: string[] = [];
  if (result.liveAnswer) outcomes.push("live_answer");
  if (result.ownerReached) outcomes.push("owner_conversation");
  if (result.qualificationStatus === "qualified") outcomes.push("qualified_opportunity");
  if (result.meetingStatus === "booked") outcomes.push("meeting_booked");
  if (result.doNotCallRequested) outcomes.push("do_not_call");

  if (outcomes.length > 0) {
    try {
      await db.from("confirmed_outcomes").insert(
        outcomes.map((outcome_type) => ({
          call_id: input.callId,
          lead_id: input.leadId,
          caller_id: input.callerId,
          outcome_type,
          recorded_by: "system",
        }))
      );
    } catch {
      // Non-fatal: the dashboards fall back to reading the calls table.
    }
  }

  /* -------------------------- learning observations ------------------------ */
  try {
    await db.from("learning_observations").insert({
      call_id: input.callId,
      caller_id: input.callerId,
      dimension: "opening",
      variant: input.callStage ? `stage:${input.callStage}` : "default",
      industry: input.details.industry || null,
      outcome_type: "owner_conversation",
      succeeded: input.reachedDm,
    });
  } catch {
    // Observations are for the learning engine only; losing one costs nothing.
  }

  return { analysisId, followupId, followupDueAt, warnings };
}
