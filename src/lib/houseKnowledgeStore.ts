import "server-only";
import { supabaseAdmin } from "./supabaseAdmin";
import { isMissingColumnError } from "./enrichmentGrade";
import {
  buildKnowledge,
  appliedPriors,
  EMPTY_KNOWLEDGE,
  type HouseKnowledge,
  type OutcomeFact,
} from "./houseKnowledge";

// Gathering the evidence, and handing the knowledge back out.
//
// The gathering is the interesting half. Every channel records outcomes in its
// own table with its own vocabulary — a call has an outcome string, an email
// has an event type, a packet has a status — and the whole point of the
// ecosystem is that they are the same kind of evidence about the same
// questions. This is where they become one shape.
//
// Everything degrades. A missing table means the migration has not been run,
// and the correct behaviour is empty knowledge — under which every prior is
// inert and every tool falls back to its starting assumptions. That is exactly
// how the system behaved before this existed, so a missing migration costs the
// learning and nothing else.

const CACHE_MS = 5 * 60_000;
let cached: { at: number; knowledge: HouseKnowledge } | null = null;

/* -------------------------------------------------------------------------- */
/* settings                                                                   */
/* -------------------------------------------------------------------------- */

export type LearningSettings = {
  applyLearning: boolean;
  minSamples: number;
  explorationFloor: number;
  lastComputedAt: string | null;
};

export const LEARNING_DEFAULTS: LearningSettings = {
  // True by default. With no evidence every prior is inert, so this changes
  // nothing until the system has earned it — which is the right moment for it
  // to already be on.
  applyLearning: true,
  minSamples: 30,
  explorationFloor: 0.2,
  lastComputedAt: null,
};

export async function loadLearningSettings(): Promise<LearningSettings> {
  try {
    const { data, error } = await supabaseAdmin()
      .from("learning_settings")
      .select("apply_learning, min_samples, exploration_floor, last_computed_at")
      .eq("id", true)
      .maybeSingle();
    if (error || !data) return LEARNING_DEFAULTS;
    return {
      applyLearning: data.apply_learning !== false,
      minSamples: Number(data.min_samples ?? LEARNING_DEFAULTS.minSamples),
      explorationFloor: Number(data.exploration_floor ?? LEARNING_DEFAULTS.explorationFloor),
      lastComputedAt: data.last_computed_at ?? null,
    };
  } catch {
    return LEARNING_DEFAULTS;
  }
}

/* -------------------------------------------------------------------------- */
/* gathering                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Everything that has happened, flattened into one shape.
 *
 * Reads three channels and joins each back to the lead so an outcome can be
 * attributed to an industry, a size band and — the part that makes the
 * diagnostic able to learn at all — the angles the lead was actually
 * approached with.
 */
