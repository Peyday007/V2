import { NextRequest, NextResponse } from "next/server";
import { claimBatch, completeJob, failJob } from "@/lib/jobs";
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
