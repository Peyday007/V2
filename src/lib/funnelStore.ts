import "server-only";
import { supabaseAdmin } from "./supabaseAdmin";
import { isMissingColumnError } from "./enrichmentGrade";
import { enqueue } from "./jobs";
import { logEvent } from "./events";
import { placesKeyConfigured } from "./places";
import { requestBudgetFor } from "./budget";
import { QUICK_MIX_TRADES, RECORDABLE_METROS, formatMetro } from "./metros";
import { planReenrichment } from "./reenrichPlan";
import { readReenrichLeads, queueReenrichBatch } from "./reenrichStore";
import { countEligible } from "./emailPush";
import {
  decideFunnel,
  nextSearchTarget,
  type FunnelDecision,
  type SearchedPair,
} from "./funnelPlan";

// The world-touching half of keeping the funnel full. The decisions all live
// in funnelPlan.ts, which is pure and tested; this reads the counts, and — only
// when the pure decision says so — queues enrichment or starts a sourcing run.

export type FunnelSettings = {
  enabled: boolean;
  refillWhenBelow: number;
  leadsPerRun: number;
  maxApiRequestsPerRun: number;
  minHoursBetweenRuns: number;
  lastStartedAt: string | null;
  lastCheckNote: string | null;
  lastCheckedAt: string | null;
};

const DEFAULTS: FunnelSettings = {
  enabled: false,
  refillWhenBelow: 200,
  leadsPerRun: 300,
  maxApiRequestsPerRun: 200,
  minHoursBetweenRuns: 6,
  lastStartedAt: null,
  lastCheckNote: null,
  lastCheckedAt: null,
};

/**
 * Tolerates 0041 not having been run: a missing table reads as "switched off",
 * never as a crash. Same rule as every other settings reader here — the safe
 * direction for an unreadable setting is the one where nothing is spent.
 */
export async function loadFunnelSettings(): Promise<FunnelSettings> {
  try {
    const { data, error } = await supabaseAdmin()
      .from("funnel_settings")
      .select(
        "auto_source_enabled, refill_when_below, leads_per_run, max_api_requests_per_run, min_hours_between_runs, last_started_at, last_check_note, last_checked_at"
      )
      .eq("id", true)
      .maybeSingle();
    if (error || !data) return DEFAULTS;
    return {
      enabled: !!data.auto_source_enabled,
      refillWhenBelow: Number(data.refill_when_below) || DEFAULTS.refillWhenBelow,
      leadsPerRun: Number(data.leads_per_run) || DEFAULTS.leadsPerRun,
      maxApiRequestsPerRun:
        Number(data.max_api_requests_per_run) || DEFAULTS.maxApiRequestsPerRun,
      minHoursBetweenRuns:
        Number(data.min_hours_between_runs) || DEFAULTS.minHoursBetweenRuns,
      lastStartedAt: data.last_started_at ?? null,
      lastCheckNote: data.last_check_note ?? null,
      lastCheckedAt: data.last_checked_at ?? null,
    };
  } catch {
    return DEFAULTS;
  }
}

/** Every exit writes one of these, including "switched off". */
async function note(text: string, extra: Record<string, unknown> = {}): Promise<void> {
  await supabaseAdmin()
    .from("funnel_settings")
    .update({ last_check_note: text, last_checked_at: new Date().toISOString(), ...extra })
    .eq("id", true)
    .then(
      () => {},
      () => {}
    );
}

/**
 * Leads already here that enrichment has never turned into an address.
 *
 * Counted through the same planner the backfill uses, so "how many are
 * waiting" and "how many would a run take" can never disagree.
 */
async function countAwaitingEnrichment(): Promise<number> {
  const { rows, error } = await readReenrichLeads();
  if (error || !rows) return 0;
  const plan = planReenrichment(rows, 1);
  return plan.queue.length + plan.waiting;
}

async function sourcingIsRunning(): Promise<boolean> {
  const { count } = await supabaseAdmin()
    .from("sourcing_campaigns")
    .select("id", { count: "exact", head: true })
    .eq("status", "running");
  return (count ?? 0) > 0;
}

async function recentAutoSearches(): Promise<SearchedPair[]> {
  try {
    const { data, error } = await supabaseAdmin()
      .from("auto_source_history")
      .select("trade, metro, created_at")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error || !data) return [];
    return data.map((r) => ({ trade: String(r.trade), metro: String(r.metro), at: String(r.created_at) }));
  } catch {
    return [];
  }
}

/**
 * Look at the funnel, and act if it needs it.
 *
 * Returns the decision so the caller can log it. Never throws for a business
 * reason: "nothing to do" is the usual answer and is not a failure.
 */
