// Browser room recording — the rules, with no browser in sight.
//
// The caller puts their handset on speaker and the laptop microphone captures
// the room. Everything that decides whether that may happen, when audio is
// thrown away, and what the caller is told lives here as pure functions, so
// the parts that matter legally are testable without a microphone.
//
// The single most important rule: consent failures DELETE the audio. Not hide
// it, not mark it — delete it. A recording that should not exist must not sit
// in storage waiting for somebody to find it.

import type { ConsentDecision } from "./consent";

/* -------------------------------------------------------------------------- */
/* the state machine                                                          */
/* -------------------------------------------------------------------------- */

export type RecorderState =
  | "idle"
  | "checking_mic"
  | "mic_blocked"
  | "ready"
  | "awaiting_consent"
  | "recording"
  | "finishing"
  | "stored"
  | "discarded"
  | "failed";

/** Consent as captured from the caller on this call. */
export type CapturedConsent = "granted" | "refused" | "pending" | "not_required" | null;

/* -------------------------------------------------------------------------- */
/* the microphone check                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Room capture fails quietly and expensively: a recording that turns out to be
 * silence is discovered days later, when the call it was meant to preserve is
 * long gone. So the level is checked BEFORE the first call, not after.
 *
 * Thresholds are on RMS amplitude, 0-1.
 */
export const LEVEL_SILENT = 0.008;
export const LEVEL_QUIET = 0.02;
export const LEVEL_CLIPPING = 0.85;

export type LevelVerdict = {
  key: "silent" | "quiet" | "good" | "clipping";
  ok: boolean;
  message: string;
};

export function levelVerdict(rms: number): LevelVerdict {
  if (!Number.isFinite(rms) || rms < LEVEL_SILENT) {
    return {
      key: "silent",
      ok: false,
      message:
        "The microphone is picking up nothing. Check it is not muted, and that the right input is selected in your system settings.",
    };
  }
  if (rms < LEVEL_QUIET) {
    return {
      key: "quiet",
      ok: false,
      message:
        "Very faint. Move the laptop closer to the phone, or turn the phone's speaker up — the prospect's side will be unusable at this level.",
    };
  }
  if (rms > LEVEL_CLIPPING) {
    return {
      key: "clipping",
      ok: true,
      message:
        "Loud enough to distort. Move the phone a little further from the laptop, or turn the speaker down a notch.",
    };
  }
  return { key: "good", ok: true, message: "Microphone level looks right." };
}

/**
 * Headphones defeat the whole approach: the prospect's voice goes into the
 * caller's ear and never reaches the microphone, so the recording captures one
 * side of a conversation and nobody notices until playback.
 */
export const ROOM_SETUP_STEPS = [
  "Put the phone on SPEAKER — the laptop microphone has to hear both sides.",
  "Take headphones and earbuds off. With headphones on, the prospect's voice never reaches the microphone and only your half is recorded.",
  "Lay the phone flat, within arm's reach of the laptop.",
  "Quiet room where you can manage it. One microphone is doing all the work.",
];

/* -------------------------------------------------------------------------- */
/* may we record?                                                             */
/* -------------------------------------------------------------------------- */

export type StartGate = {
  canStart: boolean;
  /** Consent must be captured from the prospect before audio is kept. */
  needsConsentFirst: boolean;
  /** What the caller must read out, when anything must be. */
  announcement: string | null;
  reason: string;
};

/**
 * Combine the legal decision, what the caller captured, and the microphone.
 *
 * Every unknown resolves to "no". The order matters: a refusal outranks
 * everything, because a prospect who said no is not overridden by a policy
 * that would otherwise have allowed it.
 */
export function startGate(input: {
  decision: ConsentDecision;
  captured: CapturedConsent;
  micReady: boolean;
  announcement: string;
}): StartGate {
  const { decision, captured, micReady, announcement } = input;

  if (captured === "refused") {
    return {
      canStart: false,
      needsConsentFirst: false,
      announcement: null,
      reason: "They said no. Nothing is recorded on this call.",
    };
  }

  if (!decision.allowed) {
    return {
      canStart: false,
      needsConsentFirst: false,
      announcement: null,
      reason: decision.reason,
    };
  }

  if (decision.affirmativeConsentRequired && captured !== "granted") {
    return {
      canStart: false,
      needsConsentFirst: true,
      announcement,
      reason:
        "Read the notice, and only start once they have actually agreed. Being told is not the same as agreeing.",
    };
  }

  if (!micReady) {
    return {
      canStart: false,
      needsConsentFirst: false,
      announcement: decision.announcementRequired ? announcement : null,
      reason: "Run the microphone check first.",
    };
  }

  return {
    canStart: true,
    needsConsentFirst: false,
    announcement: decision.announcementRequired ? announcement : null,
    reason: decision.reason,
  };
}

/**
 * Consent can be withdrawn mid-call, and that is the case this exists for.
 * Returns what to do with audio already captured.
 */
export type ConsentChangeAction = {
  stop: boolean;
  /** Delete what has been captured so far. */
  discard: boolean;
  discardReason: string | null;
  message: string;
};

export function onConsentChanged(
  next: CapturedConsent,
  recording: boolean
): ConsentChangeAction {
  if (next === "refused") {
    return {
      stop: recording,
      discard: true,
      discardReason: "consent_refused",
      message:
        "Recording stopped and the audio deleted. The outcome form still saves everything else about this call.",
    };
  }
  if (next === "granted") {
    return {
      stop: false,
      discard: false,
      discardReason: null,
      message: "Consent recorded. You can start recording.",
    };
  }
  return {
    stop: false,
    discard: false,
    discardReason: null,
    message: "",
  };
}

