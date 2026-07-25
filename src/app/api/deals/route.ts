import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logEvent } from "@/lib/events";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, pipeline, stage, value, notes, lead_id } = body;
  if (!name || !pipeline || !stage) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  const { data, error } = await supabase()
    .from("deals")
    .insert({ name, pipeline, stage, value: value || null, notes: notes || null, lead_id: lead_id || null })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await logEvent("deal.created", "deal", data.id, { name, pipeline, stage });
  return NextResponse.json(data);
}
