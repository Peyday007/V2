// What the dialer shows, and what it refuses to show.
//
// The old call screen answered questions the caller never asked: why this lead
// was chosen, how many leads sit in business hours, which of thirteen call
// stages they are in. All of it true, none of it their job. The packet already
// decided which lead appears; the caller's job is the conversation in front of
// them.
//
// So the screen answers three questions and nothing else:
//
//   Who am I calling?      — the header
//   What do I say next?    — the guided call
//   What just happened?    — the outcome bar
//
// This module holds the rules behind that: which outcomes stay visible, what
// the caller should say given who picked up, and how the call stage is worked
// out rather than asked for.

import type { CallStage } from "./callStages";
import type { LeadIntel } from "./callGuidance";

/* -------------------------------------------------------------------------- */
/* who picked up                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The one thing the caller is asked, because it is the only thing that changes
 * both what to say next AND what gets saved. Everything else about the call
 * stage is inferred.
 */
export type SpeakingWith = "nobody" | "gatekeeper" | "owner";

export const SPEAKING_WITH_LABEL: Record<SpeakingWith, string> = {
  nobody: "Nobody yet",
  gatekeeper: "Reception",
  owner: "The owner",
};

/**
 * Work out the call stage instead of asking for it.
 *
 * The old panel offered thirteen stage buttons. A caller mid-conversation does
 * not classify themselves into a taxonomy — and every one of those stages is
 * derivable from who picked up, whether an objection came up, and whether the
 * business has been reached before.
 */
export function inferStage(input: {
  speakingWith: SpeakingWith;
  objectionKey?: string | null;
  ownerReachedBefore?: boolean;
  /** How far through the guided lines they are. */
  lineIndex?: number;
}): CallStage {
  const { speakingWith, objectionKey, ownerReachedBefore, lineIndex = 0 } = input;

  // An objection outranks position: it is what the caller needs help with now.
  if (objectionKey && speakingWith !== "nobody") return "objection";

  if (speakingWith === "owner") {
    // Past the opening line means they are into the conversation proper.
    if (lineIndex > 0) return "discovery";
    return ownerReachedBefore ? "discovery" : "dm_confirmed";
  }
  if (speakingWith === "gatekeeper") return "gatekeeper";
  return "dialing";
}

/** What the outcome form should record about who was on the phone. */
export function spokeWithRoleFor(speakingWith: SpeakingWith): string | null {
  if (speakingWith === "owner") return "owner";
  if (speakingWith === "gatekeeper") return "gatekeeper";
  return null;
}

/* -------------------------------------------------------------------------- */
/* the outcome bar                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The six that cover almost every call, kept permanently visible. Ordered the
 * way a call actually ends: the common disappointments first, the win last.
 */
export const PRIMARY_OUTCOMES = [
  "no_answer",
  "voicemail",
  "callback",
  "transferred",
  "not_interested",
  "appointment_set",
] as const;

/**
 * The rest, behind a menu. Not less important — `do_not_call` is the most
 * consequential button on the page — just far less frequent, and a rare button
 * sitting next to a common one is how the wrong one gets pressed.
 */
export const MORE_OUTCOMES = [
  "gatekeeper",
  "dm_conversation",
  "bad_number",
  "do_not_call",
] as const;

/** Which outcome the screen puts forward first, given who is on the phone. */
export function likelyOutcome(speakingWith: SpeakingWith): string | null {
  if (speakingWith === "owner") return "dm_conversation";
  if (speakingWith === "gatekeeper") return "gatekeeper";
  return null;
}

/* -------------------------------------------------------------------------- */
/* the guided call                                                            */
/* -------------------------------------------------------------------------- */

/**
 * "Who to ask for", "Call objective" and "Script" were three cards saying the
 * same thing three ways. One goal, then one line at a time.
 */
export type GuidedLine = { heading: string; line: string };

