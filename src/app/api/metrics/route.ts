import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = supabase();
  const { data: calls, error } = await db
    .from("calls")
    .select("caller_id, outcome, reached_dm, created_at, callers(name)")
    .order("created_at", { ascending: false })
    .limit(10000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type Row = {
    caller_id: string | null;
    outcome: string;
    reached_dm: boolean;
    callers: { name: string } | { name: string }[] | null;
  };
  const rows = (calls || []) as Row[];

  function summarize(subset: Row[]) {
    const dials = subset.length;
    const dmConvos = subset.filter((c) => c.reached_dm).length;
    const appointments = subset.filter((c) => c.outcome === "appointment_set").length;
    const connects = subset.filter(
      (c) => !["no_answer", "voicemail", "bad_number"].includes(c.outcome)
    ).length;
    return {
      dials,
      connects,
      dmConvos,
      appointments,
      dmPer100: dials ? Math.round((dmConvos / dials) * 1000) / 10 : 0,
      connectRate: dials ? Math.round((connects / dials) * 1000) / 10 : 0,
      apptPer100: dials ? Math.round((appointments / dials) * 1000) / 10 : 0,
    };
  }

  const byCaller = new Map<string, { name: string; rows: Row[] }>();
  for (const c of rows) {
    const key = c.caller_id || "unknown";
    const callerRel = Array.isArray(c.callers) ? c.callers[0] : c.callers;
    if (!byCaller.has(key)) {
      byCaller.set(key, { name: callerRel?.name || "Unknown", rows: [] });
    }
    byCaller.get(key)!.rows.push(c);
  }

  const outcomes: Record<string, number> = {};
  for (const c of rows) outcomes[c.outcome] = (outcomes[c.outcome] || 0) + 1;

  return NextResponse.json({
    overall: summarize(rows),
    outcomes,
    callers: Array.from(byCaller.values()).map((v) => ({
      name: v.name,
      ...summarize(v.rows),
    })),
  });
}
