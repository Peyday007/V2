import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Proves the memory layer records what actually happened.
 *
 * The Supabase client is stubbed so these run without a database, but the
 * assertions are on the ROWS the app tries to write — i.e. whether real
 * workflows produce accurate, correctly-shaped events.
 */

const inserted: Record<string, unknown>[] = [];
let failNext = false;

vi.mock("../src/lib/supabase", () => ({
  supabase: () => ({
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        if (table === "events") {
          if (failNext) {
            return {
              select: () => ({
                single: async () => ({
                  data: null,
                  error: { message: 'column "correlation_id" does not exist' },
                }),
              }),
            };
          }
          inserted.push(row);
        }
        return {
          select: () => ({
            single: async () => ({ data: { id: inserted.length }, error: null }),
          }),
        };
      },
    }),
  }),
}));

import {
  recordEvent,
  logEvent,
  eventChain,
  newCorrelationId,
  diffValues,
} from "../src/lib/events";
import { EVENT_TYPES, isKnownEventType, eventLabel, primaryEntityFor } from "../src/lib/eventTypes";

beforeEach(() => {
  inserted.length = 0;
  failNext = false;
});

describe("recordEvent writes a complete row", () => {
  it("stores typed relationships in their own columns, not buried in json", async () => {
    await recordEvent({
      type: "lead.enriched",
      entityType: "lead",
      entityId: "11111111-1111-1111-1111-111111111111",
      leadId: "11111111-1111-1111-1111-111111111111",
      packetId: "22222222-2222-2222-2222-222222222222",
      callId: "33333333-3333-3333-3333-333333333333",
      campaignId: "44444444-4444-4444-4444-444444444444",
      actorType: "worker",
      source: "worker",
    });
    const row = inserted[0];
    expect(row.lead_id).toBe("11111111-1111-1111-1111-111111111111");
    expect(row.packet_id).toBe("22222222-2222-2222-2222-222222222222");
    expect(row.call_id).toBe("33333333-3333-3333-3333-333333333333");
    expect(row.campaign_id).toBe("44444444-4444-4444-4444-444444444444");
    expect(row.actor_type).toBe("worker");
    expect(row.source).toBe("worker");
  });

  it("keeps previous and new values separate from free-form metadata", async () => {
    await recordEvent({
      type: "lead.stage_changed",
      entityType: "lead",
      entityId: "abc",
      previousValue: { pipeline_stage: "new_lead" },
      newValue: { pipeline_stage: "qualified" },
      metadata: { via: "call outcome dm_conversation" },
    });
    const row = inserted[0];
    expect(row.previous_value).toEqual({ pipeline_stage: "new_lead" });
    expect(row.new_value).toEqual({ pipeline_stage: "qualified" });
    expect(row.data).toEqual({ via: "call outcome dm_conversation" });
  });

  it("always stamps occurred_at", async () => {
    await recordEvent({ type: "caller.signed_in", entityType: "caller" });
    expect(inserted[0].occurred_at).toBeTruthy();
  });

  it("honours an explicit occurred_at for backdated facts", async () => {
    const when = new Date("2026-01-15T10:00:00Z");
    await recordEvent({ type: "call.logged", entityType: "call", occurredAt: when });
    expect(inserted[0].occurred_at).toBe(when.toISOString());
  });

  it("defaults verification to unverified rather than claiming certainty", async () => {
    await recordEvent({ type: "lead.created", entityType: "lead" });
    expect(inserted[0].verification_status).toBe("unverified");
  });

  it("records confidence when the caller supplies it", async () => {
    await recordEvent({
      type: "lead.decision_maker_found",
      entityType: "lead",
      confidence: 0.9,
      verificationStatus: "verified",
    });
    expect(inserted[0].confidence).toBe(0.9);
    expect(inserted[0].verification_status).toBe("verified");
  });
});

describe("a memory failure never breaks the action it was recording", () => {
  it("returns null instead of throwing when the insert fails", async () => {
    failNext = true;
    const id = await recordEvent({ type: "lead.created", entityType: "lead" });
    expect(id).toBeNull();
  });

  it("names the missing migration when columns are absent", async () => {
    failNext = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await recordEvent({ type: "lead.created", entityType: "lead" });
    expect(spy.mock.calls.flat().join(" ")).toContain("0012_event_memory.sql");
    spy.mockRestore();
  });
});

