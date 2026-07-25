import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logEvent } from "@/lib/events";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const allowed = ["name", "stage", "pipeline", "value", "notes"];
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const k of allowed) if (k in body) patch[k] = body[k];

  const { data: before } = await supabase()
    .from("deals")
    .select("stage, pipeline")
    .eq("id", id)
    .single();

  const { data, error } = await supabase()
    .from("deals")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (body.stage && before && body.stage !== before.stage) {
    await logEvent("deal.stage_changed", "deal", id, {
      from: before.stage,
      to: body.stage,
      pipeline: data.pipeline,
    });
  }
  return NextResponse.json(data);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { error } = await supabase().from("deals").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await logEvent("deal.deleted", "deal", id, {});
  return NextResponse.json({ ok: true });
}