export async function keepFunnelFull(): Promise<FunnelDecision> {
  const settings = await loadFunnelSettings();

  const [eligibleToEmail, awaitingEnrichment, running] = await Promise.all([
    countEligible().catch(() => 0),
    countAwaitingEnrichment().catch(() => 0),
    sourcingIsRunning().catch(() => true), // unknown reads as "running": do not start a second
  ]);

  const hoursSinceLastRun = settings.lastStartedAt
    ? (Date.now() - Date.parse(settings.lastStartedAt)) / 3_600_000
    : null;

  const decision = decideFunnel({
    enabled: settings.enabled,
    eligibleToEmail,
    refillWhenBelow: settings.refillWhenBelow,
    awaitingEnrichment,
    sourcingRunning: running,
    hoursSinceLastRun:
      hoursSinceLastRun !== null && Number.isFinite(hoursSinceLastRun) ? hoursSinceLastRun : null,
    minHoursBetweenRuns: settings.minHoursBetweenRuns,
  });

  if (decision.act === "wait") {
    await note(decision.reason);
    return decision;
  }

  /* ----------------------------- free work first ------------------------- */
  if (decision.act === "enrich") {
    const { rows, error } = await readReenrichLeads();
    if (error || !rows) {
      await note(`Wanted to enrich, but the leads could not be read: ${error ?? "unknown"}`);
      return decision;
    }
    const plan = planReenrichment(rows, 200);
    const { queued, alreadyQueued } = await queueReenrichBatch(plan);
    await note(
      queued > 0
        ? `${decision.reason} Queued ${queued} of them for enrichment.`
        : `${decision.reason} ${alreadyQueued} were already queued today; waiting for the worker to get through them.`
    );
    return decision;
  }

  /* ------------------------- spending money at Google -------------------- */
  if (!placesKeyConfigured()) {
    await note(
      "The lead pool needs refilling, but GOOGLE_PLACES_API_KEY is not set on this deployment, so nothing can be sourced."
    );
    return { act: "wait", reason: "No Places key." };
  }

  const target = nextSearchTarget(
    QUICK_MIX_TRADES,
    RECORDABLE_METROS.map(formatMetro),
    await recentAutoSearches()
  );
  if (!target) {
    await note(
      "The lead pool needs refilling, but every trade and metro in the automatic list has been searched recently. Add more trades or metros, or start a run by hand against somewhere new — searching the same ground again would buy leads already in the database."
    );
    return { act: "wait", reason: "Search grid exhausted." };
  }

  const db = supabaseAdmin();
  const record = {
    name: `Auto — ${target.trade.replace(/_/g, " ")} in ${target.metro}`,
    industry: target.trade,
    search_terms: [target.trade.replace(/_/g, " ")],
    locations: [target.metro],
    target_lead_count: settings.leadsPerRun,
    // The same defaults the create form applies, so an automatic run produces
    // the same shape of lead as a hand-started one.
    min_rating: 3.5,
    max_review_count: 600,
    exclude_franchises: true,
    max_api_requests: Math.min(
      settings.maxApiRequestsPerRun,
      requestBudgetFor(settings.leadsPerRun)
    ),
    daily_api_request_cap: 500,
    auto_assign_packets: true,
    packet_size: 50,
    status: "draft" as const,
  };

  const { data: campaign, error: insertError } = await db
    .from("sourcing_campaigns")
    .insert(record)
    .select("id, name")
    .single();
  if (insertError || !campaign) {
    await note(`Could not create the sourcing run: ${insertError?.message ?? "unknown"}`);
    return { act: "wait", reason: "Insert failed." };
  }

  const { error: startError } = await db
    .from("sourcing_campaigns")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", campaign.id);
  if (startError) {
    await note(`Created the sourcing run but could not start it: ${startError.message}`);
    return { act: "wait", reason: "Start failed." };
  }

  await enqueue({
    type: "plan_search_tasks",
    payload: { campaign_id: campaign.id },
    idempotencyKey: `plan_search_tasks:${campaign.id}`,
    campaignId: campaign.id,
    priority: 10,
  });

  /*
   * Written down BEFORE anything else can fail, so a repeat run moves on
   * rather than asking Google the same question again. Log first, act second,
   * for the same reason the account-limit changes do.
   */
  await db
    .from("auto_source_history")
    .insert({ trade: target.trade, metro: target.metro, campaign_id: campaign.id })
    .then(
      () => {},
      () => {}
    );

  await logEvent("campaign.started", "sourcing_campaign", campaign.id, { auto: true });
  await note(
    `${decision.reason} Started "${campaign.name}" for up to ${settings.leadsPerRun} leads, capped at ${record.max_api_requests} Google requests.`,
    { last_started_campaign_id: campaign.id, last_started_at: new Date().toISOString() }
  );

  return decision;
}

/** Exported for the status view, which needs the numbers without acting. */
export async function funnelSnapshot() {
  const settings = await loadFunnelSettings();
  const [eligibleToEmail, awaitingEnrichment, running] = await Promise.all([
    countEligible().catch(() => 0),
    countAwaitingEnrichment().catch(() => 0),
    sourcingIsRunning().catch(() => false),
  ]);
  return { settings, eligibleToEmail, awaitingEnrichment, sourcingRunning: running };
}

/** Re-exported so callers do not need to know which module owns it. */
export { isMissingColumnError };
