// The post-call pipeline: read the transcript, decide, apply, escalate.
//
// This is where "the AI has the last word" actually happens. The model's
// reading is written to the call record without asking anyone. What reaches a
// person is the short queue defined in ./aiAuthority — the unsure ones, the
// contradictions that matter, anything touching do-not-call, and a small
// random sample so accuracy stays measurable.
//
// Everything here is individually guarded. The caller's outcome is already
// saved by the time this runs, and nothing below may undo it: a model outage,
// a malformed response or a missing API key all end with the deterministic
// reading standing and the call recorded as form_only.

import "server-only";
import { supabaseAdmin } from "./supabaseAdmin";
import { anthropic, TRANSCRIPT_ANALYSIS_MODEL } from "./anthropic";
import { recordEvent } from "./events";
import {
  decideAuthority,
  type AuthorityDecision,
  type AuthoritySettings,
} from "./aiAuthority";
import {
  ANALYSIS_SYSTEM_PROMPT,
  buildTranscriptPrompt,
  parseAnalysis,
  transcriptConfidence,
  tooThinToRead,
  type TranscriptLine,
} from "./transcriptAnalysis";
import type { CallAnalysisResult } from "./callAnalysis";

export type ReviewOutcome = {
  ok: boolean;
  authority: "ai" | "human" | "form_only";
  escalated: boolean;
  reasons: string[];
  skipped?: string;
};

async function loadAuthoritySettings(): Promise<AuthoritySettings> {
  try {
    const { data } = await supabaseAdmin()
      .from("call_intelligence_settings")
      .select("ai_decides, ai_confidence_floor, ai_spot_check_rate")
      .eq("id", true)
      .maybeSingle();
    if (!data) return { aiDecides: false, confidenceFloor: 0.6, spotCheckRate: 0.02 };
    return {
      aiDecides: !!data.ai_decides,
      confidenceFloor: Number(data.ai_confidence_floor) || 0.6,
      spotCheckRate: Number(data.ai_spot_check_rate) || 0,
    };
  } catch {
    // Unreadable settings mean the model decides nothing. The deterministic
    // reading is already saved and remains correct on its own.
    return { aiDecides: false, confidenceFloor: 0.6, spotCheckRate: 0.02 };
  }
}

/** Ask the model what happened. Returns null on any failure — never throws. */
export async function readTranscript(input: {
  businessName: string;
  callerName?: string | null;
  industry?: string | null;
  segments: TranscriptLine[];
  durationSeconds?: number | null;
}): Promise<{ result: CallAnalysisResult; confidence: number } | null> {
  const ai = anthropic();
  if (!ai) return null;
  if (tooThinToRead(input.segments)) return null;

  try {
    const msg = await ai.messages.create({
      model: TRANSCRIPT_ANALYSIS_MODEL,
      max_tokens: 1400,
      system: ANALYSIS_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildTranscriptPrompt(input) }],
    });
    const block = msg.content[0];
    const raw = block.type === "text" ? block.text : "";
    const result = parseAnalysis(raw);
    if (!result) return null;
    // Confidence comes from the transcript, not the model's opinion of itself.
    return { result, confidence: transcriptConfidence(input.segments) };
  } catch {
    return null;
  }
}

/**
 * Run the whole thing for one call. Called after transcription finishes.
 */
