import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { reviewLoad } from "@/lib/aiAuthority";

export const dynamic = "force-dynamic";

/**
 * The shape the page renders, always complete.
 *
 * The error path used to return `{ queue, error }` only, and the page read
 * `data.blocked.length` off it — a white screen instead of the migration hint
 * it was supposed to show. Every response is built from this now, so a partial
 * payload cannot happen.
 */
function payload(over: Record<string, unknown> = {}) {
  return {
    queue: [],
    blocked: [],
    load: "",
    weekTotal: 0,
    weekEscalated: 0,
    error: null,
    ...over,
  };
}

function migrationHint(message: string): string | null {
  if (/relation .* does not exist|column .* does not exist|schema cache/i.test(message)) {
    return (
      "Run supabase/migrations/0022_ai_authority.sql in the Supabase SQL Editor, then reload. " +
      `(${message})`
    );
  }
  return null;
}

/**
 * The short queue. Deliberately NOT every call — the model's reading is already
 * applied to all of them. This is only what it was unsure about, contradicted
 * the caller on, or a random slice kept back so accuracy stays measurable.
 */
export async function GET() {
  try {
    return await queue();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(payload({ error: migrationHint(msg) || msg }), { status: 200 });
  }
}

async function queue() {
  const db = supabaseAdmin();

  const { data, error } = await db
    .from("call_analysis")
    .select(
      "id, call_id, lead_id, caller_id, authority, ai_confidence, transcript_confidence, applied_result, transcript_result, ai_result, held_fields, disagreements, review_reasons, needs_review, reviewed_at, review_verdict, created_at, leads(business_name), callers(name)"
    )
    .eq("needs_review", true)
    .is("reviewed_at", null)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json(
      payload({ error: migrationHint(error.message) || error.message }),
      { status: 200 }
    );
  }

  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const { count: total } = await db
    .from("call_analysis")
    .select("*", { count: "exact", head: true })
    .gte("created_at", since);
  const { count: escalated } = await db
    .from("call_analysis")
    .select("*", { count: "exact", head: true })
    .eq("needs_review", true)
    .gte("created_at", since);

  const { data: blocked } = await db
    .from("blocked_actions")
    .select("id, call_id, lead_id, action, rationale, created_at, leads(business_name)")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(50);

  return NextResponse.json(
    payload({
      queue: data || [],
      blocked: blocked || [],
      load: reviewLoad(total ?? 0, escalated ?? 0),
      weekTotal: total ?? 0,
      weekEscalated: escalated ?? 0,
    })
  );
}
