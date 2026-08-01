// Recording storage — the logic, with its database client passed in.
//
// Split from ./recordingStore so the whole capture-to-playback flow can be
// driven end to end in a test against a fake client. The wrapper supplies the
// real one; nothing else differs.
//
// Two behaviours are worth stating outright:
//
//   Discard means DELETE. When consent is refused the audio is removed from
//   storage, not merely flagged. What survives is a compliance_events row
//   recording that it was deleted and why.
//
//   Every write is idempotent on the browser's capture id. Uploads retry over
//   flaky hotel wifi, and a retried part must land on the same row rather than
//   spawning a second recording of the same call.

import type { SupabaseClient } from "@supabase/supabase-js";

/** Only what this module touches. The real client satisfies it. */
export type Db = SupabaseClient;
import { decideConsent, retentionExpiry, type ConsentPolicy } from "./consent";
import {
  finalKey,
  partKey,
  extensionFor,
  concatParts,
  orderedPartNames,
} from "./recordingSession";
import { transcribeAudio, transcriptionCapability } from "./transcription";

export const BUCKET = "call-recordings";

/** Playback links are short-lived on purpose. */
export const PLAYBACK_URL_SECONDS = 60 * 15;

export type RecordingSettings = {
  recordingEnabled: boolean;
  consentPolicy: ConsentPolicy;
  announcement: string;
  retentionDays: number;
  transcriptionEnabled: boolean;
};

const FALLBACK_SETTINGS: RecordingSettings = {
  // Off, and every field set to the strictest reading. If the settings row
  // cannot be read, the answer to "may we record" is no.
  recordingEnabled: false,
  consentPolicy: "all_party",
  announcement: "This call may be recorded for quality and training purposes.",
  retentionDays: 90,
  transcriptionEnabled: false,
};

export async function loadRecordingSettings(client: Db): Promise<RecordingSettings> {
  try {
    const db = client;
    const { data, error } = await db
      .from("call_intelligence_settings")
      .select(
        "recording_enabled, consent_policy, consent_announcement, retention_days, transcription_enabled"
      )
      .eq("id", true)
      .maybeSingle();
    if (error || !data) return FALLBACK_SETTINGS;
    return {
      recordingEnabled: !!data.recording_enabled,
      consentPolicy: (data.consent_policy || "all_party") as ConsentPolicy,
      announcement: data.consent_announcement || FALLBACK_SETTINGS.announcement,
      retentionDays: Number(data.retention_days) || 90,
      transcriptionEnabled: !!data.transcription_enabled,
    };
  } catch {
    return FALLBACK_SETTINGS;
  }
}

/* -------------------------------------------------------------------------- */
/* compliance trail                                                           */
/* -------------------------------------------------------------------------- */

export async function logCompliance(client: Db, input: {
  eventType: string;
  recordingId?: string | null;
  callId?: string | null;
  leadId?: string | null;
  callerId?: string | null;
  state?: string | null;
  policyApplied?: string | null;
  actor?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await client
      .from("compliance_events")
      .insert({
        event_type: input.eventType,
        recording_id: input.recordingId || null,
        call_id: input.callId || null,
        lead_id: input.leadId || null,
        caller_id: input.callerId || null,
        state: input.state || null,
        policy_applied: input.policyApplied || null,
        actor: input.actor || null,
        detail: input.detail || {},
      });
  } catch {
    // A failed audit write must not stop a caller from working, and must not
    // be the thing that lets recording proceed either — callers reach here
    // only after the decision has already been made and acted on.
  }
}

/* -------------------------------------------------------------------------- */
/* starting                                                                   */
/* -------------------------------------------------------------------------- */

export type StartResult =
  | { ok: true; recordingId: string; consentStatus: string; policyApplied: string; reason: string }
  | { ok: false; error: string; blocked: true };

