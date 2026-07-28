import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { buildBriefing, type CallbackFact, type AppointmentFact } from "@/lib/briefing";
import type { CallFact, ObjectionFact } from "@/lib/analytics";

export const dynamic = "force-dynamic";

function migrationHint(message: string): string | null {
  if (/column .* does not exist|schema cache|relation .* does not exist/i.test(message)) {
    return (
      "Some analytics columns are missing. Run the migrations in supabase/migrations " +
      `(0013 and 0014 are the recent ones), then reload. (${message})`
    );
  }
  return null;
}

export async function GET() {
  const db = supabase();

  const { data: calls, error } = await db
    .from("calls")
    .select(
      "outcome, reached_dm, created_at, duration_seconds, attempt_number, dialed_hour, dialed_dow, lead_industry, lead_state, owner_known_before, callers(name)"
    )
    .order("created_at", { ascending: false })
    .limit(20000);
  if (error) {
    return NextResponse.json(
      { error: migrationHint(error.message) || error.message },
      { status: 500 }
    );
  }

  type Row = (typeof calls)[number] & { callers: { name: string } | { name: string }[] | null };
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

  // Everything else is best-effort: a missing table must not blank the page.
  const [objRes, apptRes, cbRes, leadRes, packetRes] = await Promise.all([
    db.from("call_objections").select("objection_key, objection_label, outcome, reached_dm").limit(20000),
    db
      .from("appointments")
      .select("scheduled_for, attendance_status, leads(business_name), callers(name)")
      .order("scheduled_for", { ascending: false })
      .limit(500),
    db
      .from("callbacks")
      .select("scheduled_for, status, leads(business_name), callers(name)")
      .order("scheduled_for")
      .limit(500),
    db
      .from("leads")
      .select(
        "owner_name, best_call_time, direct_number, extension, answering_setup, existing_provider, gatekeeper_name, attempt_count"
      )
      .gt("attempt_count", 0)
      .limit(20000),
    db.from("packets").select("id").eq("status", "open"),
  ]);

  // supabase-js types an embedded relation as an array; at runtime it is a
  // single row here. Narrow through unknown rather than fight the generics.
  function one<T>(rel: unknown): T | null {
    if (Array.isArray(rel)) return (rel[0] as T) ?? null;
    return (rel as T) ?? null;
  }

  const appointments: AppointmentFact[] = (apptRes.data || []).map((a) => ({
    scheduled_for: a.scheduled_for,
    attendance_status: a.attendance_status ?? null,
    business_name: one<{ business_name: string }>(a.leads)?.business_name ?? null,
    caller_name: one<{ name: string }>(a.callers)?.name ?? null,
  }));

  const callbacks: CallbackFact[] = (cbRes.data || []).map((c) => ({
    scheduled_for: c.scheduled_for,
    status: c.status ?? null,
    business_name: one<{ business_name: string }>(c.leads)?.business_name ?? null,
    caller_name: one<{ name: string }>(c.callers)?.name ?? null,
  }));

  const touched = leadRes.data || [];
  const learned = {
    ownerNames: touched.filter((l) => l.owner_name).length,
    bestCallTimes: touched.filter((l) => l.best_call_time).length,
    directNumbers: touched.filter((l) => l.direct_number || l.extension).length,
    answeringSetups: touched.filter((l) => l.answering_setup).length,
    existingProviders: touched.filter((l) => l.existing_provider).length,
    gatekeeperNames: touched.filter((l) => l.gatekeeper_name).length,
    totalLeadsTouched: touched.length,
  };

  let pendingInPackets = 0;
  const openIds = (packetRes.data || []).map((p) => p.id);
  if (openIds.length > 0) {
    const { count } = await db
      .from("packet_leads")
      .select("*", { count: "exact", head: true })
      .in("packet_id", openIds)
      .eq("status", "pending");
    pendingInPackets = count ?? 0;
  }

  const { count: readyToCall } = await db
    .from("leads")
    .select("*", { count: "exact", head: true })
    .eq("status", "new")
    .eq("machine_status", "ready_for_calling")
    .eq("do_not_call", false)
    .is("archived_at", null);

  const briefing = buildBriefing({
    calls: facts,
    objections: (objRes.data || []) as ObjectionFact[],
    appointments,
    callbacks,
    learned,
    readyToCall: readyToCall ?? 0,
    pendingInPackets,
  });

  return NextResponse.json(briefing);
}
