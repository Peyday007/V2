import "server-only";
import { supabaseAdmin } from "./supabaseAdmin";
import { isMissingColumnError } from "./enrichmentGrade";
import { enqueue } from "./jobs";
import { logEvent } from "./events";
import { placesKeyConfigured } from "./places";
import { requestBudgetFor } from "./budget";
import { QUICK_MIX_TRADES, RECORDABLE_METROS, formatMetro } from "./metros";
import {
  planReenrichment,
  countStillEnrichable,
  skipReasonFor,
  MAX_ENRICH_ATTEMPTS,
} from "./reenrichPlan";
import { readReenrichLeads, queueReenrichBatch } from "./reenrichStore";
import { countEligible } from "./emailPush";
import { passesRecipientPolicy } from "./emailEligibility";
import { loadSettings } from "./instantlyStore";
import { activeSequenceShape } from "./capacitySync";
import {
  computeDemand,
  planSupply,
  measuredYield,
  DEFAULT_RESERVE_DAYS,
  sourcingCeilingFor,
  type Demand,
} from "./supplyPlan";
import { nextSearchTarget, type FunnelDecision, type SearchedPair } from "./funnelPlan";
import {
  assessRun,
  productionStatus,
  type RunFacts,
  type RunAssessment,
} from "./sourcingHealth";

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

/**
 * The run that is supposedly in progress, and whether it is actually alive.
 *
 * THE LOCK THAT HAD NO LEASE. This used to be a bare count of campaigns with
 * status 'running', and that count was the only thing gating sourcing. The
 * status column is set when a run starts and cleared only by
 * finishCampaignIfDone — which is called exclusively from inside a job handler
 * for that campaign. Exhaust max_attempts on those jobs, or lose the worker
 * mid-run, and nothing is left alive to clear it.
 *
 * The result was a campaign marked running for days, sourcingIsRunning
 * returning true forever, planSupply holding forever, and the page reporting
 * "A sourcing run is already going" beside zero qualified contacts and 989
 * unused sends. Every statement true; the pipeline dead.
 *
 * The jobs table already solved this — claim_jobs reclaims any lease older
 * than 300 seconds. This gives the campaign lock the same property, using
 * updated_at as the heartbeat, and RECOVERS rather than merely reporting: a
 * dead run is marked failed so the next check is free to start a real one.
 */
export type ActiveRun = {
  run: RunFacts | null;
  assessment: RunAssessment;
  /** True when this call released a wedged lock. */
  recovered: boolean;
};

const RUN_COLUMNS =
  "id, name, status, started_at, updated_at, searches_planned, searches_completed, " +
  "api_requests_used, businesses_returned, unique_saved, duplicates_skipped, " +
  "qualification_failures, enrichment_queued, error_count, last_error";

export async function activeSourcingRun(now: Date = new Date()): Promise<ActiveRun> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("sourcing_campaigns")
    .select(RUN_COLUMNS)
    .eq("status", "running")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  /*
   * An unreadable table is treated as "a run is going", exactly as before:
   * not knowing must never authorise a spend.
   */
  if (error) {
    return {
      run: null,
      assessment: {
        state: "progressing",
        minutesSinceProgress: null,
        minutesSinceStart: null,
        shouldRecover: false,
        blocksNewRun: true,
        reason: `Could not read the sourcing runs, so nothing was started: ${error.message}`,
      },
      recovered: false,
    };
  }

  if (!data) {
    return { run: null, assessment: assessRun(null, now), recovered: false };
  }

  const r = data as unknown as Record<string, unknown>;
  const num = (k: string) => Number(r[k]) || 0;
  const run: RunFacts = {
    id: String(r.id),
    name: String(r.name ?? "unnamed run"),
    status: String(r.status),
    startedAt: (r.started_at as string) ?? null,
    updatedAt: (r.updated_at as string) ?? null,
    counters: {
      searchesPlanned: num("searches_planned"),
      searchesCompleted: num("searches_completed"),
      apiRequestsUsed: num("api_requests_used"),
      businessesReturned: num("businesses_returned"),
      uniqueSaved: num("unique_saved"),
      duplicatesSkipped: num("duplicates_skipped"),
      qualificationFailures: num("qualification_failures"),
      enrichmentQueued: num("enrichment_queued"),
      errorCount: num("error_count"),
      lastError: (r.last_error as string) ?? null,
    },
  };

  const assessment = assessRun(run, now);
  let recovered = false;

  if (assessment.shouldRecover) {
    /*
     * Released, with the reason written down. Marked `failed` rather than
     * `completed` so the history is honest about what happened, and guarded on
     * status = 'running' so two workers recovering at once cannot both act.
     */
    const { error: recoverError, data: updated } = await db
      .from("sourcing_campaigns")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        completion_reason: assessment.reason,
      })
      .eq("id", run.id)
      .eq("status", "running")
      .select("id");
    recovered = !recoverError && (updated?.length ?? 0) > 0;
    if (recovered) {
      await logEvent("campaign.recovered", "sourcing_campaign", run.id, {
        state: assessment.state,
        minutes_since_progress: assessment.minutesSinceProgress,
        searches_completed: run.counters.searchesCompleted,
        unique_saved: run.counters.uniqueSaved,
        last_error: run.counters.lastError,
      }).catch(() => {});
    }
  }

  return { run, assessment, recovered };
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

