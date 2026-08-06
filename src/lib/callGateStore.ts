import "server-only";
import { supabaseAdmin } from "./supabaseAdmin";
import { recordEvent } from "./events";
import { decideGate, type CallRecord, type GateDecision } from "./callGate";

/*
 * The gate, on the server, in front of the real production path.
 *
 * The decision logic in callGate.ts is pure and testable. This is the half
 * that makes it real: it reads what actually happened, and /api/dial/next
 * refuses to hand over a lead when the answer is no.
 *
 * WHY THE SERVER AND ONLY THE SERVER: a gate the browser enforces is a
 * suggestion. Refreshing the page, opening a second tab, or calling the
 * endpoint directly would all walk straight past it, and the one thing this
 * feature exists to prevent — a shift of calls with nothing recorded — is
 * exactly what somebody does when the prompt is annoying. The lead is withheld
 * at source, so there is nothing to bypass.
 *
 * WHAT COUNTS AS A SESSION: calls made by this caller since local midnight.
 * There is no session table and inventing one would be a bigger change than
 * this needs; a day is the unit the team already thinks in ("done today" is
 * already on the dialler), and thresholds reset with it.
 */

/** Failed saves, which are the system's fault and must never count against a caller. */
const SAVE_FAILED_EVENT = "call.save_failed";

export type GateState = GateDecision & {
  /** How many calls the decision was made from, for the audit trail. */
  consideredCalls: number;
  /** True when the gate could not be evaluated — see loadGate. */
  unknown: boolean;
};

/**
 * Evaluate the gate for one caller, now.
 *
 * NEVER BLOCKS ON IGNORANCE. If the calls cannot be read, or the settings
 * cannot be read, the caller keeps working. A control that stops the phones
 * because a query failed converts a database blip into an outage, and the
 * failure it is guarding against — a wasted shift — is smaller than that.
 */
export async function loadGate(callerId: string): Promise<GateState> {
  const open = (over: Partial<GateState> = {}): GateState => ({
    level: "clear",
    mayDial: true,
    message: "",
    callIds: [],
    next: null,
    liftedBy: null,
    systemFault: false,
    consideredCalls: 0,
    unknown: false,
    ...over,
  });

  const db = supabaseAdmin();
  const since = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

  let enabled = true;
  try {
    const { data } = await db
      .from("call_intelligence_settings")
      .select("after_call_gate_enabled")
      .eq("id", true)
      .maybeSingle();
    // Absent column (0039 not run) reads as ON by design: the directive's
    // default behaviour is enforcement, and a missing setting must not
    // silently disable a safety control.
    if (data && data.after_call_gate_enabled === false) enabled = false;
  } catch {
    // Unreadable settings leave it on, for the same reason.
  }

  let calls: CallRecord[] = [];
  try {
    const { data, error } = await db
      .from("calls")
      .select("id, outcome, notes, next_step, duration_seconds, created_at")
      .eq("caller_id", callerId)
      .gte("created_at", since)
      .order("created_at")
      .limit(500);
    if (error) return open({ unknown: true });
    calls = (data || []).map((c) => ({
      id: String(c.id),
      outcome: c.outcome ?? null,
      notes: c.notes ?? null,
      nextStep: c.next_step ?? null,
      durationSeconds: c.duration_seconds ?? null,
      createdAt: String(c.created_at),
    }));
  } catch {
    return open({ unknown: true });
  }

  /*
   * Saves that never became rows.
   *
   * A failed insert leaves no call to inspect, so the only trace is the event
   * written when it failed. Without this the system's own outage would look
   * like a caller who simply stopped logging work — the precise
   * misattribution rule 1 exists to prevent.
   */
  try {
    const { data } = await db
      .from("events")
      .select("id, occurred_at")
      .eq("event_type", SAVE_FAILED_EVENT)
      .eq("actor_caller_id", callerId)
      .gte("occurred_at", since)
      .limit(100);
    for (const e of data || []) {
      calls.push({
        id: `save-failure-${e.id}`,
        outcome: null,
        notes: null,
        nextStep: null,
        durationSeconds: null,
        createdAt: String(e.occurred_at),
        saveFailed: true,
      });
    }
    calls.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch {
    // No failure history is not a reason to stop; it only means the gate
    // cannot credit the system for a fault it cannot see.
  }

  const decision = decideGate({ calls, enabled });
  return { ...decision, consideredCalls: calls.length, unknown: false };
}

/** A save that never became a row. Recorded so the gate can tell whose fault it was. */
export async function recordSaveFailure(input: {
  callerId: string;
  leadId: string | null;
  reason: string;
}): Promise<void> {
  await recordEvent({
    type: SAVE_FAILED_EVENT,
    entityType: "call",
    entityId: input.leadId,
    leadId: input.leadId,
    actorType: "system",
    actorCallerId: input.callerId,
    source: "api",
    newValue: { reason: input.reason },
    metadata: {
      area: "after_call_gate",
      note: "The outcome could not be saved. This is a system fault and must not count against the caller.",
    },
    verificationStatus: "verified",
  });
}

/**
 * Write down that the gate stopped somebody, so it can be reconstructed later.
 *
 * Only on a block. Recording every "carry on" would be one row per call for
 * no benefit, and the audit question is always about the times it acted.
 */
export async function recordGateAction(callerId: string, decision: GateState): Promise<void> {
  if (decision.mayDial) return;
  await recordEvent({
    type: "call.gate_blocked",
    entityType: "caller",
    entityId: callerId,
    actorType: "system",
    actorCallerId: callerId,
    source: "api",
    newValue: {
      level: decision.level,
      call_ids: decision.callIds,
      system_fault: decision.systemFault,
      lifted_by: decision.liftedBy,
    },
    metadata: {
      area: "after_call_gate",
      message: decision.message,
      considered_calls: decision.consideredCalls,
    },
    verificationStatus: "verified",
  });
}
