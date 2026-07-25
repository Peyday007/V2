import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logEvent } from "@/lib/events";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = supabase();
  const { data: campaigns, error } = await db
    .from("campaigns")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const result = [];
  for (const c of campaigns || []) {
    const { count: total } = await db
      .from("leads")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", c.id);
    const { count: available } = await db
      .from("leads")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", c.id)
      .eq("status", "new")
      .eq("do_not_call", false);
    result.push({ ...c, total_leads: total || 0, available_leads: available || 0 });
  }
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  const { name, config } = await req.json();
  if (!name?.trim()) {
    return NextResponse.json({ error: "Name required" }, { status: 400 });
  }
  const { data, error } = await supabase()
    .from("campaigns")
    .insert({ name: name.trim(), config: config || {} })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await logEvent("campaign.created", "campaign", data.id, { name: data.name });
  return NextResponse.json(data);
}