export async function gatherFacts(limit = 20000): Promise<OutcomeFact[]> {
  const db = supabaseAdmin();
  const facts: OutcomeFact[] = [];

  /*
   * The lead side, once.
   *
   * Every channel needs the same handful of lead attributes, and joining them
   * per channel would mean three passes over the same rows plus three chances
   * to describe a lead differently.
   */
  const leadIndex = new Map<
    string,
    { industry: string | null; state: string | null; band: string | null; angles: string[] }
  >();
  try {
    const columnTiers = [
      "id, industry, state, affordability_band, approached_with, diagnostic_findings",
      "id, industry, state, affordability_band, diagnostic_findings",
      "id, industry, state",
    ];
    for (const columns of columnTiers) {
      const res = await db.from("leads").select(columns).limit(50000);
      if (res.error) {
        if (isMissingColumnError(res.error)) continue;
        break;
      }
      for (const raw of res.data || []) {
        const row = raw as unknown as Record<string, unknown>;
        // Prefer what was actually said on the approach; fall back to what the
        // diagnostic proposed. The two differ when a caller went off-script,
        // and the first is the honest attribution.
        const approached = Array.isArray(row.approached_with) ? (row.approached_with as string[]) : null;
        const findings = Array.isArray(row.diagnostic_findings)
          ? (row.diagnostic_findings as { service?: string }[])
              .map((f) => f?.service)
              .filter((s): s is string => !!s)
          : [];
        leadIndex.set(String(row.id), {
          industry: (row.industry as string) ?? null,
          state: (row.state as string) ?? null,
          band: (row.affordability_band as string) ?? null,
          angles: approached ?? findings,
        });
      }
      break;
    }
  } catch {
    // No lead context is survivable: the facts still carry channel and outcome,
    // so the script and timing priors work and the rest stay unknown.
  }

  const lead = (id: unknown) => leadIndex.get(String(id ?? ""));

  /* -------------------------------- calls --------------------------------- */
  try {
    const { data, error } = await db
      .from("calls")
      .select(
        "lead_id, outcome, reached_dm, script_version, script_overridden, dialed_hour, dialed_dow, created_at"
      )
      .order("created_at", { ascending: false })
      .limit(limit);
    if (!error) {
      for (const c of data || []) {
        const l = lead(c.lead_id);
        facts.push({
          channel: "call",
          at: c.created_at,
          industry: l?.industry ?? null,
          state: l?.state ?? null,
          sizeBand: l?.band ?? null,
          angles: l?.angles ?? null,
          scriptVersion: c.script_version ?? null,
          scriptOverridden: (c as { script_overridden?: boolean }).script_overridden ?? false,
          hour: typeof c.dialed_hour === "number" ? c.dialed_hour : null,
          dayOfWeek: typeof c.dialed_dow === "number" ? c.dialed_dow : null,
          reachedDecisionMaker: c.reached_dm === null ? null : !!c.reached_dm,
          // What "worked" means for a call. Deliberately the commercial
          // outcome and not "they were polite".
          converted: CONVERTING_OUTCOMES.has(String(c.outcome || "")),
          estimatedBand: l?.band ?? null,
        });
      }
    }
  } catch {
    /* a channel that cannot be read contributes nothing, and says so via
       blindSpots rather than by poisoning the averages */
  }

  /* -------------------------------- email --------------------------------- */
  try {
    const { data, error } = await db
      .from("email_events")
      .select("lead_id, event_type, occurred_at")
      .order("occurred_at", { ascending: false })
      .limit(limit);
    if (!error) {
      for (const e of data || []) {
        // Only terminal-ish events are evidence. An "opened" says nothing
        // about whether the angle worked, and counting it as a failure would
        // drown every real signal in noise.
        const type = String(e.event_type || "");
        if (!["replied", "bounced", "unsubscribed"].includes(type)) continue;
        const l = lead(e.lead_id);
        facts.push({
          channel: "email",
          at: e.occurred_at,
          industry: l?.industry ?? null,
          state: l?.state ?? null,
          sizeBand: l?.band ?? null,
          angles: l?.angles ?? null,
          converted: type === "replied",
          estimatedBand: l?.band ?? null,
        });
      }
    }
  } catch {
    /* same */
  }

  /* ------------------------------- packets -------------------------------- */
  try {
    const { data, error } = await db
      .from("workshop_packets")
      .select("lead_id, status, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (!error) {
      for (const p of data || []) {
        const l = lead(p.lead_id);
        facts.push({
          channel: "packet",
          at: p.created_at,
          industry: l?.industry ?? null,
          state: l?.state ?? null,
          sizeBand: l?.band ?? null,
          angles: l?.angles ?? null,
          // The packet's whole job is to turn a conversation into a trial.
          converted: String(p.status) === "trial_requested",
          estimatedBand: l?.band ?? null,
        });
      }
    }
  } catch {
    /* same */
  }

  /* ------------------------- what deals were worth ------------------------ */
  try {
    const { data } = await db
      .from("deals")
      .select("lead_id, closed_value_cents, stage")
      .not("closed_value_cents", "is", null)
      .limit(5000);
    const values = new Map<string, number>();
    for (const d of data || []) {
      if (typeof d.closed_value_cents === "number") {
        values.set(String(d.lead_id), d.closed_value_cents / 100);
      }
    }
    /*
     * One fact per closed deal, carrying what it was worth.
     *
     * A deal is not a fourth observation of the same lead — it is what the
     * observation turned out to be worth — but the only consumer of
     * actualDealValue is the band calibration, which counts deals rather than
     * attempts. Adding it as its own fact keeps the conversion rates
     * unpolluted while still giving the calibration something to read.
     */
    for (const [leadId, value] of values) {
      const l = leadIndex.get(leadId);
      if (!l) continue;
      facts.push({
        channel: "packet",
        at: new Date().toISOString(),
        industry: l.industry,
        state: l.state,
        sizeBand: l.band,
        angles: null, // already counted against the angles by the packet fact
        converted: true,
        estimatedBand: l.band,
        actualDealValue: value,
      });
    }
  } catch {
    /* deal values are for calibration only; their absence costs nothing else */
  }

  return facts;
}

