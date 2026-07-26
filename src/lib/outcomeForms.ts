// What each outcome must capture. Pure data so the dialer UI and the
// server-side validation cannot drift apart.

export type FieldType = "text" | "textarea" | "select" | "date" | "time" | "checkbox";

export type OutcomeField = {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
  /** Only show when another field has one of these values. */
  showIf?: { field: string; equals: string[] };
  placeholder?: string;
};

export type OutcomeForm = {
  value: string;
  label: string;
  /** Short note shown at the top of the form. */
  hint?: string;
  /** Caller must tick this before saving. */
  confirmation?: string;
  fields: OutcomeField[];
};

const YES_NO = ["Yes", "No"];

export const OUTCOME_FORMS: OutcomeForm[] = [
  {
    value: "no_answer",
    label: "No answer",
    hint: "Attempt is counted and the lead is rescheduled into a different calling window.",
    fields: [
      {
        name: "what_happened",
        label: "What happened",
        type: "select",
        options: [
          "Rang with no answer",
          "Call disconnected",
          "Business appeared closed",
          "Other",
        ],
      },
      { name: "note", label: "Note (optional)", type: "textarea" },
    ],
  },
  {
    value: "voicemail",
    label: "Voicemail",
    fields: [
      {
        name: "voicemail_left",
        label: "Voicemail left?",
        type: "select",
        options: YES_NO,
        required: true,
      },
      {
        name: "message_type",
        label: "Message type used",
        type: "select",
        options: ["First touch", "Follow-up", "Value/benefit", "Callback request", "Other"],
        showIf: { field: "voicemail_left", equals: ["Yes"] },
      },
      { name: "note", label: "Note (optional)", type: "textarea" },
    ],
  },
  {
    value: "gatekeeper",
    label: "Gatekeeper only",
    hint: "Anything learned here permanently updates the lead for every future caller.",
    fields: [
      {
        name: "gatekeeper_name",
        label: "Gatekeeper name",
        type: "text",
        required: true,
        placeholder: "or type: Name not provided",
      },
      {
        name: "owner_identified",
        label: "Was the owner identified?",
        type: "select",
        options: YES_NO,
        required: true,
      },
      {
        name: "owner_name",
        label: "Owner name",
        type: "text",
        required: true,
        showIf: { field: "owner_identified", equals: ["Yes"] },
      },
      { name: "best_call_day", label: "Best day to reach the owner", type: "text" },
      { name: "best_call_time", label: "Best time to reach the owner", type: "text" },
      { name: "extension", label: "Extension", type: "text" },
      { name: "direct_number", label: "Direct number", type: "text" },
      {
        name: "gatekeeper_said",
        label: "What the gatekeeper said",
        type: "textarea",
        required: true,
      },
    ],
  },
  {
    value: "transferred",
    label: "Transferred",
    hint: "If the owner picked up, log this as a Decision-maker conversation instead.",
    fields: [
      { name: "transferred_to_name", label: "Transferred to (name)", type: "text", required: true },
      { name: "transferred_to_role", label: "Their role", type: "text", required: true },
      {
        name: "transfer_connected",
        label: "Did the transfer connect?",
        type: "select",
        options: YES_NO,
        required: true,
      },
      { name: "what_happened", label: "What happened after the transfer", type: "textarea", required: true },
    ],
  },
  {
    value: "dm_conversation",
    label: "Decision-maker conversation",
    hint: "Only use this when you actually spoke with the owner or a confirmed decision-maker.",
    confirmation: "I spoke with the owner or a confirmed decision-maker.",
    fields: [
      { name: "dm_name", label: "Decision-maker name", type: "text", required: true },
      {
        name: "dm_role",
        label: "Role",
        type: "select",
        required: true,
        options: [
          "Owner",
          "Co-owner",
          "General manager",
          "Office manager",
          "Operations manager",
          "Other",
        ],
      },
      {
        name: "answering_setup",
        label: "Current call-answering situation",
        type: "select",
        required: true,
        options: [
          "Owner answers most calls",
          "Office staff answers",
          "Calls go to voicemail",
          "Uses an answering service",
          "Uses another AI receptionist",
          "Unsure",
          "Other",
        ],
      },
      {
        name: "main_problem",
        label: "Main problem discovered",
        type: "select",
        required: true,
        options: [
          "Missed calls",
          "After-hours calls",
          "Staff interruptions",
          "Slow callback times",
          "Scheduling problems",
          "Lead follow-up problems",
          "No major problem identified",
          "Other",
        ],
      },
      {
        name: "interest_level",
        label: "Interest level",
        type: "select",
        required: true,
        options: ["Strong interest", "Mild interest", "Unsure", "Not interested"],
      },
      { name: "objection", label: "Objection or concern", type: "text" },
      { name: "next_step", label: "Agreed next step", type: "text", required: true },
      { name: "note", label: "Notes", type: "textarea" },
    ],
  },
  {
    value: "callback",
    label: "Callback requested",
    hint: "A callback is not an appointment. This returns the lead to you at the agreed time.",
    fields: [
      { name: "requested_by_name", label: "Who requested it (name)", type: "text", required: true },
      {
        name: "requested_by_role",
        label: "Their role",
        type: "select",
        required: true,
        options: ["Owner", "Gatekeeper", "Office staff", "Other", "Unknown"],
      },
      { name: "callback_date", label: "Callback date", type: "date", required: true },
      { name: "callback_time", label: "Callback time", type: "time", required: true },
      { name: "reason", label: "Reason for the callback", type: "text", required: true },
      { name: "note", label: "Notes", type: "textarea" },
    ],
  },
  {
    value: "appointment_set",
    label: "Appointment set",
    hint: "Only for a confirmed decision-maker who agreed to a specific date and time.",
    confirmation:
      "I spoke with the owner or a confirmed decision-maker, and they agreed to a specific meeting date and time.",
    fields: [
      { name: "dm_name", label: "Decision-maker name", type: "text", required: true },
      {
        name: "dm_role",
        label: "Confirmed role",
        type: "select",
        required: true,
        options: ["Owner", "Co-owner", "General manager", "Operations manager", "Other"],
      },
      { name: "appt_date", label: "Appointment date", type: "date", required: true },
      { name: "appt_time", label: "Appointment time", type: "time", required: true },
      {
        name: "timezone",
        label: "Time zone",
        type: "select",
        required: true,
        options: ["Eastern", "Central", "Mountain", "Pacific", "Alaska", "Hawaii"],
      },
      { name: "phone", label: "Phone number", type: "text", required: true },
      { name: "email", label: "Email (if available)", type: "text" },
      { name: "product", label: "Product discussed", type: "text", required: true },
      { name: "meeting_reason", label: "Reason for the meeting", type: "text", required: true },
      { name: "pain_point", label: "Main pain point", type: "text", required: true },
      {
        name: "confirmation_method",
        label: "Confirmation method",
        type: "select",
        required: true,
        options: ["Email", "Text message", "Calendar invite", "Verbal only"],
      },
      { name: "note", label: "Notes for whoever takes the appointment", type: "textarea" },
    ],
  },
  {
    value: "not_interested",
    label: "Not interested",
    hint: "A gatekeeper brush-off is not the same as an owner saying no.",
    fields: [
      {
        name: "said_by_role",
        label: "Who said they were not interested?",
        type: "select",
        required: true,
        options: ["Owner / decision-maker", "Gatekeeper", "Employee", "Unknown"],
      },
      { name: "said_by_name", label: "Their name (if known)", type: "text" },
      {
        name: "gatekeeper_has_authority",
        label: "Did they confirm they decide this?",
        type: "select",
        options: YES_NO,
        showIf: { field: "said_by_role", equals: ["Gatekeeper", "Employee", "Unknown"] },
      },
      {
        name: "reason",
        label: "Reason",
        type: "select",
        required: true,
        options: [
          "Already has a solution",
          "Owner handles calls personally",
          "No missed-call problem",
          "Too expensive",
          "Does not trust AI",
          "Bad timing",
          "Needs more information",
          "Corporate/franchise decision",
          "Gatekeeper rejected the call",
          "Other",
        ],
      },
      {
        name: "try_again",
        label: "Should we try again later?",
        type: "select",
        options: YES_NO,
        required: true,
      },
      {
        name: "follow_up_date",
        label: "Follow-up date",
        type: "date",
        showIf: { field: "try_again", equals: ["Yes"] },
      },
      { name: "note", label: "Notes", type: "textarea" },
    ],
  },
  {
    value: "bad_number",
    label: "Bad number",
    hint: "Marks the phone number invalid. The company record is kept.",
    fields: [
      {
        name: "reason",
        label: "What was wrong?",
        type: "select",
        required: true,
        options: [
          "Disconnected",
          "Wrong business",
          "Number belongs to another person",
          "Fax line",
          "Other",
        ],
      },
      { name: "note", label: "Note", type: "textarea" },
    ],
  },
  {
    value: "do_not_call",
    label: "Do not call",
    hint: "Suppresses this company for every caller, immediately and permanently.",
    confirmation: "They explicitly asked not to be contacted again.",
    fields: [
      {
        name: "requested_by",
        label: "Who requested it?",
        type: "select",
        required: true,
        options: ["Owner / decision-maker", "Employee", "Unknown"],
      },
      { name: "reason", label: "Reason", type: "text", required: true },
      { name: "note", label: "Note", type: "textarea" },
    ],
  },
];

export const OUTCOME_FORM_MAP: Record<string, OutcomeForm> = Object.fromEntries(
  OUTCOME_FORMS.map((f) => [f.value, f])
);

/** Should this field be shown, given what's filled in so far? */
export function fieldVisible(
  field: OutcomeField,
  values: Record<string, string>
): boolean {
  if (!field.showIf) return true;
  return field.showIf.equals.includes(values[field.showIf.field] || "");
}

/** Names of required fields that are still empty. Used by UI and server. */
export function missingRequired(
  outcome: string,
  values: Record<string, string>
): string[] {
  const form = OUTCOME_FORM_MAP[outcome];
  if (!form) return [];
  return form.fields
    .filter((f) => f.required && fieldVisible(f, values))
    .filter((f) => !String(values[f.name] || "").trim())
    .map((f) => f.label);
}

/** Outcomes that mean we actually reached a decision-maker. */
export const DM_REACHED_OUTCOMES = ["dm_conversation", "appointment_set"];
