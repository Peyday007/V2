// SINGLE SOURCE OF TRUTH for pipeline stages.
//
// The database stores the canonical snake_case key (leads.pipeline_stage).
// The UI never stores or compares display text. If you add a stage, add it
// here and nowhere else.

export const SALES_STAGES = [
  "new_lead",
  "contact_attempted",
  "qualified",
  "discovery_booked",
  "discovery_completed",
  "proposal_sent",
  "won",
  "lost",
] as const;

export type SalesStage = (typeof SALES_STAGES)[number];

export const STAGE_LABELS: Record<SalesStage, string> = {
  new_lead: "New Lead",
  contact_attempted: "Contact Attempted",
  qualified: "Qualified",
  discovery_booked: "Discovery Booked",
  discovery_completed: "Discovery Completed",
  proposal_sent: "Proposal Sent",
  won: "Won",
  lost: "Lost",
};

export const DEFAULT_STAGE: SalesStage = "new_lead";

/** Stages that mean the lead is finished — no forward advance from here. */
export const TERMINAL_STAGES: SalesStage[] = ["won", "lost"];

const ALIASES: Record<string, SalesStage> = {
  // canonical
  new_lead: "new_lead",
  contact_attempted: "contact_attempted",
  qualified: "qualified",
  discovery_booked: "discovery_booked",
  discovery_completed: "discovery_completed",
  proposal_sent: "proposal_sent",
  won: "won",
  lost: "lost",
  // legacy display text and historical variants
  new: "new_lead",
  lead: "new_lead",
  contacted: "contact_attempted",
  contact: "contact_attempted",
  attempted: "contact_attempted",
  appointment: "discovery_booked",
  appointment_set: "discovery_booked",
  discovery: "discovery_booked",
  demo_booked: "discovery_booked",
  proposal: "proposal_sent",
  closed_won: "won",
  closed_lost: "lost",
  dead: "lost",
  disqualified: "lost",
  do_not_call: "lost",
};

/**
 * Convert any historical/display value into a canonical stage.
 * Returns null when the value is unrecognized, so callers can flag it
 * instead of silently hiding the lead.
 */
export function normalizeStage(raw: string | null | undefined): SalesStage | null {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase().replace(/[\s-]+/g, "_");
  return ALIASES[key] ?? null;
}

/** Normalize, falling back to new_lead so a lead is never stageless. */
export function coerceStage(raw: string | null | undefined): SalesStage {
  return normalizeStage(raw) ?? DEFAULT_STAGE;
}

export function isSalesStage(value: string): value is SalesStage {
  return (SALES_STAGES as readonly string[]).includes(value);
}

export function stageLabel(stage: string): string {
  const canonical = normalizeStage(stage);
  return canonical ? STAGE_LABELS[canonical] : stage;
}

/** Index used to decide whether a call outcome moves a lead forward. */
export function stageIndex(stage: SalesStage): number {
  return SALES_STAGES.indexOf(stage);
}

/** Call outcome -> the stage that outcome implies. */
export const STAGE_FOR_OUTCOME: Record<string, SalesStage> = {
  no_answer: "contact_attempted",
  voicemail: "contact_attempted",
  gatekeeper: "contact_attempted",
  transferred: "contact_attempted",
  callback: "contact_attempted",
  dm_conversation: "qualified",
  appointment_set: "discovery_booked",
  not_interested: "lost",
  bad_number: "lost",
  do_not_call: "lost",
};

/**
 * Where a lead should end up after an outcome.
 * Never moves a lead backwards; terminal outcomes always win.
 */
export function nextStageAfterOutcome(
  current: SalesStage,
  outcome: string
): SalesStage | null {
  const target = STAGE_FOR_OUTCOME[outcome];
  if (!target) return null;
  if (TERMINAL_STAGES.includes(target)) return target === current ? null : target;
  if (TERMINAL_STAGES.includes(current)) return null;
  return stageIndex(target) > stageIndex(current) ? target : null;
}
