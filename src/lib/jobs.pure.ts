// Pure job-queue helpers with no server-only imports, so they can be
// unit-tested and shared by client code.

export type JobType =
  | "plan_search_tasks"
  | "execute_places_search"
  | "continue_places_pagination"
  | "normalize_lead"
  | "qualify_lead"
  | "queue_enrichment"
  | "enrich_lead";

/** Exponential backoff with a ceiling: 30s, 60s, 120s, 240s… max 15 min. */
export function backoffSeconds(attempts: number): number {
  return Math.min(30 * Math.pow(2, Math.max(0, attempts - 1)), 900);
}

/** Deterministic idempotency key — the same logical job maps to one key. */
export function idempotencyKey(type: JobType, entityId: string): string {
  return `${type}:${entityId}`;
}
