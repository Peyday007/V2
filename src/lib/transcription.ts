// Transcription.
//
// Anthropic has no speech-to-text, so this needs an outside provider. Rather
// than hard-wire one, this mirrors ./telephony: an adapter interface, a "none"
// default that says precisely why it did nothing, and normalisers that are
// pure so a provider's response shape can be tested without a network.
//
// Nothing here runs unless TRANSCRIPTION_PROVIDER is set AND transcription is
// switched on in the admin settings. Recording and playback work without it.
//
// A note on speaker labels. This deployment captures a room through one
// microphone: the caller is a foot away, the prospect is coming out of a phone
// speaker across the desk. Diarisation on that is unreliable, so a label is
// only kept when the provider is confident (see SPEAKER_CONFIDENCE_FLOOR) and
// everything else stores as "unknown". A transcript that confidently puts the
// prospect's words in the caller's mouth is worse than one that admits it does
// not know.

import { resolveSpeaker, type TranscriptSegmentInput } from "./telephony";

export type TranscriberName = "none" | "deepgram" | "openai";

export type TranscriptionCapability = {
  available: boolean;
  provider: TranscriberName;
  reason: string;
  /** What an admin has to do to change the answer. */
  remedy?: string;
};

export function configuredTranscriber(): TranscriberName {
  const name = (process.env.TRANSCRIPTION_PROVIDER || "none").toLowerCase();
  if (name === "deepgram") return "deepgram";
  if (name === "openai" || name === "whisper") return "openai";
  return "none";
}

function keyFor(provider: TranscriberName): string | null {
  if (provider === "deepgram") return process.env.DEEPGRAM_API_KEY || null;
  if (provider === "openai") return process.env.OPENAI_API_KEY || null;
  return null;
}

export function transcriptionCapability(): TranscriptionCapability {
  const provider = configuredTranscriber();
  if (provider === "none") {
    return {
      available: false,
      provider,
      reason:
        "No transcription provider is configured, so recordings are saved and playable but not written out as text.",
      remedy:
        "Set TRANSCRIPTION_PROVIDER to deepgram or openai, add that provider's API key, and redeploy. Both charge per minute of audio.",
    };
  }
  if (!keyFor(provider)) {
    return {
      available: false,
      provider,
      reason: `${provider} is selected but its API key is missing.`,
      remedy:
        provider === "deepgram"
          ? "Add DEEPGRAM_API_KEY in Vercel and redeploy."
          : "Add OPENAI_API_KEY in Vercel and redeploy.",
    };
  }
  return { available: true, provider, reason: `${provider} is connected.` };
}

/* -------------------------------------------------------------------------- */
/* normalising a provider response                                            */
/* -------------------------------------------------------------------------- */

function clean(text: unknown): string {
  return typeof text === "string" ? text.trim() : "";
}