describe("the original logEvent signature still works", () => {
  it("accepts the old four-argument form", async () => {
    await logEvent("caller.created", "caller", "55555555-5555-5555-5555-555555555555", {
      name: "Jack",
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].event_type).toBe("caller.created");
    expect(inserted[0].data).toEqual({ name: "Jack" });
  });

  it("promotes the entity id into its typed column", async () => {
    const id = "66666666-6666-6666-6666-666666666666";
    await logEvent("lead.created", "lead", id, {});
    expect(inserted[0].lead_id).toBe(id);
  });

  it("promotes ids that were previously buried in the payload", async () => {
    await logEvent("packet.created", "packet", "77777777-7777-7777-7777-777777777777", {
      caller_id: "88888888-8888-8888-8888-888888888888",
      campaign_id: "99999999-9999-9999-9999-999999999999",
    });
    const row = inserted[0];
    expect(row.packet_id).toBe("77777777-7777-7777-7777-777777777777");
    expect(row.actor_caller_id).toBe("88888888-8888-8888-8888-888888888888");
    expect(row.campaign_id).toBe("99999999-9999-9999-9999-999999999999");
  });

  it("does not mistake a non-uuid entity id for a foreign key", async () => {
    await logEvent("import.completed", "campaign", "not-a-uuid", {});
    expect(inserted[0].campaign_id).toBeNull();
    expect(inserted[0].entity_id).toBe("not-a-uuid");
  });
});

describe("correlation chains group one workflow", () => {
  it("gives every event in a call the same correlation id", async () => {
    const chain = eventChain({ actorType: "caller", actorCallerId: "caller-1" });
    await chain.record({ type: "call.outcome_recorded", entityType: "call" });
    await chain.record({ type: "callback.scheduled", entityType: "callback" });
    await chain.record({ type: "lead.intelligence_updated", entityType: "lead" });

    const ids = new Set(inserted.map((r) => r.correlation_id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBe(chain.correlationId);
  });

  it("links each event to the one that caused it", async () => {
    const chain = eventChain();
    await chain.record({ type: "call.outcome_recorded", entityType: "call" });
    await chain.record({ type: "appointment.booked", entityType: "appointment" });

    expect(inserted[0].causation_event_id).toBeNull();
    expect(inserted[1].causation_event_id).toBe(1);
  });

  it("carries the actor through the whole chain", async () => {
    const chain = eventChain({ actorType: "caller", actorCallerId: "caller-9" });
    await chain.record({ type: "call.outcome_recorded", entityType: "call" });
    await chain.record({ type: "lead.suppressed", entityType: "lead" });
    for (const row of inserted) {
      expect(row.actor_type).toBe("caller");
      expect(row.actor_caller_id).toBe("caller-9");
    }
  });

  it("produces distinct ids for separate workflows", () => {
    expect(newCorrelationId()).not.toBe(newCorrelationId());
  });
});

describe("diffValues records only what changed", () => {
  it("returns just the changed fields", () => {
    const d = diffValues(
      { owner_name: null, best_call_time: "9am" },
      { owner_name: "Mike Reynolds", best_call_time: "9am" }
    );
    expect(d).toEqual({
      previous: { owner_name: null },
      next: { owner_name: "Mike Reynolds" },
    });
  });

  it("returns null when nothing changed", () => {
    expect(diffValues({ a: 1 }, { a: 1 })).toBeNull();
  });

  it("handles a missing before or after", () => {
    expect(diffValues(null, { a: 1 })).toBeNull();
    expect(diffValues({ a: 1 }, null)).toBeNull();
  });
});

describe("the event vocabulary covers the workflows that exist", () => {
  it("includes every workflow wired in this milestone", () => {
    for (const t of [
      "lead.created",
      "lead.duplicate_linked",
      "lead.enrichment_queued",
      "lead.enrichment_started",
      "lead.enriched",
      "lead.enrichment_failed",
      "lead.decision_maker_found",
      "lead.contact_info_changed",
      "lead.intelligence_updated",
      "lead.stage_changed",
      "lead.archived",
      "lead.suppressed",
      "lead.added_to_packet",
      "packet.created",
      "packet.assigned",
      "packet.completed",
      "call.outcome_recorded",
      "callback.scheduled",
      "appointment.booked",
      "caller.created",
      "caller.signed_in",
      "caller.deactivated",
      "campaign.started",
      "campaign.completed",
    ]) {
      expect(isKnownEventType(t), t).toBe(true);
    }
  });

  it("does not invent types for features that do not exist yet", () => {
    for (const t of [
      "script.changed",
      "experiment.started",
      "recommendation.generated",
      "sale.created",
      "objection.detected",
    ]) {
      expect(isKnownEventType(t), t).toBe(false);
    }
  });

  it("has no duplicates", () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });

  it("maps each event to the entity it is about", () => {
    expect(primaryEntityFor("lead.enriched")).toBe("lead");
    expect(primaryEntityFor("packet.assigned")).toBe("packet");
    expect(primaryEntityFor("callback.scheduled")).toBe("callback");
    expect(primaryEntityFor("nonsense.thing")).toBeNull();
  });

  it("renders a readable label", () => {
    expect(eventLabel("lead.decision_maker_found")).toBe("Lead decision maker found");
  });
});
