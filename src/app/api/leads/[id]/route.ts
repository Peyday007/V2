import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { recordEvent } from "@/lib/events";
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
    .select("pipeline_stage, archived_at, phone, website, city, state, industry")
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
    await recordEvent({
      type: "lead.stage_changed",
      entityType: "lead",
      entityId: id,
      leadId: id,
      actorType: "admin",
      source: "ui",
      previousValue: { pipeline_stage: before.pipeline_stage },
      newValue: { pipeline_stage: patch.pipeline_stage },
      metadata: { via: "board" },
    });
  }
  if ("archived_at" in patch) {
    await recordEvent({
      type: patch.archived_at ? "lead.archived" : "lead.unarchived",
      entityType: "lead",
      entityId: id,
      leadId: id,
      actorType: "admin",
      source: "ui",
      previousValue: { archived_at: before?.archived_at ?? null },
      newValue: { archived_at: patch.archived_at ?? null },
    });
  }

  // Contact-information changes are permanent facts worth their own event.
  const CONTACT_KEYS = ["phone", "website", "city", "state", "industry"];
  const contactChanges = CONTACT_KEYS.filter((k) => k in patch);
  if (contactChanges.length > 0 && before) {
    const prev: Record<string, unknown> = {};
    const next: Record<string, unknown> = {};
    for (const k of contactChanges) {
      const oldVal = (before as unknown as Record<string, unknown>)[k] ?? null;
      if (oldVal !== patch[k]) {
        prev[k] = oldVal;
        next[k] = patch[k];
      }
    }
    if (Object.keys(next).length > 0) {
      await recordEvent({
        type: "lead.contact_info_changed",
        entityType: "lead",
        entityId: id,
        leadId: id,
        actorType: "admin",
        source: "ui",
        previousValue: prev,
        newValue: next,
      });
    }
  }
  return NextResponse.json(data);
}
