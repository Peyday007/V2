// Sales pipeline stages live in src/lib/stages.ts — that is the single
// source of truth shared by the database and the UI. Do not redefine them here.

export const DELIVERY_STAGES = [
  "Onboarding",
  "In Progress",
  "Live",
  "Complete",
] as const;

export const CALL_OUTCOMES = [
  { value: "no_answer", label: "No answer" },
  { value: "voicemail", label: "Voicemail" },
  { value: "gatekeeper", label: "Gatekeeper only" },
  { value: "transferred", label: "Transferred" },
  { value: "dm_conversation", label: "DM conversation" },
  { value: "appointment_set", label: "Appointment set" },
  { value: "callback", label: "Callback requested" },
  { value: "not_interested", label: "Not interested" },
  { value: "bad_number", label: "Bad number" },
  { value: "do_not_call", label: "Do not call" },
] as const;

export type CallOutcome = (typeof CALL_OUTCOMES)[number]["value"];

export const ROLE_CATEGORIES = [
  "owner",
  "founder",
  "president",
  "general_manager",
  "operations_manager",
  "office_manager",
  "phone_system_decision_maker",
  "unknown_decision_maker",
  "gatekeeper",
  "employee",
  "other",
] as const;
