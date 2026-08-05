import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { enqueue } from "@/lib/jobs";
import { recordEvent } from "@/lib/events";
import { isMissingColumnError } from "@/lib/enrichmentGrade";
import { availableProviders } from "@/lib/contactProviders";
import {
  planReenrichment,
  reenrichKey,
  DEFAULT_BATCH,
  MAX_BATCH,
  type ReenrichLead,
} from "@/lib/reenrichPlan";

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

const CORE = "id, business_name, website, owner_name, do_not_call, archived_at";

/**
 * Newest migration first, stepping down.
 *
 * Selecting a column from an unrun migration fails the WHOLE query rather than
 * degrading — the failure mode that took the packet pipeline down. If 0032 has
 * not run there is no diagnostic to be missing, and the run still usefully
 * collects addresses and names.
 */
const COLUMN_TIERS = [
  `${CORE}, website_email, direct_email, owner_email, decision_maker_name, diagnostic_findings`,
  `${CORE}, website_email, direct_email, owner_email, decision_maker_name`,
  `${CORE}, website_email, owner_email, decision_maker_name`,
  `${CORE}, owner_email, decision_maker_name`,
  `${CORE}, owner_email`,
];

async function readLeads(): Promise<{ rows: ReenrichLead[] | null; error: string | null }> {
  const db = supabaseAdmin();
  for (const columns of COLUMN_TIERS) {
    const res = await db.from("leads").select(columns).is("archived_at", null).limit(20000);
    if (!res.error) return { rows: res.data as unknown as ReenrichLead[], error: null };
    if (!isMissingColumnError(res.error)) return { rows: null, error: res.error.message };
  }
  return { rows: null, error: "Could not read the leads table at any column set." };
}

/**
 * What a re-run can and cannot produce, stated plainly.
 *
 * A direct number comes only from a paid contact provider. With none
 * configured this run cannot produce one, and the page must say so rather than
 * let somebody press the button expecting the gatekeeper problem to go away.
 */
function capabilities() {
  const providers = availableProviders();
  return {
    email: true,
    diagnostic: true,
    decisionMaker: true,
    directNumber: providers.length > 0,
    directNumberNote:
      providers.length > 0
        ? `Direct numbers will be attempted through ${providers.map((p) => p.key).join(", ")}, within the budget.`
        : "No contact provider is configured, so this will NOT find direct numbers. Callers will still reach the main line.",
  };
}

export async function GET() {
  const { rows, error } = await readLeads();
  if (error) return NextResponse.json({ error, plan: null, capabilities: capabilities() }, { status: 200 });

  const plan = planReenrichment(rows || [], DEFAULT_BATCH);
  return NextResponse.json({
    error: null,
    capabilities: capabilities(),
    plan: { ...plan, queue: plan.queue.length, maxBatch: MAX_BATCH },
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const limit = Number(body.limit) || DEFAULT_BATCH;

  const { rows, error } = await readLeads();
  if (error) return NextResponse.json({ error, queued: 0 }, { status: 500 });

  const plan = planReenrichment(rows || [], limit);
  if (plan.queue.length === 0) {
    return NextResponse.json({ queued: 0, alreadyQueued: 0, plan, error: null });
  }

  let queued = 0;
  let alreadyQueued = 0;
  const today = new Date();

  for (const item of plan.queue) {
    try {
      const accepted = await enqueue({
        type: "enrich_owner_contact",
        payload: {
          lead_id: item.id,
          /*
           * THE FLAG THAT MAKES THIS WORK AT ALL.
           *
           * enrichLeadForOwner runs shouldReEnrich() first, and an already
           * enriched lead is refused — correctly, so nothing pays twice for a
           * record that has not changed. But the record has not changed; the
           * APPLICATION has. Without this flag the backfill queues a thousand
           * jobs that every one of them declines, and the page reports success
           * while nothing happens.
           */
          admin_requested: true,
          reason: "backfill",
        },
        // One per lead per day, so a second press this afternoon is a no-op
        // and tomorrow can pick up where this left off.
        idempotencyKey: reenrichKey(item.id, today),
        // Behind live lead generation. This is catch-up work on leads that
        // already exist; nothing is waiting on it in real time.
        priority: 200,
      });
      if (accepted) queued += 1;
      else alreadyQueued += 1;
    } catch {
      // One lead failing to queue must not abandon the batch.
      alreadyQueued += 1;
    }
  }

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
    capabilities: capabilities(),
    error: null,
    note:
      queued === 0 && alreadyQueued > 0
        ? "These were already queued today. They will be worked as the worker gets to them."
        : plan.summary,
  });
}
