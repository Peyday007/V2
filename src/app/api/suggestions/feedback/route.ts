import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getCallerId } from "@/lib/callerSession";
import { isCallStage } from "@/lib/callStages";

export const dynamic = "force-dynamic";

/**
 * What the caller did with a suggestion.
 *
 * Recorded so the coaching engine can tell which advice is actually used
 * rather than assuming it lands. Deliberately fire-and-forget from the
 * dialer's point of view: a failure here must never interrupt a live call, so
 * every error returns 200 with a note instead of surfacing to the caller.
 */
export async function POST(req: NextRequest) {
  const callerId = await getCallerId();
  if (!callerId) return NextResponse.json({ ok: false, reason: "not signed in" });

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");
  if (!["used", "dismissed", "rated"].includes(action)) {
    return NextResponse.json({ ok: false, reason: "unknown action" });
  }
  const stage = String(body.call_stage || "");
  if (!isCallStage(stage)) {
    return NextResponse.json({ ok: false, reason: "unknown stage" });
  }

  const db = supabase();
  try {
    // The suggestion is generated client-side from a deterministic engine, so
    // it is recorded here at the moment feedback arrives rather than being
    // written on every render — one row per suggestion the caller reacted to.
    const { data: suggestion, error } = await db
      .from("coaching_suggestions")
      .insert({
        lead_id: body.lead_id || null,
        caller_id: callerId,
        call_stage: stage,
        suggestion_type: String(body.suggestion_id || "").split("-")[0] || "next_sentence",
        headline: String(body.suggestion_id || "unknown"),
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    await db.from("suggestion_feedback").insert({
      suggestion_id: suggestion.id,
      caller_id: callerId,
      action,
      rating: typeof body.rating === "number" ? body.rating : null,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A missing table means migration 0019 has not run. Say so in the log, not
    // to the caller, who is mid-conversation.
    console.warn("[suggestions/feedback]", msg);
    return NextResponse.json({ ok: false, reason: "not recorded" });
  }
}
