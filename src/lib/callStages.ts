// Live caller assistance.
//
// The caller is mid-conversation. Anything longer than a glance is useless, so
// this returns ONE primary suggestion at a time, ranked, with the rest
// available behind it. Never a paragraph.
//
// Suggestions are derived from the call stage plus what is already known about
// the lead — deterministic, instant, and free. When transcription is running,
// the detected stage and objection come from the transcript instead of from
// the caller's own button, and everything below works unchanged.
//
// Pure: no I/O, so the wording is testable and the panel cannot disagree with
// the engine.

export const CALL_STAGES = [
  "dialing",
  "voicemail",
  "gatekeeper",
  "dm_not_confirmed",
  "dm_confirmed",
  "discovery",
  "objection",
  "qualified_interest",
  "meeting_request",
  "meeting_booked",
  "followup_requested",
  "not_interested",
  "do_not_call",
  "completed",
] as const;

export type CallStage = (typeof CALL_STAGES)[number];

export const STAGE_LABEL: Record<CallStage, string> = {
  dialing: "Dialing",
  voicemail: "Voicemail",
  gatekeeper: "Gatekeeper",
  dm_not_confirmed: "Not sure who this is",
  dm_confirmed: "Decision-maker confirmed",
  discovery: "Discovery",
  objection: "Objection",
  qualified_interest: "Qualified interest",
  meeting_request: "Asking for the meeting",
  meeting_booked: "Meeting booked",
  followup_requested: "Follow-up requested",
  not_interested: "Not interested",
  do_not_call: "Do not call",
  completed: "Done",
};

export function isCallStage(v: string): v is CallStage {
  return (CALL_STAGES as readonly string[]).includes(v);
}

export type SuggestionType =
  | "next_sentence"
  | "question"
  | "objection_detected"
  | "info_captured"
  | "missing_qualification"
  | "ask_for_owner"
  | "request_meeting"
  | "compliance_warning"
  | "confirm_followup";

export type Suggestion = {
  id: string;
  type: SuggestionType;
  /** Read at a glance. Kept short on purpose — enforced by a test. */
  headline: string;
  /** One extra line, optional. Never a paragraph. */
  detail?: string;
  priority: number;
};

export const SUGGESTION_TYPE_LABEL: Record<SuggestionType, string> = {
  next_sentence: "Say this",
  question: "Ask this",
  objection_detected: "Objection",
  info_captured: "Captured",
  missing_qualification: "Still missing",
  ask_for_owner: "Ask for the owner",
  request_meeting: "Ask for the meeting",
  compliance_warning: "Compliance",
  confirm_followup: "Confirm before you hang up",
};

/** The longest a headline may be and still be readable mid-call. */
export const MAX_HEADLINE = 90;
export const MAX_DETAIL = 140;

export type AssistantContext = {
  stage: CallStage;
  businessName: string;
  ownerName?: string | null;
  ownerReachedBefore?: boolean;
  gatekeeperName?: string | null;
  answeringSetup?: string | null;
  existingProvider?: string | null;
  mainProblem?: string | null;
  /** Objection key detected or chosen, if any. */
  objectionKey?: string | null;
  /** Set once the caller has captured an email or direct number this call. */
  contactConfirmed?: boolean;
  /** True when a specific date AND time have been agreed. */
  meetingTimeAgreed?: boolean;
  /** Recording is on and consent has not been captured yet. */
  awaitingConsent?: boolean;
  /** The prospect asked not to be called again. */
  dncHeard?: boolean;
};

function s(
  id: string,
  type: SuggestionType,
  headline: string,
  priority: number,
  detail?: string
): Suggestion {
  return { id, type, headline, priority, detail };
}

/**
 * Everything worth saying right now, most important first. The panel shows
 * only the first one unless the caller opens the rest.
 */