/* -------------------------------------------------------------------------- */
/* uploading                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Audio is uploaded in parts WHILE the call runs, not as one blob at the end.
 *
 * A single blob at the end means a refreshed tab, a closed laptop or a dropped
 * connection loses the entire call. Parts mean it loses the tail.
 */
export const PART_INTERVAL_MS = 20_000;

/** Retry schedule for a failed part. Bounded: a call is not a download manager. */
export const UPLOAD_RETRY_DELAYS_MS = [1_000, 3_000, 8_000, 20_000];

export function retryDelayFor(attempt: number): number | null {
  if (attempt < 0 || attempt >= UPLOAD_RETRY_DELAYS_MS.length) return null;
  return UPLOAD_RETRY_DELAYS_MS[attempt];
}

/** Object key for one part. Zero-padded so a plain sort is chronological. */
export function partKey(recordingId: string, sequence: number): string {
  return `${recordingId}/parts/${String(sequence).padStart(6, "0")}`;
}

export function finalKey(recordingId: string, mimeType: string): string {
  return `${recordingId}/call${extensionFor(mimeType)}`;
}

export function extensionFor(mimeType: string): string {
  const t = (mimeType || "").toLowerCase();
  if (t.includes("webm")) return ".webm";
  if (t.includes("ogg")) return ".ogg";
  if (t.includes("mp4") || t.includes("m4a") || t.includes("aac")) return ".mp4";
  if (t.includes("wav")) return ".wav";
  return ".bin";
}

/**
 * Browsers disagree on what MediaRecorder can produce: Chrome and Firefox do
 * webm/opus, Safari does mp4/aac. Both are accepted downstream, so the caller
 * is never told their browser is unsupported when it merely differs.
 */
export const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

export function pickMimeType(supported: (t: string) => boolean): string | null {
  for (const t of PREFERRED_MIME_TYPES) if (supported(t)) return t;
  return null;
}

/* -------------------------------------------------------------------------- */
/* what the caller sees                                                       */
/* -------------------------------------------------------------------------- */

export function formatTimer(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export type StatusRead = {
  label: string;
  tone: "idle" | "live" | "warn" | "done" | "error";
  detail: string;
};

export function statusFor(input: {
  state: RecorderState;
  seconds: number;
  partsUploaded: number;
  partsPending: number;
  lastError?: string | null;
}): StatusRead {
  const { state, seconds, partsPending, lastError } = input;
  switch (state) {
    case "recording":
      return {
        label: `Recording ${formatTimer(seconds)}`,
        tone: "live",
        detail:
          partsPending > 0
            ? `${partsPending} chunk${partsPending === 1 ? "" : "s"} still uploading — keep this tab open.`
            : "Saving as you go. Only the last few seconds would be lost if this tab closed.",
      };
    case "finishing":
      return {
        label: "Finishing upload…",
        tone: "warn",
        detail: "Keep this tab open until it says saved.",
      };
    case "stored":
      return {
        label: `Saved · ${formatTimer(seconds)}`,
        tone: "done",
        detail: "Playable from the lead's page once you save the outcome.",
      };
    case "discarded":
      return {
        label: "Deleted",
        tone: "warn",
        detail: "The audio was removed. Everything else about the call still saves.",
      };
    case "failed":
      return {
        label: "Recording failed",
        tone: "error",
        detail: lastError || "The audio could not be saved. The outcome form still works.",
      };
    case "mic_blocked":
      return {
        label: "Microphone blocked",
        tone: "error",
        detail:
          lastError ||
          "Your browser refused access to the microphone. Allow it in the address bar, then re-run the check.",
      };
    case "checking_mic":
      return { label: "Checking microphone…", tone: "idle", detail: "Say something." };
    case "awaiting_consent":
      return {
        label: "Waiting on consent",
        tone: "warn",
        detail: "Read the notice, then mark whether they agreed.",
      };
    case "ready":
      return { label: "Ready to record", tone: "idle", detail: "Phone on speaker, headphones off." };
    default:
      return { label: "Not recording", tone: "idle", detail: "" };
  }
}

/**
 * After a refresh there may be a half-finished recording on the server. What
 * can be honestly said about it: the parts already uploaded are real, the tail
 * is gone, and it needs closing off rather than resuming — MediaRecorder state
 * does not survive a page load and pretending otherwise would produce a file
 * with a silent gap nobody could see.
 */
export type RecoveryPlan = {
  action: "finalize" | "discard" | "none";
  message: string;
};

export function recoveryPlanFor(open: {
  partsUploaded: number;
  consentStatus: string;
  startedAt?: string | null;
} | null): RecoveryPlan {
  if (!open) return { action: "none", message: "" };
  if (open.consentStatus === "refused") {
    return {
      action: "discard",
      message: "A recording was left open on a call where consent was refused. Deleting it.",
    };
  }
  if (open.partsUploaded === 0) {
    return {
      action: "discard",
      message: "A recording was left open but nothing was captured. Clearing it.",
    };
  }
  return {
    action: "finalize",
    message:
      "This page was reloaded mid-recording. What had already uploaded has been saved; the last few seconds before the reload were lost.",
  };
}

/* -------------------------------------------------------------------------- */
/* stitching                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Join the uploaded parts back into one file.
 *
 * MediaRecorder with a timeslice emits a continuous stream: the first blob
 * carries the container header and the rest continue it, so appending the
 * bytes IN ORDER reproduces exactly the file a single blob would have been.
 * Out of order produces something no player will open, which is why part keys
 * are zero-padded and sorted server-side rather than trusted from the client.
 */
export function concatParts(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/**
 * Storage lists names, not order. Sorting them is what guarantees the stitch
 * is chronological; trusting the listing order would be a silent corruption.
 */
export function orderedPartNames(names: string[]): string[] {
  return [...names].sort();
}
