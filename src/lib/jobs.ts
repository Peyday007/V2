import "server-only";
import { supabaseAdmin } from "./supabaseAdmin";
import { backoffSeconds, JobType } from "./jobs.pure";

export type { JobType };
export { backoffSeconds };

export type Job = {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  max_attempts: number;
  campaign_id: string | null;
  idempotency_key: string | null;
};

/**
 * Enqueue a job. When `idempotencyKey` is supplied, a duplicate insert is a
 * silent no-op — the same logical job can never be queued twice.
 * Returns true when a new job row was actually created.
 */
export async function enqueue(opts: {
  type: JobType;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  campaignId?: string | null;
  runAfter?: Date;
  priority?: number;
  maxAttempts?: number;
}): Promise<boolean> {
  const db = supabaseAdmin();
  const { error } = await db.from("jobs").insert({
    type: opts.type,
    payload: opts.payload || {},
    idempotency_key: opts.idempotencyKey || null,
    campaign_id: opts.campaignId || null,
    run_after: (opts.runAfter || new Date()).toISOString(),
    priority: opts.priority ?? 100,
    max_attempts: opts.maxAttempts ?? 5,
  });

  if (error) {
    // 23505 = unique_violation on idempotency_key: the job already exists.
    if (error.code === "23505") return false;
    throw new Error(`enqueue(${opts.type}) failed: ${error.message}`);
  }
  return true;
}

/** Atomically claim a batch of due jobs (FOR UPDATE SKIP LOCKED in SQL). */
export async function claimBatch(limit: number, worker: string): Promise<Job[]> {
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("claim_jobs", {
    p_limit: limit,
    p_worker: worker,
    p_lease_seconds: 300,
  });
  if (error) throw new Error(`claim_jobs failed: ${error.message}`);
  return (data || []) as Job[];
}

export async function completeJob(id: string): Promise<void> {
  await supabaseAdmin()
    .from("jobs")
    .update({ status: "done", locked_at: null, locked_by: null, last_error: null })
    .eq("id", id);
}

/**
 * Record a failure. Retries with backoff until max_attempts, then marks the
 * job failed permanently so a poison job cannot loop forever.
 */
export async function failJob(job: Job, message: string): Promise<void> {
  const db = supabaseAdmin();
  const exhausted = job.attempts >= job.max_attempts;
  const truncated = message.slice(0, 500);

  if (exhausted) {
    await db
      .from("jobs")
      .update({
        status: "failed",
        locked_at: null,
        locked_by: null,
        last_error: truncated,
      })
      .eq("id", job.id);
  } else {
    const runAfter = new Date(Date.now() + backoffSeconds(job.attempts) * 1000);
    await db
      .from("jobs")
      .update({
        status: "pending",
        locked_at: null,
        locked_by: null,
        last_error: truncated,
        run_after: runAfter.toISOString(),
      })
      .eq("id", job.id);
  }

  if (job.campaign_id) {
    const { data: c } = await db
      .from("sourcing_campaigns")
      .select("error_count")
      .eq("id", job.campaign_id)
      .single();
    await db
      .from("sourcing_campaigns")
      .update({
        error_count: (c?.error_count ?? 0) + 1,
        last_error: truncated,
      })
      .eq("id", job.campaign_id);
  }
}

/** Cancel all outstanding work for a campaign (stop button). */
export async function cancelCampaignJobs(campaignId: string): Promise<number> {
  const db = supabaseAdmin();
  const { data } = await db
    .from("jobs")
    .update({ status: "cancelled", locked_at: null, locked_by: null })
    .eq("campaign_id", campaignId)
    .in("status", ["pending", "running"])
    .select("id");
  return data?.length ?? 0;
}
