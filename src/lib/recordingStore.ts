// Recording storage, bound to the real database client.
//
// All the logic lives in ./recordingPipeline, which takes its client as an
// argument so the whole capture-to-playback flow can be driven in a test. This
// file is the seam where the server-only client is supplied, and nothing else.

import "server-only";
import { supabaseAdmin } from "./supabaseAdmin";
import * as pipeline from "./recordingPipeline";

export { BUCKET, PLAYBACK_URL_SECONDS } from "./recordingPipeline";
export type { RecordingSettings, StartResult } from "./recordingPipeline";

export const loadRecordingSettings = () => pipeline.loadRecordingSettings(supabaseAdmin());

export const logCompliance = (input: Parameters<typeof pipeline.logCompliance>[1]) =>
  pipeline.logCompliance(supabaseAdmin(), input);

export const startRecording = (input: Parameters<typeof pipeline.startRecording>[1]) =>
  pipeline.startRecording(supabaseAdmin(), input);

export const recordConsent = (
  recordingId: string,
  status: "granted" | "refused",
  actor: string
) => pipeline.recordConsent(supabaseAdmin(), recordingId, status, actor);

export const appendPart = (
  recordingId: string,
  sequence: number,
  bytes: ArrayBuffer,
  contentType: string
) => pipeline.appendPart(supabaseAdmin(), recordingId, sequence, bytes, contentType);

export const finalizeRecording = (
  recordingId: string,
  input: Parameters<typeof pipeline.finalizeRecording>[2]
) => pipeline.finalizeRecording(supabaseAdmin(), recordingId, input);

export const discardRecording = (recordingId: string, reason: string, actor: string) =>
  pipeline.discardRecording(supabaseAdmin(), recordingId, reason, actor);

export const linkRecordingToCall = (recordingId: string, callId: string, leadId: string) =>
  pipeline.linkRecordingToCall(supabaseAdmin(), recordingId, callId, leadId);

export const playbackUrlFor = (recordingId: string) =>
  pipeline.playbackUrlFor(supabaseAdmin(), recordingId);

export const transcribeRecording = (recordingId: string) =>
  pipeline.transcribeRecording(supabaseAdmin(), recordingId);
