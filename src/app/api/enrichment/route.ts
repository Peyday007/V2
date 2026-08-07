import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  buildEnrichmentReport,
  type AttemptFact,
  type CallFactForReport,
  type FeedbackFact,
  type LeadFact,
} from "@/lib/enrichmentReport";
import { DEFAULT_LIMITS } from "@/lib/directNumber";
import {
  PROVIDERS,
  providerStatus,
  directNumberCapability,
} from "@/lib/contactProviders";
import { MAX_BATCH } from "@/lib/reenrichPlan";

export const dynamic = "force-dynamic";

/**
 * The shape the page renders, always complete.
 *
 * Built the same way as /api/review after a partial error payload put a white
 * screen where a migration hint belonged: every response, success or failure,
 * comes out of here so the page can never read a field that is not there.
 */
function payload(over: Record<string, unknown> = {}) {
  return {
    report: null,
    settings: null,
    spend: [],
    providers: [],
    capability: null,
    defaults: DEFAULT_LIMITS,
    error: null,
    ...over,
  };
}

function migrationHint(message: string): string | null {
  if (/relation .* does not exist|column .* does not exist|schema cache/i.test(message)) {
    return (
      "Run supabase/migrations/0023_owner_enrichment.sql in the Supabase SQL Editor, then reload. " +
      `(${message})`
    );
  }
  return null;
}

export async function GET(req: NextRequest) {
  try {
    return await report(req);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      payload({
        error: migrationHint(msg) || msg,
        providers: providerStatus(),
        capability: directNumberCapability(),
      }),
      { status: 200 }
    );
  }
}

async function report(req: NextRequest) {
  const db = supabaseAdmin();
  const days = Math.max(1, Math.min(365, Number(req.nextUrl.searchParams.get("days")) || 30));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const [leadsRes, callsRes, attemptsRes, feedbackRes, settingsRes, spendRes] = await Promise.all([
    db
      .from("leads")
      .select(
        "id, decision_maker_name, direct_phone, direct_phone_class, enrichment_grade, enrichment_state, enrichment_cost_cents, enriched_at, created_at"
      )
      .is("archived_at", null)
      .limit(50000),
    db
      .from("calls")
      .select("lead_id, outcome, reached_dm, spoke_with_role, created_at")
      .gte("created_at", since)
      .limit(50000),
    db
      .from("enrichment_attempts")
      .select("provider, stage, attempted, accepted, phones_returned, cost_cents, error")
      .gte("created_at", since)
      .limit(50000),
    db
      .from("contact_feedback")
      .select("lead_id, outcome, provider, phone_class")
      .gte("created_at", since)
      .limit(50000),
    db.from("enrichment_settings").select("*").eq("id", true).maybeSingle(),
    db.from("enrichment_spend").select("*").order("period", { ascending: false }).limit(12),
  ]);

  // A missing enrichment table is the common case before the migration runs,
  // and it must read as "run the migration", not as an empty dashboard that
  // looks like the pipeline found nothing.
  const firstError =
    leadsRes.error || callsRes.error || attemptsRes.error || feedbackRes.error || settingsRes.error;
  if (firstError) {
    return NextResponse.json(
      payload({
        error: migrationHint(firstError.message) || firstError.message,
        providers: providerStatus(),
        capability: directNumberCapability(),
      }),
      { status: 200 }
    );
  }

  const built = buildEnrichmentReport({
    leads: (leadsRes.data || []) as LeadFact[],
    calls: (callsRes.data || []) as CallFactForReport[],
    attempts: (attemptsRes.data || []) as AttemptFact[],
    feedback: (feedbackRes.data || []) as FeedbackFact[],
  });

  return NextResponse.json(
    payload({
      report: { ...built, days },
      settings: settingsRes.data ?? null,
      spend: spendRes.data || [],
      providers: providerStatus(),
      capability: directNumberCapability(),
    })
  );
}

/* -------------------------------------------------------------------------- */
/* settings                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The budget and the on/off switch, edited by an administrator.
 *
 * `enabled` ships false, and stays false until somebody deliberately turns it
 * on, because every provider call is billable. Nothing in the pipeline may
 * flip it — it is an administrator's decision, not an outcome of a run.
 */
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const db = supabaseAdmin();

  const num = (v: unknown, min: number, max: number): number | undefined => {
    const n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    return Math.max(min, Math.min(max, n));
  };

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  /*
   * Same rule as auto_push_enabled on the email side: ships false, and only
   * an explicit administrator action turns it on. This one does not bill
   * anything by itself, but it does crawl real websites on its own schedule,
   * which is autonomous behaviour by the same standard.
   */
  if (typeof body.auto_reenrich_enabled === "boolean") {
    patch.auto_reenrich_enabled = body.auto_reenrich_enabled;
  }

  const caps: [string, number, number][] = [
    ["max_cost_per_lead_cents", 0, 10_000],
    ["max_provider_attempts", 1, 10],
    ["monthly_budget_cents", 0, 10_000_000],
    ["per_run_budget_cents", 0, 1_000_000],
    ["data_expiry_days", 1, 3650],
    ["max_retries", 0, 20],
    ["auto_reenrich_batch", 1, MAX_BATCH],
  ];
  for (const [key, min, max] of caps) {
    if (body[key] !== undefined) {
      const v = num(body[key], min, max);
      if (v !== undefined) patch[key] = Math.round(v);
    }
  }
  if (body.min_confidence !== undefined) {
    const v = num(body.min_confidence, 0, 1);
    if (v !== undefined) patch.min_confidence = v;
  }
  if (Array.isArray(body.provider_priority)) {
    const known = new Set(PROVIDERS.map((p) => p.key));
    patch.provider_priority = body.provider_priority.filter(
      (k: unknown) => typeof k === "string" && known.has(k)
    );
  }

  const { data, error } = await db
    .from("enrichment_settings")
    .update(patch)
    .eq("id", true)
    .select()
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: migrationHint(error.message) || error.message },
      { status: 500 }
    );
  }
  return NextResponse.json({ settings: data, error: null });
}