export function suggestionsFor(ctx: AssistantContext): Suggestion[] {
  const out: Suggestion[] = [];
  const who = ctx.ownerName || "the owner";

  // Compliance outranks selling, always.
  if (ctx.dncHeard) {
    out.push(
      s(
        "dnc",
        "compliance_warning",
        "They asked not to be called — stop pitching",
        1000,
        "Confirm, apologise, end the call, and log Do not call."
      )
    );
  }
  if (ctx.awaitingConsent) {
    out.push(
      s(
        "consent",
        "compliance_warning",
        "Read the recording notice before going further",
        900,
        "Recording cannot start until they agree."
      )
    );
  }

  switch (ctx.stage) {
    case "dialing":
      out.push(
        s("open", "next_sentence", `Ask for ${who} by name, do not explain yet`, 100,
          ctx.ownerName ? undefined : "If you get a name, that alone makes the call worth it.")
      );
      break;

    case "voicemail":
      out.push(
        s("vm", "next_sentence", "Leave your name, company, and one reason to call back", 100,
          "Keep it under 20 seconds and say you will try again.")
      );
      break;

    case "gatekeeper":
      out.push(
        s("gk-name", "ask_for_owner", `Ask for ${who} directly, by name if you have it`, 100));
      out.push(
        s("gk-when", "question", "When is he usually in and free to talk?", 90,
          "A best time is worth more than a voicemail."));
      if (!ctx.gatekeeperName) {
        out.push(s("gk-who", "question", "Get their name — who am I speaking with?", 80));
      }
      break;

    case "dm_not_confirmed":
      out.push(
        s("confirm", "question", "Are you the one who decides how calls get answered?", 100,
          "Do not pitch until you know. A yes from the wrong person is worthless."));
      break;

    case "dm_confirmed":
      out.push(
        s("permission", "next_sentence", "Thirty seconds on why I called, then you can tell me to go?", 100));
      if (!ctx.answeringSetup) {
        out.push(
          s("setup", "missing_qualification", "Who picks up when you are on a job?", 95,
            "This is the qualifying question — without it there is nothing to sell against."));
      }
      break;

    case "discovery":
      if (!ctx.answeringSetup) {
        out.push(s("d-setup", "missing_qualification", "How are calls handled when nobody can pick up?", 100));
      }
      if (!ctx.mainProblem) {
        out.push(s("d-problem", "question", "What happens to a call you miss?", 95,
          "Get them to say the cost out loud."));
      }
      if (!ctx.existingProvider) {
        out.push(s("d-provider", "question", "Are you using an answering service already?", 80));
      }
      out.push(s("d-quantify", "question", "Roughly how many calls a week go unanswered?", 70));
      break;

    case "objection":
      out.push(
        s("obj", "objection_detected",
          ctx.objectionKey ? `Objection: ${ctx.objectionKey.replace(/_/g, " ")}` : "Objection raised",
          100,
          "Acknowledge it, then ask one question. Do not argue."));
      out.push(
        s("obj-q", "question", "What would have to be true for this to be worth a look?", 85));
      break;

    case "qualified_interest":
      out.push(
        s("qi-meeting", "request_meeting", "Ask for a specific day and time now", 100,
          "Interest without a slot in the diary is not an appointment."));
      if (!ctx.contactConfirmed) {
        out.push(s("qi-contact", "missing_qualification", "Get the best email before you hang up", 90));
      }
      break;

    case "meeting_request":
      out.push(
        s("mr", "request_meeting", "Offer two times, not an open question", 100,
          `"Thursday at 9, or Friday at 2 — which is easier?"`));
      if (!ctx.meetingTimeAgreed) {
        out.push(s("mr-lock", "request_meeting", "Do not log this as booked until they pick one", 95));
      }
      break;

    case "meeting_booked":
      out.push(
        s("mb-confirm", "confirm_followup", "Read the date, time and time zone back to them", 100));
      if (!ctx.contactConfirmed) {
        out.push(s("mb-email", "missing_qualification", "Confirm the email for the invite", 95));
      }
      break;

    case "followup_requested":
      out.push(
        s("fu-what", "confirm_followup", "Confirm exactly what they want sent, and to which address", 100));
      out.push(
        s("fu-when", "question", "When shall I follow up after you have read it?", 90,
          "A follow-up with no next date is a dead end."));
      break;

    case "not_interested":
      out.push(
        s("ni-who", "question", "Is that your call, or does someone else decide?", 100,
          "A gatekeeper's no is not the owner's no."));
      out.push(
        s("ni-later", "question", "Worth a call in a few months?", 80));
      break;

    case "do_not_call":
      out.push(
        s("dnc-log", "compliance_warning", "Confirm and log it — this blocks the number everywhere", 100));
      break;

    case "completed":
      out.push(
        s("done", "confirm_followup", "Log the outcome while it is fresh", 100,
          "Anything you learned that is not written down gets rediscovered."));
      break;
  }

  // Cross-cutting nudges, below whatever the stage suggested.
  const talking = ["dm_confirmed", "discovery", "objection", "qualified_interest"];
  if (!ctx.ownerName && talking.includes(ctx.stage)) {
    out.push(s("x-name", "ask_for_owner", "Get the owner's name before you hang up", 60));
  }
  if (ctx.ownerReachedBefore && ctx.stage === "dm_confirmed") {
    out.push(s("x-prior", "info_captured", "You have spoken before — pick up where you left off", 70));
  }

  return out.sort((a, b) => b.priority - a.priority);
}

/** The one to show. Everything else stays behind it. */
export function primarySuggestion(ctx: AssistantContext): Suggestion | null {
  return suggestionsFor(ctx)[0] ?? null;
}

/**
 * Which outcome the caller most likely wants, given where the call ended.
 * Pre-selects the outcome form rather than choosing for them.
 */
export function suggestedOutcomeFor(stage: CallStage): string | null {
  const map: Partial<Record<CallStage, string>> = {
    voicemail: "voicemail",
    gatekeeper: "gatekeeper",
    dm_confirmed: "dm_conversation",
    discovery: "dm_conversation",
    objection: "dm_conversation",
    qualified_interest: "dm_conversation",
    meeting_booked: "appointment_set",
    followup_requested: "callback",
    not_interested: "not_interested",
    do_not_call: "do_not_call",
  };
  return map[stage] ?? null;
}
