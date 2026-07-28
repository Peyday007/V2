import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { recordEvent } from "@/lib/events";
import { benchmarkFrom, scoreTrial, type Benchmark } from "@/lib/trial";
import type { CallFact } from "@/lib/analytics";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

function migrationHint(message: string): string | null {
  if (/relation .* does not exist|column .* does not exist|schema cache/i.test(message)) {
    return (
      "Trials are not set up yet. Run supabase/migrations/0016_caller_trials.sql " +
      `in the Supabase SQL Editor, then reload. (${message})`
    );
  }
  return null;
}

/** Every call, flattened, with the caller id kept so trials can be scoped. */
async function loadCalls(db: SupabaseClient) {
  const { data, error } = await db
    .from("calls")
    .select(
      "caller_id, outcome, reached_dm, created_at, duration_seconds, attempt_number, dialed_hour, dialed_dow, lead_industry, lead_state, owner_known_before, spoke_with_role, callers(name)"
    )
    .order("created_at", { ascending: false })
    .limit(20000);
  if (error) throw new Error(error.message);

  return (data || []).map((c) => {
    const caller = Array.isArray(c.callers) ? c.callers[0] : c.callers;
    return {
      caller_id: c.caller_id ? String(c.caller_id) : null,
      fact: {
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
        spoke_with_role: c.spoke_with_role ?? null,
      } as CallFact,
    };
  });
}

export async function GET() {
  const db = supabase();

  const { data: trials, error } = await db
    .from("caller_trials")
    .select("*, callers(id, name, active), packets(id, name, status)")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    return NextResponse.json(
      { error: migrationHint(error.message) || error.message },
      { status: 500 }
    );
  }

  let all: Awaited<ReturnType<typeof loadCalls>>;
  try {
    all = await loadCalls(db);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not read calls" },
      { status: 500 }
    );
  }

  // Intel capture per caller, for the capture score.
  const { data: intelEvents } = await db
    .from("events")
    .select("actor_caller_id")
    .eq("event_type", "lead.intelligence_updated")
    .limit(20000);

  const scored = (trials || []).map((t) => {
    // Only calls this candidate made AFTER the trial began count toward it.
    const startedAt = new Date(t.started_at).getTime();
    const mine = all
      .filter(
        (c) =>
          c.caller_id === String(t.caller_id) &&
          new Date(c.fact.created_at).getTime() >= startedAt
      )
      .map((c) => c.fact);

    const captureCount = (intelEvents || []).filter(
      (e) => String(e.actor_caller_id) === String(t.caller_id)
    ).length;

    const benchmark = (t.benchmark || {}) as Benchmark;
    const score = scoreTrial({
      calls: mine,
      targetCalls: t.target_calls,
      benchmark: {
        dials: benchmark.dials ?? 0,
        talked: benchmark.talked ?? 0,
        ownerConversations: benchmark.ownerConversations ?? 0,
        appointments: benchmark.appointments ?? 0,
        callsPerDay: benchmark.callsPerDay ?? null,
      },
      intelCaptureCount: captureCount,
    });

    return { ...t, score };
  });

  return NextResponse.json({ trials: scored });
}

/** Start a trial: freeze the benchmark, then build the standard packet. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const callerId = typeof body.caller_id === "string" ? body.caller_id : "";
  const target = Math.max(10, Math.min(500, Number(body.target_calls) || 100));
  if (!callerId) {
    return NextResponse.json({ error: "Pick a caller to put on trial" }, { status: 400 });
  }

  const db = supabase();

  const { data: caller } = await db
    .from("callers")
    .select("id, name, active")
    .eq("id", callerId)
    .single();
  if (!caller) return NextResponse.json({ error: "Caller not found" }, { status: 404 });
  if (!caller.active) {
    return NextResponse.json(
      { error: `${caller.name} is revoked, so they cannot sign in to dial.` },
      { status: 400 }
    );
  }

  // Freeze the bar at today's team, excluding the candidate's own history.
  let benchmark: Benchmark;
  try {
    const all = await loadCalls(db);
    benchmark = benchmarkFrom(
      all.filter((c) => c.caller_id !== callerId).map((c) => c.fact)
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not read calls" },
      { status: 500 }
    );
  }

  const { data: trial, error: trialErr } = await db
    .from("caller_trials")
    .insert({
      caller_id: callerId,
      target_calls: target,
      benchmark,
      status: "running",
    })
    .select()
    .single();
  if (trialErr) {
    const dup = /caller_trials_one_live/.test(trialErr.message);
    return NextResponse.json(
      {
        error: dup
          ? `${caller.name} already has a trial running. Decide that one first.`
          : migrationHint(trialErr.message) || trialErr.message,
      },
      { status: 400 }
    );
  }

  // The packet itself: deliberately unbiased, so candidates are comparable.
  const origin = req.nextUrl.origin;
  const packetRes = await fetch(`${origin}/api/packets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: req.headers.get("cookie") || "",
    },
    body: JSON.stringify({ caller_id: callerId, size: target, unbiased: true }),
  });
  const packet = await packetRes.json().catch(() => ({}));

  if (!packetRes.ok) {
    // No packet means no trial. Roll it back rather than leave a dead row.
    await db.from("caller_trials").delete().eq("id", trial.id);
    return NextResponse.json(
      { error: packet.error || "Could not build the trial packet." },
      { status: 400 }
    );
  }

  await db.from("caller_trials").update({ packet_id: packet.id }).eq("id", trial.id);

  await recordEvent({
    type: "packet.assigned",
    entityType: "packet",
    entityId: packet.id,
    packetId: packet.id,
    actorType: "admin",
    actorCallerId: callerId,
    source: "ui",
    newValue: { trial: true, target_calls: target, leads: packet.total },
    metadata: { benchmark, trial_id: trial.id },
    verificationStatus: "verified",
  });

  return NextResponse.json({
    ok: true,
    trial: { ...trial, packet_id: packet.id },
    leads: packet.total,
    suppressed_excluded: packet.suppressed_excluded ?? 0,
  });
}
