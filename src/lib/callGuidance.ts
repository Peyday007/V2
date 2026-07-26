// Owner-first guidance for the dialer. These leads are owner-operated local
// service businesses (600 reviews or fewer), so the owner is always the first
// target — no enterprise title hierarchy.

export type LeadIntel = {
  owner_name: string | null;
  owner_title: string | null;
  extension: string | null;
  direct_number: string | null;
  best_call_day: string | null;
  best_call_time: string | null;
  gatekeeper_name: string | null;
  other_decision_maker: string | null;
  owner_reached: boolean;
  last_next_step: string | null;
  attempt_count: number;
};

/* ------------------------------ who to ask for ---------------------------- */

export function whoToAskFor(lead: LeadIntel): { text: string; detail: string[] } {
  const detail: string[] = [];
  if (lead.extension) detail.push(`Extension ${lead.extension}`);
  if (lead.direct_number) detail.push(`Direct line ${lead.direct_number}`);
  if (lead.best_call_day || lead.best_call_time) {
    detail.push(
      `Best time: ${[lead.best_call_day, lead.best_call_time].filter(Boolean).join(" ")}`
    );
  }
  if (lead.gatekeeper_name) detail.push(`Gatekeeper: ${lead.gatekeeper_name}`);
  if (lead.other_decision_maker) {
    detail.push(`Business says the decision-maker is ${lead.other_decision_maker}`);
  }

  if (lead.owner_name) {
    const title = lead.owner_title ? lead.owner_title.toLowerCase() : "owner";
    return {
      text: `Ask for ${lead.owner_name}, the ${title}. If they are unavailable, find out the best day and time to reach them directly.`,
      detail,
    };
  }
  return {
    text: "Ask whether the owner is available. If not, get the owner's name and the best day and time to call back.",
    detail,
  };
}

/* ------------------------------ call objective ---------------------------- */

export function callObjective(lead: LeadIntel): string {
  if (lead.owner_reached) {
    return lead.last_next_step
      ? `Continue the previous conversation and complete the next step: ${lead.last_next_step}`
      : "Continue the previous conversation and complete the next step shown in the call history.";
  }
  if (lead.owner_name) {
    return `Reach ${lead.owner_name}, briefly identify whether missed or after-hours calls are costing the business opportunities, and attempt to book a demo.`;
  }
  return "Identify the owner, get transferred to them, or obtain a specific time when they can be reached.";
}

/* --------------------------------- script --------------------------------- */

export type ScriptSection = { heading: string; line: string };

export function callScript(lead: LeadIntel): ScriptSection[] {
  const opening = lead.owner_name
    ? `"Hi, could I speak with ${lead.owner_name} for a moment?"`
    : `"Quick question — could I speak with the owner for a moment?"`;

  return [
    { heading: "Opening", line: opening },
    {
      heading: "Owner discovery",
      line: `"Who is the owner, and when is usually the best time to reach them?"`,
    },
    {
      heading: "Owner conversation",
      line: `"I'm calling because we help local service businesses answer missed and after-hours calls without adding another full-time employee. What normally happens when nobody can answer your phone?"`,
    },
  ];
}

/* ------------------------------- objections ------------------------------- */

export type Objection = {
  key: string;
  label: string;
  response: string;
  followUp: string;
  suggestedOutcome: string;
};

export const OBJECTIONS: Objection[] = [
  {
    key: "answer_every_call",
    label: "We already answer every call",
    response:
      "That's good to hear — most owners tell me the gaps show up after hours or when crews are on a job.",
    followUp: "What happens to a call that comes in at 7pm on a Saturday?",
    suggestedOutcome: "dm_conversation",
  },
  {
    key: "have_answering_service",
    label: "We already have an answering service",
    response:
      "Makes sense. Most of those take a message rather than book the job.",
    followUp: "Can yours actually schedule an appointment, or does it just take a name and number?",
    suggestedOutcome: "dm_conversation",
  },
  {
    key: "owner_unavailable",
    label: "The owner is unavailable",
    response: "No problem — I don't want to catch them mid-job.",
    followUp: "What's their name, and what day and time do they usually pick up?",
    suggestedOutcome: "gatekeeper",
  },
  {
    key: "send_info",
    label: "Send some information",
    response:
      "Happy to. It's only worth sending if it's relevant to how you handle calls now.",
    followUp:
      "Before I do — who's answering the phone when everyone's out on a job?",
    suggestedOutcome: "callback",
  },
  {
    key: "not_interested_ai",
    label: "We are not interested in AI",
    response:
      "Fair — a lot of owners picture a robot that annoys customers. This just answers when nobody else can.",
    followUp: "How many calls a week do you reckon go to voicemail?",
    suggestedOutcome: "not_interested",
  },
  {
    key: "cost",
    label: "How much does it cost?",
    response:
      "It depends on call volume, and it's a fraction of a part-time receptionist.",
    followUp:
      "So I quote you the right thing — roughly how many calls come in a week?",
    suggestedOutcome: "dm_conversation",
  },
  {
    key: "not_enough_calls",
    label: "We do not receive enough calls",
    response: "Then the ones you do get matter more, not less.",
    followUp: "What's a typical job worth to you?",
    suggestedOutcome: "dm_conversation",
  },
  {
    key: "tried_before",
    label: "We tried something similar before",
    response: "What went wrong last time is usually the useful part.",
    followUp: "What did it fail to do that you needed?",
    suggestedOutcome: "dm_conversation",
  },
  {
    key: "call_back_later",
    label: "Call back later",
    response: "Of course — I'd rather catch you at a good moment.",
    followUp: "What day and time works best? I'll put it in now.",
    suggestedOutcome: "callback",
  },
];
