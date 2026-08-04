// Pure job-queue helpers with no server-only imports, so they can be
// unit-tested and shared by client code.

export type JobType =
  | "plan_search_tasks"
  | "execute_places_search"
  | "continue_places_pagination"
  | "normalize_lead"
  | "qualify_lead"
  | "queue_enrichment"
  | "enrich_lead"
  | "enrich_owner_contact"
  | "auto_assign_packets"
  // Keeps the Instantly campaign topped up without anybody pressing a button.
  // Only does anything when an administrator has switched auto_push_enabled
  // on; otherwise it reads the settings, decides "no", and completes.
  | "refill_email_campaign"
  // Reads the sending inboxes, recomputes how many leads a day they can carry,
  // and — only when an administrator switched that on — nudges warmed-up
  // accounts toward their ceiling.
  | "sync_sending_accounts"
  // Rebuilds what the house knows from every outcome across every channel.
  // Nothing acts on a prior until it clears the sample floor, so this getting
  // behind costs sharpness, never correctness.
  | "recompute_house_knowledge";

/** Exponential backoff with a ceiling: 30s, 60s, 120s, 240s… max 15 min. */
export function backoffSeconds(attempts: number): number {
  return Math.min(30 * Math.pow(2, Math.max(0, attempts - 1)), 900);
}

/** Deterministic idempotency key — the same logical job maps to one key. */
export function idempotencyKey(type: JobType, entityId: string): string {
  return `${type}:${entityId}`;
}
