import { NextRequest, NextResponse } from "next/server";
import { recordEvent } from "@/lib/events";
import { planReenrichment, DEFAULT_BATCH, MAX_BATCH } from "@/lib/reenrichPlan";
import { readReenrichLeads, reenrichCapabilities, queueReenrichBatch } from "@/lib/reenrichStore";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/*
 * Re-enrich the leads that were enriched before the app could collect anything.
 *
 * GET  — what a run would do, without doing it.
 * POST — queue it.
 *
 * The split matters: this touches a thousand real websites, so being able to
 * read the plan before committing to it is the difference between a button and
 * a gamble.
 */

export async function GET() {
  const { rows, error } = await readReenrichLeads();
  if (error)
    return NextResponse.json({ error, plan: null, capabilities: reenrichCapabilities() }, { status: 200 });

  const plan = planReenrichment(rows || [], DEFAULT_BATCH);
  return NextResponse.json({
    error: null,
    capabilities: reenrichCapabilities(),
    plan: { ...plan, queue: plan.queue.length, maxBatch: MAX_BATCH },
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const limit = Number(body.limit) || DEFAULT_BATCH;

  const { rows, error } = await readReenrichLeads();
  if (error) return NextResponse.json({ error, queued: 0 }, { status: 500 });

  const plan = planReenrichment(rows || [], limit);
  if (plan.queue.length === 0) {
    return NextResponse.json({ queued: 0, alreadyQueued: 0, plan, error: null });
  }

  const { queued, alreadyQueued } = await queueReenrichBatch(plan);

  await recordEvent({
    type: "lead.enrichment_requested",
    entityType: "lead",
    entityId: plan.queue[0].id,
    actorType: "admin",
    source: "ui",
    newValue: { queued, alreadyQueued },
    metadata: {
      area: "reenrich_backfill",
      waiting: plan.waiting,
      skipped: plan.skipped,
      reason:
        "Leads enriched before the application could collect an email address, a diagnosis or an owner name.",
    },
    verificationStatus: "unverified",
  });

  return NextResponse.json({
    queued,
    alreadyQueued,
    waiting: plan.waiting,
    skipped: plan.skipped,
    capabilities: reenrichCapabilities(),
    error: null,
    note:
      queued === 0 && alreadyQueued > 0
        ? "These were already queued today. They will be worked as the worker gets to them."
        : plan.summary,
  });
}
