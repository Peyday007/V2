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

  /*
   * The caller's name is fetched separately, not embedded.
   *
   * `call_analysis` has TWO foreign keys to `callers` — `caller_id`, who made
   * the call, and `confirmed_by`, whoever settled the reading afterwards — so
   * `callers(name)` is ambiguous and PostgREST refuses the whole query with
   * "more than one relationship was found". The count endpoint has no embed,
   * so the badge said 30 while the list said 0, which is a horrible way to
   * find out.
   *
   * A disambiguating hint would fix today's query and break again the moment
   * anybody adds a third reference. Two plain selects and a map cannot be
   * ambiguous at all, and tests/schema.test.ts now fails the build if any
   * embed in the codebase becomes ambiguous.
   */
  const { data, error } = await db
    .from("call_analysis")
    .select(
      "id, call_id, lead_id, caller_id, authority, ai_confidence, transcript_confidence, applied_result, transcript_result, ai_result, held_fields, disagreements, review_reasons, needs_review, reviewed_at, review_verdict, created_at, leads(business_name)"
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

  // Names for the callers actually in this page of results.
  const callerIds = [...new Set((data || []).map((r) => r.caller_id).filter(Boolean))];
  const names = new Map<string, string>();
  if (callerIds.length > 0) {
    const { data: people } = await db
      .from("callers")
      .select("id, name")
      .in("id", callerIds as string[]);
    for (const c of people || []) names.set(String(c.id), String(c.name));
  }

  // Shaped exactly as the embed used to be, so the page needs no change and
  // an older cached client keeps working.
  const rows = (data || []).map((r) => ({
    ...r,
    callers: r.caller_id && names.has(String(r.caller_id))
      ? { name: names.get(String(r.caller_id))! }
      : null,
  }));

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
      queue: rows,
      blocked: blocked || [],
      load: reviewLoad(total ?? 0, escalated ?? 0),
      weekTotal: total ?? 0,
      weekEscalated: escalated ?? 0,
    })
  );
}
