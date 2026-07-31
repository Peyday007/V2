import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { anthropic, PRIORITIZER_MODEL } from "@/lib/anthropic";
import { buildDossier, dossierPrompt, type CallRow } from "@/lib/relationship";
import { buildPrompt } from "@/lib/promptStore";

export const dynamic = "force-dynamic";

/**
 * The relationship read.
 *
 * The dossier is assembled deterministically from the record and returned
 * whether or not Claude is available — the panel is useful without it. The AI
 * narrative is fed ONLY the dossier, so it cannot describe a conversation that
 * never happened.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = supabase();

  const { data: lead } = await db.from("leads").select("*").eq("id", id).single();
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  const [callsRes, apptRes, cbRes, objRes] = await Promise.all([
    db
      .from("calls")
      .select("outcome, reached_dm, notes, details, next_step, spoke_with_role, attempt_number, created_at")
      .eq("lead_id", id)
      .order("created_at", { ascending: false })
      .limit(200),
    db.from("appointments").select("*").eq("lead_id", id).order("scheduled_for", { ascending: false }),
    db.from("callbacks").select("scheduled_for, status, reason, requested_by_name").eq("lead_id", id),
    db.from("call_objections").select("objection_key, objection_label").eq("lead_id", id),
  ]);

  const dossier = buildDossier({
    lead,
    calls: (callsRes.data || []) as CallRow[],
    appointments: apptRes.data || [],
    callbacks: cbRes.data || [],
    objections: objRes.data || [],
  });

  const ai = anthropic();
  if (!ai) {
    return NextResponse.json({
      dossier,
      analysis: null,
      analysisError:
        "ANTHROPIC_API_KEY is not set on this deployment, so there is no written read — the facts above are still complete. If you added the key in Vercel, redeploy.",
    });
  }

  if (!dossier.hasSubstance) {
    return NextResponse.json({
      dossier,
      analysis: null,
      analysisError:
        "Not enough has happened with this business yet to say anything useful. Once someone speaks to them, this fills in.",
    });
  }

  try {
    const content = await buildPrompt("relationship_read", {
      business_name: String(lead.business_name || "this business"),
      record: dossierPrompt(String(lead.business_name || "this business"), dossier),
    });
    const msg = await ai.messages.create({
      model: PRIORITIZER_MODEL,
      max_tokens: 900,
      messages: [{ role: "user", content }],
    });
    const block = msg.content[0];
    return NextResponse.json({
      dossier,
      analysis: block.type === "text" ? block.text : null,
      analysisError: null,
    });
  } catch (e) {
    return NextResponse.json({
      dossier,
      analysis: null,
      analysisError: e instanceof Error ? e.message : "Claude request failed",
    });
  }
}
