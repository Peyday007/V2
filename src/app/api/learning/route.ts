import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recordEvent } from "@/lib/events";
import {
  proposeChange,
  evaluateExperiment,
  type ArmResult,
  type LearningDimension,
  type Observation,
  type OutcomeType,
} from "@/lib/learning";

type ObservationRow = {
  dimension: string;
  variant: string;
  outcome: string | null;
  call_id: string;
  caller_id: string | null;
};

function toObservation(r: ObservationRow, variant = r.variant): Observation {
  return {
    callId: r.call_id,
    callerId: r.caller_id,
    dimension: r.dimension as LearningDimension,
    variant,
    outcomeType: (r.outcome ?? null) as OutcomeType | null,
  };
}

/** Successes and trials for one arm on one metric. */
function armFor(obs: Observation[], arm: string, metric: OutcomeType): ArmResult {
  const inArm = obs.filter((o) => o.variant === arm);
  return {
    trials: inArm.length,
    successes: inArm.filter((o) => o.outcomeType === metric).length,
  };
}

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function migrationHint(message: string): string | null {
  if (/relation .* does not exist|column .* does not exist|schema cache/i.test(message)) {
    return (
      "Run supabase/migrations/0019_call_intelligence.sql and 0022_ai_authority.sql in the " +
      `Supabase SQL Editor, then reload. (${message})`
    );
  }
  return null;
}

/**
 * What the system has noticed, what it wants to change, and what is under test.
 *
 * The engine proposes; it never applies. A platform that rewrites its own
 * pitch after a good week is how a team ends up with a script nobody chose and
 * nobody can explain to a new hire.
 */
export async function GET() {
  const db = supabaseAdmin();

  try {
    const [proposals, experiments, versions, observations] = await Promise.all([
      db
        .from("change_proposals")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50),
      db.from("experiments").select("*").order("created_at", { ascending: false }).limit(20),
      db
        .from("coaching_versions")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(20),
      db
        .from("learning_observations")
        .select("dimension, variant, outcome, call_id, caller_id")
        .limit(20000),
    ]);

    const err = proposals.error || experiments.error || versions.error || observations.error;
    if (err) {
      return NextResponse.json(
        { proposals: [], experiments: [], versions: [], error: migrationHint(err.message) || err.message },
        { status: 200 }
      );
    }

    // Live scores for anything running, so the page shows the current state
    // rather than whatever was written when the experiment started.
    const scored = await Promise.all(
      (experiments.data || []).map(async (e) => {
        const { data: assignments } = await db
          .from("experiment_assignments")
          .select("call_id, arm")
          .eq("experiment_id", e.id);
        const armByCall = new Map((assignments || []).map((a) => [a.call_id, a.arm]));
        // The arm a call was assigned to IS the variant being compared, so it
        // replaces whatever variant the observation recorded.
        const obs = ((observations.data || []) as ObservationRow[])
          .filter((o) => armByCall.has(o.call_id))
          .map((o) => toObservation(o, armByCall.get(o.call_id) as string));

        const primary = (e.primary_metric || "owner_conversation") as OutcomeType;
        const verdict = evaluateExperiment({
          primaryMetric: primary,
          baseline: armFor(obs, "baseline", primary),
          candidate: armFor(obs, "candidate", primary),
          guardrails: ((e.guardrail_metrics || []) as OutcomeType[]).map((m) => ({
            outcome: m,
            baseline: armFor(obs, "baseline", m),
            candidate: armFor(obs, "candidate", m),
          })),
          minimumSample: e.minimum_sample ?? 40,
        });
        return { ...e, verdict, assigned: obs.length };
      })
    );

    return NextResponse.json({
      proposals: proposals.data || [],
      experiments: scored,
      versions: versions.data || [],
      observationCount: (observations.data || []).length,
      error: null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { proposals: [], experiments: [], versions: [], error: migrationHint(msg) || msg },
      { status: 500 }
    );
  }
}

