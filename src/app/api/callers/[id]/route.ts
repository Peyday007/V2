import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logEvent } from "@/lib/events";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { active } = await req.json();
  const { data, error } = await supabase()
    .from("callers")
    .update({ active })
    .eq("id", id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await logEvent(
    active ? "caller.activated" : "caller.deactivated",
    "caller",
    id,
    { name: data.name }
  );
  return NextResponse.json(data);
}