function seconds(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Deepgram, with diarisation on. Words carry a speaker index; paragraphs carry
 * the readable grouping. Speaker 0 vs 1 tells us there are two voices but not
 * WHICH is the caller, so neither is claimed — see the note at the top.
 */
export function normaliseDeepgram(body: unknown): TranscriptSegmentInput[] {
  const root = body as {
    results?: {
      channels?: {
        alternatives?: {
          paragraphs?: { paragraphs?: unknown[] };
          words?: unknown[];
        }[];
      }[];
    };
  };
  const alt = root?.results?.channels?.[0]?.alternatives?.[0];
  if (!alt) return [];

  const out: TranscriptSegmentInput[] = [];
  const paragraphs = alt.paragraphs?.paragraphs;

  if (Array.isArray(paragraphs) && paragraphs.length > 0) {
    for (const p of paragraphs) {
      const para = p as {
        sentences?: { text?: unknown; start?: unknown; end?: unknown }[];
        start?: unknown;
        end?: unknown;
        speaker?: unknown;
      };
      const text = (para.sentences || [])
        .map((s) => clean(s.text))
        .filter(Boolean)
        .join(" ");
      if (!text) continue;
      out.push({
        sequence: out.length,
        startMs: Math.round(seconds(para.start) * 1000),
        endMs: Math.round(seconds(para.end) * 1000),
        // A speaker index is not an identity. Stored unknown deliberately.
        speaker: "unknown",
        speakerConfidence: null,
        text,
      });
    }
    return out;
  }

  // No paragraphs: fall back to grouping words by their speaker index.
  const words = Array.isArray(alt.words) ? alt.words : [];
  let current: { speaker: unknown; start: number; end: number; parts: string[] } | null = null;
  for (const w of words) {
    const word = w as { word?: unknown; punctuated_word?: unknown; start?: unknown; end?: unknown; speaker?: unknown };
    const text = clean(word.punctuated_word) || clean(word.word);
    if (!text) continue;
    if (!current || current.speaker !== word.speaker) {
      if (current && current.parts.length) {
        out.push({
          sequence: out.length,
          startMs: Math.round(current.start * 1000),
          endMs: Math.round(current.end * 1000),
          speaker: "unknown",
          speakerConfidence: null,
          text: current.parts.join(" "),
        });
      }
      current = { speaker: word.speaker, start: seconds(word.start), end: seconds(word.end), parts: [] };
    }
    current.parts.push(text);
    current.end = seconds(word.end);
  }
  if (current && current.parts.length) {
    out.push({
      sequence: out.length,
      startMs: Math.round(current.start * 1000),
      endMs: Math.round(current.end * 1000),
      speaker: "unknown",
      speakerConfidence: null,
      text: current.parts.join(" "),
    });
  }
  return out;
}

/** OpenAI Whisper, verbose_json. Timestamped segments, no diarisation at all. */
export function normaliseWhisper(body: unknown): TranscriptSegmentInput[] {
  const root = body as { segments?: unknown[]; text?: unknown };
  const segments = Array.isArray(root?.segments) ? root.segments : null;

  if (!segments) {
    const whole = clean(root?.text);
    if (!whole) return [];
    return [
      { sequence: 0, startMs: 0, endMs: null, speaker: "unknown", speakerConfidence: null, text: whole },
    ];
  }

  const out: TranscriptSegmentInput[] = [];
  for (const s of segments) {
    const seg = s as { text?: unknown; start?: unknown; end?: unknown };
    const text = clean(seg.text);
    if (!text) continue;
    out.push({
      sequence: out.length,
      startMs: Math.round(seconds(seg.start) * 1000),
      endMs: Math.round(seconds(seg.end) * 1000),
      speaker: "unknown",
      speakerConfidence: null,
      text,
    });
  }
  return out;
}

/**
 * Last gate before storage. Re-sequences from zero, drops empties, and puts
 * every uncertain label back to "unknown" using the same floor the telephony
 * path uses, so both routes into transcript_segments obey one rule.
 */
export function prepareSegments(segments: TranscriptSegmentInput[]): TranscriptSegmentInput[] {
  const out: TranscriptSegmentInput[] = [];
  for (const s of segments) {
    const text = clean(s.text);
    if (!text) continue;
    const { speaker } = resolveSpeaker(s.speaker, s.speakerConfidence);
    out.push({
      sequence: out.length,
      startMs: Math.max(0, Math.round(s.startMs || 0)),
      endMs: s.endMs === null || s.endMs === undefined ? null : Math.max(0, Math.round(s.endMs)),
      speaker,
      speakerConfidence: s.speakerConfidence ?? null,
      text,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* calling the provider                                                       */
/* -------------------------------------------------------------------------- */

export type TranscribeResult = {
  ok: boolean;
  provider: TranscriberName;
  segments: TranscriptSegmentInput[];
  error?: string;
};

/**
 * One call, one audio file. Deliberately not streaming and not real-time — the
 * brief was reliable capture first, live features later.
 */
export async function transcribeAudio(
  audio: ArrayBuffer,
  mimeType: string
): Promise<TranscribeResult> {
  const capability = transcriptionCapability();
  if (!capability.available) {
    return {
      ok: false,
      provider: capability.provider,
      segments: [],
      error: capability.reason,
    };
  }

  const provider = capability.provider;
  const key = keyFor(provider)!;

  try {
    if (provider === "deepgram") {
      const res = await fetch(
        "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true&paragraphs=true&diarize=true",
        {
          method: "POST",
          headers: { Authorization: `Token ${key}`, "Content-Type": mimeType || "audio/webm" },
          body: audio,
        }
      );
      if (!res.ok) {
        return {
          ok: false,
          provider,
          segments: [],
          error: `Deepgram returned ${res.status}: ${(await res.text()).slice(0, 300)}`,
        };
      }
      return { ok: true, provider, segments: prepareSegments(normaliseDeepgram(await res.json())) };
    }

    const form = new FormData();
    form.append("file", new Blob([audio], { type: mimeType || "audio/webm" }), "call.webm");
    form.append("model", "whisper-1");
    form.append("response_format", "verbose_json");
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    if (!res.ok) {
      return {
        ok: false,
        provider,
        segments: [],
        error: `OpenAI returned ${res.status}: ${(await res.text()).slice(0, 300)}`,
      };
    }
    return { ok: true, provider, segments: prepareSegments(normaliseWhisper(await res.json())) };
  } catch (e) {
    return {
      ok: false,
      provider,
      segments: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