export type GuidedCall = {
  /** One sentence: what this call is for, right now. */
  goal: string;
  /** Facts that change how the call opens. Empty most of the time. */
  notes: string[];
  lines: GuidedLine[];
};

export function guidedCall(lead: LeadIntel, speakingWith: SpeakingWith): GuidedCall {
  const notes: string[] = [];
  if (lead.extension) notes.push(`Extension ${lead.extension}`);
  if (lead.direct_number) notes.push(`Direct line ${lead.direct_number}`);
  if (lead.gatekeeper_name) notes.push(`Reception: ${lead.gatekeeper_name}`);
  if (lead.other_decision_maker) {
    notes.push(`They say the decision-maker is ${lead.other_decision_maker}`);
  }

  const who = lead.owner_name || "the owner";

  if (speakingWith === "owner") {
    const goal =
      lead.owner_reached && lead.last_next_step
        ? `Pick up where you left off: ${lead.last_next_step}`
        : "Find out what happens to their missed calls, then ask for the meeting.";
    return {
      goal,
      notes,
      lines: [
        {
          heading: "Why you called",
          line: `"I'll be quick — we help local service businesses answer missed and after-hours calls without hiring anyone. What normally happens when nobody can get to the phone?"`,
        },
        {
          heading: "Make it cost something",
          line: `"Roughly how many calls a week end up going to voicemail? And what's a job worth to you on average?"`,
        },
        {
          heading: "How they handle it now",
          line: `"Is anyone picking those up later, or does it depend who's around?"`,
        },
        {
          heading: "Ask for the meeting",
          line: `"Let me show you what it'd catch for you — fifteen minutes. Does Tuesday or Thursday morning suit you better?"`,
        },
        {
          heading: "Lock it down",
          line: `"Perfect. What's the best email for the invite? I'll send it over now so it's in your calendar."`,
        },
      ],
    };
  }

  if (speakingWith === "gatekeeper") {
    return {
      goal: lead.owner_name
        ? `Get through to ${lead.owner_name}, or get a time when they will pick up.`
        : "Get the owner's name and a time they actually answer.",
      notes,
      lines: [
        {
          heading: "Ask again, warmly",
          line: lead.owner_name
            ? `"Is ${lead.owner_name} around at the moment?"`
            : `"Is the owner around at the moment?"`,
        },
        {
          heading: "If they are not",
          line: `"No problem — I don't want to catch them mid-job. What's their name, and what day and time do they usually pick up?"`,
        },
        {
          heading: "Get a direct route",
          line: `"Is there a direct line or extension that reaches them, rather than the main number?"`,
        },
        {
          heading: "Leave the door open",
          line: `"That's helpful, thank you. I'll try then — who should I say I spoke with?"`,
        },
      ],
    };
  }

  return {
    goal: lead.owner_name
      ? `Get ${lead.owner_name} on the phone.`
      : "Find out who the owner is and get them on the phone.",
    notes,
    lines: [
      {
        heading: "Open",
        line: lead.owner_name
          ? `"Hi, could I speak with ${lead.owner_name} for a moment?"`
          : `"Quick question — could I speak with the owner for a moment?"`,
      },
      {
        heading: "If they ask what it is about",
        line: `"It's about how the phones get answered when everyone's out on a job — takes two minutes."`,
      },
      {
        heading: "If it goes to voicemail",
        line: `"Hi ${who === "the owner" ? "" : who}, it's about missed calls turning into missed jobs. I'll try you again — no need to call back."`,
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* the header                                                                 */
/* -------------------------------------------------------------------------- */

/** Attempt history, in the few words that fit on one line. */
export function attemptSummary(attemptCount: number, ownerReached: boolean): string {
  const n = Math.max(0, attemptCount);
  if (n === 0) return "First attempt";
  if (ownerReached) return `Attempt ${n + 1} · owner reached before`;
  return `Attempt ${n + 1} · never reached the owner`;
}