/* -------------------------------------------------------------------------- */
/* what "worked" means                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Call outcomes that count as the thing working.
 *
 * Deliberately narrow. "Interested" is not a conversion — it is a feeling
 * somebody had on a phone call, and a learning system trained on it optimises
 * for calls that feel good rather than calls that produce business.
 */
export const CONVERTING_OUTCOMES = new Set([
  "appointment_set",
  "trial_agreed",
  "demo_booked",
  "closed_won",
  "sale",
]);

/* -------------------------------------------------------------------------- */
/* reading and writing                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The current knowledge.
 *
 * Cached in memory for five minutes. This is read on the hot path — every
 * packet build, every diagnosis, every dial — and recomputing from twenty
 * thousand rows each time would make the learning layer the slowest thing in
 * the application, which is a good way for somebody to switch it off.
 */
export async function currentKnowledge(force = false): Promise<HouseKnowledge> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.knowledge;

  try {
    const { data, error } = await supabaseAdmin()
      .from("house_knowledge")
      .select("knowledge, computed_at")
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data?.knowledge) {
      cached = { at: Date.now(), knowledge: EMPTY_KNOWLEDGE };
      return EMPTY_KNOWLEDGE;
    }
    const knowledge = data.knowledge as HouseKnowledge;
    cached = { at: Date.now(), knowledge };
    return knowledge;
  } catch {
    // Empty knowledge means every prior is inert and every tool uses its
    // starting assumptions — which is how the system worked before this
    // existed. A learning layer that can take the app down is worse than no
    // learning layer.
    return EMPTY_KNOWLEDGE;
  }
}

/** Recompute from scratch and store a new snapshot. */
export async function recomputeKnowledge(): Promise<HouseKnowledge> {
  const facts = await gatherFacts();
  const knowledge = buildKnowledge(facts);

  try {
    const db = supabaseAdmin();
    await db.from("house_knowledge").insert({
      knowledge,
      total_facts: knowledge.totalFacts,
      applied_priors: appliedPriors(knowledge).length,
      blind_spots: knowledge.blindSpots.length,
    });
    await db
      .from("learning_settings")
      .update({ last_computed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", true);
  } catch (e) {
    console.error("[knowledge] could not store the snapshot:", e instanceof Error ? e.message : e);
  }

  cached = { at: Date.now(), knowledge };
  return knowledge;
}

/**
 * Write down that a prior changed something.
 *
 * Called at the point of intervention, not afterwards. A learning system that
 * cannot show you where it intervened is indistinguishable from one that does
 * nothing — and from one that is quietly making things worse.
 *
 * Never throws, and never blocks: the decision has already been made by the
 * time this runs, and failing to log it must not undo it.
 */
export async function logApplication(input: {
  surface: "diagnostic_order" | "script_weighting" | "packet_order" | "sequence_brief";
  priorKey: string;
  samples: number;
  lift?: number | null;
  leadId?: string | null;
  detail: string;
}): Promise<void> {
  try {
    await supabaseAdmin().from("knowledge_applications").insert({
      surface: input.surface,
      prior_key: input.priorKey,
      samples: input.samples,
      lift: input.lift ?? null,
      lead_id: input.leadId ?? null,
      detail: input.detail,
    });
  } catch {
    /* the intervention already happened; losing the note must not undo it */
  }
}

/** Drop the in-memory cache, for a route that has just recomputed. */
export function invalidateKnowledgeCache(): void {
  cached = null;
}
