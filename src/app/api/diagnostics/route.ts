import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { SALES_STAGES } from "@/lib/stages";

export const dynamic = "force-dynamic";

/**
 * Live diagnostics for the admin. Reports which database this deployment is
 * actually talking to and exactly what it contains. Never returns secrets:
 * the anon key is only reported as present/absent, never echoed.
 */
export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || null;
  const hasAnonKey = !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Project ref is the subdomain: https://<ref>.supabase.co
  let projectRef: string | null = null;
  if (url) {
    try {
      projectRef = new URL(url).hostname.split(".")[0];
    } catch {
      projectRef = null;
    }
  }

  const base = {
    supabase_url: url,
    supabase_project_ref: projectRef,
    anon_key_present: hasAnonKey,
    anthropic_key_present: !!process.env.ANTHROPIC_API_KEY,
    caller_secret_present: !!process.env.CALLER_SESSION_SECRET,
    vercel_env: process.env.VERCEL_ENV || "local",
    // Which commit is actually serving this request.
    git_sha: (process.env.VERCEL_GIT_COMMIT_SHA || "unknown").slice(0, 7),
    git_branch: process.env.VERCEL_GIT_COMMIT_REF || "unknown",
    git_message: (process.env.VERCEL_GIT_COMMIT_MESSAGE || "").split("\n")[0].slice(0, 80),
    fetched_at: new Date().toISOString(),
  };

  if (!url || !hasAnonKey) {
    return NextResponse.json({
      ...base,
      ok: false,
      error:
        "Supabase environment variables are missing on this deployment. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in Vercel → Settings → Environment Variables, then redeploy.",
    });
  }

  const db = supabase();

  async function countOf(
    table: string,
    apply?: (q: ReturnType<typeof db.from>) => unknown
  ): Promise<{ count: number | null; error: string | null }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = db.from(table).select("*", { count: "exact", head: true });
    if (apply) q = apply(q);
    const { count, error } = await q;
    return { count: count ?? null, error: error ? error.message : null };
  }

  const [total, archived, dnc, assigned, contactsCount, sourceCount] =
    await Promise.all([
      countOf("leads"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      countOf("leads", (q: any) => q.not("archived_at", "is", null)),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      countOf("leads", (q: any) => q.eq("do_not_call", true)),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      countOf("leads", (q: any) => q.eq("status", "in_packet")),
      countOf("contacts"),
      countOf("source_records"),
    ]);

  // Machine status distribution — lets the board explain WHY it is empty.
  const { data: msRows } = await db.from("leads").select("machine_status").limit(5000);
  const byMachineStatus: Record<string, number> = {};
  for (const r of msRows || []) {
    const k = String(r.machine_status);
    byMachineStatus[k] = (byMachineStatus[k] || 0) + 1;
  }

  const { count: pendingJobs } = await db
    .from("jobs")
    .select("*", { count: "exact", head: true })
    .in("status", ["pending", "running"]);
  const { count: failedJobs } = await db
    .from("jobs")
    .select("*", { count: "exact", head: true })
    .eq("status", "failed");

  const byStage: Record<string, number | string> = {};
  for (const stage of SALES_STAGES) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await countOf("leads", (q: any) => q.eq("pipeline_stage", stage));
    byStage[stage] = r.error ? `error: ${r.error}` : (r.count ?? 0);
  }

  // Leads whose stage is not one of the canonical values — these would be
  // invisible on the board, so surface them explicitly.
  const { data: strayRows, error: strayError } = await db
    .from("leads")
    .select("id, business_name, pipeline_stage")
    .not("pipeline_stage", "in", `(${SALES_STAGES.join(",")})`)
    .limit(25);

  const errors = [
    total.error && `leads: ${total.error}`,
    contactsCount.error && `contacts: ${contactsCount.error}`,
    sourceCount.error && `source_records: ${sourceCount.error}`,
    strayError && `stage check: ${strayError.message}`,
  ].filter(Boolean);

  return NextResponse.json({
    ...base,
    ok: errors.length === 0,
    errors,
    migration_hint: errors.some((e) =>
      /does not exist|schema cache|column/i.test(String(e))
    )
      ? "A table or column the app needs is missing. Run supabase/migrations/0005_canonical_stages.sql in the Supabase SQL Editor."
      : null,
    leads: {
      total: total.count,
      archived: archived.count,
      do_not_call: dnc.count,
      assigned_to_packet: assigned.count,
      by_stage: byStage,
      by_machine_status: byMachineStatus,
      unrecognized_stage_count: strayRows?.length ?? 0,
      unrecognized_stage_examples: strayRows || [],
    },
    contacts_total: contactsCount.count,
    source_records_total: sourceCount.count,
    engine: {
      places_key_present: !!process.env.GOOGLE_PLACES_API_KEY,
      worker_secret_set: !!process.env.WORKER_SECRET,
      service_role_key_present: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      jobs_pending_or_running: pendingJobs ?? 0,
      jobs_failed: failedJobs ?? 0,
    },
  });
}
