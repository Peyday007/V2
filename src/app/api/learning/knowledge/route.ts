import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recordEvent } from "@/lib/events";
import {
  currentKnowledge,
  recomputeKnowledge,
  loadLearningSettings,
  invalidateKnowledgeCache,
} from "@/lib/houseKnowledgeStore";
import { appliedPriors, summarise } from "@/lib/houseKnowledge";

export const dynamic = "force-dynamic";

/*
 * What the house knows, what it changed, and what it still cannot answer.
 *
 * The third one is the point. A learning system that only reports its
 * conclusions quietly stops improving, because nobody can see where the next
 * improvement would come from. The blind spots turn "we should call more
 * roofers" from a hunch into a number.
 */

function migrationHint(message: string): string | null {
  if (/relation .* does not exist|column .* does not exist|schema cache/i.test(message)) {
    return (
      "The learning tables are not there yet. Run supabase/migrations/0033_house_knowledge.sql " +
      `in the Supabase SQL Editor, then reload. Until then every tool runs on its starting ` +
      `assumptions, which is exactly how it behaved before. (${message})`
    );
  }
  return null;
}

export async function GET() {
  const settings = await loadLearningSettings();
  const knowledge = await currentKnowledge();

  let applications: unknown[] = [];
  let history: unknown[] = [];
  let error: string | null = null;

  try {
    const db = supabaseAdmin();
    const recent = await db
      .from("knowledge_applications")
      .select("surface, prior_key, samples, lift, detail, created_at")
      .order("created_at", { ascending: false })
      .limit(30);
    if (recent.error) error = migrationHint(recent.error.message) || recent.error.message;
    else applications = recent.data || [];

    // The compounding, as a series. "It is getting smarter" should be a chart,
    // not a claim.
    const snapshots = await db
      .from("house_knowledge")
      .select("total_facts, applied_priors, blind_spots, computed_at")
      .order("computed_at", { ascending: false })
      .limit(30);
    if (!snapshots.error) history = (snapshots.data || []).reverse();
  } catch (e) {
    error = error || (e instanceof Error ? e.message : String(e));
  }

  return NextResponse.json({
    settings,
    knowledge,
    summary: summarise(knowledge),
    applied: appliedPriors(knowledge),
    applications,
    history,
    error,
  });
}

/** Recompute now, rather than waiting for the worker. */
export async function POST() {
  try {
    invalidateKnowledgeCache();
    const knowledge = await recomputeKnowledge();
    return NextResponse.json({
      ok: true,
      summary: summarise(knowledge),
      totalFacts: knowledge.totalFacts,
      applied: appliedPriors(knowledge).length,
      blindSpots: knowledge.blindSpots.length,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: migrationHint(msg) || msg }, { status: 500 });
  }
}

/**
 * Change how the learning behaves.
 *
 * Three knobs and no more. In particular there is no way here to raise a
 * single prior above the floor by hand — the floor is the thing that stops
 * nine observations becoming policy, and a per-prior override would be a hole
 * straight through it.
 */
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (typeof body.apply_learning === "boolean") patch.apply_learning = body.apply_learning;

  if (body.min_samples !== undefined) {
    const n = Number(body.min_samples);
    if (!Number.isInteger(n) || n < 10 || n > 1000) {
      return NextResponse.json(
        {
          error:
            "A sample floor between 10 and 1000. Below about 30 you are acting on coincidences; the default is 30 because that is where the analytics page also starts calling something directional.",
        },
        { status: 400 }
      );
    }
    patch.min_samples = n;
  }

  if (body.exploration_floor !== undefined) {
    const f = Number(body.exploration_floor);
    if (!Number.isFinite(f) || f < 0.05 || f > 1) {
      return NextResponse.json(
        {
          error:
            "Exploration between 0.05 and 1. Zero is not offered on purpose: a system that sends everything to today's winner cannot notice when the market moves, because the data it would need is data it stopped collecting.",
        },
        { status: 400 }
      );
    }
    patch.exploration_floor = f;
  }

  try {
    const db = supabaseAdmin();
    const { data: before } = await db
      .from("learning_settings")
      .select("apply_learning, min_samples, exploration_floor")
      .eq("id", true)
      .maybeSingle();

    const { error } = await db.from("learning_settings").update(patch).eq("id", true);
    if (error) {
      return NextResponse.json({ error: migrationHint(error.message) || error.message }, { status: 500 });
    }

    invalidateKnowledgeCache();
    await recordEvent({
      type: "prompt.changed",
      entityType: "prompt",
      entityId: "learning:settings",
      actorType: "admin",
      source: "ui",
      previousValue: before ?? null,
      newValue: patch,
      metadata: { area: "house_knowledge" },
      verificationStatus: "verified",
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: migrationHint(msg) || msg }, { status: 500 });
  }
}
