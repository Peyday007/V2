import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { buildAllProfiles } from "@/lib/callerProfile";
import type { CallFact, ObjectionFact } from "@/lib/analytics";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = supabase();

  const { data: calls, error } = await db
    .from("calls")
    .select(
      "outcome, reached_dm, created_at, duration_seconds, attempt_number, dialed_hour, dialed_dow, lead_industry, lead_state, owner_known_before, spoke_with_role, caller_id, callers(name)"
    )
    .order("created_at", { ascending: false })
    .limit(20000);
  if (error) {
    const hint = /column .* does not exist|schema cache/i.test(error.message)
      ? "The analytics columns are missing. Run supabase/migrations/0013_call_analytics.sql, then reload."
      : error.message;
    return NextResponse.json({ error: hint }, { status: 500 });
  }

  type Row = (typeof calls)[number] & {
    callers: { name: string } | { name: string }[] | null;
  };

  const nameById = new Map<string, string>();
  const facts: CallFact[] = ((calls || []) as Row[]).map((c) => {
    const caller = Array.isArray(c.callers) ? c.callers[0] : c.callers;
    const name = caller?.name ?? "Unknown";
    if (c.caller_id) nameById.set(String(c.caller_id), name);
    return {
      outcome: c.outcome,
      reached_dm: !!c.reached_dm,
      caller_name: name,
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
      spoke_with_role: c.spoke_with_role ?? null,
    };
  });

  // Objections each caller actually faced.
  const objectionsByCaller: Record<string, ObjectionFact[]> = {};
  const { data: objections } = await db
    .from("call_objections")
    .select("objection_key, objection_label, outcome, reached_dm, caller_id")
    .limit(20000);
  for (const o of objections || []) {
    const name = nameById.get(String(o.caller_id));
    if (!name) continue;
    (objectionsByCaller[name] ||= []).push(o as ObjectionFact);
  }

  // How often each caller wrote down something durable. This is a management
  // signal in its own right: what is not captured gets rediscovered.
  const intelCaptureByCaller: Record<string, number> = {};
  const { data: intelEvents } = await db
    .from("events")
    .select("actor_caller_id")
    .eq("event_type", "lead.intelligence_updated")
    .limit(20000);
  for (const e of intelEvents || []) {
    const name = nameById.get(String(e.actor_caller_id));
    if (!name) continue;
    intelCaptureByCaller[name] = (intelCaptureByCaller[name] || 0) + 1;
  }

  const profiles = buildAllProfiles(facts, {
    intelCaptureByCaller,
    objectionsByCaller,
  });

  return NextResponse.json({ profiles });
}
