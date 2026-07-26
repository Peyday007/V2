// Machine-processing status. Deliberately SEPARATE from the sales pipeline
// stage in stages.ts: pipeline_stage is where a human moved the deal,
// machine_status is where the automated engine has got to.

export const MACHINE_STATUSES = [
  "discovered",
  "normalized",
  "duplicate_review",
  "enrichment_queued",
  "enriching",
  "decision_maker_found",
  "role_only_found",
  "enrichment_failed",
  "ready_for_calling",
  "assigned_to_packet",
  "contacted",
  "archived",
] as const;

export type MachineStatus = (typeof MACHINE_STATUSES)[number];

export const MACHINE_STATUS_LABELS: Record<MachineStatus, string> = {
  discovered: "Discovered",
  normalized: "Normalized",
  duplicate_review: "Duplicate review",
  enrichment_queued: "Waiting for enrichment",
  enriching: "Enriching",
  decision_maker_found: "Decision-maker found",
  role_only_found: "Role only found",
  enrichment_failed: "Enrichment failed",
  ready_for_calling: "Ready for calling",
  assigned_to_packet: "Assigned to packet",
  contacted: "Contacted",
  archived: "Archived",
};

/** Only these leads may be pulled into a caller packet. */
export const PACKET_ELIGIBLE: MachineStatus[] = ["ready_for_calling"];

/** Statuses that mean the engine still has work to do on this lead. */
export const IN_FLIGHT: MachineStatus[] = [
  "discovered",
  "normalized",
  "enrichment_queued",
  "enriching",
];

/** Statuses at or past the point where enrichment has been requested. */
const ENRICHMENT_REQUESTED: MachineStatus[] = [
  "enrichment_queued",
  "enriching",
  "decision_maker_found",
  "role_only_found",
  "enrichment_failed",
  "ready_for_calling",
  "assigned_to_packet",
  "contacted",
];

export function isMachineStatus(v: string): v is MachineStatus {
  return (MACHINE_STATUSES as readonly string[]).includes(v);
}

export function machineStatusLabel(v: string): string {
  return isMachineStatus(v) ? MACHINE_STATUS_LABELS[v] : v;
}

/**
 * Guard against re-queueing enrichment for a lead that already has it,
 * and against reprocessing terminal leads.
 */
export function needsEnrichmentQueue(status: string): boolean {
  if (!isMachineStatus(status)) return false;
  if (status === "archived") return false;
  return !ENRICHMENT_REQUESTED.includes(status);
}

export function isPacketEligible(status: string): boolean {
  return isMachineStatus(status) && PACKET_ELIGIBLE.includes(status);
}
