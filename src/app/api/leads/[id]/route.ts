import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logEvent } from "@/lib/events";
import { normalizeDomain, normalizePhone } from "@/lib/normalize";
import { isSalesStage } from "@/lib/stages";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const allowed = [
    "business_name",
    "phone",
    "website",
    "city",
    "state",
    "industry",
    "notes",
    "do_not_call",
  ];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in body) patch[k] = body[k];

  if ("pipeline_stage" in body) {
    if (!isSalesStage(body.pipeline_stage)) {
      return NextResponse.json(
        { error: `Unrecognized stage: ${body.pipeline_stage}` },
        { status: 400 }
      );
    }
    patch.pipeline_stage = body.pipeline_stage;
  }
  if ("archived" in body) {
    patch.archived_at = body.archived ? new Date().toISOString() : null;
  }
  if ("phone" in patch) patch.normalized_phone = normalizePhone(body.phone);
  if ("website" in patch) patch.domain = normalizeDomain(body.website);

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const db = supabase();
  const { data: before } = await db
    .from("leads")
    .select("pipeline_stage")
    .eq("id", id)
    .single();

  const { data, error } = await db
    .from("leads")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    console.error("[api/leads/:id] update failed:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (patch.pipeline_stage && before && patch.pipeline_stage !== before.pipeline_stage) {
    await logEvent("lead.stage_changed", "lead", id, {
      from: before.pipeline_stage,
      to: patch.pipeline_stage,
    });
  }
  if ("archived_at" in patch) {
    await logEvent(
      patch.archived_at ? "lead.archived" : "lead.unarchived",
      "lead",
      id,
      {}
    );
  }
  return NextResponse.json(data);
}
