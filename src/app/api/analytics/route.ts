import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import {
  analyzeCalls,
  analyzeObjections,
  wilson,
  confidenceFor,
  type CallFact,
  type ObjectionFact,
} from "@/lib/analytics";

export const dynamic = "force-dynamic";

/** The analytics columns live in 0013. Recognise their absence explicitly. */
function migrationHint(message: string): string | null {
  if (/column .* does not exist|schema cache|relation .* does not exist/i.test(message)) {
    return (
      "The analytics columns are missing. Run supabase/migrations/0013_call_analytics.sql " +
      `in the Supabase SQL Editor, then reload this page. (${message})`
    );
  }
  return null;
}

export async function GET(req: NextRequest) {
  const db = supabase();
  const days = Number(req.nextUrl.searchParams.get("days") || 0);
  const since =
    days > 0 ? new Date(Date.now() - days * 86400_000).toISOString() : null;

  let q = db
    .from("calls")
    .select(
      "outcome, reached_dm, created_at, duration_seconds, attempt_number, dialed_hour, dialed_dow, lead_industry, lead_state, owner_known_before, callers(name)"
    )
    .order("created_at", { ascending: false })
    .limit(20000);
  if (since) q = q.gte("created_at", since);

  const { data: calls, error } = await q;
  if (error) {
    return NextResponse.json(
      { error: migrationHint(error.message) || error.message },
      { status: 500 }
    );
  }

  type Row = (typeof calls)[number] & {
    callers: { name: string } | { name: string }[] | null;
  };

  const facts: CallFact[] = ((calls || []) as Row[]).map((c) => {
    const caller = Array.isArray(c.callers) ? c.callers[0] : c.callers;
    return {
      outcome: c.outcome,
      reached_dm: !!c.reached_dm,
      caller_name: caller?.name ?? null,
      lead_industry: c.lead_industry ?? null,
      lead_state: c.lead_state ?? null,
      dialed_hour: c.dialed_hour ?? null,
      dialed_dow: c.dialed_dow ?? null,
      attempt_number: c.attempt_number ?? null,
      duration_seconds: c.duration_seconds ?? null,
      owner_known_before:
        c.owner_known_before === null || c.owner_known_before === undefined
          ? null
          : !!c.owner_known_before,
      created_at: c.created_at,
    };
  });

  const report = analyzeCalls(facts);

  /* ----------------------------- objections ------------------------------ */
  let objections: ReturnType<typeof analyzeObjections> = [];
  let objectionsError: string | null = null;
  {
    const { data, error: objErr } = await db
      .from("call_objections")
      .select("objection_key, objection_label, outcome, reached_dm")
      .limit(20000);
    if (objErr) {
      objectionsError = migrationHint(objErr.message) || objErr.message;
    } else {
      objections = analyzeObjections((data || []) as ObjectionFact[]);
    }
  }

  /* ------------------------- appointment show rate ----------------------- */
  let showRate: {
    booked: number;
    held: number;
    noShow: number;
    awaiting: number;
    rate: number;
    low: number;
    high: number;
    confidence: string;
  } | null = null;
  let appointmentsError: string | null = null;
  {
    const { data, error: apptErr } = await db
      .from("appointments")
      .select("attendance_status")
      .limit(20000);
    if (apptErr) {
      appointmentsError = migrationHint(apptErr.message) || apptErr.message;
    } else {
      const rows = (data || []) as { attendance_status: string | null }[];
      const held = rows.filter((r) => r.attendance_status === "held").length;
      const noShow = rows.filter((r) => r.attendance_status === "no_show").length;
      const awaiting = rows.filter(
        (r) => !r.attendance_status || r.attendance_status === "scheduled"
      ).length;
      const decided = held + noShow;
      const { rate, low, high } = wilson(held, decided);
      showRate = {
        booked: rows.length,
        held,
        noShow,
        awaiting,
        rate,
        low,
        high,
        confidence: confidenceFor(decided),
      };
    }
  }

  return NextResponse.json({
    ...report,
    objections,
    objectionsError,
    showRate,
    appointmentsError,
    windowDays: days > 0 ? days : null,
  });
}
