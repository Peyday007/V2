// Telephony.
//
// This platform has no provider today: callers dial from their own phones via
// a tel: link, and no audio passes through the system. That is a real
// constraint, not an oversight, so this module makes it explicit rather than
// pretending otherwise — `configuredProvider()` returns "none" and every
// recording path reports precisely why it did nothing.
//
// The adapter interface below is what a provider has to satisfy. Adding
// Twilio means implementing it and setting TELEPHONY_PROVIDER; nothing else in
// the codebase changes, because everything downstream works off the recordings
// and transcript_segments tables rather than off a provider's shapes.

export type ProviderName = "none" | "twilio";

export type NormalisedCallEvent = {
  /** The provider's id for the call leg. The idempotency key. */
  providerCallSid: string;
  providerRecordingSid?: string | null;
  status: "queued" | "ringing" | "in_progress" | "completed" | "failed" | "no_answer" | "busy";
  startedAt?: string | null;
  endedAt?: string | null;
  durationSeconds?: number | null;
  recordingUrl?: string | null;
  /** Our own identifiers, passed through the provider and returned. */
  callId?: string | null;
  leadId?: string | null;
  callerId?: string | null;
  failureReason?: string | null;
};

export type TranscriptSegmentInput = {
  sequence: number;
  startMs: number;
  endMs?: number | null;
  speaker: "caller" | "prospect" | "unknown";
  speakerConfidence?: number | null;
  text: string;
};

export interface TelephonyAdapter {
  readonly name: ProviderName;
  /** Everything needed to place calls and receive webhooks is present. */
  isConfigured(): boolean;
  /** Turn a provider webhook body into our shape. Must be pure. */
  normaliseWebhook(body: unknown): NormalisedCallEvent | null;
  /** Verify the request really came from the provider. */
  verifySignature(headers: Record<string, string>, rawBody: string): boolean;
  /** A URL a manager's browser can play, valid for a short window. */
  playbackUrl(storageUrl: string): Promise<string | null>;
}

/**
 * The state of the world today. Deliberately not a stub that pretends to work:
 * a fake that silently accepts recordings would produce empty recording rows
 * and make the feature look broken rather than unconfigured.
 */
const noProvider: TelephonyAdapter = {
  name: "none",
  isConfigured: () => false,
  normaliseWebhook: () => null,
  verifySignature: () => false,
  playbackUrl: async () => null,
};

export function configuredProvider(): ProviderName {
  const name = (process.env.TELEPHONY_PROVIDER || "none").toLowerCase();
  return name === "twilio" ? "twilio" : "none";
}

export function adapter(): TelephonyAdapter {
  // When a provider is added, return it here. The switch is the only place in
  // the codebase that needs to know a provider exists.
  return noProvider;
}

export type RecordingCapability = {
  available: boolean;
  reason: string;
  /** What an admin has to do to change the answer. */
  remedy?: string;
};

/** Can this deployment record at all? Answered in words, not a boolean alone. */
export function recordingCapability(): RecordingCapability {
  const provider = configuredProvider();
  if (provider === "none") {
    return {
      available: false,
      reason:
        "No telephony provider is connected. Callers dial from their own phones, so no audio reaches this system and there is nothing to record.",
      remedy:
        "Connect a provider and set TELEPHONY_PROVIDER, then callers place calls from the browser instead of their handsets.",
    };
  }
  if (!adapter().isConfigured()) {
    return {
      available: false,
      reason: `${provider} is selected but its credentials are missing.`,
      remedy: "Add the provider credentials in Vercel and redeploy.",
    };
  }
  return { available: true, reason: `${provider} is connected.` };
}

/**
 * Providers retry webhooks, so every ingest is keyed on the provider's own
 * identifier. This is the key: a repeat delivery updates the existing row
 * rather than creating a second call.
 */
export function idempotencyKeyFor(event: NormalisedCallEvent): string {
  return `telephony:${event.providerRecordingSid || event.providerCallSid}`;
}

/**
 * Speaker labelling is a guess. Below this, the segment is stored as "unknown"
 * rather than being attributed to the wrong person — a transcript that
 * confidently puts the prospect's words in the caller's mouth is worse than
 * one that admits it does not know.
 */
export const SPEAKER_CONFIDENCE_FLOOR = 0.65;

export function resolveSpeaker(
  speaker: string | null | undefined,
  confidence: number | null | undefined
): { speaker: "caller" | "prospect" | "unknown"; uncertain: boolean } {
  if (speaker !== "caller" && speaker !== "prospect") {
    return { speaker: "unknown", uncertain: true };
  }
  if (confidence !== null && confidence !== undefined && confidence < SPEAKER_CONFIDENCE_FLOOR) {
    return { speaker: "unknown", uncertain: true };
  }
  return { speaker, uncertain: false };
}