export async function startRecording(client: Db, input: {
  clientCaptureId: string;
  leadId: string;
  callerId: string;
  leadState: string | null;
  mimeType: string;
}): Promise<StartResult> {
  const db = client;
  const settings = await loadRecordingSettings(client);

  const decision = decideConsent({
    policy: settings.consentPolicy,
    recordingEnabled: settings.recordingEnabled,
    leadState: input.leadState,
  });

  if (!decision.allowed) {
    await logCompliance(client, {
      eventType: "recording_blocked",
      leadId: input.leadId,
      callerId: input.callerId,
      state: input.leadState,
      policyApplied: decision.policyApplied,
      actor: "caller",
      detail: { reason: decision.reason },
    });
    return { ok: false, error: decision.reason, blocked: true };
  }

  // A retried start must not create a second row for the same capture.
  const { data: existing } = await db
    .from("recordings")
    .select("id, consent_status, consent_policy_applied")
    .eq("client_capture_id", input.clientCaptureId)
    .maybeSingle();
  if (existing) {
    return {
      ok: true,
      recordingId: existing.id,
      consentStatus: existing.consent_status,
      policyApplied: existing.consent_policy_applied || decision.policyApplied,
      reason: decision.reason,
    };
  }

  const { data, error } = await db
    .from("recordings")
    .insert({
      lead_id: input.leadId,
      caller_id: input.callerId,
      provider: "browser",
      capture_mode: "browser_room",
      client_capture_id: input.clientCaptureId,
      mime_type: input.mimeType,
      started_at: new Date().toISOString(),
      consent_status: decision.status,
      consent_policy_applied: decision.policyApplied,
      telephony_status: "in_progress",
      processing_status: "pending",
      storage_expires_at: retentionExpiry(new Date(), settings.retentionDays).toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    return { ok: false, error: error.message, blocked: true };
  }

  await logCompliance(client, {
    eventType: "recording_started",
    recordingId: data.id,
    leadId: input.leadId,
    callerId: input.callerId,
    state: input.leadState,
    policyApplied: decision.policyApplied,
    actor: "caller",
    detail: { captureMode: "browser_room", mimeType: input.mimeType },
  });

  return {
    ok: true,
    recordingId: data.id,
    consentStatus: decision.status,
    policyApplied: decision.policyApplied,
    reason: decision.reason,
  };
}

/* -------------------------------------------------------------------------- */
/* consent captured mid-call                                                  */
/* -------------------------------------------------------------------------- */

export async function recordConsent(
  client: Db,
  recordingId: string,
  status: "granted" | "refused",
  actor: string
): Promise<{ ok: boolean; discarded: boolean; error?: string }> {
  const db = client;
  const { data: rec } = await db
    .from("recordings")
    .select("id, lead_id, caller_id, call_id, consent_policy_applied")
    .eq("id", recordingId)
    .maybeSingle();
  if (!rec) return { ok: false, discarded: false, error: "That recording no longer exists." };

  await db
    .from("recordings")
    .update({ consent_status: status, consent_captured_at: new Date().toISOString() })
    .eq("id", recordingId);

  await logCompliance(client, {
    eventType: status === "granted" ? "consent_granted" : "consent_refused",
    recordingId,
    leadId: rec.lead_id,
    callerId: rec.caller_id,
    callId: rec.call_id,
    policyApplied: rec.consent_policy_applied,
    actor,
  });

  // Refusal is not a flag. The audio goes.
  if (status === "refused") {
    await discardRecording(client, recordingId, "consent_refused", actor);
    return { ok: true, discarded: true };
  }
  return { ok: true, discarded: false };
}

/* -------------------------------------------------------------------------- */
/* parts                                                                      */
/* -------------------------------------------------------------------------- */

export async function appendPart(
  client: Db,
  recordingId: string,
  sequence: number,
  bytes: ArrayBuffer,
  contentType: string
): Promise<{ ok: boolean; error?: string }> {
  const db = client;

  const { data: rec } = await db
    .from("recordings")
    .select("id, deleted_at, consent_status, parts_uploaded")
    .eq("id", recordingId)
    .maybeSingle();
  if (!rec) return { ok: false, error: "That recording no longer exists." };
  if (rec.deleted_at) return { ok: false, error: "That recording was deleted." };
  // Belt and braces: a part arriving after a refusal is dropped on the floor.
  if (rec.consent_status === "refused") {
    return { ok: false, error: "Consent was refused for this call." };
  }

  const { error } = await db.storage
    .from(BUCKET)
    .upload(partKey(recordingId, sequence), bytes, {
      contentType: contentType || "application/octet-stream",
      upsert: true, // a retried part overwrites rather than duplicating
    });
  if (error) return { ok: false, error: error.message };

  await db
    .from("recordings")
    .update({ parts_uploaded: Math.max(rec.parts_uploaded || 0, sequence + 1) })
    .eq("id", recordingId);

  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* finishing                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Stitch the uploaded parts into one file.
 *
 * MediaRecorder with a timeslice emits a continuous stream: the first blob
 * carries the container header and the rest continue it, so appending the
 * bytes in order reproduces exactly the file a single blob would have been.
 * Concatenating in the wrong order produces an unplayable file, which is why
 * part keys are zero-padded and sorted rather than trusted from the client.
 */
export async function finalizeRecording(
  client: Db,
  recordingId: string,
  input: { durationSeconds?: number | null; partsExpected?: number | null }
): Promise<{ ok: boolean; error?: string; sizeBytes?: number }> {
  const db = client;

  const { data: rec } = await db
    .from("recordings")
    .select("id, lead_id, caller_id, call_id, mime_type, deleted_at, finalized_at, consent_status, consent_policy_applied")
    .eq("id", recordingId)
    .maybeSingle();
  if (!rec) return { ok: false, error: "That recording no longer exists." };
  if (rec.deleted_at) return { ok: false, error: "That recording was deleted." };
  if (rec.consent_status === "refused") {
    await discardRecording(client, recordingId, "consent_refused", "system");
    return { ok: false, error: "Consent was refused, so the audio was deleted." };
  }
  // A retried finalize is a no-op rather than a second stitch.
  if (rec.finalized_at) return { ok: true };

  const { data: listed, error: listErr } = await db.storage
    .from(BUCKET)
    .list(`${recordingId}/parts`, { limit: 10_000, sortBy: { column: "name", order: "asc" } });
  if (listErr) return { ok: false, error: listErr.message };

  const parts = orderedPartNames((listed || []).map((f) => f.name));
  if (parts.length === 0) {
    await discardRecording(client, recordingId, "no_audio_captured", "system");
    return { ok: false, error: "No audio was captured, so nothing was saved." };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const name of parts) {
    const { data: blob, error } = await db.storage
      .from(BUCKET)
      .download(`${recordingId}/parts/${name}`);
    if (error || !blob) return { ok: false, error: error?.message || "A chunk went missing." };
    const buf = new Uint8Array(await blob.arrayBuffer());
    chunks.push(buf);
    total += buf.byteLength;
  }

  const joined = concatParts(chunks);

  const mime = rec.mime_type || "audio/webm";
  const key = finalKey(recordingId, mime);
  const { error: upErr } = await db.storage
    .from(BUCKET)
    .upload(key, joined, { contentType: mime, upsert: true });
  if (upErr) return { ok: false, error: upErr.message };

  await db
    .from("recordings")
    .update({
      storage_url: key,
      size_bytes: total,
      parts_expected: input.partsExpected ?? parts.length,
      duration_seconds: input.durationSeconds ?? null,
      ended_at: new Date().toISOString(),
      finalized_at: new Date().toISOString(),
      telephony_status: "completed",
      processing_status: "pending",
    })
    .eq("id", recordingId);

  // The parts have served their purpose and are pure duplication now.
  await db.storage
    .from(BUCKET)
    .remove(parts.map((n) => `${recordingId}/parts/${n}`))
    .catch(() => {});

  await logCompliance(client, {
    eventType: "recording_stopped",
    recordingId,
    leadId: rec.lead_id,
    callerId: rec.caller_id,
    callId: rec.call_id,
    policyApplied: rec.consent_policy_applied,
    actor: "caller",
    detail: { sizeBytes: total, parts: parts.length, extension: extensionFor(mime) },
  });

  return { ok: true, sizeBytes: total };
}

/* -------------------------------------------------------------------------- */
/* discarding                                                                 */
/* -------------------------------------------------------------------------- */

/** Remove the audio. The row and the audit trail stay; the sound does not. */
export async function discardRecording(
  client: Db,
  recordingId: string,
  reason: string,
  actor: string
): Promise<{ ok: boolean; error?: string }> {
  const db = client;
  const { data: rec } = await db
    .from("recordings")
    .select("id, lead_id, caller_id, call_id, storage_url, consent_policy_applied, deleted_at")
    .eq("id", recordingId)
    .maybeSingle();
  if (!rec) return { ok: false, error: "That recording no longer exists." };

  const keys: string[] = [];
  const { data: listed } = await db.storage
    .from(BUCKET)
    .list(`${recordingId}/parts`, { limit: 10_000 });
  for (const f of listed || []) keys.push(`${recordingId}/parts/${f.name}`);
  if (rec.storage_url) keys.push(rec.storage_url);

  if (keys.length > 0) {
    const { error } = await db.storage.from(BUCKET).remove(keys);
    // Reported, not swallowed: audio that survives a discard is the one
    // failure in this feature that actually matters.
    if (error) {
      await logCompliance(client, {
        eventType: "recording_deleted",
        recordingId,
        leadId: rec.lead_id,
        callerId: rec.caller_id,
        actor,
        detail: { reason, deletionFailed: true, error: error.message },
      });
      return { ok: false, error: `The audio could not be deleted: ${error.message}` };
    }
  }

  await db
    .from("recordings")
    .update({
      deleted_at: new Date().toISOString(),
      discard_reason: reason,
      storage_url: null,
      processing_status: "skipped",
      telephony_status: "completed",
    })
    .eq("id", recordingId);

  // Transcript segments go with the audio.
  await db.from("transcript_segments").delete().eq("recording_id", recordingId);

  await logCompliance(client, {
    eventType: "recording_deleted",
    recordingId,
    leadId: rec.lead_id,
    callerId: rec.caller_id,
    callId: rec.call_id,
    policyApplied: rec.consent_policy_applied,
    actor,
    detail: { reason, objectsRemoved: keys.length },
  });

  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* linking to the call                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The dialer creates the calls row only when the outcome is saved, so a
 * recording is born attached to the lead and joined to the call afterwards.
 */
export async function linkRecordingToCall(
  client: Db,
  recordingId: string,
  callId: string,
  leadId: string
): Promise<void> {
  try {
    const db = client;
    await db
      .from("recordings")
      .update({ call_id: callId, lead_id: leadId })
      .eq("id", recordingId)
      .is("deleted_at", null);
    await db.from("calls").update({ recording_id: recordingId }).eq("id", callId);
    await db.from("transcript_segments").update({ call_id: callId }).eq("recording_id", recordingId);
  } catch {
    // A failed link leaves the recording on the lead, where it is still
    // findable. Not worth failing the outcome save over.
  }
}

/* -------------------------------------------------------------------------- */
/* playback                                                                   */
/* -------------------------------------------------------------------------- */

export async function playbackUrlFor(client: Db, recordingId: string): Promise<string | null> {
  const db = client;
  const { data: rec } = await db
    .from("recordings")
    .select("storage_url, deleted_at")
    .eq("id", recordingId)
    .maybeSingle();
  if (!rec || rec.deleted_at || !rec.storage_url) return null;

  const { data, error } = await db.storage
    .from(BUCKET)
    .createSignedUrl(rec.storage_url, PLAYBACK_URL_SECONDS);
  if (error) return null;
  return data?.signedUrl ?? null;
}

/* -------------------------------------------------------------------------- */
/* transcription                                                              */
/* -------------------------------------------------------------------------- */

export async function transcribeRecording(
  client: Db,
  recordingId: string
): Promise<{ ok: boolean; segments: number; error?: string }> {
  const db = client;
  const settings = await loadRecordingSettings(client);

  const capability = transcriptionCapability();
  if (!settings.transcriptionEnabled || !capability.available) {
    const why = !settings.transcriptionEnabled
      ? "Transcription is switched off in the admin settings."
      : capability.reason;
    await db
      .from("recordings")
      .update({ processing_status: "skipped", transcription_error: why })
      .eq("id", recordingId);
    return { ok: false, segments: 0, error: why };
  }

  const { data: rec } = await db
    .from("recordings")
    .select("id, call_id, storage_url, mime_type, deleted_at")
    .eq("id", recordingId)
    .maybeSingle();
  if (!rec || rec.deleted_at || !rec.storage_url) {
    return { ok: false, segments: 0, error: "There is no audio to transcribe." };
  }

  await db.from("recordings").update({ processing_status: "transcribing" }).eq("id", recordingId);

  const { data: blob, error: dlErr } = await db.storage.from(BUCKET).download(rec.storage_url);
  if (dlErr || !blob) {
    await db
      .from("recordings")
      .update({ processing_status: "failed", transcription_error: dlErr?.message || "download failed" })
      .eq("id", recordingId);
    return { ok: false, segments: 0, error: dlErr?.message || "Could not read the audio back." };
  }

  const result = await transcribeAudio(await blob.arrayBuffer(), rec.mime_type || "audio/webm");
  if (!result.ok) {
    await db
      .from("recordings")
      .update({
        processing_status: "failed",
        transcription_provider: result.provider,
        transcription_error: result.error || "unknown",
      })
      .eq("id", recordingId);
    return { ok: false, segments: 0, error: result.error };
  }

  // Re-running replaces rather than duplicating.
  await db.from("transcript_segments").delete().eq("recording_id", recordingId);

  if (result.segments.length > 0) {
    const { error } = await db.from("transcript_segments").insert(
      result.segments.map((s) => ({
        recording_id: recordingId,
        call_id: rec.call_id,
        sequence: s.sequence,
        start_ms: s.startMs,
        end_ms: s.endMs ?? null,
        speaker: s.speaker,
        speaker_confidence: s.speakerConfidence ?? null,
        text: s.text,
      }))
    );
    if (error) {
      await db
        .from("recordings")
        .update({ processing_status: "failed", transcription_error: error.message })
        .eq("id", recordingId);
      return { ok: false, segments: 0, error: error.message };
    }
  }

  await db
    .from("recordings")
    .update({
      processing_status: "analyzed",
      transcription_provider: result.provider,
      transcription_error: null,
    })
    .eq("id", recordingId);

  return { ok: true, segments: result.segments.length };
}
