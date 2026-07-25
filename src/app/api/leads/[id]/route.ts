import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logEvent } from "@/lib/events";
import { normalizeDomain, normalizePhone } from "@/lib/normalize";

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
    "stage",
    "do_not_call",
  ];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in body) patch[k] = body[k];
  if ("phone" in patch) patch.normalized_phone = normalizePhone(body.phone);
  if ("website" in patch) patch.domain = normalizeDomain(body.website);

  const db = supabase();
  const { data: before } = await db.from("leads").select("stage").eq("id", id).single();

  const { data, error } = await db
    .from("leads")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (body.stage && before && body.stage !== before.stage) {
    await logEvent("lead.stage_changed", "lead", id, {
      from: before.stage,
      to: body.stage,
    });
  }
  return NextResponse.json(data);
}
