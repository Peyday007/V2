export const SALES_STAGES = [
  "New Lead",
  "Contact Attempted",
  "Qualified",
  "Discovery Booked",
  "Discovery Completed",
  "Closed Won",
  "Closed Lost",
] as const;

export const DELIVERY_STAGES = [
  "Onboarding",
  "In Progress",
  "Live",
  "Complete",
] as const;

export const PIPELINES = {
  sales: SALES_STAGES,
  delivery: DELIVERY_STAGES,
} as const;

export type Pipeline = keyof typeof PIPELINES;

export const CALL_OUTCOMES = [
  { value: "no_answer", label: "No answer" },
  { value: "voicemail", label: "Voicemail" },
  { value: "gatekeeper", label: "Gatekeeper only" },
  { value: "dm_conversation", label: "DM conversation" },
  { value: "appointment_set", label: "Appointment set" },
  { value: "callback", label: "Callback requested" },
  { value: "not_interested", label: "Not interested" },
  { value: "bad_number", label: "Bad number" },
] as const;

export type CallOutcome = (typeof CALL_OUTCOMES)[number]["value"];