export async function reviewCall(callId: string): Promise<ReviewOutcome> {
  const db = supabaseAdmin();

  const { data: analysis } = await db
    .from("call_analysis")
    .select("id, call_id, lead_id, caller_id, ai_result")
    .eq("call_id", callId)
    .maybeSingle();
  if (!analysis) {
    return { ok: false, authority: "form_only", escalated: false, reasons: [], skipped: "no analysis row" };
  }

  const { data: recording } = await db
    .from("recordings")
    .select("id, duration_seconds")
    .eq("call_id", callId)
    .is("deleted_at", null)
    .maybeSingle();

  const { data: rows } = await db
    .from("transcript_segments")
    .select("speaker, text, start_ms")
    .eq("call_id", callId)
    .order("sequence", { ascending: true });

  const segments: TranscriptLine[] = (rows || []).map((r) => ({
    speaker: r.speaker,
    text: r.text,
    startMs: r.start_ms,
  }));

  const { data: lead } = await db
    .from("leads")
    .select("business_name, industry")
    .eq("id", analysis.lead_id)
    .maybeSingle();
  const { data: caller } = await db
    .from("callers")
    .select("name")
    .eq("id", analysis.caller_id)
    .maybeSingle();

  const human = (analysis.ai_result || {}) as CallAnalysisResult;
  const settings = await loadAuthoritySettings();

  const read =
    segments.length > 0
      ? await readTranscript({
          businessName: lead?.business_name ?? "this business",
          callerName: caller?.name ?? null,
          industry: lead?.industry ?? null,
          segments,
          durationSeconds: recording?.duration_seconds ?? null,
        })
      : null;

  const decision = decideAuthority({
    human,
    ai: read?.result ?? null,
    aiConfidence: read?.confidence ?? null,
    settings,
  });

  // No transcript at all is worth surfacing exactly once, not silently.
  const reasons = [...decision.reasons];
  if (!read && segments.length === 0) reasons.push("no_transcript");

  await applyDecision(analysis.id, callId, analysis.lead_id, decision, {
    aiRaw: read?.result ?? null,
    confidence: read?.confidence ?? null,
    reasons,
  });

  return {
    ok: true,
    authority: decision.authority,
    escalated: decision.escalate,
    reasons,
  };
}

/** Write the decision. The applied reading becomes the call's record of truth. */
async function applyDecision(
  analysisId: string,
  callId: string,
  leadId: string | null,
  decision: AuthorityDecision,
  extra: { aiRaw: CallAnalysisResult | null; confidence: number | null; reasons: string[] }
): Promise<void> {
  const db = supabaseAdmin();
  const r = decision.applied;

  try {
    await db
      .from("call_analysis")
      .update({
        authority: decision.authority,
        applied_result: r,
        applied_at: new Date().toISOString(),
        held_fields: decision.held,
        disagreements: decision.disagreements,
        needs_review: extra.reasons.length > 0,
        review_reasons: extra.reasons,
        // The transcript reading, kept beside the applied one so accuracy
        // stays measurable after the fact.
        transcript_result: extra.aiRaw,
        transcript_confidence: extra.confidence,
        // The queryable columns follow whatever won.
        person_reached: r.personReached ?? null,
        live_answer: r.liveAnswer ?? null,
        owner_reached: r.ownerReached ?? null,
        interest_level: r.interestLevel ?? null,
        qualification_status: r.qualificationStatus ?? null,
        meeting_status: r.meetingStatus ?? null,
        meeting_at: r.meetingAt ?? null,
        followup_requested: r.followupRequested ?? null,
        followup_deadline: r.followupDeadline ?? null,
        do_not_call_requested: r.doNotCallRequested ?? null,
        coaching_point: r.coachingPoint ?? null,
      })
      .eq("id", analysisId);
  } catch {
    // The deterministic reading is already saved and still correct.
  }

  // Actions the model asked for and was refused. Recorded, never performed.
  for (const action of decision.blockedActions) {
    try {
      await db.from("blocked_actions").insert({
        call_id: callId,
        lead_id: leadId,
        analysis_id: analysisId,
        action,
        rationale:
          "The model proposed this from the transcript. It is on the never-automatic list and needs a person.",
        status: "pending",
      });
    } catch {
      /* the queue is a convenience; its absence must not fail the call */
    }
  }

  // A heard do-not-call suppresses immediately. Suppression is the safe
  // direction — the reverse is what needs a human, and is blocked above.
  if (decision.applied.doNotCallRequested === true && leadId) {
    try {
      await db.from("leads").update({ do_not_call: true }).eq("id", leadId);
      await db.from("callbacks").update({ status: "cancelled" }).eq("lead_id", leadId);
    } catch {
      /* the outcome route already handles the caller-reported case */
    }
  }

  await recordEvent({
    type: extra.reasons.length > 0 ? "analysis.escalated" : "analysis.applied",
    entityType: "call",
    entityId: callId,
    leadId: leadId ?? undefined,
    callId,
    actorType: "system",
    source: "system",
    newValue: {
      authority: decision.authority,
      escalated: extra.reasons.length > 0,
      reasons: extra.reasons,
      held: decision.held.map((h) => h.field),
      disagreements: decision.disagreements.map((d) => d.field),
    },
    verificationStatus: extra.reasons.length > 0 ? "unverified" : "verified",
  });
}