/** Roughly how many leads one day of enrichment gets through. */
export const ENRICHMENT_PER_DAY = 200;

export type SupplyPicture = {
  demand: Demand;
  /** Personal address, name on record, not yet pushed. */
  qualifiedReady: number;
  /** Leads a further crawl could still turn into a qualified contact. */
  enrichableNow: number;
  /** Leads enrichment has given up on — no longer counted as work. */
  givenUp: number;
  enrichmentPerDay: number;
  qualificationYield: number;
  yieldIsMeasured: boolean;
  yieldSample: number;
  sequenceSteps: number;
  spanDays: number;
  /** Day each step lands on, counted from the push. */
  offsets: number[];
};

/**
 * Everything the supply decision needs, read once.
 *
 * One function rather than four so the page and the worker can never disagree
 * about how many contacts are ready — the drift that produced "47 ready to
 * call" beside "none are available" was two readers with two definitions.
 */
export async function readSupplyPicture(): Promise<SupplyPicture> {
  const [instantly, shape, qualifiedReady, reenrich] = await Promise.all([
    loadSettings().catch(() => null),
    activeSequenceShape().catch(() => ({ steps: 3, spanDays: 7, offsets: [] as number[] })),
    countEligible().catch(() => 0),
    readReenrichLeads().catch(() => ({ rows: null, error: "unreadable" })),
  ]);

  const demand = computeDemand({
    usableSends: instantly?.settings.computed_daily_sends ?? 0,
    sequenceSteps: shape.steps,
    spanDays: shape.spanDays,
    reserveDays: instantly?.settings.reserve_days ?? DEFAULT_RESERVE_DAYS,
  });

  const rows = reenrich.rows || [];
  const enrichableNow = countStillEnrichable(rows);
  const givenUp = rows.filter(
    (l) => skipReasonFor(l) === "Enrichment has been tried enough"
  ).length;

  /*
   * THE YIELD, measured rather than assumed.
   *
   * Denominator: leads enrichment has actually finished with — tried at least
   * once and either qualified or given up on. Leads still queued are excluded,
   * because counting work in progress as a failure understates the yield and
   * would buy far too much.
   */
  let resolved = 0;
  let qualified = 0;
  for (const l of rows) {
    const attempts = l.enrich_attempts ?? 0;
    const passes = passesRecipientPolicy(l as never);
    if (passes) {
      resolved += 1;
      qualified += 1;
    } else if (attempts >= MAX_ENRICH_ATTEMPTS) {
      resolved += 1;
    }
  }
  const measured = measuredYield({ resolved, qualified });

  return {
    demand,
    qualifiedReady,
    enrichableNow,
    givenUp,
    enrichmentPerDay: ENRICHMENT_PER_DAY,
    qualificationYield: measured.yield,
    yieldIsMeasured: measured.measured,
    yieldSample: resolved,
    sequenceSteps: shape.steps,
    spanDays: shape.spanDays,
    offsets: shape.offsets,
  };
}

/**
 * Look at the funnel, and act if it needs it.
 *
 * Returns the decision so the caller can log it. Never throws for a business
 * reason: "nothing to do" is the usual answer and is not a failure.
 */
