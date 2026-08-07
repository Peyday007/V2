import { NextRequest, NextResponse } from "next/server";
import { claimBatch, completeJob, enqueue, failJob } from "@/lib/jobs";
import { HANDLERS } from "@/lib/jobHandlers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BATCH_SIZE = 5;
// Leave headroom under maxDuration so in-flight work finishes cleanly.
const TIME_BUDGET_MS = 45_000;

function authorized(req: NextRequest): boolean {
  const secret = process.env.WORKER_SECRET;
  // If no secret is configured the worker stays open (campaign caps still
  // bound spend). Setting WORKER_SECRET locks it down.
  if (!secret) return true;
  const header =
    req.headers.get("x-worker-secret") ||
    req.headers.get("authorization")?.replace(/^Bearer /i, "") ||
    req.nextUrl.searchParams.get("secret");
  return header === secret;
}

async function runTick() {
  const worker = `w_${Math.random().toString(36).slice(2, 10)}`;
  const startedAt = Date.now();
  const processed: { type: string; ok: boolean; error?: string }[] = [];

  /*
   * Keep the email campaign fed.
   *
   * Queued at the top of every tick with a per-tick idempotency key, so a
   * second worker running at the same time cannot double-push. The handler
   * itself almost always decides to do nothing — it is off unless an
   * administrator switched it on, and even then it only pushes when the
   * campaign is actually below its target and the day's cap has room.
   *
   * Enqueued rather than called inline so it goes through the same claim,
   * retry and backoff machinery as everything else, and shows up in the same
   * job history when it misbehaves.
   */
  /*
   * Re-read the sending inboxes, hourly.
   *
   * The idempotency key is the hour rather than the minute: account limits do
   * not move minute to minute, the ramp has a two-day cooldown anyway, and
   * asking Instantly for the account list every sixty seconds is a request
   * nobody needs. The handler no-ops entirely unless one of the two capacity
   * switches is on.
   */
  /*
   * Rebuild what the house knows, a few times a day.
   *
   * The idempotency key buckets to six hours. It reads tens of thousands of
   * rows and nothing downstream needs it minutes-fresh — every prior has a
   * sample floor, so a snapshot from this morning differs from a new one by a
   * handful of observations at most.
   */
  await enqueue({
    type: "recompute_house_knowledge",
    idempotencyKey: `recompute_house_knowledge:${new Date().toISOString().slice(0, 11)}${Math.floor(new Date().getUTCHours() / 6)}`,
    priority: 220,
  }).catch(() => {});

  await enqueue({
    type: "sync_sending_accounts",
    idempotencyKey: `sync_sending_accounts:${new Date().toISOString().slice(0, 13)}`,
    // Ahead of the refill (200) — claim_jobs orders by priority ascending, and
    // the refill should read a cap that was computed from the CURRENT limits,
    // not yesterday.
    priority: 190,
  }).catch(() => {});

  await enqueue({
    type: "refill_email_campaign",
    idempotencyKey: `refill_email_campaign:${new Date().toISOString().slice(0, 16)}`,
    priority: 200, // behind lead sourcing; a top-up is never the urgent thing
  }).catch(() => {
    // A jobs table that will not accept this must not stop the tick.
  });

  /*
   * Catch old leads up on their own, once a day.
   *
   * A daily bucket rather than the minute bucket refill uses: this is
   * catch-up work on a fixed backlog, not something that needs to notice a
   * change within sixty seconds. The handler no-ops entirely unless an
   * administrator switched auto_reenrich_enabled on.
   */
  await enqueue({
    type: "auto_reenrich",
    idempotencyKey: `auto_reenrich:${new Date().toISOString().slice(0, 10)}`,
    priority: 210, // behind the email top-up; this is older data, not today's work
  }).catch(() => {});

  while (Date.now() - startedAt < TIME_BUDGET_MS) {
    const jobs = await claimBatch(BATCH_SIZE, worker);
    if (jobs.length === 0) break;

    for (const job of jobs) {
      const handler = HANDLERS[job.type];
      if (!handler) {
        await failJob(job, `No handler registered for job type "${job.type}"`);
        processed.push({ type: job.type, ok: false, error: "no handler" });
        continue;
      }
      try {
        await handler(job);
        await completeJob(job.id);
        processed.push({ type: job.type, ok: true });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[worker] ${job.type} failed:`, message);
        await failJob(job, message);
        processed.push({ type: job.type, ok: false, error: message });
      }
      if (Date.now() - startedAt >= TIME_BUDGET_MS) break;
    }
  }

  return {
    worker,
    processed: processed.length,
    succeeded: processed.filter((p) => p.ok).length,
    failed: processed.filter((p) => !p.ok).length,
    duration_ms: Date.now() - startedAt,
    details: processed.slice(0, 25),
  };
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await runTick());
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[worker] tick failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// GET so pg_cron / a browser can trigger it too.
export async function GET(req: NextRequest) {
  return POST(req);
}
