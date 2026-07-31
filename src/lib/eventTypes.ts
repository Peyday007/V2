// Canonical event vocabulary. Pure data so it can be validated and tested
// without a database.
//
// Only events for workflows that ACTUALLY EXIST in the app today. Future
// types (script variants, experiments, recommendations) get added here when
// those features are built — the schema does not need to change.

export const EVENT_TYPES = [
  // lead lifecycle
  "lead.created",
  "lead.imported",
  "lead.duplicate_linked",
  "lead.updated",
  "lead.stage_changed",
  "lead.machine_status_changed",
  "lead.archived",
  "lead.unarchived",
  "lead.qualification_failed",
  "lead.suppressed",

  // enrichment
  "lead.enrichment_queued",
  "lead.enrichment_started",
  "lead.enriched",
  "lead.enrichment_failed",
  "lead.decision_maker_found",
  "lead.contact_info_changed",
  "lead.intelligence_updated",

  // campaigns
  "campaign.created",
  "campaign.planned",
  "campaign.started",
  "campaign.paused",
  "campaign.resumed",
  "campaign.stopped",
  "campaign.completed",
  "campaign.refilled",
  "import.completed",

  // packets
  "packet.created",
  "packet.assigned",
  "packet.completed",
  "lead.added_to_packet",
  "lead.removed_from_packet",

  // calls
  "call.logged",
  "call.outcome_recorded",
  "callback.scheduled",
  "appointment.booked",
  "appointment.attendance_recorded",
  "objection.raised",
  "note.added",
  "prompt.changed",

  // callers
  "caller.created",
  "caller.activated",
  "caller.deactivated",
  "caller.signed_in",

  // deals
  "deal.created",
  "deal.stage_changed",
  "deal.deleted",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const ENTITY_TYPES = [
  "lead",
  "call",
  "packet",
  "caller",
  "campaign",
  "sourcing_campaign",
  "deal",
  "callback",
  "appointment",
  "objection",
  "contact",
  "prompt",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export type ActorType = "caller" | "admin" | "system" | "worker" | "script";
export type EventSource = "ui" | "api" | "worker" | "script" | "system" | "legacy";
export type VerificationStatus =
  | "unverified"
  | "verified"
  | "corrected"
  | "disputed";

export function isKnownEventType(v: string): v is EventType {
  return (EVENT_TYPES as readonly string[]).includes(v);
}

/** Human label for the admin history view. */
export function eventLabel(type: string): string {
  return type
    .replace(/[._]/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

/** Which entity a given event type is primarily about. */
export function primaryEntityFor(type: string): EntityType | null {
  const prefix = type.split(".")[0];
  const map: Record<string, EntityType> = {
    lead: "lead",
    call: "call",
    callback: "callback",
    appointment: "appointment",
    objection: "objection",
    prompt: "prompt",
    packet: "packet",
    caller: "caller",
    campaign: "campaign",
    deal: "deal",
    note: "call",
    import: "campaign",
  };
  return map[prefix] ?? null;
}