export async function keepFunnelFull(): Promise<FunnelDecision> {
  const settings = await loadFunnelSettings();

  /*
   * DEMAND FIRST, then supply. This used to compare the eligible count against
   * a flat `refillWhenBelow` of 200 — a number with no relationship to what
   * the inboxes could carry, so it was simultaneously far too high for a small
   * account and far too low for this one.
   *
   * Now the question is "how many sending days of qualified contacts are in
   * hand", which stays meaningful whatever the capacity.
   */
  const supply = await readSupplyPicture();

  const hoursSinceLastRun = settings.lastStartedAt
    ? (Date.now() - Date.parse(settings.lastStartedAt)) / 3_600_000
    : null;

  /*
   * A lock only counts while something is behind it. activeSourcingRun
   * assesses the run against its own heartbeat and RELEASES it when dead, so
   * a crashed job can no longer wedge sourcing indefinitely.
   */
  const active = await activeSourcingRun().catch(() => ({
    run: null,
    assessment: {
      state: "progressing" as const,
      minutesSinceProgress: null,
      minutesSinceStart: null,
      shouldRecover: false,
      blocksNewRun: true,
      reason: "Could not read the sourcing runs, so nothing was started.",
    },
    recovered: false,
  }));
  const running = active.assessment.blocksNewRun;

  const plan = planSupply({
    sourcingEnabled: settings.enabled,
    demand: supply.demand,
    qualifiedReady: supply.qualifiedReady,
    enrichableNow: supply.enrichableNow,
    enrichmentPerDay: supply.enrichmentPerDay,
    qualificationYield: supply.qualificationYield,
    yieldIsMeasured: supply.yieldIsMeasured,
    sourcingRunning: running,
    hoursSinceLastRun:
      hoursSinceLastRun !== null && Number.isFinite(hoursSinceLastRun) ? hoursSinceLastRun : null,
    minHoursBetweenRuns: settings.minHoursBetweenRuns,
    maxLeadsPerRun: sourcingCeilingFor(settings.leadsPerRun, supply.demand.intakePerDay),
  });

  /*
   * The measurement is written down whatever was decided, so the yield the
   * next run scales against is visible rather than inferred from spend.
   */
  const yieldNote = {
    last_yield_measured: supply.yieldIsMeasured ? supply.qualificationYield : null,
    last_yield_sample: supply.yieldSample,
  };

  const decision: FunnelDecision =
    plan.act === "hold"
      ? { act: "wait", reason: plan.reason }
      : { act: plan.act, reason: plan.reason };

  if (plan.act === "hold") {
    await note(plan.reason, yieldNote);
    return decision;
  }

  /* ----------------------------- free work first ------------------------- */
  if (plan.act === "enrich") {
    const { rows, error } = await readReenrichLeads();
    if (error || !rows) {
      await note(`Wanted to enrich, but the leads could not be read: ${error ?? "unknown"}`, yieldNote);
      return decision;
    }
    const batch = planReenrichment(rows, supply.enrichmentPerDay);
    const { queued, alreadyQueued } = await queueReenrichBatch(batch);
    await note(
      queued > 0
        ? `${plan.reason} Queued ${queued} of them for enrichment.`
        : `${plan.reason} ${alreadyQueued} were already queued today; waiting for the worker to get through them.`,
      yieldNote
    );
    return decision;
  }

  /* ------------------------- spending money at Google -------------------- */
  if (!placesKeyConfigured()) {
    await note(
      "The lead pool needs refilling, but GOOGLE_PLACES_API_KEY is not set on this deployment, so nothing can be sourced.",
      yieldNote
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
    /*
     * Scaled to what recent batches actually qualified, not a flat number.
     *
     * Sourcing 300 businesses to close a 300-contact gap is what a 10% yield
     * turns into 30, and it is why the reserve never filled however often this
     * ran. planSupply has already divided the shortfall by the measured yield
     * and capped the result at one run's worth.
     */
    target_lead_count: plan.sourceCount,
    // The same defaults the create form applies, so an automatic run produces
    // the same shape of lead as a hand-started one.
    min_rating: 3.5,
    max_review_count: 600,
    exclude_franchises: true,
    max_api_requests: Math.min(
      settings.maxApiRequestsPerRun,
      requestBudgetFor(plan.sourceCount)
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
    `${plan.reason} Started "${campaign.name}" for up to ${plan.sourceCount} leads, capped at ${record.max_api_requests} Google requests.`,
    {
      last_started_campaign_id: campaign.id,
      last_started_at: new Date().toISOString(),
      ...yieldNote,
    }
  );

  return decision;
}

/** Exported for the status view, which needs the numbers without acting. */
export async function funnelSnapshot() {
  const settings = await loadFunnelSettings();
  const [eligibleToEmail, awaitingEnrichment, active] = await Promise.all([
    countEligible().catch(() => 0),
    countAwaitingEnrichment().catch(() => 0),
    activeSourcingRun().catch(() => null),
  ]);
  /*
   * "Running" here means VERIFIED PROGRESS, not the presence of a lock. A
   * status view reporting a stalled run as running is how the page said
   * "A sourcing run is already going" for days after the run had died.
   */
  const progressing = active?.assessment.state === "progressing";
  return {
    settings,
    eligibleToEmail,
    awaitingEnrichment,
    sourcingRunning: progressing,
    run: active?.run ?? null,
    runAssessment: active?.assessment ?? null,
    runRecovered: active?.recovered ?? false,
  };
}

/** Re-exported so callers do not need to know which module owns it. */
export { isMissingColumnError };