/** Look for something worth proposing, right now. Refuses far more than it proposes. */
export async function PUT() {
  const db = supabaseAdmin();
  try {
    const { data: settings } = await db
      .from("call_intelligence_settings")
      .select("minimum_learning_sample")
      .eq("id", true)
      .maybeSingle();

    const { data: rows, error } = await db
      .from("learning_observations")
      .select("dimension, variant, outcome, call_id, caller_id")
      .limit(20000);
    if (error) {
      return NextResponse.json({ error: migrationHint(error.message) || error.message }, { status: 500 });
    }

    const byDimension = new Map<string, Observation[]>();
    for (const row of (rows || []) as ObservationRow[]) {
      const o = toObservation(row);
      if (!byDimension.has(o.dimension)) byDimension.set(o.dimension, []);
      byDimension.get(o.dimension)!.push(o);
    }

    const created: string[] = [];
    const refused: { dimension: string; reason: string }[] = [];

    for (const [dimension, obs] of byDimension) {
      const decision = proposeChange(obs, {
        minimumSample: settings?.minimum_learning_sample ?? 40,
        primaryMetric: "owner_conversation",
      });
      if (!decision.propose) {
        refused.push({ dimension, reason: decision.reason });
        continue;
      }
      const e = decision.evidence;
      const { data: inserted } = await db
        .from("change_proposals")
        .insert({
          scope: dimension,
          exact_change: `Use "${e.candidateVariant}" instead of "${e.baselineVariant}" for ${dimension}.`,
          reason: decision.summary,
          supporting_call_ids: e.supportingCallIds,
          sample_size: e.sampleSize,
          baseline_rate: e.baselineRate,
          candidate_rate: e.candidateRate,
          confidence: e.confidence,
          p_value: e.pValue,
          controlled_for: e.controlledFor,
          status: "pending",
        })
        .select("id")
        .single();
      if (inserted) {
        created.push(inserted.id);
        await recordEvent({
          type: "proposal.created",
          entityType: "prompt",
          entityId: inserted.id,
          actorType: "system",
          source: "worker",
          newValue: { dimension, change: e.candidateVariant, pValue: e.pValue },
          verificationStatus: "unverified",
        });
      }
    }

    return NextResponse.json({ created: created.length, refused });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: migrationHint(msg) || msg }, { status: 500 });
  }
}

/** Approve, reject, or stop. Every one of these is a person's decision. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const db = supabaseAdmin();
  const id = String(body.id || "");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    if (body.action === "reject") {
      await db
        .from("change_proposals")
        .update({
          status: "rejected",
          rejected_reason: String(body.note || "").trim() || "Rejected by an admin.",
          decided_by: "admin",
          decided_at: new Date().toISOString(),
        })
        .eq("id", id);
      await recordEvent({
        type: "proposal.rejected",
        entityType: "prompt",
        entityId: id,
        actorType: "admin",
        source: "ui",
        newValue: { note: body.note ?? null },
        verificationStatus: "verified",
      });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "test") {
      // Approving means testing it, not deploying it. A proposal that looked
      // good in past data still has to beat the current approach live.
      const { data: proposal } = await db
        .from("change_proposals")
        .select("id, scope")
        .eq("id", id)
        .maybeSingle();
      if (!proposal) return NextResponse.json({ error: "No such proposal" }, { status: 404 });

      const { data: experiment, error } = await db
        .from("experiments")
        .insert({
          proposal_id: id,
          scope: proposal.scope,
          traffic_percent: Number(body.traffic) || 50,
          minimum_sample: Number(body.minimum_sample) || 40,
          status: "running",
        })
        .select("id")
        .single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      await db
        .from("change_proposals")
        .update({
          status: "testing",
          approved_by: "admin",
          approved_at: new Date().toISOString(),
          decided_by: "admin",
          decided_at: new Date().toISOString(),
        })
        .eq("id", id);

      await recordEvent({
        type: "experiment.started",
        entityType: "prompt",
        entityId: experiment.id,
        actorType: "admin",
        source: "ui",
        newValue: { proposalId: id, scope: proposal.scope },
        verificationStatus: "verified",
      });
      return NextResponse.json({ ok: true, experiment_id: experiment.id });
    }

    if (body.action === "stop") {
      await db
        .from("experiments")
        .update({
          status: "stopped",
          stopped_at: new Date().toISOString(),
          stopped_reason: String(body.note || "").trim() || "Stopped by an admin.",
          conclusion: String(body.note || "").trim() || null,
        })
        .eq("id", id);
      await recordEvent({
        type: "experiment.concluded",
        entityType: "prompt",
        entityId: id,
        actorType: "admin",
        source: "ui",
        newValue: { note: body.note ?? null },
        verificationStatus: "verified",
      });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: migrationHint(msg) || msg }, { status: 500 });
  }
}
