import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { enqueue } from "@/lib/jobs";

export const dynamic = "force-dynamic";

/**
 * Re-run the baseline enrichment pass for any lead that is stuck before
 * ready_for_calling. Needed because leads queued while enrich_lead was a
 * no-op had their jobs completed without doing anything.
 *
 * Idempotency keys are versioned so this can be re-run safely.
 */
const VERSION = "v2";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const db = supabaseAdmin();

  let query = db
    .from("leads")
    .select("id")
    .in("machine_status", ["discovered", "normalized", "enrichment_queued", "enriching"])
    .is("archived_at", null)
    .limit(1000);

  if (body.sourcing_campaign_id) {
    query = query.eq("sourcing_campaign_id", body.sourcing_campaign_id);
  }

  const { data: leads, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!leads || leads.length === 0) {
    return NextResponse.json({ queued: 0, message: "No leads waiting to be processed." });
  }

  let queued = 0;
  for (const lead of leads) {
    const created = await enqueue({
      type: "enrich_lead",
      payload: { lead_id: lead.id },
      idempotencyKey: `enrich_lead:${VERSION}:${lead.id}`,
      priority: 200,
    });
    if (created) queued++;
  }

  return NextResponse.json({
    queued,
    found: leads.length,
    message:
      queued > 0
        ? `Queued ${queued} lead(s) for processing. Run the worker to process them.`
        : "These leads are already queued. Run the worker to process them.",
  });
}
