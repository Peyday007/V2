import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logEvent } from "@/lib/events";

export const dynamic = "force-dynamic";

export async function GET() {
  const { data, error } = await supabase()
    .from("callers")
    .select("*")
    .order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const { name } = await req.json();
  if (!name?.trim()) {
    return NextResponse.json({ error: "Name required" }, { status: 400 });
  }
  const db = supabase();
  let pin = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    pin = String(Math.floor(100000 + Math.random() * 900000));
    const { data: existing } = await db.from("callers").select("id").eq("pin", pin);
    if (!existing || existing.length === 0) break;
  }
  const { data, error } = await db
    .from("callers")
    .insert({ name: name.trim(), pin })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await logEvent("caller.created", "caller", data.id, { name: data.name });
  return NextResponse.json(data);
}
