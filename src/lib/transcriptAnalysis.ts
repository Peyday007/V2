// Reading a call from its transcript.
//
// The outcome form gives a deterministic reading that always works and cannot
// hallucinate. This gives a second one, from what was actually said, and under
// the authority rules in ./aiAuthority it is usually the one that wins.
//
// Two things this module refuses to do:
//
//   Guess. Every field may come back null. A transcript of a room recording —
//   one microphone, a phone speaker across a desk — is often too poor to say
//   whether the owner was reached, and "unknown" is a useful answer where an
//   invented one is not.
//
//   Trust its own output. The model returns JSON; this validates every field
//   against the same shapes the deterministic reader uses, drops anything it
//   does not recognise, and reports a confidence that reflects how much of the
//   transcript was actually usable.
//
// The prompt-building and parsing are pure so they can be tested without a
// model call.

import {
  type CallAnalysisResult,
  type InterestLevel,
  type MeetingStatus,
  type QualificationStatus,
} from "./callAnalysis";

export type TranscriptLine = {
  speaker: string;
  text: string;
  startMs: number;
};

/* -------------------------------------------------------------------------- */
/* the prompt                                                                 */
/* -------------------------------------------------------------------------- */

export const ANALYSIS_SYSTEM_PROMPT = `You read cold-call transcripts for a company selling an AI receptionist to owner-operated home-service businesses (plumbers, roofers, HVAC, electricians).

The recording is a room capture: one laptop microphone, with the prospect coming through a phone speaker across a desk. The caller's side is clear; the prospect's side is often not. Mis-heard words are expected.

Return ONLY a JSON object. No prose, no markdown fence.

Every field may be null. Null means "the transcript does not establish this". That is a correct and useful answer — a wrong confident answer is worse than an admitted gap, because these readings are applied without a human checking them.

Fields:
  personReached        string|null   who answered, in a few words
  liveAnswer           bool|null     did a human answer at all
  ownerReached         bool|null     was the owner or decision-maker reached
  objections           string[]      objections raised, in the prospect's own words
  needsDiscovered      string[]      problems or needs the prospect described
  interestLevel        "strong"|"mild"|"unsure"|"none"|null
  qualificationStatus  "qualified"|"not_qualified"|"partially_qualified"|"unknown"|null
  meetingStatus        "booked"|"requested"|"declined"|"none"|null
  meetingAt            string|null   ISO 8601, ONLY if a specific date AND time were agreed
  contactConfirmed     string|null   an email or direct number the prospect confirmed
  followupRequested    bool|null     did they ask to be contacted again
  newInformation       string[]      durable facts about the business worth keeping
  doNotCallRequested   bool|null     true ONLY if they asked not to be called again
  callerStrengths      string[]      what the caller did well
  missedOpportunities  string[]      openings the caller did not take
  coachingPoint        string|null   the single most useful thing to tell the caller

Rules:
  - doNotCallRequested is true only for an actual request to stop calling. Irritation is not a request.
  - meetingAt requires a specific date and time. "Next week" is not one.
  - Never invent a name, email or number that does not appear in the transcript.
  - objections and needsDiscovered quote the prospect, not your paraphrase.
  - coachingPoint is one sentence, addressed to the caller, about this call.`;

export function buildTranscriptPrompt(input: {
  businessName: string;
  callerName?: string | null;
  industry?: string | null;
  segments: TranscriptLine[];
  durationSeconds?: number | null;
}): string {
  const body = input.segments
    .map((s) => {
      const t = Math.floor(s.startMs / 1000);
      const stamp = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
      // Speaker labels are usually "unknown" on a single-mic room capture, and
      // saying so is more honest than a label the diariser guessed.
      const who = s.speaker === "unknown" ? "?" : s.speaker;
      return `[${stamp}] ${who}: ${s.text}`;
    })
    .join("\n");

  return [
    `Business: ${input.businessName}`,
    input.industry ? `Trade: ${input.industry}` : null,
    input.callerName ? `Our caller: ${input.callerName}` : null,
    input.durationSeconds ? `Call length: ${input.durationSeconds}s` : null,
    "",
    "Transcript:",
    body || "(empty)",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/* -------------------------------------------------------------------------- */
/* parsing what comes back                                                    */
/* -------------------------------------------------------------------------- */

const INTEREST: InterestLevel[] = ["strong", "mild", "unsure", "none", "unknown"];
const QUALIFICATION: QualificationStatus[] = [
  "qualified",
  "not_qualified",
  "partially_qualified",
  "unknown",
];
const MEETING: MeetingStatus[] = ["booked", "requested", "declined", "none"];

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.toLowerCase() !== "null" && t.toLowerCase() !== "unknown" ? t : null;
}

function bool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  return null;
}

function list(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => x.length > 0)
    .slice(0, 12);
}

function oneOf<T extends string>(v: unknown, allowed: T[]): T | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().toLowerCase() as T;
  return allowed.includes(t) ? t : undefined;
}

/** ISO 8601 only, and only if it parses. A made-up date is worse than none. */
function isoDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Models sometimes wrap JSON in prose or a fence despite being told not to. */
export function extractJson(raw: string): unknown | null {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseAnalysis(raw: string): CallAnalysisResult | null {
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;

  return {
    personReached: str(o.personReached),
    liveAnswer: bool(o.liveAnswer),
    ownerReached: bool(o.ownerReached),
    objections: list(o.objections),
    needsDiscovered: list(o.needsDiscovered),
    interestLevel: oneOf(o.interestLevel, INTEREST),
    qualificationStatus: oneOf(o.qualificationStatus, QUALIFICATION),
    meetingStatus: oneOf(o.meetingStatus, MEETING),
    meetingAt: isoDate(o.meetingAt),
    contactConfirmed: str(o.contactConfirmed),
    followupRequested: bool(o.followupRequested),
    newInformation: list(o.newInformation),
    doNotCallRequested: bool(o.doNotCallRequested),
    callerStrengths: list(o.callerStrengths),
    missedOpportunities: list(o.missedOpportunities),
    coachingPoint: str(o.coachingPoint),
  };
}

/* -------------------------------------------------------------------------- */
/* how much to trust it                                                       */
/* -------------------------------------------------------------------------- */

/** Words below which a transcript cannot settle anything. */
export const MIN_WORDS_FOR_ANALYSIS = 40;

/**
 * Confidence from the transcript itself, not from the model's self-report.
 *
 * A model asked how sure it is will say "0.9" about a transcript of three
 * words. This measures the thing that actually limits the reading: how much
 * usable speech there was, and how much of it the transcriber could attribute.
 */
export function transcriptConfidence(segments: TranscriptLine[]): number {
  const words = segments.reduce((n, s) => n + s.text.trim().split(/\s+/).length, 0);
  if (words < MIN_WORDS_FOR_ANALYSIS) return 0.2;

  // Diarisation on a single-mic room capture is poor, and a transcript where
  // nobody can be told apart supports weaker conclusions.
  const attributed = segments.filter((s) => s.speaker !== "unknown").length;
  const attributionRatio = segments.length > 0 ? attributed / segments.length : 0;

  const lengthScore = Math.min(1, words / 400);
  return Math.max(0.25, Math.min(0.95, 0.45 + lengthScore * 0.35 + attributionRatio * 0.2));
}

export function tooThinToRead(segments: TranscriptLine[]): boolean {
  const words = segments.reduce((n, s) => n + s.text.trim().split(/\s+/).length, 0);
  return words < MIN_WORDS_FOR_ANALYSIS;
}
