import { supabase } from "./supabase";
import type {
  ActorType,
  EventSource,
  VerificationStatus,
} from "./eventTypes";

/**
 * Organizational memory: the append-only record of everything meaningful
 * that happens in the system.
 *
 * Two entry points:
 *   recordEvent()  — full, typed. Use for new code.
 *   logEvent()     — the original 4-argument signature, preserved so the
 *                    31 existing call sites keep working unchanged.
 */

export type EventInput = {
  type: string;
  entityType: string;
  entityId?: string | null;

  /** Typed relationships — indexed, so history views are fast. */
  leadId?: string | null;
  campaignId?: string | null;
  packetId?: string | null;
  callId?: string | null;

  /** Who did it. */
  actorType?: ActorType;
  actorCallerId?: string | null;

  /** What changed. Kept out of `data` so before/after is queryable. */
  previousValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;

  /** Free-form context that does not deserve a column. */
  metadata?: Record<string, unknown>;

  /** Ties every event from one workflow together. */
  correlationId?: string | null;
  /** The event that caused this one. */
  causationEventId?: number | null;

  source?: EventSource;
  confidence?: number | null;
  verificationStatus?: VerificationStatus;
  /** When it actually happened, if different from now. */
  occurredAt?: Date | string | null;
};

/** A correlation id for grouping one workflow's events. */
export function newCorrelationId(): string {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toIso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : v;
}

/**
 * Write one event. Returns the new event id so a follow-up event can point
 * at it via causationEventId, or null when the write failed.
 *
 * Never throws: a memory failure must not break the user-facing action it
 * was recording. Failures are logged loudly instead of swallowed silently.
 */
export async function recordEvent(input: EventInput): Promise<number | null> {
  const row = {
    event_type: input.type,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    lead_id: input.leadId ?? null,
    campaign_id: input.campaignId ?? null,
    packet_id: input.packetId ?? null,
    call_id: input.callId ?? null,
    actor_type: input.actorType ?? "system",
    actor_caller_id: input.actorCallerId ?? null,
    previous_value: input.previousValue ?? null,
    new_value: input.newValue ?? null,
    data: input.metadata ?? {},
    correlation_id: input.correlationId ?? null,
    causation_event_id: input.causationEventId ?? null,
    source: input.source ?? "api",
    confidence: input.confidence ?? null,
    verification_status: input.verificationStatus ?? "unverified",
    occurred_at: toIso(input.occurredAt) ?? new Date().toISOString(),
  };

  try {
    const { data, error } = await supabase()
      .from("events")
      .insert(row)
      .select("id")
      .single();

    if (error) {
      // A missing column means migration 0012 has not been run. Say so
      // rather than failing mysteriously on every action.
      if (/column .* does not exist|schema cache/i.test(error.message)) {
        console.error(
          `[events] ${input.type} not recorded — the events table is missing ` +
            `columns. Run supabase/migrations/0012_event_memory.sql. (${error.message})`
        );
      } else {
        console.error(`[events] ${input.type} failed:`, error.message);
      }
      return null;
    }
    return data?.id ?? null;
  } catch (e) {
    console.error(`[events] ${input.type} threw:`, e);
    return null;
  }
}

/**
 * Original signature, kept so existing call sites are untouched.
 * Well-known keys inside `data` are promoted to their typed columns, so
 * old call sites benefit from the new indexes without being rewritten.
 */
export async function logEvent(
  eventType: string,
  entityType: string,
  entityId: string | null,
  data: Record<string, unknown> = {}
): Promise<number | null> {
  const pick = (k: string): string | null => {
    const v = data[k];
    return typeof v === "string" && v.length > 0 ? v : null;
  };

  const isUuid = (v: string | null) =>
    !!v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

  const entityUuid = isUuid(entityId) ? entityId : null;

  return recordEvent({
    type: eventType,
    entityType,
    entityId,
    leadId: entityType === "lead" ? entityUuid : pick("lead_id"),
    packetId: entityType === "packet" ? entityUuid : pick("packet_id"),
    callId: entityType === "call" ? entityUuid : pick("call_id"),
    campaignId:
      entityType === "campaign" || entityType === "sourcing_campaign"
        ? entityUuid
        : pick("campaign_id"),
    actorCallerId: entityType === "caller" ? entityUuid : pick("caller_id"),
    actorType: pick("caller_id") ? "caller" : "system",
    metadata: data,
  });
}

/**
 * Groups a set of related writes under one correlation id, and chains each
 * event to the previous one as its cause. Used for multi-step workflows
 * like logging a call, where several facts are recorded together.
 */
export function eventChain(opts?: {
  correlationId?: string;
  actorType?: ActorType;
  actorCallerId?: string | null;
  source?: EventSource;
}) {
  const correlationId = opts?.correlationId ?? newCorrelationId();
  let lastId: number | null = null;

  return {
    correlationId,
    async record(input: EventInput): Promise<number | null> {
      const id = await recordEvent({
        ...input,
        correlationId,
        causationEventId: input.causationEventId ?? lastId,
        actorType: input.actorType ?? opts?.actorType,
        actorCallerId: input.actorCallerId ?? opts?.actorCallerId ?? null,
        source: input.source ?? opts?.source,
      });
      if (id !== null) lastId = id;
      return id;
    },
  };
}

/** Diff two records, returning only what actually changed. */
export function diffValues(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  fields?: string[]
): { previous: Record<string, unknown>; next: Record<string, unknown> } | null {
  if (!before || !after) return null;
  const keys = fields ?? Object.keys(after);
  const previous: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  for (const k of keys) {
    if (before[k] !== after[k]) {
      previous[k] = before[k] ?? null;
      next[k] = after[k] ?? null;
    }
  }
  return Object.keys(next).length > 0 ? { previous, next } : null;
}
